import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class Context {
      state = 'running';
      resume() { return Promise.resolve(); }
      close() { this.state = 'closed'; return Promise.resolve(); }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: Context });
    Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, value: class {} });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: () => new Promise((_resolve, reject) => {
        (window as unknown as { rejectPianoMic: (e: Error) => void }).rejectPianoMic = reject;
      }),
    } });
  });
  await page.goto('/learn-piano');
});

test('pending microphone startup is visible immediately and cancellation defeats a late rejection', async ({ page }) => {
  await page.getByLabel('Listen to my piano').check();
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel microphone request', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Starting microphone');
  await expect(page.getByRole('status')).not.toContainText('Microphone is off');
  await page.getByRole('button', { name: 'Cancel microphone request', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Microphone off.');
  await page.evaluate(() => (window as unknown as { rejectPianoMic: (e: Error) => void }).rejectPianoMic(new Error('late denial')));
  await expect(page.getByRole('button', { name: 'Start listening', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Microphone off.');
});

test('denial leaves an actionable status and a retry control', async ({ page }) => {
  await page.getByLabel('Listen to my piano').check();
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Starting microphone');
  await page.evaluate(() => (window as unknown as { rejectPianoMic: (e: Error) => void }).rejectPianoMic(new Error('permission denied')));
  await expect(page.getByRole('status')).toContainText('Check browser permission');
  await expect(page.getByRole('button', { name: 'Start listening', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel microphone request', exact: true })).toHaveCount(0);
});

test('touch phrase and Next drill still work independently of microphone startup', async ({ page }) => {
  for (const note of ['C3', 'F3', 'G3', 'A3', 'C3']) await page.getByRole('button', { name: `Play ${note}`, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Phrase complete');
  await page.getByRole('button', { name: 'Next drill' }).click();
  await expect(page.getByTestId('target-note')).toHaveText('C2');
});
