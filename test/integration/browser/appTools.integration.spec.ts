import { expect, test } from '@playwright/test';

test('application tools update the visible sidebar, preserve focus, persist and return explicit failures', async ({ page }) => {
	page.on('pageerror', error => console.error(error.message));
	await page.goto('/appTools.html');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	const group = await page.evaluate(async () => await window.ashAppToolsIntegration.call({ type: 'createSection', name: '<Review>' }) as { sectionId: string; });
	await expect(page.getByRole('heading', { name: '<Review>', exact: true })).toBeVisible();
	await page.evaluate(sectionId => window.ashAppToolsIntegration.call({ type: 'moveSession', sessionId: 'session-2', sectionId }), group.sectionId);
	const rows = page.locator('.ash-sessions-list-item');
	await expect(rows).toHaveText(['Task 2', 'Task 1']);
	await rows.first().focus();
	await page.evaluate(sectionId => window.ashAppToolsIntegration.call({ type: 'renameSection', sectionId, name: 'Ship' }), group.sectionId);
	await expect(rows.first()).toBeFocused();
	await expect(page.getByRole('heading', { name: 'Ship', exact: true })).toBeVisible();
	expect(await page.evaluate(async sectionId => {
		try { await window.ashAppToolsIntegration.call({ type: 'reorderSection', sectionId, sessionIds: [] }); return 'accepted'; }
		catch (error) { return String(error); }
	}, group.sectionId)).toContain('exactly once');
	await expect(rows).toHaveText(['Task 2', 'Task 1']);
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Ship', exact: true })).toBeVisible();
	await expect(rows).toHaveText(['Task 2', 'Task 1']);
	await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'navigate', sessionId: 'session-1', threadId: 'thread-1' }));
	expect(await page.evaluate(() => window.ashAppToolsIntegration.opened)).toEqual([{ sessionId: 'session-1', threadId: 'thread-1' }]);
	await page.evaluate(sectionId => window.ashAppToolsIntegration.call({ type: 'deleteSection', sectionId }), group.sectionId);
	await expect(rows).toHaveText(['Task 1', 'Task 2']);
});

test('application celebration respects reduced motion and localized sidebar controls', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/appTools.html?locale=zh-CN');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'confetti' }))).toEqual({ fired: false });
	await expect(page.getByRole('searchbox')).toHaveAttribute('aria-label', '搜索会话');
	const result = await page.evaluate(async () => {
		try { await window.ashAppToolsIntegration.call({ type: 'checkUpdate' }); return 'accepted'; }
		catch (error) { return String(error); }
	});
	expect(result).toContain('unavailable');
});

test('cancelling an application request preserves the connection and releases a late terminal', async ({ page }) => {
	await page.goto('/appTools.html');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	const cancelled = page.evaluate(async () => {
		try { await window.ashAppToolsIntegration.call({ type: 'openTerminal' }); return 'accepted'; }
		catch (error) { return String(error); }
	});
	await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.terminalPending)).toBe(true);
	await page.evaluate(() => window.ashAppToolsIntegration.cancelLast());
	expect(await cancelled).toContain('cancelled');
	await page.evaluate(() => window.ashAppToolsIntegration.releaseTerminal());
	await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.closedTerminals)).toEqual(['terminal-1']);
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'listSections' }))).toEqual({ sections: [] });
});
