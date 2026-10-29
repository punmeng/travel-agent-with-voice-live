import { test, expect } from '@playwright/test';

test.skip(!process.env.ENGLISH_UI_CANDIDATE_DIR, 'Requires the isolated staged member frontend.');

const demoPassword = 'MeihaoDemo!2026';

test('English member sign-in shows only the selected demo profile and soft preferences', async ({ page }) => {
  await page.goto('/');
  await page.locator('#language').selectOption('en-US');
  await expect(page.locator('#member-login')).toHaveText('Member sign in');
  await page.locator('#member-login').click();
  await page.locator('#member-email').fill('alex.taipei@example.test');
  await page.locator('#member-password').fill(demoPassword);
  await page.locator('#member-submit').click();

  await expect(page.locator('#member-session')).toBeVisible();
  await expect(page.locator('#member-name')).toHaveText('Alex · Business traveler');
  await expect(page.locator('#member-profile')).toContainText('Taipei');
  await expect(page.locator('#member-profile')).toContainText('Your explicit trip choices take priority');
  await expect(page.locator('#member-profile')).toContainText('Confirm before using as departure');
  await expect(page.locator('#voice-mode option[value="foundry-voice-agent"]')).toBeHidden();
});

test('wrong password is surfaced in the dialog without changing member state', async ({ page }) => {
  await page.goto('/');
  await page.locator('#member-login').click();
  await page.locator('#member-email').fill('tomo.tokyo@example.test');
  await page.locator('#member-password').fill('IncorrectPassword!');
  await page.locator('#member-submit').click();

  await expect(page.locator('#member-error')).toBeVisible();
  await expect(page.locator('#member-error')).toHaveText('電子郵件或密碼不正確。');
  await expect(page.locator('#member-session')).toBeHidden();
});

test('logout requires clearing an active journey and removes its visible transcript', async ({ page }) => {
  await page.goto('/');
  await page.locator('#member-login').click();
  await page.locator('#member-email').fill('alex.taipei@example.test');
  await page.locator('#member-password').fill(demoPassword);
  await page.locator('#member-submit').click();
  await expect(page.locator('#member-session')).toBeVisible();

  await page.locator('#message').fill('Hello, I am planning a trip.');
  await page.locator('#chat-form').locator('button[type="submit"]').click();
  await expect(page.locator('#messages .message.user')).toHaveCount(1);
  await expect.poll(() => page.evaluate(async () => {
    const data = await fetch('/api/bootstrap').then(response => response.json());
    return data.hasActiveJourney;
  })).toBe(true);

  page.once('dialog', dialog => dialog.accept());
  await page.locator('#member-logout').click();
  await expect(page.locator('#member-login')).toBeVisible();
  await expect(page.locator('#messages .message.user')).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => {
    const data = await fetch('/api/bootstrap').then(response => response.json());
    return data.member;
  })).toBeNull();
});
