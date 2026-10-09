import { expect, test } from '@playwright/test';

for (const [state, reason, icon, color, label] of [
	['open', '', 'issue-opened', 'charts-green', 'Open'],
	['closed', 'completed', 'issue-closed', 'charts-purple', 'Closed'],
	['closed', 'not_planned', 'issue-closed', 'description-foreground', 'Closed as not planned'],
	['closed', 'duplicate', 'issue-closed', 'description-foreground', 'Closed as duplicate'],
	['closed', '', 'issue-closed', 'charts-purple', 'Closed'],
] as const) {
	test(`Issue ${state} ${reason || 'without reason'} renders a decorative themed status through the GitHub protocol`, async ({ page }) => {
		await page.goto(`/github.html?issueState=${state}&issueReason=${reason}`);
		const issue = page.locator('main a[href="https://github.com/team/repo/issues/7"]');
		await expect(issue).toContainText(state === 'open' ? 'Open' : 'Closed');
		await issue.focus();
		await page.keyboard.press('F2');
		const card = page.locator('.ash-github-resource-hover');
		const glyph = card.locator('svg');
		await expect(card.locator('.ash-github-hover-metadata')).toHaveText(label);
		expect(await page.evaluate(() => window.ashGitHubIntegration.accessibleContent('view' as import('../../../src/ash/platform/accessibility/browser/accessibleView.js').AccessibleViewType))).toContain(label);
		await expect(glyph).toHaveAttribute('data-ash-icon-id', icon);
		await expect(glyph).toHaveAttribute('aria-hidden', 'true');
		expect(await glyph.evaluate(element => element.style.color)).toBe(`var(--ash-${color})`);
		for (const theme of ['light', 'highContrast'] as const) {
			await page.evaluate(name => window.ashGitHubIntegration.theme(name), theme);
			expect(await glyph.evaluate(element => getComputedStyle(element).color)).not.toBe('rgba(0, 0, 0, 0)');
			await expect(card.getByRole('link', { name: 'team/repo', exact: true })).toBeFocused();
		}
		await page.keyboard.press('Escape');
		await expect(issue).toBeFocused();
		await expect(card).toHaveCount(0);
	});
}

test('Issue closure reasons are readable in Chinese in links, details and the accessible view', async ({ page }) => {
	for (const [reason, label] of [['not_planned', '已关闭：不计划处理'], ['duplicate', '已关闭：重复问题']] as const) {
		await page.goto(`/github.html?issueState=closed&issueReason=${reason}&locale=zh-CN`);
		const issue = page.locator('main a[href="https://github.com/team/repo/issues/7"]');
		await expect(issue).toContainText(label);
		await issue.focus();
		await page.keyboard.press('F2');
		await expect(page.locator('.ash-github-resource-hover .ash-github-hover-metadata')).toHaveText(label);
		expect(await page.evaluate(() => window.ashGitHubIntegration.accessibleContent('view' as import('../../../src/ash/platform/accessibility/browser/accessibleView.js').AccessibleViewType))).toContain(label);
	}
});

