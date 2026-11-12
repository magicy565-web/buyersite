import { test, expect } from '@playwright/test';
const routes = [
  '/',
  '/materials/silver-wool-fabric/',
  '/suppliers/burel-factory/',
  '/guides/burel-project-brief/',
];
for (const route of routes)
  test('read and inspect ' + route, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('h1')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // Scroll each image into view so native lazy loading is tested rather than disabled.
    for (const image of await page.locator('img').all()) {
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          image.evaluate((img) => {
            const element = img as HTMLImageElement;
            return element.complete && element.naturalWidth > 0;
          }),
        )
        .toBe(true);
    }
    const enquiry = page.locator('header a[href="/enquiry"]');
    await expect(enquiry).toBeVisible();
    const opener = page.locator('header [data-assistant-open]');
    await opener.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByRole('dialog').getByText('AI is not connected', { exact: false }),
    ).toBeVisible();
    await expect(page.getByLabel('Your question')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(opener).toBeFocused();
    await page.screenshot({ path: info.outputPath('page.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
test('download an unsent enquiry brief', async ({ page }, info) => {
  await page.goto('/enquiry/');
  await page.getByLabel('Quantity and unit').fill('20 linear metres');
  await page
    .getByLabel('Application and installation')
    .fill('Indoor wall panel; request suitability confirmation.');
  await page
    .getByLabel('Destination and target delivery')
    .fill('United Kingdom; date to be confirmed.');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download enquiry brief' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('material-enquiry-draft.txt');
  await download.saveAs(info.outputPath('material-enquiry-draft.txt'));
  await expect(page.getByRole('status')).toContainText('It has not been submitted or sent.');
});
