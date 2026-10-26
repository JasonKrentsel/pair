import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir:'./e2e',outputDir:'./test-results',fullyParallel:true,workers:2,timeout:30000,
  expect:{timeout:5000},reporter:[['list'],['html',{outputFolder:'playwright-report',open:'never'}]],
  use:{baseURL:'http://127.0.0.1:5173',browserName:'chromium',channel:'chrome',headless:true,viewport:{width:380,height:900},trace:'retain-on-failure',screenshot:'only-on-failure',reducedMotion:'reduce'},
  webServer:{command:'npm run dev -- --host 127.0.0.1',url:'http://127.0.0.1:5173',reuseExistingServer:!process.env.CI,timeout:30000,cwd:'..'},
});
