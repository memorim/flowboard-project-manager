import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { HttpError } from '../src/flow-http.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('hex');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function mfaSecret() {
  // 160 random bits, encoded as 32 base32 symbols without padding.
  let bits = '';
  for (const byte of randomBytes(20)) bits += byte.toString(2).padStart(8, '0');
  return bits
    .match(/.{5}/g)!
    .map((value) => alphabet[parseInt(value, 2)])
    .join('');
}
export function totp(secret: string, counter: number, digits = 6) {
  if (!/^[A-Z2-7]{32}$/.test(secret) || !Number.isSafeInteger(counter) || counter < 0)
    throw new Error('Invalid TOTP input');
  const bits = [...secret].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((v) => parseInt(v, 2)));
  const moving = Buffer.alloc(8);
  moving.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac('sha1', key).update(moving).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
export function matchTotp(secret: string, code: string, now: number, lastCounter = -1) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const counter of [current, current - 1, current + 1]) {
    if (
      counter >= 0 &&
      counter > lastCounter &&
      timingSafeEqual(Buffer.from(totp(secret, counter)), Buffer.from(code))
    )
      return counter;
  }
  return null;
}
export function encryptionKey(env: NodeJS.ProcessEnv = process.env) {
  if (!env.FLOW_APP_KEY) return undefined;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(env.FLOW_APP_KEY))
    throw new Error('FLOW_APP_KEY must be 32 base64-encoded random bytes');
  const key = Buffer.from(env.FLOW_APP_KEY, 'base64');
  if (key.length !== 32) throw new Error('Invalid FLOW_APP_KEY');
  return key;
}
export function encrypt(value: string, key: Buffer) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
export function decrypt(value: string, key: Buffer) {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
export function requireKey(key?: Buffer) {
  if (!key) throw new HttpError(503, 'Настройка безопасности аккаунтов ещё не завершена');
  return key;
}
