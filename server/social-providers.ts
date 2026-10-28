import * as oidc from 'openid-client';
import { z } from 'zod';
export const providerIds = ['google', 'yandex', 'github', 'telegram'] as const;
export type ProviderId = (typeof providerIds)[number];
export type Profile = { subject: string; name: string };
export type SocialProvider = {
  id: ProviderId;
  label: string;
  config: oidc.Configuration;
  scope: string;
  oidc: boolean;
  profile: (
    tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
  ) => Promise<Profile>;
};
export async function identityFetch(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(15000), ...(init?.signal ? [init.signal] : [])]),
  });
  if (String(input) === definitions.github.token_endpoint && response.status !== 200)
    console.warn(JSON.stringify({ event: 'github_token_http_failed', status: response.status }));
  const reader = response.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 262144) {
        await reader.cancel();
        throw new Error('Identity response exceeds limit');
      }
      chunks.push(part.value);
    }
  const body = Buffer.concat(chunks);
  let status = response.status;
  const provider =
    String(input) === definitions.github.token_endpoint
      ? 'github'
      : String(input) === definitions.telegram.token_endpoint
        ? 'telegram'
        : undefined;
  // These providers return token errors with HTTP 200; OAuth libraries expect 4xx.
  if (provider && status === 200) {
    const token = JSON.parse(body.toString('utf8')) as { error?: unknown } | null;
    if (typeof token?.error === 'string') {
      status = 400;
      const reason = z
        .enum([
          'bad_verification_code',
          'incorrect_client_credentials',
          'redirect_uri_mismatch',
          'invalid_grant',
          'invalid_client',
          'invalid_request',
        ])
        .safeParse(token.error);
      console.warn(
        JSON.stringify({
          event: provider + '_token_rejected',
          reason: reason.success ? reason.data : 'provider_error',
        }),
      );
    }
  }
  return new Response([204, 304].includes(status) ? null : body, {
    status,
    headers: response.headers,
  });
}
const definitions = {
  google: {
    label: 'Google',
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    scope: 'openid profile',
    oidc: true,
  },
  yandex: {
    label: 'Яндекс',
    issuer: 'https://oauth.yandex.ru',
    authorization_endpoint: 'https://oauth.yandex.ru/authorize',
    token_endpoint: 'https://oauth.yandex.ru/token',
    scope: 'login:info',
    oidc: false,
  },
  github: {
    label: 'GitHub',
    issuer: 'https://github.com/login/oauth',
    authorization_endpoint: 'https://github.com/login/oauth/authorize',
    token_endpoint: 'https://github.com/login/oauth/access_token',
    scope: 'read:user',
    oidc: false,
  },
  telegram: {
    label: 'Telegram',
    issuer: 'https://oauth.telegram.org',
    authorization_endpoint: 'https://oauth.telegram.org/auth',
    token_endpoint: 'https://oauth.telegram.org/token',
    jwks_uri: 'https://oauth.telegram.org/.well-known/jwks.json',
    scope: 'openid profile',
    oidc: true,
  },
};
export function socialProviders(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof identityFetch = identityFetch,
): SocialProvider[] {
  const result: SocialProvider[] = [];
  for (const id of providerIds) {
    const prefix = 'FLOW_' + id.toUpperCase(),
      clientId = env[prefix + '_CLIENT_ID'],
      secret = env[prefix + '_CLIENT_SECRET'];
    if (!clientId && !secret) continue;
    if (
      !clientId ||
      !secret ||
      clientId.length > 512 ||
      secret.length > 4096 ||
      /[\r\n]/.test(clientId + secret)
    )
      throw new Error('Configure ' + prefix + ' client ID and secret');
    const definition = definitions[id];
    const config = new oidc.Configuration(
      {
        ...definition,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
      },
      clientId,
      { client_secret: secret, id_token_signed_response_alg: 'RS256' },
      id === 'telegram' ? oidc.ClientSecretBasic(secret) : oidc.ClientSecretPost(secret),
    );
    config.timeout = 15;
    if (definition.oidc) oidc.enableNonRepudiationChecks(config);
    config[oidc.customFetch] = fetcher;
    result.push({
      id,
      label: definition.label,
      scope: definition.scope,
      oidc: definition.oidc,
      config,
      async profile(tokens) {
        let subject: unknown, name: unknown;
        if (definition.oidc) {
          const claims = tokens.claims();
          subject = claims?.sub;
          name = claims?.name || claims?.preferred_username;
        } else {
          const url =
            id === 'github'
              ? 'https://api.github.com/user'
              : 'https://login.yandex.ru/info?format=json';
          const response = await fetcher(url, {
            headers: {
              Authorization: (id === 'github' ? 'Bearer ' : 'OAuth ') + tokens.access_token,
              Accept: 'application/json',
              'User-Agent': 'Flowboard',
            },
          });
          if (!response.ok) throw new Error('Identity profile unavailable');
          const profile = (await response.json()) as Record<string, unknown>;
          subject =
            id === 'github' && typeof profile.id === 'number' && Number.isSafeInteger(profile.id)
              ? String(profile.id)
              : profile.id;
          name = profile.display_name || profile.real_name || profile.name || profile.login;
        }
        const parsed = z.string().min(1).max(255).safeParse(subject);
        if (!parsed.success) throw new Error('Missing provider subject');
        return {
          subject: parsed.data,
          name:
            typeof name === 'string' && name.trim()
              ? name.trim().slice(0, 80)
              : definition.label + ' user',
        };
      },
    });
  }
  return result;
}
