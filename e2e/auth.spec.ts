import { test, expect } from './fixtures';

test.describe('Auth flow', () => {
  test('unauthenticated user is redirected to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText('password', { exact: true })).toBeVisible();
  });

  test('wrong password associates and announces the error', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="password"]', 'wrong-password');
    await page.click('button[type="submit"]');

    const password = page.locator('#password');
    const error = page.getByRole('alert');
    await expect(error).toHaveText(/Incorrect password/);
    await expect(error).toHaveAttribute('aria-live', 'assertive');
    await expect(password).toHaveAttribute('aria-invalid', 'true');
    await expect(password).toHaveAttribute('aria-describedby', 'login-error');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('password');
  });

  test('skip link moves focus to the login landmark', async ({ page }) => {
    await page.goto('/login');
    const skipLink = page.getByRole('link', { name: 'Skip to content' });
    await skipLink.focus();
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });

  test('correct password redirects to app', async ({ page, login }) => {
    await login(page, 'test-password');
    await expect(page).toHaveURL('/');
  });

  test('after login, page does not redirect back to login', async ({ page, login }) => {
    await login(page, 'test-password');
    await page.goto('/');
    await expect(page).toHaveURL((url) => url.pathname === '/');
  });
});
