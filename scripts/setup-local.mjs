import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const values = {
  POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
  FLOW_APP_KEY: randomBytes(32).toString('base64'),
  FLOW_YOOKASSA_WEBHOOK_TOKEN: randomBytes(32).toString('hex'),
};
try {
  writeFileSync(
    '.env',
    Object.entries(values)
      .map(([key, value]) => key + '=' + value)
      .join('\n') + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Created .env with random local credentials. Existing files are never replaced.');
} catch (error) {
  if (error.code === 'EEXIST')
    console.error('.env already exists; keep it or choose a new directory.');
  else console.error('Could not create local configuration.');
  process.exitCode = 1;
}
