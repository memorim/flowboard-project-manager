import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';
export default defineConfig({
  ...baseline,
  testMatch: 'auth.spec.mjs',
  testIgnore: [],
  projects: baseline.projects.filter((project) => ['desktop', 'mobile'].includes(project.name)),
  use: { ...baseline.use, baseURL: 'http://127.0.0.1:4141' },
  webServer: {
    command: 'pnpm build && node --import tsx tests/serve-auth.mjs',
    url: 'http://127.0.0.1:4141/api/health',
    timeout: 120000,
    reuseExistingServer: false,
  },
});
