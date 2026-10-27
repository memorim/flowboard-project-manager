import { z } from 'zod';

type Row = Record<string, unknown>;
export type Result<T = Row> = { results: T[]; meta: { changes?: number; last_row_id?: number } };
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<Result<T>>;
  run(): Promise<Result>;
}
// Native D1 subset, reused by the local SQLite adapter so authorization has one implementation.
export interface SqlDB {
  dialect?: 'sqlite' | 'postgres';
  limits?: { changes: number; workspaces: number; projects: number; invitations: number };
  transaction?<T>(operation: () => Promise<T>): Promise<T>;
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<Result[]>;
}
export type Actor = { id: number; name: string; role: string; initials: string; color: string };
export const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function tokenHash(token: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
}
export async function body(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) {
      await reader.cancel();
      throw new HttpError(413, 'Слишком большой запрос');
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}
export function operationKey(req: Request, scope: string) {
  const key = req.headers.get('Idempotency-Key');
  if (key === null) return null;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new HttpError(400, 'Некорректный ключ операции');
  return scope + ':' + key;
}
export function replay(row: { request_payload: string; create_result: string }, payload: string) {
  if (row.request_payload !== payload)
    throw new HttpError(409, 'Ключ уже использован с другими данными');
  return json(JSON.parse(row.create_result), 201);
}
export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'Проверьте данные запроса');
  return r.data;
}

export type Workspace = { id: number; name: string; is_public: number; access_role: string | null };
export type ReadScope = {
  req: Request;
  db: SqlDB;
  actor: Actor | null;
  workspace: number;
  space: Workspace;
  role: string;
};
export type WriteScope = Omit<ReadScope, 'actor' | 'space'> & {
  actor: Actor;
  limited: boolean;
  event: (text: string, conditional?: boolean) => Statement;
};
