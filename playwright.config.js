// Browser tests for the web part of Palimpsest (the same code runs inside the Android app).
// Run: npm test             (Chrome, the engine inside Android's web view)
//      npm run test:webkit  (Safari's engine, the one inside an iPad app; needs: npx playwright install webkit)
const { defineConfig } = require('@playwright/test');
const fs = require('fs');

const chromium = '/opt/pw-browsers/chromium';   // a preinstalled Chromium, if there is one; otherwise Playwright's own
module.exports = defineConfig({
  testDir: 'tests',
  timeout: 30000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4310',
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: fs.existsSync(chromium) ? { executablePath: chromium } : {} } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: { command: 'python3 -m http.server 4310 --bind 127.0.0.1', port: 4310, reuseExistingServer: true },
});
