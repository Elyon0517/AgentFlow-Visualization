import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

test('replays a complete run, switches views and round-trips an exported trace', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '4×', exact: true }).click();
  await expect(page.getByText('completed', { exact: true }).first()).toBeVisible({ timeout: 35000 });
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(800); // let the force layout settle before capturing
  mkdirSync('assets/screenshots', { recursive: true });
  await page.screenshot({ path: 'assets/screenshots/topology.png' });
  await page.getByRole('button', { name: /02 \/ TIMING/i }).click();
  await expect(page.locator('body')).toContainText(/timeline|duration|orchestrator/i);
  await page.screenshot({ path: 'assets/screenshots/timeline.png' });
  await page.getByRole('button', { name: /03 \/ TELEMETRY/i }).click();
  await expect(page.locator('body')).toContainText(/Risk check passed/i);
  await page.screenshot({ path: 'assets/screenshots/telemetry.png' });
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: /Export trace/i }).click(),
  ]);
  const trace = info.outputPath('trace.jsonl');
  await download.saveAs(trace);
  const events = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events.length).toBeGreaterThan(20);
  expect(events.some(event => event.eventType === 'node.failed')).toBe(true);
  await page.getByRole('button', { name: 'JSONL', exact: true }).click();
  await page.getByRole('button', { name: /INPUT BUS/ }).click();
  await page.locator('input[type=file]').setInputFiles(trace);
  await page.getByRole('button', { name: /01 \/ TOPOLOGY/i }).click();
  await expect(page.getByText('SPY 0DTE signal evaluation', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
