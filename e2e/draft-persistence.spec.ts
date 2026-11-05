import { test, expect } from './fixtures';

/**
 * Durable composer drafts — unsent text survives a full reload (the same
 * path as a discarded PWA). The mock re-serves the same session on reconnect.
 */
test.describe('Composer draft persistence', () => {
  test.beforeEach(async ({ page, mockWs, login }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('restores an unsent draft after reload', async ({ page }) => {
    const textarea = page.locator('textarea');
    await expect(textarea).toBeEditable();
    await textarea.fill('half-written thought');
    // Saved after a short idle debounce.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('pi-ui:drafts:v1') ?? ''))
      .toContain('half-written thought');

    await page.reload();
    await expect(page.locator('textarea')).toHaveValue('half-written thought', {
      timeout: 10_000,
    });
  });

  test('a sent message clears the saved draft', async ({ page, mockWs }) => {
    void mockWs;
    const textarea = page.locator('textarea');
    await expect(textarea).toBeEditable();
    await textarea.fill('send me');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('pi-ui:drafts:v1') ?? ''))
      .toContain('send me');
    await page.click('button[aria-label="Send message"]');
    await expect(textarea).toHaveValue('');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('pi-ui:drafts:v1') ?? ''))
      .not.toContain('send me');

    await page.reload();
    await expect(page.locator('textarea')).toBeEditable({ timeout: 10_000 });
    await expect(page.locator('textarea')).toHaveValue('');
  });
});
