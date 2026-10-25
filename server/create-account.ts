import { resolve } from 'node:path';
import { createDatabase } from './db.js';
import { createAccount } from './auth.js';

const db = createDatabase(resolve('data', 'flowboard.db'));
try {
  const account = await createAccount(db, {
    email: process.env.FLOW_USER_EMAIL || '',
    password: process.env.FLOW_USER_PASSWORD || '',
    ...(process.env.FLOW_USER_NAME ? { name: process.env.FLOW_USER_NAME } : {}),
    ...(process.env.FLOW_USER_MEMBER_ID
      ? { memberId: Number(process.env.FLOW_USER_MEMBER_ID) }
      : {}),
  });
  console.log(JSON.stringify({ event: 'account_created', memberId: account.id }));
} catch {
  console.error(
    'Account creation failed. Provide a unique FLOW_USER_EMAIL, a 15–128 character FLOW_USER_PASSWORD and FLOW_USER_NAME (or an existing FLOW_USER_MEMBER_ID). No credentials were printed.',
  );
  process.exitCode = 1;
} finally {
  db.close();
}
