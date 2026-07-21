import { test, expect } from './fixtures';

test.describe('Web Share Target', () => {
  test.beforeEach(async ({ page, mockWs, login }) => {
    await mockWs(page);
    await login(page, 'test-password');
  });

  test('populates the composer from share_title/share_text/share_url and scrubs the URL', async ({
    page,
  }) => {
    await page.goto(
      '/?share_title=Fix+the+bug&share_text=console.log(1)&share_url=https%3A%2F%2Fexample.com%2Fissue%2F1'
    );

    await expect(page.locator('textarea')).toHaveValue(
      'Fix the bug\nconsole.log(1)\nhttps://example.com/issue/1'
    );

    const search = new URL(page.url()).search;
    expect(search).toBe('');
  });

  test('ignores navigation with no share params', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('textarea')).toHaveValue('');
  });

  test('populates from a single share param', async ({ page }) => {
    await page.goto('/?share_text=just+some+text');
    await expect(page.locator('textarea')).toHaveValue('just some text');
  });
});
