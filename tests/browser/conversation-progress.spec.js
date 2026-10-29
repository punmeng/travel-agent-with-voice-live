import { test, expect } from '@playwright/test';

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`screenshot follow-ups progress instead of repeating discovery at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.locator('#language').selectOption('en-US');
    await expect(page.locator('#send')).toBeEnabled();
    const say = async text => {
      await page.locator('#message').fill(text);
      const response = page.waitForResponse(response => response.url().endsWith('/api/chat') &&
        response.request().method() === 'POST');
      await page.locator('#send').click();
      const result = await (await response).json();
      expect(result.error).toBeUndefined();
      await expect(page.locator('#send')).toBeEnabled();
      return result;
    };
    await say('I want to travel to Tokyo for 3 days');
    const flights = await say('seach the flight , encomcy, 1 persion');
    expect(flights.state.activeAgent).toBe('flight');
    expect(flights.state.draft.cabin).toBe('economy');
    expect(flights.state.draft.travelers).toBe(1);
    expect(flights.text).toContain('NRT');
    expect(flights.text).toContain('HND');
    expect(flights.text).not.toContain('What experiences and pace');
    const plan = await say('give me suggest');
    expect(plan.state.activeAgent).toBe('planner');
    await expect(page.locator('#messages .message.assistant').last()).toContainText('Day 3');
    await expect(page.locator('#messages .message.assistant').last()).not.toContainText('What experiences and pace');
    expect(await page.locator('#messages').evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#messages .message.assistant').last().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`conversation-progress-${viewport.width}.png`),
      fullPage: true
    });
    const search = await say('Search flights from TPE to NRT on November 12, 2026');
    expect(search.tools.filter(tool => tool.tool === 'search_flights')).toHaveLength(1);
    expect(search.state.trip.travelers).toBe(1);
    expect(search.state.trip.cabin).toBe('economy');
    await expect(page.locator('#messages .message.assistant').last()).toContainText('Synthetic flights');
  });
}
