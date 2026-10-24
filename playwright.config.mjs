import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:45000,retries:process.env.CI?1:0,
  use:{baseURL:'http://127.0.0.1:4140',trace:'retain-on-failure'},
  projects:[{name:'desktop',use:{viewport:{width:1280,height:900}}},{name:'mobile',use:{viewport:{width:390,height:844}}}],
  webServer:{command:'pnpm build && node --import tsx tests/serve.mjs',url:'http://127.0.0.1:4140/api/health',timeout:120000,reuseExistingServer:false}
});