test('loading chat links own a decorative spinner until resolution and respect reduced motion', async ({ page }) => {
	await page.goto('/github.html');
	await page.evaluate(() => window.ashGitHubIntegration.render('[Waiting](https://github.com/team/repo/issues/9)'));
	const link = page.locator('main a[href="https://github.com/team/repo/issues/9"]');
	const spinner = link.locator('.ash-pixel-spinner');
	await expect(link).toHaveAttribute('aria-busy', 'true');
	await expect(spinner).toHaveCount(1);
	await expect(spinner).toBeInViewport();
	await expect(spinner).toHaveAttribute('aria-hidden', 'true');
	await expect(spinner).not.toHaveAttribute('role');
	await link.evaluate(element => element.setAttribute('hidden', ''));
	await expect(spinner).toHaveClass(/paused/);
	await link.evaluate(element => element.removeAttribute('hidden'));
	await expect(spinner).not.toHaveClass(/paused/);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	expect(await spinner.locator('i').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
	await page.evaluate(() => window.ashGitHubIntegration.theme('highContrast'));
	expect(await spinner.evaluate(element => getComputedStyle(element).color === getComputedStyle(element.parentElement!).color)).toBe(true);
	const retainedSpinner = await spinner.elementHandle();
	await page.evaluate(() => window.ashGitHubIntegration.releaseIssue());
	await expect(link).toContainText('Old private issue');
	await expect(link).toHaveAttribute('aria-busy', 'false');
	await expect(spinner).toHaveCount(0);
	expect(await retainedSpinner!.evaluate(element => element.isConnected)).toBe(false);
	await retainedSpinner!.dispose();
});

test('four GitHub resources resolve through the protocol and expose safe keyboard-accessible cards', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
	await page.goto('/github.html');
	const repository = page.locator('main a[href="https://github.com/team/repo"]');
	const issue = page.locator('main a[href="https://github.com/team/repo/issues/7"]');
	const pr = page.locator('main a[href="https://github.com/team/repo/pull/8"]');
	const commit = page.locator('main a[href*="/commit/"]');
	await expect(repository).toHaveText('team/repo');
	await expect(issue).toHaveText('<img src=x onerror=alert(1)> · #7 · team/repo · Open');
	await expect(issue.locator('img')).toHaveCount(0);
	await expect(commit).toHaveText('Improve links · abcdef0 · team/repo · +12 −3');
	await expect(issue).toHaveAccessibleDescription(/Press F2/);
	await page.evaluate(() => window.ashGitHubIntegration.setVerbosity(false));
	await expect(issue).not.toHaveAttribute('aria-description');
	await page.evaluate(() => window.ashGitHubIntegration.setVerbosity(true));
	await expect(issue).toHaveAccessibleDescription(/Press F2/);
	await issue.focus();
	await page.keyboard.press('F2');
	const card = page.locator('.ash-github-resource-hover');
	await expect(card).toBeVisible();
	await expect(card.getByRole('link', { name: 'team/repo', exact: true })).toBeFocused();
	await expect(card.locator('.ash-github-hover-description')).toHaveText(/^Issue details .*…$/);
	await expect(card).toHaveAttribute('data-github-content', /Long description Long description/);
	expect(await page.evaluate(() => window.ashGitHubIntegration.accessibleContent('view' as import('../../../src/ash/platform/accessibility/browser/accessibleView.js').AccessibleViewType))).toContain('Long description '.repeat(30).trim());
	expect(await page.evaluate(() => window.ashGitHubIntegration.accessibleContent('help' as import('../../../src/ash/platform/accessibility/browser/accessibleView.js').AccessibleViewType))).toContain('Escape closes the card');
	await page.keyboard.press('Escape');
	await expect(issue).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashGitHubIntegration.opened)).toEqual(['https://github.com/team/repo/issues/7']);
	await expect(pr).toHaveText('Fix GitHub links · #8 · team/repo · Draft');
	expect(await page.evaluate(() => window.ashGitHubIntegration.requests.filter(request => request.method === 'github/checks').length)).toBe(0);
	await pr.focus();
	await page.keyboard.press('F2');
	await page.keyboard.press('Tab');
	await page.keyboard.press('Tab');
	await expect(card.getByRole('link', { name: 'main', exact: true })).toBeFocused();
	await page.evaluate(() => window.ashGitHubIntegration.releaseChecks());
	await expect(pr).toContainText('Checks passed');
	await expect(card).toHaveAttribute('data-github-content', /main ← feature\/links\nChecks passed/);
	await expect(card.getByRole('link', { name: 'main', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashGitHubIntegration.opened.at(-1))).toBe('https://github.com/contributor/fork/tree/feature%2Flinks');
	await page.keyboard.press('Escape');
	await commit.focus();
	await page.keyboard.press('F2');
	await expect(card).toContainText('Alex');
	await expect(card).toContainText('Commit description');
	await page.evaluate(() => window.ashGitHubIntegration.theme('highContrast'));
	await expect(card.getByRole('link', { name: 'team/repo', exact: true })).toBeFocused();
	expect(await card.getByRole('link', { name: 'team/repo', exact: true }).evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
	await page.keyboard.press('Escape');
	await repository.focus();
	await page.keyboard.press('F2');
	await expect(card).toContainText('Default branch: main');
	await page.evaluate(() => window.ashGitHubIntegration.dispose());
	await expect(card).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('a deleted fork leaves its branch as text while preserving the PR and target branch links', async ({ page }) => {
	await page.goto('/github.html?deletedSource');
	const pr = page.locator('main a[href="https://github.com/team/repo/pull/8"]');
	await expect(pr).toContainText('Draft');
	await pr.focus();
	await page.keyboard.press('F2');
	const card = page.locator('.ash-github-resource-hover');
	await expect(card).toBeVisible();
	await expect(card.getByRole('link', { name: 'feature/links', exact: true })).toHaveCount(0);
	await expect(card.locator('.ash-github-hover-branches')).toHaveText('main←feature/links');
	await expect(card.getByRole('link', { name: 'main', exact: true })).toHaveAttribute('href', 'https://github.com/team/repo/tree/main');
});

test('rerendering duplicate cached links and retiring requests preserves data ownership', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
	await page.goto('/github.html');
	const issue = page.locator('main a[href="https://github.com/team/repo/issues/7"]');
	await expect(issue).toContainText('Open');
	await page.evaluate(() => window.ashGitHubIntegration.render('[One](https://github.com/team/repo/issues/7) [Two](https://github.com/team/repo/issues/7) [Held](https://github.com/team/repo/issues/9)'));
	await expect(issue).toHaveCount(2);
	await expect(issue.nth(0)).toContainText('Open');
	await expect(issue.nth(1)).toContainText('Open');
	await expect.poll(() => page.evaluate(() => window.ashGitHubIntegration.requests.filter(request => request.method === 'github/issue/read' && request.params.number === 9).length)).toBe(1);
	await page.evaluate(() => window.ashGitHubIntegration.render('[Remaining](https://example.org/)'));
	await expect.poll(() => page.evaluate(() => window.ashGitHubIntegration.requests.filter(request => request.method === 'github/cancel').length)).toBeGreaterThan(0);
	await page.evaluate(() => window.ashGitHubIntegration.releaseIssue());
	await expect(page.locator('main')).not.toContainText('Old private issue');
	await expect(page.getByRole('link', { name: 'Remaining' })).toBeVisible();
	expect(errors).toEqual([]);
});

for (const [state, id, label] of [
	['open', 'git-pull-request', 'Open'],
	['draft', 'git-pull-request-draft', 'Draft'],
	['closed', 'git-pull-request-closed', 'Closed'],
	['merged', 'git-pull-request-done', 'Merged'],
] as const) {
	test(`${state} PRs use the same accessible state icon in the chat link and its keyboard details`, async ({ page }) => {
		await page.goto(`/github.html?prState=${state}`);
		const pr = page.locator('main a[href="https://github.com/team/repo/pull/8"]');
		const glyph = pr.locator('svg');
		await expect(pr).toHaveAccessibleName(`Fix GitHub links · #8 · team/repo · ${label}`);
		await expect(glyph).toHaveAttribute('data-ash-icon-id', id);
		await expect(glyph).toHaveAttribute('aria-hidden', 'true');
		await pr.focus();
		await page.keyboard.press('F2');
		const card = page.locator('.ash-github-resource-hover');
		await expect(card.locator('svg')).toHaveAttribute('data-ash-icon-id', id);
		await page.evaluate(() => window.ashGitHubIntegration.releaseChecks('failure'));
		await expect(pr).toContainText('Checks failed');
		const expectedIcon = state === 'open' ? 'git-pull-request-error' : id;
		await expect(pr.locator('svg')).toHaveAttribute('data-ash-icon-id', expectedIcon);
		await expect(card.locator('svg')).toHaveAttribute('data-ash-icon-id', expectedIcon);
		await expect(card.getByRole('link', { name: 'team/repo', exact: true })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(pr).toBeFocused();
		for (const theme of ['light', 'highContrast'] as const) {
			await page.evaluate(theme => window.ashGitHubIntegration.theme(theme), theme);
			expect(await pr.locator('svg').evaluate(element => getComputedStyle(element).color)).not.toBe('rgba(0, 0, 0, 0)');
			await expect(pr.locator('svg')).toHaveAttribute('data-ash-icon-id', expectedIcon);
		}
		const retainedAnchor = await pr.elementHandle();
		await page.evaluate(() => window.ashGitHubIntegration.dispose());
		await expect(pr).toHaveCount(0);
		expect(await retainedAnchor!.evaluate(element => ({ text: element.textContent, icons: element.querySelectorAll('svg').length }))).toEqual({ text: 'PR', icons: 0 });
		await retainedAnchor!.dispose();
	});
}

test('a failed CI check remains visible while another check is pending', async ({ page }) => {
	await page.goto('/github.html?prState=open');
	const pr = page.locator('main a[href="https://github.com/team/repo/pull/8"]');
	await expect(pr).toContainText('Open');
	await pr.focus();
	await page.keyboard.press('F2');
	await page.evaluate(() => window.ashGitHubIntegration.releaseChecks('mixed'));
	await expect(pr).toContainText('Checks failed');
	await expect(pr.locator('svg')).toHaveAttribute('data-ash-icon-id', 'git-pull-request-error');
});

test('Cowork uses the same PR icon and preserves keyboard focus when checks resolve', async ({ page }) => {
	await page.goto('/github.html?cowork&prState=open');
	const pr = page.locator('.cowork-test-message a');
	await expect(pr.locator('svg[data-ash-icon-id="git-pull-request"]')).toHaveCount(1);
	await pr.focus();
	await page.keyboard.press('F2');
	await page.evaluate(() => window.ashGitHubIntegration.releaseChecks('failure'));
	await expect(pr.locator('svg[data-ash-icon-id="git-pull-request-error"]')).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(pr).toBeFocused();
	await expect(pr.locator('svg')).toHaveAttribute('aria-hidden', 'true');
});

test('merge conflicts are readable in both chat links and keyboard details', async ({ page }) => {
	await page.goto('/github.html?cowork&prState=open&conflicts');
	for (const pr of [page.locator('main a[href="https://github.com/team/repo/pull/8"]').first(), page.locator('.cowork-test-message a')]) {
		await expect(pr).toHaveAccessibleName(/Open · Merge conflicts/);
		await expect(pr.locator('svg')).toHaveAttribute('data-ash-icon-id', 'git-pull-request-error');
		await pr.focus();
		await page.keyboard.press('F2');
		const card = page.locator('.ash-github-resource-hover');
		await expect(card).toHaveAttribute('data-github-content', /Merge conflicts/);
		await expect(card.locator('svg')).toHaveAttribute('data-ash-icon-id', 'git-pull-request-error');
		await page.keyboard.press('Escape');
		await expect(pr).toBeFocused();
	}
});

test('Chinese PR attention text reaches the chat link and its details', async ({ page }) => {
	await page.goto('/github.html?prState=open&conflicts&locale=zh-CN');
	const pr = page.locator('main a[href="https://github.com/team/repo/pull/8"]');
	await expect(pr).toHaveAccessibleName(/合并冲突/);
	await pr.focus();
	await page.keyboard.press('F2');
	await expect(page.locator('.ash-github-resource-hover')).toHaveAttribute('data-github-content', /合并冲突/);
});
