import { expect, test } from '@playwright/test';

test('status bar progress keeps its animation through its own and other entry updates', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.goto('/language.html');
	try {
		await page.evaluate(() => { window.languageIntegration.progress(10); window.languageIntegration.updatePeer(10); });
		const progress = page.locator('[data-statusbar-item-id="status.progress"]');
		const peer = page.locator('[data-statusbar-item-id="test.sync"]');
		const icon = progress.locator('.ash-statusbar-progress');
		const peerIcon = peer.locator('.ash-statusbar-progress');
		const animation = await icon.evaluateHandle(element => element.getAnimations()[0]!);
		const peerAnimation = await peerIcon.evaluateHandle(element => element.getAnimations()[0]!);
		await animation.evaluate(async animation => { await animation.ready; animation.currentTime = 650; });
		await peerAnimation.evaluate(async animation => { await animation.ready; animation.currentTime = 650; });
		await progress.getByRole('button').focus();
		for (const percentage of [20, 40, 60]) {
			await page.evaluate(percentage => window.languageIntegration.progress(percentage), percentage);
			await expect(progress).toHaveText(`rust-analyzer: Indexing ${percentage}%`);
			await page.evaluate(percentage => window.languageIntegration.updatePeer(percentage), percentage);
			await expect(peer).toHaveText(`Sync ${percentage}%`);
			expect(await icon.evaluate((element, animation) => element.getAnimations()[0] === animation, animation)).toBe(true);
			expect(await peerIcon.evaluate((element, animation) => element.getAnimations()[0] === animation, peerAnimation)).toBe(true);
			expect(await animation.evaluate(animation => animation.currentTime as number)).toBeGreaterThanOrEqual(650);
			expect(await peerAnimation.evaluate(animation => animation.currentTime as number)).toBeGreaterThanOrEqual(650);
			await expect(progress.getByRole('button')).toBeFocused();
		}
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await expect.poll(() => icon.evaluate(element => element.getAnimations().length)).toBe(0);
		await expect.poll(() => peerIcon.evaluate(element => element.getAnimations().length)).toBe(0);
		await animation.dispose();
		await peerAnimation.dispose();
	} finally {
		await page.evaluate(() => window.languageIntegration.dispose());
	}
});

test('language-server window progress names its server and retains keyboard activation through updates', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/language.html');
	try {
		await page.evaluate(() => window.languageIntegration.progress(68));
		const entry = page.locator('[data-statusbar-item-id="status.progress"]');
		const action = entry.getByRole('button', { name: 'rust-analyzer: Indexing 68%', exact: true });
		await expect(entry).toHaveText('rust-analyzer: Indexing 68%');
		await page.locator('.ash-workbench-statusbar').focus();
		await page.keyboard.press('ArrowRight');
		await expect(action).toBeFocused();
		await page.evaluate(() => window.languageIntegration.progress(90));
		const updated = entry.getByRole('button', { name: 'rust-analyzer: Indexing 90%', exact: true });
		await expect(updated).toBeFocused();
		await updated.press('Enter');
		expect(await page.evaluate(() => window.languageIntegration.revealedChannel())).toBe('rust-analyzer');
		await page.evaluate(() => window.languageIntegration.progress(100, true));
		await expect(entry).toHaveCount(0);
		await page.evaluate(() => window.languageIntegration.progress(10));
		await expect(entry).toBeVisible();
		await page.evaluate(() => window.languageIntegration.disposeProgress());
		await expect(entry).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await page.evaluate(() => window.languageIntegration.dispose());
	}
});

test('installing a language package enables completion in an already open Python editor', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
	await page.goto('/language.html');
	try {
		expect(await page.evaluate(() => window.languageIntegration.registered())).toBe(false);
		await page.getByRole('button', { name: 'Install Python server', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.languageIntegration.registered())).toBe(true);
		await page.evaluate(() => window.languageIntegration.focus());
		await page.keyboard.press('Control+Space');
		await expect(page.locator('.stanza-editor-completion-option').filter({ hasText: 'print_from_server' })).toBeVisible();
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Uninstall Python server', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.languageIntegration.registered())).toBe(false);
		const requests = await page.evaluate(() => window.languageIntegration.requests());
		await page.evaluate(() => window.languageIntegration.focus());
		await page.keyboard.press('Control+Space');
		await expect(page.locator('.stanza-editor-completion-option').filter({ hasText: 'print_from_server' })).toHaveCount(0);
		expect(await page.evaluate(() => window.languageIntegration.requests())).toBe(requests);
		expect(errors).toEqual([]);
	} finally {
		await page.evaluate(() => window.languageIntegration.dispose());
	}
});
