import { test, expect } from './fixtures';

test.describe('Auth flow', () => {
  test('unauthenticated user is redirected to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText('password', { exact: true })).toBeVisible();
  });

  test('wrong password shows error message', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="password"]', 'wrong-password');
    await page.click('button[type="submit"]');
    await expect(page.locator('text=Incorrect password')).toBeVisible();
  });

  test('correct password redirects to app', async ({ page, login }) => {
    await login(page, 'test-password');
    await expect(page).toHaveURL('/');
  });

  test('after login, page does not redirect back to login', async ({ page, login }) => {
    await login(page, 'test-password');
    await page.goto('/');
    await expect(page).toHaveURL('/');
  });
});
