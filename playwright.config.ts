import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  maxFailures: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: process.env.BUYERSITE_BROWSER_REPORT || 'test-results/browser.json' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4321',
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    { name: 'mobile-390', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    {
      name: 'mobile-360',
      use: {
        browserName: 'chromium',
        viewport: { width: 360, height: 800 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    // Astro 7 agent detection otherwise detaches and exits before Playwright owns it.
    command: 'pnpm preview --host 127.0.0.1 --port 4321 --ignore-lock',
    env: { PUBLIC_ASSISTANT_API_BASE: '' },
    url: 'http://127.0.0.1:4321',
    reuseExistingServer: false,
  },
});
