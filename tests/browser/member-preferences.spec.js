import { test, expect } from '@playwright/test';

test.skip(!process.env.ENGLISH_UI_CANDIDATE_DIR, 'Requires the isolated staged member frontend.');

const password = 'MeihaoDemo!2026';
async function login(page, email) {
  const response = await page.request.post('/api/member/login', {
    headers: { Origin: new URL(page.url()).origin }, data: { email, password, confirmReset: true } });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function send(page, text) {
  await page.locator('#message').fill(text);
  const response = page.waitForResponse(r => r.url().endsWith('/api/chat'));
  await page.locator('#send').click();
  const result = await (await response).json();
  await expect(page.locator('#send')).toBeEnabled();
  return result;
}
const search = '從桃園到成田，2026-11-12，1 人，經濟艙，搜尋航班';

test('guest has no member card or applied note after a real offline search', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#member-profile')).toBeHidden();
  const result = await send(page, search);
  expect(result.state.offers.length).toBeGreaterThanOrEqual(2);
  expect(result.state.memberRanking).toBeNull();
  await expect(page.locator('.applied-preferences')).toHaveCount(0);
});

for (const [email, name, persona, cabin] of [
  ['alex.taipei@example.test', 'Alex', 'Business traveler', 'No default cabin'],
  ['tomo.tokyo@example.test', 'Tomo', 'Family traveler', 'No default cabin'],
  ['ohsung.seoul@example.test', 'Ohsung', 'Value seeker', 'No default cabin'],
  ['adam.sydney@example.test', 'Adam', 'Premium traveler', 'Business']
]) test(`${name}: catalog profile is separate from trip and actual ranking is shown once`, async ({ page }) => {
  await page.goto('/');
  await login(page, email);
  await page.request.post('/api/language', { headers: { Origin: new URL(page.url()).origin }, data: { locale: 'en-US' } });
  await page.reload();
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#member-profile-name')).toHaveText(`${name} · ${persona}`);
  await expect(page.locator('#member-cabin-default')).toContainText(cabin);
  await expect(page.locator('#member-profile')).toContainText('Profile city · Confirm before using as departure');
  await expect(page.locator('#member-profile')).toContainText('Demo profile · Not learned from past conversations');
  await expect(page.locator('#session-facts')).toContainText('Awaiting confirmation');
  await expect(page.locator('#session-context > summary')).toHaveText('Current trip');
  if (name === 'Alex') {
    await expect(page.locator('#member-preferences')).toContainText('daytime departures');
    await expect(page.locator('#member-preferences')).toContainText('only after meeting times are provided');
  }
  const result = await send(page, 'Search flights from TPE to NRT on November 12, 2026 for 1 adult in economy.');
  expect(result.state.memberRanking).toBeTruthy();
  expect(result.state.trip.cabin).toBe('economy');
  await expect(page.locator('#session-facts')).toContainText('Economy');
  await expect(page.locator('.applied-preferences')).toHaveCount(1);
  await expect(page.locator('.applied-preferences')).toContainText(result.state.memberRanking.message);
  expect(await page.locator('#messages .message.assistant').last().evaluate((node, text) =>
    node.textContent.split(text).length - 1, result.state.memberRanking.message)).toBe(1);
  if (name === 'Alex') {
    expect(result.state.memberRanking.meetingAware).toBe(false);
    await expect(page.locator('.applied-preferences')).toContainText('Add meeting times');
    await expect(page.locator('.applied-preferences')).not.toContainText('compared with the saved meeting blocks');
  }
  await page.locator('#language').selectOption('zh-TW');
  await expect(page.locator('#member-profile')).toContainText('示範個人檔案 · 非從過往對話學得');
  await expect(page.locator('.applied-preferences')).toContainText('已套用至這些航班結果的偏好');
  await page.locator('#new-trip').click();
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('.applied-preferences')).toHaveCount(0);
  await expect(page.locator('#member-profile-name')).toContainText(name);
  await expect(page.locator('#session-facts')).not.toContainText('2026-11-12');
});

test('new unranked/one-offer response cannot inherit an applied note; account changes clear previous cards', async ({ page }) => {
  await page.goto('/');
  await login(page, 'alex.taipei@example.test');
  await page.reload();
  await expect(page.locator('#send')).toBeEnabled();
  const result = await send(page, search);
  await expect(page.locator('.applied-preferences')).toHaveCount(1);
  await page.route('**/api/chat', route => route.fulfill({ json: {
    text: '只有一個示範選項，未套用會員排序。',
    state: { ...result.state, offers: [result.state.offers[0]], memberRanking: null }
  } }));
  await send(page, '重新搜尋');
  await expect(page.locator('.applied-preferences')).toHaveCount(0);
  await page.unroute('**/api/chat');
  await login(page, 'tomo.tokyo@example.test');
  await page.reload();
  await expect(page.locator('#member-profile-name')).toContainText('Tomo');
  await expect(page.locator('#member-profile')).not.toContainText('Alex');
  await expect(page.locator('#messages')).not.toContainText('個人化排序');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#member-logout').click();
  await expect(page.locator('#member-profile')).toBeHidden();
  await expect(page.locator('#member-profile-name')).toBeEmpty();
  await expect(page.locator('#member-preferences')).toBeEmpty();
  await expect(page.locator('.applied-preferences')).toHaveCount(0);
});

test('preference card and trip context remain reachable without reducing conversation at laptop/mobile sizes', async ({ page }) => {
  await page.goto('/');
  await login(page, 'alex.taipei@example.test');
  for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    await expect(page.locator('#send')).toBeEnabled();
    const height = await page.locator('#messages').evaluate(node => node.clientHeight);
    expect(height).toBeGreaterThanOrEqual(300);
    await page.locator('#member-profile').scrollIntoViewIfNeeded();
    await expect(page.locator('#member-preferences')).toBeVisible();
    if (!await page.locator('#session-context').evaluate(node => node.open)) {
      await page.locator('#session-context > summary').click();
    }
    await page.locator('#session-facts').scrollIntoViewIfNeeded();
    await expect(page.locator('#session-facts')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
