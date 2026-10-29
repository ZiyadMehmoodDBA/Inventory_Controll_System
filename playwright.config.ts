import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the TuneGEN demo recording.
 *
 * Run with: `npm run demo`
 *
 * Output:
 *   tests/demo-output/<timestamp>/<spec>/video.webm
 *   tests/demo-output/<timestamp>/<spec>/trace.zip   (debugging)
 *
 * Convert to mp4 (after a run completes), if you have ffmpeg installed:
 *   ffmpeg -i video.webm -c:v libx264 -preset slow -crf 18 demo.mp4
 */
export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts/,
  // Single worker so the recording is one continuous file
  workers: 1,
  // Plenty of time for the full walkthrough
  timeout: 5 * 60 * 1000,
  // Don't keep retrying — we want a clean single take
  retries: 0,
  reporter: [['list']],

  use: {
    baseURL: process.env.DEMO_BASE_URL || 'http://localhost:5173',
    // Headed by default so the recording captures real rendering
    headless: process.env.CI ? true : false,
    // Slow each action ~150ms — makes the recording readable
    launchOptions: { slowMo: Number(process.env.DEMO_SLOWMO_MS ?? 150) },
    viewport: { width: 1440, height: 900 },
    video: {
      mode: 'on',
      size: { width: 1440, height: 900 },
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Tire-shop demo data — accept self-signed certs in case prod uses them
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  outputDir: './tests/demo-output',
});
