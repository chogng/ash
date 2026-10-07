import { expect, test } from '@playwright/test';

test('application tools adapt file, review and browser resources into window services', async ({ page }) => {
	await page.goto('/appTools.html');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'openFile', path: '/workspace/a b.ts', line: 12 }))).toEqual({ opened: true, path: '/workspace/a b.ts' });
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'openReview', original: '/workspace/before.ts', modified: '/workspace/after.ts' }))).toEqual({ opened: true });
	expect(await page.evaluate(() => {
		const [file, options] = window.ashAppToolsIntegration.opened[0] as [{ resource: { scheme: string; path: string; }; }, { selection: { startLineNumber: number; startColumn: number; }; }];
		const [review] = window.ashAppToolsIntegration.opened[1] as [{ original: { resource: { path: string; }; }; modified: { resource: { path: string; }; }; }];
		return { file: [file.resource.scheme, file.resource.path], selection: [options.selection.startLineNumber, options.selection.startColumn], review: [review.original.resource.path, review.modified.resource.path] };
	})).toEqual({ file: ['file', '/workspace/a b.ts'], selection: [12, 1], review: ['/workspace/before.ts', '/workspace/after.ts'] });
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'openBrowser', url: 'https://example.com/review?item=1' }))).toEqual({ opened: true });
	expect(await page.evaluate(() => window.ashAppToolsIntegration.openedUrls)).toEqual(['https://example.com/review?item=1']);
});

test('application tools update the visible sidebar, preserve focus, persist and return explicit failures', async ({ page }) => {
	page.on('pageerror', error => console.error(error.message));
	await page.goto('/appTools.html');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	const group = await page.evaluate(async () => await window.ashAppToolsIntegration.call({ type: 'createSection', name: '<Review>' }) as { sectionId: string; });
	await expect(page.getByRole('heading', { name: '<Review>', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: '<Review>', exact: true })).toHaveCSS('font-size', '12px');
	await expect(page.getByRole('heading', { name: '<Review>', exact: true })).toHaveCSS('font-weight', '600');
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

test('disposing the application adapter releases its host and rejects late terminal completion', async ({ page }) => {
	await page.goto('/appTools.html');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'confetti' }))).toEqual({ fired: true });
	await expect(page.locator('.ash-app-confetti')).toHaveCount(1);
	await expect(page.locator('.ash-app-confetti')).toHaveAttribute('aria-hidden', 'true');
	await expect(page.locator('.ash-app-confetti-particle').first()).toHaveCSS('font-size', '13px');
	const pending = page.evaluate(async () => {
		try { await window.ashAppToolsIntegration.call({ type: 'openTerminal' }); return 'accepted'; }
		catch (error) { return String(error); }
	});
	await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.terminalPending)).toBe(true);
	await page.evaluate(() => window.ashAppToolsIntegration.disposeHost());
	await expect(page.locator('.ash-app-confetti')).toHaveCount(0);
	await page.evaluate(() => window.ashAppToolsIntegration.releaseTerminal());
	expect(await pending).toContain('cancelled');
	expect(await page.evaluate(() => window.ashAppToolsIntegration.closedTerminals)).toEqual(['terminal-1']);
	expect(await page.evaluate(async () => {
		try { await window.ashAppToolsIntegration.call({ type: 'listSections' }); return 'accepted'; }
		catch (error) { return String(error); }
	})).toBe('Error: Method not found');
});

test('sidebar headings and celebration particles resolve typography in every theme', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		await page.goto(`/appTools.html?theme=${theme}`);
		await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
		const name = `Review ${theme}`;
		await page.evaluate(name => window.ashAppToolsIntegration.call({ type: 'createSection', name }), name);
		const heading = page.getByRole('heading', { name, exact: true });
		await expect(heading).toHaveCSS('font-size', '12px');
		await expect(heading).toHaveCSS('font-weight', '600');
		expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'confetti' }))).toEqual({ fired: true });
		await expect(page.locator('.ash-app-confetti-particle').first()).toHaveCSS('font-size', '13px');
		await page.evaluate(() => window.ashAppToolsIntegration.disposeHost());
		await expect(page.locator('.ash-app-confetti')).toHaveCount(0);
	}
});
