import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/scmHistory.html');
	await expect.poll(async () => ({ mounted: await page.getByRole('treeitem', { name: /History metadata:/u }).count(), errors })).toEqual({ mounted: 1, errors: [] });
});

test('history rows retain identity and reserve title width when the pane resizes', async ({ page }) => {
	const commit = page.getByRole('treeitem', { name: /History metadata:/u });
	const retainedCommit = await commit.elementHandle();
	const retainedActions = await commit.locator('.ash-scm-graph-actions').elementHandle();
	for (const width of [280, 560]) {
		await page.evaluate(width => window.ashSCMHistoryIntegration.resize(width), width);
		expect(await retainedCommit!.evaluate(element => element.isConnected)).toBe(true);
		expect(await retainedActions!.evaluate(element => element.isConnected)).toBe(true);
		await expect(commit.locator('.ash-scm-graph-metadata')).toHaveCount(0);
		const geometry = await commit.evaluate(element => {
			const graph = element.querySelector('.ash-scm-graph-graph')!.getBoundingClientRect();
			const title = element.querySelector('.ash-scm-graph-subject')!.getBoundingClientRect();
			const row = element.querySelector('.ash-scm-graph-row')!.getBoundingClientRect();
			return { left: title.left - graph.right, right: row.right - title.right };
		});
		expect(geometry.left).toBeCloseTo(0, 1);
		expect(geometry.right).toBeCloseTo(8, 1);
	}
	await commit.locator('.ash-scm-graph-row').hover({ position: { x: 80, y: 10 } });
	const overlay = commit.locator('.ash-scm-graph-overlay');
	await expect(overlay.locator('.ash-scm-graph-actions')).toBeVisible();
	const fade = await overlay.evaluate(element => {
		const style = getComputedStyle(element, '::before');
		return { mask: style.maskImage, opacity: style.opacity, pointerEvents: style.pointerEvents };
	});
	expect(fade).toMatchObject({ opacity: '1', pointerEvents: 'none' });
	expect(fade.mask).toContain('linear-gradient');
	await test.info().attach('scm-history-row-overlay', { body: await commit.screenshot(), contentType: 'image/png' });
	await retainedCommit?.dispose();
	await retainedActions?.dispose();
});

test('commit details preserve whitespace, metadata, scrolling and long-title geometry', async ({ page }) => {
	const { hash, timestamp, subject, message: body } = await page.evaluate(() => window.ashSCMHistoryIntegration);
	const commit = page.getByRole('treeitem', { name: /History metadata:/u });
	const hover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
	await commit.locator('.ash-scm-graph-subject').hover({ position: { x: 3, y: 8 } });
	await expect(hover.locator('.ash-scm-graph-hover-subject')).toHaveText(subject);
	await expect(hover.locator('.ash-scm-graph-hover-author > span')).toHaveText('History Author');
	await expect(hover.locator('.ash-scm-graph-hover-author > span')).toHaveAttribute('title', 'history@example.invalid');
	await expect(hover.locator('time')).toHaveAttribute('datetime', new Date(Number(timestamp) * 1000).toISOString());
	await expect(hover.locator('.ash-scm-graph-hover-message')).toHaveText(body);
	expect(await hover.locator('.ash-scm-graph-hover-message').textContent()).toBe(body);
	const messageScroll = hover.getByRole('region', { name: 'Commit message', exact: true });
	const messageViewport = messageScroll.locator('.ash-scrollbar-viewport');
	await expect(messageScroll).toHaveCSS('height', '180px');
	await expect(messageViewport).toHaveCSS('scrollbar-width', 'none');
	await messageScroll.focus();
	await expect(messageScroll.locator('.ash-scrollbar-track-vertical')).toHaveAttribute('data-visibility', 'auto');
	await messageViewport.hover();
	await expect(messageScroll.locator('.ash-scrollbar-track-vertical')).toHaveCSS('opacity', '1');
	await messageScroll.press('End');
	await expect.poll(() => messageViewport.evaluate(element => element.scrollTop > 0 && Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1)).toBe(true);
	await messageScroll.press('Home');
	await expect.poll(() => messageViewport.evaluate(element => element.scrollTop)).toBe(0);
	await messageViewport.hover();
	await page.mouse.wheel(0, 160);
	await expect.poll(() => messageViewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await expect(hover.locator('.ash-scm-graph-hover-statistics > span')).toHaveText(['2 files changed', '2 insertions(+)', '0 deletions(-)']);
	await expect(hover.locator('.ash-scm-graph-hover-hash')).toHaveAttribute('title', hash);
	await expect(hover.getByRole('group', { name: 'History references', exact: true })).toContainText('metadata-topic');
	await expect(hover.getByRole('group', { name: 'History references', exact: true })).toContainText('metadata-v1');
	const contentGeometry = await hover.evaluate(element => {
		const tooltip = element.closest<HTMLElement>('.ash-hover')!;
		const bounds = tooltip.getBoundingClientRect();
		const range = element.ownerDocument.createRange();
		range.selectNodeContents(element.querySelector('.ash-scm-graph-hover-subject')!);
		return {
			horizontalOverflow: tooltip.scrollWidth > tooltip.clientWidth,
			fullTitleInsideCard: [...range.getClientRects()].every(rect => rect.left >= bounds.left && rect.right <= bounds.right),
		};
	});
	expect(contentGeometry).toEqual({ horizontalOverflow: false, fullTitleInsideCard: true });
	const openOnGitHub = hover.getByRole('button', { name: 'Open on GitHub', exact: true });
	await expect(openOnGitHub).toBeVisible();
	await expect(openOnGitHub).toHaveText('Open on GitHub');
	await expect(openOnGitHub.locator('.ash-icon')).toHaveAttribute('aria-hidden', 'true');
	await test.info().attach('scm-history-hover', { body: await hover.screenshot(), contentType: 'image/png' });
});

test('slow pointer movement and action tooltip delays retain the details card', async ({ page }) => {
	const commit = page.getByRole('treeitem', { name: /History metadata:/u });
	const hover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
	await commit.locator('.ash-scm-graph-subject').hover({ position: { x: 3, y: 8 } });
	await expect(hover).toBeVisible();
	const pointerCopy = hover.getByRole('button', { name: 'Copy Commit Hash', exact: true });
	const hoverId = await hover.getAttribute('id');
	const commitBounds = (await commit.boundingBox())!;
	const hoverBounds = (await hover.boundingBox())!;
	expect(hoverBounds.x).toBeGreaterThan(commitBounds.x + commitBounds.width);
	await page.mouse.move((commitBounds.x + commitBounds.width + hoverBounds.x) / 2, commitBounds.y + commitBounds.height / 2);
	// A deliberate pause in the gap reproduces a slow move from the row to its actions.
	await page.waitForTimeout(150);
	await expect(hover).toHaveAttribute('id', hoverId!);
	await pointerCopy.hover();
	// Hold past the action-tooltip delay to detect replacement of the details card.
	await page.waitForTimeout(700);
	await expect(hover).toHaveAttribute('id', hoverId!);
	await hover.getByRole('button', { name: 'Open on GitHub', exact: true }).hover();
	await page.waitForTimeout(700);
	await expect(hover).toHaveAttribute('id', hoverId!);
	await page.locator('#outside').click();
	await expect(hover).toHaveCount(0);
	await commit.focus();
	await expect(hover).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(hover).toHaveCount(0);
});

test('commit message focus and scrollbars follow all four color themes', async ({ page }) => {
	const commit = page.getByRole('treeitem', { name: /History metadata:/u });
	const hover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
	await commit.focus();
	await commit.press('Alt+ArrowDown');
	const messageScroll = hover.getByRole('region', { name: 'Commit message', exact: true });
	for (let theme = 0; theme < 4; theme++) {
		await page.evaluate(index => window.ashSCMHistoryIntegration.setTheme(index), theme);
		await commit.focus();
		await commit.press('Alt+ArrowDown');
		await messageScroll.focus();
		await messageScroll.press('Home');
		await expect(messageScroll).toHaveCSS('outline-style', 'solid');
		const thumb = messageScroll.locator('.ash-scrollbar-track-vertical > .ash-scrollbar-thumb');
		await expect(thumb).toBeVisible();
		expect(await thumb.evaluate(element => {
			const probe = document.createElement('span');
			probe.style.backgroundColor = 'var(--ash-scrollbarSlider-background)';
			element.append(probe);
			const color = getComputedStyle(element).backgroundColor;
			const themed = color === getComputedStyle(probe).backgroundColor && color !== 'rgba(0, 0, 0, 0)';
			probe.remove();
			return themed;
		})).toBe(true);
		await test.info().attach(`scm-history-${theme}`, { body: await hover.screenshot(), contentType: 'image/png' });
		await page.keyboard.press('Escape');
		await expect(commit).toBeFocused();
	}
});

test('Chinese history hover labels and narrow viewports preserve complete details', async ({ page }) => {
	const { hash, subject } = await page.evaluate(() => window.ashSCMHistoryIntegration);
	await page.goto('/scmHistory.html?locale=zh-CN');
	const localizedHistory = page.locator('[data-view-id="fixture.history"]');
	const localizedCommit = page.getByRole('treeitem', { name: /History metadata:/u });
	await localizedCommit.focus();
	await localizedCommit.press('Alt+ArrowDown');
	const localizedHover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
	await expect(localizedHover.getByRole('button', { name: '复制提交哈希', exact: true })).toHaveText('');
	await expect(localizedHover.getByRole('button', { name: `打开提交 ${hash.slice(0, 7)}`, exact: true })).toBeVisible();
	await expect(localizedHistory.locator('[data-action-id="workbench.scm.action.graph.revealCurrentHistoryItem"] > button')).toHaveAttribute('aria-label', '转到当前历史记录项');
	await expect(localizedHover.getByRole('button', { name: '在 GitHub 上打开', exact: true })).toHaveText('在 GitHub 上打开');
	await expect(localizedHover.getByRole('region', { name: '提交消息', exact: true })).toHaveCSS('height', '180px');
	await page.keyboard.press('Escape');
	await page.mouse.move(900, 100);
	for (const width of [1100, 640, 360]) {
		await page.setViewportSize({ width, height: 820 });
		await page.evaluate(width => window.ashSCMHistoryIntegration.resize(Math.min(width, 560)), width);
		await localizedCommit.focus();
		await localizedCommit.press('Alt+ArrowDown');
		await expect(localizedHover).toBeVisible();
		await expect.poll(() => localizedHover.evaluate(element => {
			const tooltip = element.closest<HTMLElement>('.ash-hover')!;
			const bounds = tooltip.getBoundingClientRect();
			return {
				horizontalOverflow: tooltip.scrollWidth > tooltip.clientWidth,
				insideWindow: bounds.left >= 0 && bounds.right <= element.ownerDocument.defaultView!.innerWidth,
			};
		})).toEqual({ horizontalOverflow: false, insideWindow: true });
		await expect(localizedHover.locator('.ash-scm-graph-hover-subject')).toHaveText(subject);
	}
});
