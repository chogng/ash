import type { ElectronApplication } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);


test.use({ gitRepository: true });

test('SCM activation focuses its input or selected resource without outlining the whole pane', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench }) => {
	await writeFile(testWorkspace.file, 'const changed = true;\n');
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const pane = page.locator('[data-view-id="ash.gitView"]');
	const input = pane.locator('.ash-scm-input .stanza-editor-input');
	await expect(input).toBeFocused();
	await expect(pane).toHaveCSS('outline-style', 'none');
	await expect(pane.locator('.ash-scm-input')).toHaveCSS('outline-style', 'solid');
	const tree = pane.getByRole('tree', { name: 'Source control changes' });
	await expect(tree.getByRole('treeitem').filter({ hasText: 'main.ts' })).toBeVisible();
	await tree.focus();
	await tree.press('Home');
	const resource = await tree.getAttribute('aria-activedescendant');
	expect(resource).toBeTruthy();
	await page.getByRole('tab', { name: /^Explorer(?:,|$)/u }).click();
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	await expect(tree).toBeFocused();
	await expect(tree).toHaveAttribute('aria-activedescendant', resource!);
	await expect(pane).toHaveCSS('outline-style', 'none');
	await expect(tree.locator('.ash-tree-row.focused')).toHaveCSS('outline-style', 'solid');
});

test('SCM history retains the reading position, expanded files and row actions after a commit', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench }) => {
	const cwd = testWorkspace.directory;
	const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd });
	const commits = Array.from({ length: 80 }, (_, index) => {
		const message = `Retained history ${index}`;
		return `commit refs/heads/main\nmark :${index + 1}\ncommitter History Author <history@example.invalid> ${1_700_000_000 + index} +0000\ndata ${message.length}\n${message}\nfrom ${index === 0 ? stdout.trim() : `:${index}`}\n\n`;
	}).join('');
	await new Promise<void>((resolve, reject) => {
		const importer = execFile('git', ['fast-import', '--quiet'], { cwd }, error => error ? reject(error) : resolve());
		importer.stdin!.end(commits);
	});
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	await history.locator('[data-action-id="workbench.scm.action.graph.refresh"] > button').click();
	const graph = history.locator('.ash-scm-graph');
	const viewport = graph.locator('.ash-scrollbar-viewport');
	await expect(graph.getByRole('treeitem').first()).toContainText('Retained history 79');
	await viewport.evaluate(element => { element.scrollTop = 35 * 22; });
	const row = graph.getByRole('treeitem').filter({ hasText: 'Retained history 44' });
	await expect(row).toHaveAttribute('aria-setsize', '81');
	await page.mouse.move(900, 100);
	await row.focus();
	await row.press('Enter');
	await expect(row.locator('.ash-scm-graph-change-state')).toHaveText('No changed files.');
	await expect(row).toHaveAttribute('aria-selected', 'true');
	const retained = await row.elementHandle();
	const actions = await row.locator('.ash-scm-graph-actions').elementHandle();
	const originalViewport = await viewport.elementHandle();
	const position = (await row.boundingBox())!.y;
	try {
		await run('git', ['commit', '--allow-empty', '-m', 'Commit without resetting history'], { cwd });
		await expect(row).toHaveAttribute('aria-setsize', '82');
		expect(await retained!.evaluate(element => element.isConnected)).toBe(true);
		expect(await actions!.evaluate(element => element.isConnected)).toBe(true);
		expect(await originalViewport!.evaluate(element => element.isConnected)).toBe(true);
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await expect(row).toBeFocused();
		expect((await row.boundingBox())!.y).toBeCloseTo(position, 0);
		await expect(row).toHaveAttribute('aria-selected', 'true');
		await history.locator('[data-action-id="workbench.scm.action.graph.refresh"] > button').click();
		await expect(graph).toHaveAttribute('aria-busy', 'false');
		await expect(row).toHaveAttribute('aria-selected', 'true');
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		expect((await row.boundingBox())!.y).toBeCloseTo(position, 0);
		await row.focus();
		const parent = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
		const prefix = Array.from({ length: 65 }, (_, index) => {
			const message = `Batch refresh ${index}`;
			return `commit refs/heads/main\nmark :${index + 1}\ncommitter History Author <history@example.invalid> ${1_800_000_000 + index} +0000\ndata ${message.length}\n${message}\nfrom ${index === 0 ? parent : `:${index}`}\n\n`;
		}).join('');
		await new Promise<void>((resolve, reject) => {
			const importer = execFile('git', ['fast-import', '--quiet'], { cwd }, error => error ? reject(error) : resolve());
			importer.stdin!.end(prefix);
		});
		await expect(row).toHaveAttribute('aria-setsize', '147');
		await expect(row).toHaveAttribute('aria-selected', 'true');
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await expect(row).toBeFocused();
		expect((await row.boundingBox())!.y).toBeCloseTo(position, 0);
		await expect(graph.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(1);

		await viewport.evaluate(element => { element.scrollTop = 0; });
		await expect(graph.getByRole('treeitem').first()).toContainText('Batch refresh 64');
		await expect(graph.locator('.ash-scm-graph-commit.current .ash-scm-graph-label.head')).toHaveText('main');
		await expect(graph.locator('.ash-scm-graph-label.head')).toHaveCount(1);
		const current = graph.getByRole('treeitem').filter({ hasText: 'Batch refresh 64' });
		await current.focus();
		await current.press('ArrowDown');
		const next = graph.getByRole('treeitem').filter({ hasText: 'Batch refresh 63' });
		await expect(next).toBeFocused();
		await next.press('PageDown');
		expect(await graph.locator('.ash-scm-graph-commit:focus').getAttribute('aria-posinset')).not.toBe('2');
		await page.keyboard.press('End');
		await expect(graph.locator('.ash-scm-graph-commit:focus')).toHaveAttribute('aria-posinset', '147');
		await history.locator('[data-action-id="workbench.scm.action.graph.revealCurrentHistoryItem"] > button').click();
		await expect(current).toBeFocused();
		await expect(current).toHaveAttribute('aria-selected', 'true');
		await next.locator('.ash-scm-graph-subject').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'], position: { x: 4, y: 10 } });
		await expect(next).toHaveAttribute('aria-selected', 'true');
		await expect(current).toHaveAttribute('aria-selected', 'false');
		await current.locator('.ash-scm-graph-subject').click({ modifiers: ['Shift'], position: { x: 4, y: 10 } });
		await expect(current).toHaveAttribute('aria-selected', 'true');
		await expect(next).toHaveAttribute('aria-selected', 'false');
		await expect(graph.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(1);
		expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
		await page.mouse.move(900, 100);
		await current.focus();
		await expect(current.locator(':scope > .ash-scm-graph-row')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await history.screenshot({ path: test.info().outputPath('scm-history-retained-selection.png') });
		await test.info().attach('scm-history-retained-selection', { path: test.info().outputPath('scm-history-retained-selection.png'), contentType: 'image/png' });
		await current.press('ArrowRight');
		await expect(current).toHaveAttribute('aria-expanded', 'true');
		await current.press('ArrowLeft');
		await expect(current).toHaveAttribute('aria-expanded', 'false');
	} finally {
		await retained?.dispose();
		await actions?.dispose();
		await originalViewport?.dispose();
	}
});

test('SCM history respects saved page size and manual loading settings', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench, reloadWorkbench }) => {
	const cwd = testWorkspace.directory;
	const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd });
	const commits = Array.from({ length: 20 }, (_, index) => {
		const message = `Configured history ${index}`;
		return `commit refs/heads/main\nmark :${index + 1}\ncommitter History Author <history@example.invalid> ${1_700_000_000 + index} +0000\ndata ${message.length}\n${message}\nfrom ${index === 0 ? stdout.trim() : `:${index}`}\n\n`;
	}).join('');
	await new Promise<void>((resolve, reject) => {
		const importer = execFile('git', ['fast-import', '--quiet'], { cwd }, error => error ? reject(error) : resolve());
		importer.stdin!.end(commits);
	});
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = workbench.settingsEditor.element;
	await settings.getByRole('searchbox').fill('scm.graph');
	const size = settings.locator('[data-settings-item-id="scm.graph.pageSize"]').getByRole('spinbutton');
	await expect(size).toHaveValue('50');
	await size.fill('3');
	await size.press('Tab');
	await expect(size).toHaveValue('3');
	const automatic = settings.locator('[data-settings-item-id="scm.graph.pageOnScroll"]').getByRole('switch');
	await expect(automatic).toHaveAttribute('aria-checked', 'true');
	await automatic.press('Space');
	await expect(automatic).toHaveAttribute('aria-checked', 'false');
	await settings.locator('.ash-modal-editor-close').click();
	({ workbench } = await reloadWorkbench());
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	const rows = history.getByRole('treeitem');
	await expect(rows.first()).toHaveAttribute('aria-setsize', '3');
	const more = history.getByRole('button', { name: 'Load more commits', exact: true });
	await expect(more).toBeVisible();
	await more.click();
	await expect(rows.first()).toHaveAttribute('aria-setsize', '6');
	await expect(more).toBeVisible();
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.element.getByRole('searchbox').fill('scm.graph');
	await expect(workbench.settingsEditor.element.locator('[data-settings-item-id="scm.graph.pageSize"]').getByRole('spinbutton')).toHaveValue('3');
	await workbench.settingsEditor.element.locator('[data-settings-item-id="scm.graph.pageOnScroll"] .ash-switch-track').click();
	await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	await expect.poll(async () => Number(await rows.first().getAttribute('aria-setsize'))).toBeGreaterThan(6);
	await history.locator('.ash-scm-graph .ash-scrollbar-viewport').evaluate(element => { element.scrollTop = element.scrollHeight; });
	await expect(rows.first()).toHaveAttribute('aria-setsize', '21');
	await expect(more).toHaveCount(0);
	await test.info().attach('scm-history-configured-pages', { body: await history.screenshot(), contentType: 'image/png' });
});

test('SCM startup keeps commit hover targets stable in a large history', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench, reloadWorkbench }) => {
	const cwd = testWorkspace.directory;
	const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd });
	const commits = Array.from({ length: 2000 }, (_, index) => {
		const message = `Startup history ${index}`;
		return `commit refs/heads/main\nmark :${index + 1}\ncommitter History Author <history@example.invalid> ${1_700_000_000 + index} +0000\ndata ${message.length}\n${message}\nfrom ${index === 0 ? stdout.trim() : `:${index}`}\n\n`;
	}).join('');
	await new Promise<void>((resolve, reject) => {
		const importer = execFile('git', ['fast-import', '--quiet'], { cwd }, error => error ? reject(error) : resolve());
		importer.stdin!.end(commits);
	});
	const restarted = await reloadWorkbench();
	const page = restarted.workbench.page;
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	const graph = history.locator('.ash-scm-graph');
	const viewport = graph.locator('.ash-scrollbar-viewport');
	await expect(graph).toHaveAttribute('aria-busy', 'false');
	const row = graph.getByRole('treeitem').filter({ hasText: 'Startup history 1997' });
	await expect(row).toHaveAttribute('aria-setsize', '50');
	const original = await row.elementHandle();
	try {
		await row.locator('.ash-scm-graph-subject').hover({ position: { x: 3, y: 8 } });
		const tooltip = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
		await expect(tooltip.locator('.ash-scm-graph-hover-subject')).toHaveText('Startup history 1997');
		await expect(tooltip.locator('.ash-scm-graph-hover-author > span')).toHaveText('History Author');
		await expect(row).toHaveAttribute('aria-describedby', (await tooltip.getAttribute('id'))!);
		await restarted.workbench.waitForUiIdle();
		expect(await original!.evaluate(element => element.isConnected)).toBe(true);
		await expect(row).toHaveAttribute('aria-setsize', '50');
		await expect(tooltip).toBeVisible();
		await page.getByRole('tab', { name: /^Explorer(?:,|$)/u }).hover();
		await expect(tooltip).toHaveCount(0);
	} finally {
		await original?.dispose();
	}
	await page.keyboard.press('Escape');
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	// Keep the pointer outside the graph so viewport changes do not hover another commit.
	await page.mouse.move(900, 100);
	await row.focus();
	await page.keyboard.press('Alt+ArrowDown');
	const tooltip = page.getByRole('tooltip');
	const tooltipId = await tooltip.getAttribute('id');
	const copy = tooltip.getByRole('button', { name: 'Copy Commit Hash', exact: true });
	await expect(copy).toBeFocused();
	await page.keyboard.press('Tab');
	expect(await tooltip.evaluate(element => element.contains(document.activeElement))).toBe(true);
	await page.keyboard.press('Shift+Tab');
	await expect(copy).toBeFocused();
	const retainedRow = await row.elementHandle();
	const retainedToolbar = await row.locator('.ash-scm-graph-actions').elementHandle();
	try {
		if (target.kind === 'electron') {
			const window = await (restarted.application as ElectronApplication).browserWindow(page);
			try { await window.evaluate(window => window.setSize(1100, 820)); }
			finally { await window.dispose(); }
		} else {
			await page.setViewportSize({ width: 1100, height: 820 });
		}
		await restarted.workbench.waitForUiIdle();
		await expect(tooltip).toHaveAttribute('id', tooltipId!);
		await expect(copy).toBeFocused();
		await viewport.evaluate(element => { element.scrollTop = 22; });
		await restarted.workbench.waitForUiIdle();
		expect(await retainedRow!.evaluate(element => element.isConnected)).toBe(true);
		expect(await retainedToolbar!.evaluate(element => element.isConnected)).toBe(true);
		await expect(tooltip).toHaveAttribute('id', tooltipId!);
		await expect(copy).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(row).toBeFocused();
		await row.press('Enter');
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await expect(row.locator('.ash-scm-graph-change-state')).toHaveText('No changed files.');
		expect(await retainedRow!.evaluate(element => element.isConnected)).toBe(true);
		expect(await retainedToolbar!.evaluate(element => element.isConnected)).toBe(true);
		await expect(row).toBeFocused();
		await row.press('Enter');
		await expect(row).toHaveAttribute('aria-expanded', 'false');
	} finally {
		await retainedRow?.dispose();
		await retainedToolbar?.dispose();
	}
	await page.keyboard.press('Escape');
	await expect(row).toBeFocused();

	// Keep an overlapping commit's focused actions attached while prefetch appends another page.
	await viewport.evaluate(element => { element.scrollTop = 50 * 22 - element.clientHeight - 260; });
	const paginationRow = graph.getByRole('treeitem').filter({ hasText: 'Startup history 1960' });
	await paginationRow.focus();
	await expect(paginationRow).toHaveAttribute('aria-setsize', '50');
	await paginationRow.press('Alt+ArrowDown');
	const paginationTooltip = page.getByRole('tooltip');
	const paginationTooltipId = await paginationTooltip.getAttribute('id');
	const paginationCopy = paginationTooltip.getByRole('button', { name: 'Copy Commit Hash', exact: true });
	await expect(paginationCopy).toBeFocused();
	const paginationActions = await paginationRow.locator('.ash-scm-graph-actions').elementHandle();
	try {
		// Prefetch while several commits remain below the viewport.
		await viewport.evaluate(element => { element.scrollTop = 50 * 22 - element.clientHeight - 120; });
		await expect(paginationRow).toHaveAttribute('aria-setsize', '100');
		expect(await paginationActions!.evaluate(element => element.isConnected)).toBe(true);
		await expect(paginationTooltip).toHaveAttribute('id', paginationTooltipId!);
		await expect(paginationCopy).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(paginationRow).toBeFocused();
	} finally { await paginationActions?.dispose(); }
	await viewport.evaluate(element => { element.scrollTop = 50 * 22 - element.clientHeight; });
	await expect(row).toHaveCount(0);
	await expect(graph.getByRole('treeitem').first()).toHaveAttribute('aria-setsize', '100');
	await expect(graph).toHaveAttribute('aria-busy', 'false');
	for (const scrollTop of [700, 22, 900, 400, 0]) {
		await viewport.evaluate((element, scrollTop) => { element.scrollTop = scrollTop; }, scrollTop);
		await restarted.workbench.waitForUiIdle();
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(scrollTop);
		const coverage = await viewport.evaluate(element => {
			const bounds = element.getBoundingClientRect();
			const rows = [...element.querySelectorAll('.ash-scm-graph-commit')].map(row => row.getBoundingClientRect());
			return { topCovered: rows.some(row => row.top <= bounds.top + 3 && row.bottom > bounds.top + 3), bottomCovered: rows.some(row => row.top < bounds.bottom - 10 && row.bottom >= bounds.bottom - 10) };
		});
		expect(coverage).toEqual({ topCovered: true, bottomCovered: true });
	}
	// Cached rows must release their active hover when ListView takes them out of the render range.
	await row.focus();
	await row.press('Alt+ArrowDown');
	await expect(page.getByRole('tooltip').getByRole('button', { name: 'Copy Commit Hash', exact: true })).toBeFocused();
	await viewport.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight; });
	await expect(row).toHaveCount(0);
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	expect(await graph.getByRole('treeitem').count()).toBeLessThan(100);

});

test('SCM history connects repeated merge parents back to the main lane', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, reloadWorkbench }) => {
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]): Promise<string> => (await run('git', args, { cwd })).stdout.trim();
	const root = await git('rev-parse', 'HEAD');
	const tree = await git('rev-parse', 'HEAD^{tree}');
	const createCommit = async (subject: string, parents: readonly string[]): Promise<string> => git('commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', subject);
	const base = await createCommit('Shared branch base', [root]);
	const main = await createCommit('Main lane commit', [base]);
	const merge = await createCommit('Inner merge commit', [main, base]);
	const tip = await createCommit('Outer merge commit', [merge, base]);
	await git('update-ref', 'refs/heads/main', tip);
	const restarted = await reloadWorkbench();
	const page = restarted.workbench.page;
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	const inner = history.getByRole('treeitem').filter({ hasText: 'Inner merge commit' });
	await expect(inner).toBeVisible();
	await expect(inner.locator('path[d$="33 22"]')).toHaveCount(1);
	const shared = history.getByRole('treeitem').filter({ hasText: 'Shared branch base' });
	await expect(shared.locator('path[d$="H 11"]')).toHaveCount(2);
	await expect(shared.locator('.ash-scm-graph-node')).toHaveAttribute('cx', '11');
});

test('SCM history shows Git commits and opens file and multi-file comparisons', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench }) => {

	const cwd = testWorkspace.directory;
	await run('git', ['remote', 'add', 'origin', 'https://github.com/ash-test/history.git'], { cwd });
	await run('git', ['branch', 'topic'], { cwd });
	await run('git', ['branch', 'feature'], { cwd });
	await run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd });
	await run('git', ['update-ref', 'refs/remotes/origin/release', 'HEAD'], { cwd });
	const page = workbench.page;
	if (target.kind === 'electron' && process.platform === 'darwin') {
		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		const settings = page.getByRole('dialog', { name: 'Ash Settings' });
		await settings.locator('[data-settings-group-id="workbench"]').click();
		await settings.locator('[data-settings-category-id="layout"]').click();
		await settings.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Custom', exact: true }).click();
		await settings.locator('.ash-modal-editor-close').click();
	}
	await workbench.git.setHistoryBadges('All references');
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await expect(history).toBeVisible();
	await history.locator('.ash-pane-view-header').click();
	await history.locator('[data-action-id="workbench.scm.action.graph.refresh"] > button').click();
	const commit = history.getByRole('treeitem', { name: /Initial/ });
	await expect(commit).toBeVisible();
	await expect(history.locator('.ash-scm-graph-remotes')).toHaveCount(0);
	const head = commit.locator('.ash-scm-graph-label.head');
	await expect(head).toHaveText('main');
	await expect(head).toHaveAttribute('aria-label', 'main');
	await expect(head).toHaveCSS('height', '18px');
	await expect(head).toHaveCSS('border-radius', '9999px');
	await expect(head.locator('.ash-scm-graph-label-name')).toHaveCSS('max-width', '100px');
	await expect(commit.locator('.ash-scm-graph-label.remote')).toHaveText('2');
	await expect(commit.locator('.ash-scm-graph-label.remote')).toHaveAttribute('aria-label', 'origin/main, origin/release');
	await expect(commit.locator('.ash-scm-graph-label.local')).toHaveText('2');
	await expect(commit.locator('.ash-scm-graph-label-container')).toHaveCSS('flex-shrink', '0');
	await expect(commit.locator('.ash-scm-graph-label .ash-icon').first()).toHaveCSS('width', '12px');
	const geometry = await commit.evaluate(element => {
		const subject = element.querySelector('.ash-scm-graph-subject')!.getBoundingClientRect();
		const badges = element.querySelector('.ash-scm-graph-label-container')!.getBoundingClientRect();
		const graph = element.querySelector('.ash-scm-graph-graph')!.getBoundingClientRect();
		const row = element.querySelector('.ash-scm-graph-row')!.getBoundingClientRect();
		return { subjectVisible: subject.width > 0, badgesWithinRow: badges.left >= graph.right && badges.right <= row.right };
	});
	expect(geometry).toEqual({ subjectVisible: true, badgesWithinRow: true });
	await expect(commit.locator('.ash-scm-graph-label .ash-icon').first()).toHaveAttribute('aria-hidden', 'true');
	await expect(commit).toHaveAttribute('aria-current', 'true');
	for (const theme of ['Ash Dark', 'Ash Light', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		await workbench.quickaccess.select(theme);
		if (theme.includes('High Contrast')) {
			await expect(commit.locator('.ash-scm-graph-label').first()).toHaveCSS('outline-style', 'solid');
		}
		const colors = await commit.locator('.ash-scm-graph-label').evaluateAll(elements => elements.map(element => {
			const style = getComputedStyle(element);
			return { foreground: style.color, background: style.backgroundColor, outline: style.outlineStyle };
		}));
		for (const badge of colors) {
			expect(badge.foreground).not.toBe(badge.background);
			expect(badge.background).not.toBe('rgba(0, 0, 0, 0)');
			if (theme.includes('High Contrast')) {
				expect(badge.outline).toBe('solid');
			}
		}
	}
	await run('git', ['update-ref', '-d', 'refs/remotes/origin/release'], { cwd });
	const branchName = 'work/a-long-current-branch-name';
	await run('git', ['branch', '-m', branchName], { cwd });
	await history.locator('[data-action-id="workbench.scm.action.graph.refresh"] > button').click();
	await expect(head).toHaveText(branchName);
	await expect(head).toHaveAttribute('aria-label', branchName);
	await expect(head.locator('.ash-scm-graph-label-name')).toHaveCSS('width', '100px');
	await expect(head.locator('.ash-scm-graph-label-name')).toHaveCSS('text-overflow', 'ellipsis');
	await expect(commit.locator('.ash-scm-graph-label.remote')).toHaveText('');
	await expect(commit.locator('.ash-scm-graph-label.remote')).toHaveAttribute('aria-label', 'origin/main');
	await head.hover();
	await expect(page.locator('.ash-hover')).toContainText(branchName);
	await commit.focus();
	await page.keyboard.press('Enter');
	const changedFile = commit.getByRole('button', { name: /main\.ts/ });
	await expect(changedFile).toBeVisible();
	await changedFile.click();
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
	const openChanges = commit.getByRole('button', { name: 'Open Changes', exact: true });
	await openChanges.focus();
	await expect(commit.locator('.ash-scm-graph-actions')).toBeVisible();
	await openChanges.press('Enter');
	await expect(commit).toHaveAttribute('aria-expanded', 'true');

	const comparisons = page.locator('.stanza-multi-diff-editor:visible');
	await expect(comparisons).toBeVisible();
	const toolbar = page.locator('.stanza-multi-diff-editor-pane:visible .stanza-multi-diff-editor-repository-toolbar');
	await expect(toolbar.getByRole('button', { name: 'Commit', exact: true })).toHaveCount(0);
	await expect(toolbar).toHaveCount(0);
	await expect(comparisons.getByRole('button', { name: 'Stage All', exact: true })).toHaveCount(0);
	await expect(comparisons.getByRole('button', { name: 'Discard All', exact: true })).toHaveCount(0);
	await expect(comparisons.locator('.stanza-multi-diff-editor-title')).toHaveText(['Cargo.toml', 'main.rs', 'main.ts', 'paper.ash-academic', 'paper.pdf']);
	await expect(comparisons.locator('.stanza-multi-diff-editor-section')).toHaveCount(5);

	await writeFile(join(cwd, 'main.ts'), 'const value = 2;\n');
	await writeFile(join(cwd, 'other.ts'), 'export const other = true;\n');
	await run('git', ['add', 'main.ts', 'other.ts'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Review all files'], { cwd });
	await history.locator('[data-action-id="workbench.scm.action.graph.refresh"] > button').click();
	const latest = history.getByRole('treeitem', { name: /Review all files/ });
	await expect(latest).toBeVisible();
	await latest.hover();
	await latest.getByRole('button', { name: 'Open Changes', exact: true }).click();
	await expect(latest).toHaveAttribute('aria-expanded', 'false');
	await expect(comparisons.locator('.stanza-multi-diff-editor-title')).toHaveText(['main.ts', 'other.ts']);
	await expect(comparisons.locator('.stanza-multi-diff-editor-section')).toHaveCount(2);
	// A long branch badge can cover the title; open this comparison through the commit's keyboard menu.
	await latest.focus();
	await latest.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Open Changes', exact: true }).click();
	await expect(comparisons.locator('.stanza-multi-diff-editor-title')).toHaveText(['main.ts', 'other.ts']);
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Review all files' })).toHaveCount(1);
});

test('SCM history opens committed contents, copies host metadata and restores localized actions after restart', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, testWorkspace, workbench, restartWorkbench }) => {
	const cwd = testWorkspace.directory;
	const subject = `History metadata: a long title that uses the space previously occupied by the commit hash and date ${'long-commit-identifier'.repeat(6)}`;
	const body = Array.from({ length: 24 }, (_, index) => `    Detail ${index + 1}: the complete explanation remains available without taking space from the history title.`).join('\n');
	await writeFile(join(cwd, 'details.txt'), 'first line\nsecond line\n');
	await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 1, 2]));
	await run('git', ['add', 'details.txt', 'binary.dat'], { cwd });
	await run('git', ['-c', 'user.name=History Author', '-c', 'user.email=history@example.invalid', 'commit', '-m', subject, '-m', body], { cwd });
	await run('git', ['remote', 'add', 'origin', 'https://github.com/ash-test/history.git'], { cwd });
	await run('git', ['branch', 'metadata-topic'], { cwd });
	await run('git', ['tag', 'metadata-v1'], { cwd });
	const { stdout } = await run('git', ['show', '-s', '--format=%H%n%ct', 'HEAD'], { cwd });
	const [hash] = stdout.trim().split('\n');
	const page = workbench.page;
	if (target.kind === 'browser') { await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); }
	if (target.kind === 'electron' && process.platform === 'darwin') {
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = workbench.settingsEditor.element;
		await settings.locator('[data-settings-group-id="workbench"]').click();
		await settings.locator('[data-settings-category-id="layout"]').click();
		await settings.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Custom', exact: true }).click();
		await settings.locator('.ash-modal-editor-close').click();
	}
	await workbench.git.setHistoryBadges('All references');
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	const header = history.locator('.ash-pane-view-header');
	await header.click();
	const commit = history.getByRole('treeitem', { name: /History metadata:/u });
	await expect(commit).toBeVisible();
	const hover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
	await commit.locator('.ash-scm-graph-subject').hover({ position: { x: 3, y: 8 } });
	await expect(hover.locator('.ash-scm-graph-hover-subject')).toHaveText(subject);
	await expect(hover.locator('.ash-scm-graph-hover-message')).toHaveText(body);
	const openOnGitHub = hover.getByRole('button', { name: 'Open on GitHub', exact: true });
	const pointerCopy = hover.getByRole('button', { name: 'Copy Commit Hash', exact: true });
	await pointerCopy.click();
	const pointerCopied = () => target.kind === 'electron'
		? (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText())
		: page.evaluate(() => navigator.clipboard.readText());
	await expect.poll(pointerCopied).toBe(hash);
	if (target.kind === 'electron') {
		const electron = application as ElectronApplication;
		await electron.evaluate(({ shell }) => {
			const original = shell.openExternal;
			const state = globalThis as typeof globalThis & { scmHistoryLink?: { url?: string; restore: () => void; }; };
			state.scmHistoryLink = { restore: () => { shell.openExternal = original; } };
			shell.openExternal = async url => { state.scmHistoryLink!.url = url; };
		});
		try {
			await openOnGitHub.click();
			await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { scmHistoryLink?: { url?: string; }; }).scmHistoryLink?.url)).toBe(`https://github.com/ash-test/history/commit/${hash}`);
		} finally {
			await electron.evaluate(() => (globalThis as typeof globalThis & { scmHistoryLink?: { restore: () => void; }; }).scmHistoryLink!.restore());
		}
	} else {
		const url = `https://github.com/ash-test/history/commit/${hash}`;
		await page.context().route(url, route => route.fulfill({ body: 'Commit link opened' }));
		try {
			const opened = page.context().waitForEvent('page');
			await openOnGitHub.click();
			const external = await opened;
			try { await expect(external).toHaveURL(url); } finally { await external.close(); }
		} finally {
			await page.context().unroute(url);
		}
	}
	await hover.locator('.ash-scm-graph-hover-message').hover();
	await expect(hover).toBeVisible();
	const commitInput = page.getByRole('textbox', { name: /^Commit message/u });
	await page.locator('.stanza-editor').filter({ has: commitInput }).locator('.stanza-editor-content').click();
	await expect(commitInput).toBeFocused();
	await expect(hover).toHaveCount(0);
	await commit.locator('.ash-scm-graph-subject').hover({ position: { x: 3, y: 8 } });
	await expect(hover.locator('.ash-scm-graph-hover-message')).toHaveText(body);
	await page.keyboard.press('Escape');
	await expect(hover).toHaveCount(0);
	await header.hover();
	await header.locator('.ash-pane-view-header-button').focus();
	await commit.focus();
	await expect(hover.locator('.ash-scm-graph-hover-message')).toHaveText(body);
	await expect(commit).toHaveAttribute('aria-describedby', (await hover.getAttribute('id'))!);
	await commit.press('Alt+ArrowDown');
	const copy = hover.getByRole('button', { name: 'Copy Commit Hash', exact: true });
	await expect(copy).toBeFocused();
	await expect(copy).toHaveText('');
	await expect(copy.locator('.ash-icon')).toHaveAttribute('aria-hidden', 'true');
	await copy.press('Enter');
	const copied = () => target.kind === 'electron'
		? (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText())
		: page.evaluate(() => navigator.clipboard.readText());
	await expect.poll(copied).toBe(hash);
	await copy.press('ArrowRight');
	await expect(openOnGitHub).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(hover).toHaveCount(0);
	await expect(commit).toBeFocused();
	await commit.press('Alt+ArrowDown');
	await hover.getByRole('button', { name: `Open Commit ${hash.slice(0, 7)}`, exact: true }).click();
	await expect(page.locator('.stanza-multi-diff-editor:visible')).toBeVisible();
	await expect(page.locator('.stanza-multi-diff-editor:visible')).toContainText('details.txt');
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await commit.focus();
	await commit.press('Alt+ArrowDown');
	await expect(copy).toBeFocused();
	await page.keyboard.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/complete message/);
	await page.keyboard.press('Escape');
	await expect(commit).toBeFocused();
	await commit.press('Alt+ArrowDown');
	await expect(copy).toBeFocused();
	await expect(hover.locator('.ash-scm-graph-hover-message')).toHaveText(body);
	await page.keyboard.press('Alt+F2');
	const accessible = page.getByRole('dialog', { name: 'Accessible View', exact: true });
	await expect(accessible.getByRole('textbox')).toHaveValue(new RegExp(`${body}[\\s\\S]*${hash}`, 'u'));
	await page.keyboard.press('Escape');
	await expect(commit).toBeFocused();
	await commit.press('Enter');
	await expect(commit).toHaveAttribute('aria-expanded', 'true');
	await expect(commit.getByRole('button', { name: /details\.txt/ })).toBeVisible();
	const committedFile = commit.getByRole('button', { name: /details\.txt/ });
	await committedFile.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Open File', exact: true }).click();
	const snapshot = workbench.editors.groupAt(0).editor;
	await snapshot.waitForEditorContents(text => text.startsWith('first line\nsecond line'));
	await expect(snapshot.input).toHaveAttribute('aria-readonly', 'true');
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ application, workbench } = await restartWorkbench());
	const localizedHistory = workbench.page.locator('[data-view-id="ash.gitGraph"]');
	await expect(localizedHistory).toBeVisible();
	const localizedCommit = localizedHistory.getByRole('treeitem', { name: /History metadata:/u });
	await localizedCommit.focus();
	await localizedCommit.press('Alt+ArrowDown');
	const localizedHover = workbench.page.getByRole('tooltip').filter({ has: workbench.page.locator('.ash-scm-graph-hover') });
	await expect(localizedHover.getByRole('button', { name: `打开提交 ${hash.slice(0, 7)}`, exact: true })).toBeVisible();
	await expect(localizedHover.getByRole('button', { name: '在 GitHub 上打开', exact: true })).toBeVisible();
	await workbench.page.keyboard.press('Escape');
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.element.getByRole('searchbox').fill('scm.graph');
	await expect(workbench.settingsEditor.element.locator('[data-settings-item-id="scm.graph.pageSize"]').getByRole('spinbutton')).toHaveAttribute('aria-label', '源代码管理 › 提交图：每页数量');
	await expect(workbench.settingsEditor.element.locator('[data-settings-item-id="scm.graph.pageOnScroll"]').getByRole('switch')).toHaveAttribute('aria-label', '源代码管理 › 提交图：滚动时加载');
	await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	await localizedCommit.press('ArrowRight');
	await localizedCommit.getByRole('button', { name: /details\.txt/ }).press('Shift+F10');
	await expect(workbench.page.getByRole('menuitem', { name: '打开文件', exact: true })).toBeVisible();
	await workbench.page.keyboard.press('Escape');
});

test('SCM history references and actions overlay long titles without changing row widths', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench }) => {
	const cwd = testWorkspace.directory;
	await run('git', ['commit', '--amend', '-m', 'History layout: a long commit title that reaches the action buttons at the right edge'], { cwd });
	await run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd });
	await run('git', ['commit', '--allow-empty', '-m', 'Neighbor layout: another long commit title that keeps its width while other rows are hovered'], { cwd });
	const page = workbench.page;
	if (target.kind === 'electron' && process.platform === 'darwin') {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('layout');
		const settings = workbench.settingsEditor.element;
		await settings.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Custom', exact: true }).click();
		await settings.locator('.ash-modal-editor-close').click();
	}
	await workbench.git.setHistoryBadges('All references');
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	const header = history.locator('.ash-pane-view-header');
	await header.click();
	const commit = history.getByRole('treeitem', { name: /History layout:/u });
	const neighbor = history.getByRole('treeitem', { name: /Neighbor layout:/u });
	await expect(commit).toBeVisible();
	await expect(neighbor).toBeVisible();
	const sidebar = page.locator('[data-part="sidebar"]');
	const sash = sidebar.locator('xpath=../../..').locator(':scope > .ash-sash').first();
	const sidebarBounds = (await sidebar.boundingBox())!;
	const sashBounds = (await sash.boundingBox())!;
	const x = sashBounds.x + sashBounds.width / 2;
	const y = sashBounds.y + sashBounds.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 280 - sidebarBounds.width, y);
	await page.mouse.up();
	await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(280, 0);
	const subject = commit.locator('.ash-scm-graph-subject');
	const neighborSubject = neighbor.locator('.ash-scm-graph-subject');
	const actions = commit.locator('.ash-scm-graph-actions');
	const overlay = commit.locator('.ash-scm-graph-overlay');
	const remoteLabel = overlay.locator('.ash-scm-graph-label.remote');
	const mainLabel = neighbor.locator('.ash-scm-graph-overlay .ash-scm-graph-label.head');
	for (const theme of ['Ash Dark', 'Ash Light', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		await workbench.quickaccess.select(theme);
		await header.hover();
		await expect(actions).toBeHidden();
		await expect(remoteLabel).toBeVisible();
		await expect(remoteLabel).toHaveAttribute('aria-label', 'origin/main');
		await expect(mainLabel).toBeVisible();
		await expect(mainLabel).toHaveText('main');
		const beforeHover = (await subject.boundingBox())!;
		const neighborBounds = await neighborSubject.boundingBox();
		expect(neighborBounds!.width).toBe(beforeHover.width);
		const referenceBounds = (await remoteLabel.boundingBox())!;
		expect(referenceBounds.x).toBeLessThan(beforeHover.x + beforeHover.width);
		expect(referenceBounds.x + referenceBounds.width).toBeCloseTo(beforeHover.x + beforeHover.width, 1);
		await expect.poll(() => subject.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
		await commit.hover();
		await expect(actions).toBeVisible();
		await expect(remoteLabel).toBeVisible();
		await expect(mainLabel).toBeVisible();
		expect(await subject.boundingBox()).toEqual(beforeHover);
		expect(await neighborSubject.boundingBox()).toEqual(neighborBounds);
		const actionBounds = (await actions.boundingBox())!;
		expect(actionBounds.x).toBeGreaterThan(beforeHover.x);
		expect(actionBounds.x).toBeLessThan(beforeHover.x + beforeHover.width);
		expect(actionBounds.x + actionBounds.width).toBeCloseTo(beforeHover.x + beforeHover.width, 1);
		const remoteBounds = (await remoteLabel.boundingBox())!;
		expect(remoteBounds.x + remoteBounds.width).toBeLessThanOrEqual(actionBounds.x);
		await expect(overlay).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await actions.locator('.ash-toolbar-more-actions button').click();
		await expect(page.getByRole('menuitem', { name: 'Add to Chat', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(commit).toHaveAttribute('aria-expanded', 'false');
		await header.hover();
		await header.locator('.ash-pane-view-header-button').focus();
		await expect(actions).toBeHidden();
		expect(await subject.boundingBox()).toEqual(beforeHover);
		await commit.focus();
		await expect(actions).toBeVisible();
		expect(await subject.boundingBox()).toEqual(beforeHover);
		await commit.press('Tab');
		await expect(remoteLabel).toBeFocused();
		await remoteLabel.press('Tab');
		await expect.poll(() => actions.evaluate(element => element.contains(document.activeElement))).toBe(true);
		await page.keyboard.press('Home');
		await expect(actions.getByRole('button', { name: 'Open Changes', exact: true })).toBeFocused();
	}
	await actions.getByRole('button', { name: 'Open Changes', exact: true }).press('Enter');
	await expect(workbench.editors.groupAt(0).content.locator('.stanza-multi-diff-editor-section')).toHaveCount(5);
	await expect(commit).toHaveAttribute('aria-expanded', 'false');
});

test('SCM graph menus copy complete commit information and compare current remote and base references', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, testWorkspace, workbench }) => {
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
	await git('remote', 'add', 'origin', 'https://github.com/ash-test/history.git');
	await writeFile(join(cwd, 'main-only.ts'), 'export const main = true;\n');
	await git('add', 'main-only.ts');
	await git('commit', '-m', 'Main side');
	await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
	await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
	await git('switch', '-c', 'topic', 'HEAD^');
	await writeFile(join(cwd, 'topic-only.ts'), 'export const topic = true;\n');
	await git('add', 'topic-only.ts');
	await git('commit', '-m', 'Graph comparison', '-m', 'The complete body.');
	await git('branch', '--set-upstream-to=origin/main', 'topic');
	const selected = await git('rev-parse', 'HEAD');
	const page = workbench.page;
	if (target.kind === 'electron' && process.platform === 'darwin') {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('layout');
		await workbench.settingsEditor.element.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Custom', exact: true }).click();
		await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	}
	if (target.kind === 'browser') { await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); }
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	const commit = history.getByRole('treeitem', { name: /Graph comparison/u });
	await expect(commit).toBeVisible();
	await commit.focus();
	await commit.press('Shift+F10');
	await expect(page.getByRole('menuitem').first()).toHaveText('Open Changes');
	await expect(page.getByRole('menuitem', { name: 'Open Commit in Browser', exact: true })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Compare with Remote…', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(commit).toBeFocused();
	const copied = () => target.kind === 'electron'
		? (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText())
		: page.evaluate(() => navigator.clipboard.readText());
	for (const [action, expected] of [['Copy Commit Hash', selected], ['Copy Commit Message', 'Graph comparison\n\nThe complete body.']]) {
		await commit.press('Shift+F10');
		await page.getByRole('menuitem', { name: action, exact: true }).click();
		await expect.poll(copied).toBe(expected);
	}
	const comparisons = page.locator('.stanza-multi-diff-editor:visible');
	for (const [action, paths] of [
		['Compare with…', ['main-only.ts', 'topic-only.ts']],
		['Compare with Merge Base…', ['main-only.ts', 'topic-only.ts']],
		['Compare with Remote…', ['main-only.ts', 'topic-only.ts']],
	] as const) {
		await commit.focus();
		await commit.press('Shift+F10');
		await page.getByRole('menuitem', { name: action, exact: true }).click();
		if (action === 'Compare with…') {
			const picker = page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill('origin/main');
			await picker.locator('.ash-quick-pick-row-label', { hasText: /^origin\/main$/u }).click();
		}
		await expect(comparisons.locator('.stanza-multi-diff-editor-title')).toHaveText([...paths]);
	}
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'origin/main' })).toHaveCount(1);
	const old = history.getByRole('treeitem', { name: /Initial/u });
	await old.focus();
	await old.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Compare with Remote…', exact: true })).toBeEnabled();
	await page.getByRole('menuitem', { name: 'Compare with Remote…', exact: true }).click();
	await expect(comparisons.locator('.stanza-multi-diff-editor-title')).toHaveText(['main-only.ts']);
	await workbench.quickaccess.open('>git.graph.');
	await expect(workbench.quickaccess.items.filter({ has: page.locator('.ash-quick-pick-row-description', { hasText: /^git\.graph\./u }) })).toHaveCount(0);
	await workbench.quickaccess.close();

	expect(await git('rev-parse', 'HEAD')).toBe(selected);
	expect(await git('status', '--porcelain')).toBe('');
});

test('SCM graph menus create at an old commit, switch references, delete branches, checkout and cherry-pick', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, testWorkspace, workbench }) => {
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
	const root = await git('rev-parse', 'HEAD');
	await writeFile(testWorkspace.file, 'const value = 2;\n');
	await git('commit', '-am', 'Graph latest');
	const latestId = await git('rev-parse', 'HEAD');
	await git('remote', 'add', 'origin', 'https://github.com/ash-test/history.git');
	await git('update-ref', 'refs/remotes/origin/latest', 'HEAD');
	await git('switch', '-c', 'pick-topic');
	await writeFile(join(cwd, 'picked.ts'), 'export const picked = true;\n');
	await git('add', 'picked.ts');
	await git('commit', '-m', 'Graph pick');
	await git('switch', 'main');
	const page = workbench.page;
	if (target.kind === 'electron' && process.platform === 'darwin') {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('layout');
		await workbench.settingsEditor.element.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Custom', exact: true }).click();
		await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	}
	await setHistoryBadges(workbench, 'All references');
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	await history.locator('[data-action-id="workbench.scm.action.graph.pickHistoryItemRefs"] > button').click();
	await page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText('All References', { exact: true }) }).click();
	await page.keyboard.press('Enter');
	const initial = history.getByRole('treeitem', { name: /Initial/u });
	const latest = history.getByRole('treeitem', { name: /Graph latest/u });
	const enterName = async (name: string) => {
		const input = page.getByRole('dialog', { name: 'Quick Input', exact: true }).getByRole('textbox');
		await input.fill(name);
		await input.press('Enter');
	};
	await initial.focus();
	await initial.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Create Branch…', exact: true }).click();
	await enterName('graph-review');
	await expect.poll(() => git('branch', '--list', 'graph-review')).toBe('graph-review');
	expect(await git('rev-parse', 'refs/heads/graph-review')).toBe(root);
	expect(await git('branch', '--show-current')).toBe('main');
	await initial.focus();
	await initial.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'More…', exact: true }).hover();
	await page.getByRole('menuitem', { name: 'Create Tag…', exact: true }).click();
	await enterName('graph-tag');
	await expect.poll(() => git('tag', '--list', 'graph-tag')).toBe('graph-tag');
	expect(await git('rev-parse', 'refs/tags/graph-tag')).toBe(root);
	const branch = initial.getByRole('button', { name: 'graph-review', exact: true });
	await branch.focus();
	await branch.press('Enter');
	await page.getByRole('menuitem', { name: 'Checkout…', exact: true }).click();
	await expect.poll(() => git('branch', '--show-current')).toBe('graph-review');
	await expect(history.locator('.ash-scm-graph-label.head')).toHaveText('graph-review');
	await branch.press('Enter');
	await expect(page.getByRole('menuitem', { name: 'Delete Branch…', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await latest.getByRole('button', { name: 'main', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Checkout…', exact: true }).click();
	await expect.poll(() => git('branch', '--show-current')).toBe('main');
	await expect(history.locator('.ash-scm-graph-label.head')).toHaveText('main');
	await workbench.dialogs.confirm(application, 'Delete Branch…', 'Delete', async () => {
		await branch.press('Enter');
		await page.getByRole('menuitem', { name: 'Delete Branch…', exact: true }).click();
	});
	await expect.poll(() => git('branch', '--list', 'graph-review')).toBe('');
	await workbench.dialogs.confirm(application, 'Checkout Commit (Detached)', 'Checkout', async () => {
		await initial.focus();
		await initial.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Checkout', exact: true }).hover();
		await page.getByRole('menuitem', { name: 'Checkout Commit (Detached)', exact: true }).click();
	});
	await expect.poll(() => git('rev-parse', 'HEAD')).toBe(root);
	expect(await git('branch', '--show-current')).toBe('');
	await expect(initial).toHaveAttribute('aria-current', 'true');
	await latest.getByRole('button', { name: 'origin/latest', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Checkout…', exact: true }).click();
	await enterName('graph-tracked');
	await expect.poll(() => git('branch', '--show-current')).toBe('graph-tracked');
	expect(await git('rev-parse', 'HEAD')).toBe(latestId);
	expect(await git('rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/latest');
	const pick = history.getByRole('treeitem', { name: /Graph pick/u });
	await pick.focus();
	await pick.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Cherry Pick', exact: true }).click();
	await expect.poll(() => git('log', '-1', '--format=%s')).toBe('Graph pick');
	expect(await git('show', 'HEAD:picked.ts')).toBe('export const picked = true;');
});

test('SCM history pane opens without a connected repository', { tag: ['@browser-ui', '@electron-ui'] }, async ({ target, workbench }) => {

	const page = workbench.page;
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const changes = page.locator('[data-view-id="ash.gitView"]');
	await expect(changes.locator('.ash-scm-status')).toContainText('source control');
	await expect(changes.locator('.ash-scm-status')).toBeVisible();
	await expect(changes.locator('.ash-scm-commit-form')).toBeHidden();
	await expect(changes.getByRole('tree', { name: 'Source control changes' })).toHaveCount(1);
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await expect(history).toBeVisible();
	await history.locator('.ash-pane-view-header').click();
	await expect(history.locator('.ash-scm-empty')).toContainText('No commits yet.');
});

test.describe('SCM folding', () => {
	test.beforeEach(async ({ target, testWorkspace }) => {
		if (target.appServerMode !== 'required') { return; }
		const cwd = testWorkspace.directory;
		await mkdir(join(cwd, 'src'));
		await writeFile(join(cwd, 'src', 'details.ts'), 'export const details = 1;\n');
		await run('git', ['add', 'src/details.ts'], { cwd });
		await run('git', ['commit', '-m', 'Add folding fixture'], { cwd });
		await writeFile(join(cwd, 'main.ts'), 'const value = 2;\n');
		await writeFile(join(cwd, 'src', 'details.ts'), 'export const details = 2;\n');
		await run('git', ['add', 'main.ts', 'src/details.ts'], { cwd });
		await writeFile(join(cwd, 'main.ts'), 'const value = 3;\n');
	});

	test('SCM groups fold with pointer and keyboard input and retain state after Git refresh', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench }) => {
		const page = workbench.page;
		const cwd = testWorkspace.directory;
		await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
		const tree = page.getByRole('tree', { name: 'Source control changes' });
		const working = tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-section-label', { hasText: /^Changes$/ }) });
		const staged = tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-section-label', { hasText: /^Staged Changes$/ }) });
		const workingFile = tree.getByRole('button', { name: 'Open Changes for main.ts', exact: true });
		const stagedFile = tree.getByRole('button', { name: 'Open Staged Changes for main.ts', exact: true });
		await expect(workingFile).toBeVisible();
		await expect(stagedFile).toBeVisible();
		const workingRow = tree.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Open Changes for main.ts', exact: true }) });
		const rowGeometry = await workingRow.evaluate(element => {
			const row = element.getBoundingClientRect();
			const content = element.querySelector('.ash-scm-change')!.getBoundingClientRect();
			return { height: row.height, rightInset: row.right - content.right };
		});
		expect(rowGeometry).toEqual({ height: 24, rightInset: 8 });
		await expect(working).toHaveCSS('height', '28px');
		await expect(working).toHaveCSS('border-radius', '4px');
		await expect(working.locator('.ash-count-badge')).toHaveCSS('border-radius', '9999px');
		await expect(working.locator('.ash-count-badge')).toHaveAttribute('aria-label', /changes$/);
		await expect(working.locator('.ash-tree-twistie .ash-icon')).toHaveCSS('width', '16px');
		await expect(working.locator('.ash-tree-twistie .ash-icon')).toHaveAttribute('aria-hidden', 'true');
		const actions = workingRow.locator('.ash-scm-change-actions');
		await page.getByRole('textbox', { name: /^Commit message/u }).hover();
		await expect(actions).toHaveCSS('visibility', 'hidden');
		const beforeHover = await workingFile.boundingBox();
		await workingRow.hover();
		await expect(actions).toHaveCSS('visibility', 'visible');
		expect(await workingFile.boundingBox()).toEqual(beforeHover);
		await expect(actions.locator('.ash-icon').first()).toHaveCSS('width', '16px');
		await expect(page.locator('.ash-scm-commit-form')).toHaveCSS('border-bottom-width', '1px');
		await expect(working).toHaveAttribute('aria-expanded', 'true');
		await working.locator('.ash-scm-section-label').click();
		await expect(working).toHaveAttribute('aria-expanded', 'false');
		await expect(workingFile).toHaveCount(0);
		await expect(stagedFile).toBeVisible();
		const previousCount = Number(await working.locator('.ash-scm-section-count').textContent());
		await writeFile(join(cwd, 'refreshed.ts'), 'export const refreshed = true;\n');
		await expect(working.locator('.ash-scm-section-count')).toHaveText(String(previousCount + 1));
		await expect(working).toHaveAttribute('aria-expanded', 'false');
		await expect(workingFile).toHaveCount(0);
		await tree.focus();
		await page.keyboard.press('ArrowRight');
		await expect(working).toHaveAttribute('aria-expanded', 'true');
		await expect(workingFile).toBeVisible();
		await page.keyboard.press('ArrowLeft');
		await expect(working).toHaveAttribute('aria-expanded', 'false');
		await page.keyboard.press('Enter');
		await expect(working).toHaveAttribute('aria-expanded', 'true');
		await workingFile.click();
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		const fileRow = tree.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Open Changes for main.ts', exact: true }) });
		await expect(fileRow).toHaveAttribute('aria-selected', 'true');
		await expect(fileRow).toHaveCSS('border-radius', '4px');
		const selectedBackground = await fileRow.evaluate(element => getComputedStyle(element).backgroundColor);
		await fileRow.hover();
		await expect(fileRow).toHaveCSS('background-color', selectedBackground);
		await expect(fileRow.locator('.ash-scm-change')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await fileRow.getByRole('button', { name: 'Stage main.ts', exact: true }).click();
		await expect(workingFile).toHaveCount(0);
		await expect(working).toHaveAttribute('aria-expanded', 'true');
		await expect(staged).toHaveAttribute('aria-expanded', 'true');
		await staged.locator('.ash-tree-twistie').click();
		await expect(staged).toHaveAttribute('aria-expanded', 'false');
		await expect(stagedFile).toHaveCount(0);
		await expect(tree.getByRole('button', { name: 'Open Changes for refreshed.ts', exact: true })).toBeVisible();
		for (const theme of ['Ash Light', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
			await workbench.quickaccess.runCommand('workbench.action.selectTheme');
			await page.locator('.ash-quick-pick').getByRole('combobox').fill(theme);
			await page.keyboard.press('Enter');
			await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
			await staged.locator('.ash-scm-section-label').click();
			await expect(staged).toHaveAttribute('aria-expanded', 'true');
			await expect(stagedFile).toBeVisible();
			await expect(tree).toBeFocused();
			await expect(staged).toHaveCSS('border-radius', '4px');
			const badgeStyle = await staged.locator('.ash-count-badge').evaluate(element => {
				const style = getComputedStyle(element);
				const probe = document.createElement('span');
				probe.style.backgroundColor = style.getPropertyValue('--ash-badge-background');
				probe.style.color = style.getPropertyValue('--ash-badge-foreground');
				element.append(probe);
				const result = { themed: style.backgroundColor === getComputedStyle(probe).backgroundColor && style.color === getComputedStyle(probe).color, outline: style.outlineStyle };
				probe.remove();
				return result;
			});
			expect(badgeStyle.themed).toBe(true);
			if (theme.includes('High Contrast')) { expect(badgeStyle.outline).toBe('solid'); }
			await page.keyboard.press('ArrowLeft');
			await page.keyboard.press('ArrowRight');
			await expect(staged).toHaveCSS('outline-style', 'solid');
			await stagedFile.click();
			const selected = tree.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Open Staged Changes for main.ts', exact: true }) });
			await expect(selected).toHaveAttribute('aria-selected', 'true');
			await expect.poll(() => selected.evaluate(element => {
				const style = getComputedStyle(element);
				const token = style.getPropertyValue('--ash-list-activeSelectionBackground').trim();
				const probe = document.createElement('span');
				probe.style.backgroundColor = token;
				element.append(probe);
				const matches = style.backgroundColor === getComputedStyle(probe).backgroundColor;
				probe.remove();
				return matches;
			})).toBe(true);
			await selected.hover();
			await expect(selected.locator('.ash-scm-change')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			const foreground = await selected.evaluate(element => getComputedStyle(element).color);
			await expect(selected.locator('.ash-scm-change-actions button').first()).toHaveCSS('color', foreground);
			const bounds = await stagedFile.boundingBox();
			expect(bounds?.width).toBeGreaterThan(0);
			const nestedFile = tree.getByRole('button', { name: 'Open Staged Changes for src/details.ts', exact: true });
			await nestedFile.click();
			const nestedRow = tree.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Open Staged Changes for src/details.ts', exact: true }) });
			await expect(nestedRow).toHaveAttribute('aria-selected', 'true');
			const nestedForeground = await nestedRow.evaluate(element => getComputedStyle(element).color);
			await expect(nestedFile.locator('.ash-icon-label-description')).toHaveText('src');
			await expect(nestedFile.locator('.ash-icon-label-description')).toHaveCSS('color', nestedForeground);
			await staged.locator('.ash-tree-twistie').click();
			await expect(staged).toHaveAttribute('aria-expanded', 'false');
		}
	});
});

test('SCM history filters references, compares branch ranges, switches file trees and restores binary snapshots', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench, reloadWorkbench, restartWorkbench }) => {
	test.setTimeout(120_000);
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
	await mkdir(join(cwd, 'src', 'nested'), { recursive: true });
	await writeFile(join(cwd, 'src', 'nested', 'details.txt'), 'base\n');
	await writeFile(join(cwd, 'image.bin'), Buffer.from([0, 1, 255]));
	await git('add', '.');
	await git('commit', '-m', 'Range base');
	await git('switch', '-c', 'topic');
	await writeFile(join(cwd, 'topic.txt'), 'topic\n');
	await git('add', '.');
	await git('commit', '-m', 'Topic only');
	await git('tag', 'topic-tag');
	await git('switch', 'main');
	await git('switch', '-c', 'remote-tip');
	await writeFile(join(cwd, 'src', 'incoming.txt'), 'incoming\n');
	await git('add', '.');
	await git('commit', '-m', 'Remote incoming');
	const remote = await git('rev-parse', 'HEAD');
	await git('switch', 'main');
	await git('branch', '-D', 'remote-tip');
	await writeFile(join(cwd, 'src', 'nested', 'details.txt'), 'outgoing\n');
	await writeFile(join(cwd, 'image.bin'), Buffer.from([0, 2, 254]));
	await git('add', '.');
	await git('commit', '-m', 'Local outgoing');
	await git('remote', 'add', 'origin', cwd);
	await git('update-ref', 'refs/remotes/origin/main', remote);
	await git('branch', '--set-upstream-to=origin/main', 'main');
	let page = workbench.page;
	if (target.kind === 'electron' && process.platform === 'darwin') {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('layout');
		await workbench.settingsEditor.element.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Custom', exact: true }).click();
		await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	}
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	let history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	const outgoing = () => history.getByRole('treeitem', { name: /^Outgoing Changes/u });
	const incoming = () => history.getByRole('treeitem', { name: /^Incoming Changes/u });
	await expect(outgoing()).toBeVisible();
	await expect(incoming()).toBeVisible();
	await page.locator('[data-view-id="ash.gitView"]').getByRole('button', { name: 'Changes', exact: true }).click();
	await expect(history.getByRole('treeitem', { name: /Topic only/u })).toHaveCount(0);
	await incoming().focus();
	await incoming().press('Enter');
	await expect(incoming().locator('.ash-scm-graph-change')).toHaveCount(1);
	await expect(incoming().locator('.ash-scm-graph-change')).toContainText('incoming.txt');
	await incoming().press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Copy Commit Hash', exact: true })).toHaveCount(0);
	await page.getByRole('menuitem', { name: 'Open Changes', exact: true }).click();
	const rangeComparison = page.locator('.stanza-multi-diff-editor:visible');
	await expect(rangeComparison.locator('.stanza-multi-diff-editor-section')).toHaveCount(1);
	await expect(rangeComparison.locator('.stanza-multi-diff-editor-title')).toHaveText('src/incoming.txt');
	await outgoing().focus();
	await outgoing().press('Enter');
	await expect(outgoing().locator('.ash-scm-graph-change')).toHaveCount(2);
	await outgoing().press('Alt+ArrowDown');
	const hover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
	await expect(hover).toContainText('Changes from');
	await expect(hover.getByRole('button', { name: 'Copy Commit Hash', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await history.locator('.ash-pane-view-header').getByRole('button', { name: 'More Actions', exact: true }).click();
	await page.getByRole('menuitemcheckbox', { name: 'View as Tree', exact: true }).click();
	const folder = outgoing().getByRole('button', { name: 'Folder src', exact: true });
	await expect(folder).toHaveAttribute('aria-expanded', 'true');
	await expect(folder).toHaveCSS('height', '22px');
	await expect(folder).toHaveCSS('justify-content', 'flex-start');
	await folder.focus();
	await folder.press('ArrowLeft');
	await expect(folder).toHaveAttribute('aria-expanded', 'false');
	await expect(outgoing().getByRole('button', { name: 'Folder src/nested', exact: true })).toBeHidden();
	await folder.press('ArrowRight');
	await expect(outgoing().getByRole('button', { name: 'Folder src/nested', exact: true })).toBeVisible();
	await expect(outgoing().locator('.ash-scm-graph-change').filter({ hasText: 'details.txt' })).toHaveCSS('padding-left', '24px');
	const detailsBounds = await outgoing().locator('.ash-scm-graph-change').filter({ hasText: 'details.txt' }).boundingBox();
	const headBounds = await history.getByRole('treeitem', { name: /Local outgoing/u }).boundingBox();
	expect(detailsBounds!.y + detailsBounds!.height).toBeLessThanOrEqual(headBounds!.y + 1);
	await history.screenshot({ path: test.info().outputPath('scm-history-branch-ranges-tree.png') });
	await test.info().attach('scm-history-branch-ranges-tree', { path: test.info().outputPath('scm-history-branch-ranges-tree.png'), contentType: 'image/png' });
	const binary = outgoing().locator('.ash-scm-graph-change').filter({ hasText: 'image.bin' });
	await binary.click();
	const hex = page.locator('.ash-binary-editor-content:visible');
	await expect(hex).toHaveCount(2);
	await expect(hex.nth(0)).toContainText('00 01 ff');
	await expect(hex.nth(1)).toContainText('00 02 fe');
	await binary.focus();
	const openFile = binary.locator('..').locator('[data-action-id="workbench.scm.action.graph.openFile"] > button');
	await expect(openFile).toBeVisible();
	await binary.press('Tab');
	await expect(openFile).toBeFocused();
	await openFile.press('Enter');
	await expect(hex).toHaveCount(1);
	await expect(hex).toContainText('00 02 fe');
	await expect(page.getByRole('button', { name: 'Open as Read-Only Text', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Open with Encoding', exact: true })).toHaveCount(0);
	await page.screenshot({ path: test.info().outputPath('scm-history-binary-file.png') });
	await test.info().attach('scm-history-binary-file', { path: test.info().outputPath('scm-history-binary-file.png'), contentType: 'image/png' });
	const selectReferences = async (names: readonly string[]) => {
		await history.locator('[data-action-id="workbench.scm.action.graph.pickHistoryItemRefs"] > button').click();
		for (const name of names) {
			await page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText(name, { exact: true }) }).click();
		}
		await page.keyboard.press('Enter');
	};
	await selectReferences(['topic', 'topic-tag']);
	await expect(history.getByRole('treeitem', { name: /Topic only/u })).toBeVisible();
	await expect(history.getByRole('treeitem', { name: /Local outgoing/u })).toHaveCount(0);
	await expect(incoming()).toHaveCount(0);
	({ workbench } = await reloadWorkbench());
	page = workbench.page;
	history = page.locator('[data-view-id="ash.gitGraph"]');
	await expect(history.getByRole('treeitem', { name: /Topic only/u })).toBeVisible();
	await expect(page.locator('.ash-binary-editor-content:visible')).toContainText('00 02 fe');
	await history.locator('[data-action-id="workbench.scm.action.graph.pickHistoryItemRefs"] > button').click();
	for (const name of ['topic', 'topic-tag']) {
		await expect(page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText(name, { exact: true }) })).toHaveAttribute('aria-selected', 'true');
	}
	const referenceInput = page.getByRole('combobox');
	await referenceInput.fill('topic-tag');
	await referenceInput.press('Control+Space');
	await expect(page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText('topic-tag', { exact: true }) })).toHaveAttribute('aria-selected', 'false');
	await referenceInput.fill('');
	await expect(page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText('topic', { exact: true }) })).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Escape');
	await selectReferences(['All References']);
	await expect(history.getByRole('treeitem', { name: /Topic only/u })).toBeVisible();
	await expect(outgoing()).toBeVisible();
	await outgoing().focus();
	await outgoing().press('Enter');
	await expect(outgoing().getByRole('button', { name: 'Folder src', exact: true })).toBeVisible();
	await history.locator('.ash-pane-view-header').getByRole('button', { name: 'More Actions', exact: true }).click();
	await page.getByRole('menuitemcheckbox', { name: 'View as List', exact: true }).click();
	await expect(outgoing().locator('.ash-scm-graph-folder')).toHaveCount(0);
	await expect(outgoing().locator('.ash-scm-graph-change')).toHaveCount(2);
	await selectReferences(['topic']);
	await expect(history.getByRole('treeitem', { name: /Local outgoing/u })).toHaveCount(0);
	await expect(history.getByRole('treeitem', { name: /Topic only/u })).toBeVisible();
	await history.locator('[data-action-id="workbench.scm.action.graph.revealCurrentHistoryItem"] > button').click();
	await expect(history.getByRole('treeitem', { name: /Local outgoing/u })).toBeFocused();
	await expect(history.getByRole('treeitem', { name: /Topic only/u })).toHaveCount(0);
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.element.getByRole('searchbox').fill('scm.graph');
	const visibility = workbench.settingsEditor.element.locator('[data-settings-item-id="scm.graph.showOutgoingChanges"]').getByRole('switch');
	await expect(visibility).toHaveAttribute('aria-checked', 'true');
	await visibility.press('Space');
	await expect(outgoing()).toHaveCount(0);
	await expect(incoming()).toBeVisible();
	await visibility.press('Space');
	await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	await expect(outgoing()).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	history = page.locator('[data-view-id="ash.gitGraph"]');
	await expect(history.getByRole('treeitem', { name: /^传出更改/u })).toBeVisible();
	await expect(history.getByRole('treeitem', { name: /^传入更改/u })).toBeVisible();
	await expect(history.locator('[data-action-id="workbench.scm.action.graph.pickHistoryItemRefs"] > button')).toHaveAttribute('aria-label', '筛选历史记录引用');
	await history.locator('[data-action-id="workbench.scm.action.graph.pickHistoryItemRefs"] > button').click();
	await expect(page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText('origin/main', { exact: true }) }).locator('.ash-quick-pick-row-description')).toHaveText('远程分支');
	await page.keyboard.press('Escape');
	await history.screenshot({ path: test.info().outputPath('scm-history-localized-ranges.png') });
	await test.info().attach('scm-history-localized-ranges', { path: test.info().outputPath('scm-history-localized-ranges.png'), contentType: 'image/png' });
});

test('SCM history reference menus act on their badge and the graph picker follows repository ownership', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, testWorkspace, workbench }) => {
	test.setTimeout(120_000);
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
	await mkdir(join(cwd, 'src', 'nested'), { recursive: true });
	await writeFile(join(cwd, 'src', 'nested', 'history.txt'), 'history\n');
	await git('add', '.');
	await git('commit', '-m', 'Root reference actions');
	await git('branch', 'local-review');
	await git('tag', 'release-review');
	const remote = join(cwd, '.git', 'history-test-remote.git');
	await run('git', ['init', '--bare', remote]);
	await git('remote', 'add', 'origin', remote);
	await git('push', 'origin', 'HEAD:refs/heads/remote-review');
	await git('update-ref', 'refs/remotes/origin/remote-review', 'HEAD');
	const other = join(cwd, 'other-repo');
	await mkdir(other);
	await run('git', ['init', '-b', 'other-main'], { cwd: other });
	await writeFile(join(other, 'other.txt'), 'other repository\n');
	await run('git', ['add', '.'], { cwd: other });
	await run('git', ['-c', 'user.name=History Test', '-c', 'user.email=history@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Other repository history'], { cwd: other });
	const page = workbench.page;
	if (target.kind === 'electron' && process.platform === 'darwin') {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('layout');
		await workbench.settingsEditor.element.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Custom', exact: true }).click();
		await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	}
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	const root = history.getByRole('treeitem', { name: /Root reference actions/u });
	await expect(root).toBeVisible();
	await expect(root.getByRole('button', { name: 'release-review', exact: true })).toHaveCount(0);
	await root.focus();
	await root.press('Alt+ArrowDown');
	await expect(page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') })).toContainText('release-review');
	await page.keyboard.press('Escape');
	await workbench.git.setHistoryBadges('All references');
	const tag = root.getByRole('button', { name: 'release-review', exact: true });
	await expect(tag).toBeVisible();
	await git('tag', 'temporary-review');
	const temporary = root.getByRole('button', { name: 'release-review, temporary-review', exact: true });
	await expect(temporary).toBeVisible();
	await temporary.focus();
	await temporary.press('Shift+F10');
	await git('tag', '-d', 'temporary-review');
	await expect(tag).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(root).toBeFocused();
	await tag.focus();
	await tag.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: 'Checkout…', exact: true })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Copy Commit Hash', exact: true })).toHaveCount(0);
	await workbench.dialogs.confirm(application, 'Delete Tag…', 'Cancel', () => page.getByRole('menuitem', { name: 'Delete Tag…', exact: true }).click());
	expect(await git('tag', '--list', 'release-review')).toBe('release-review');
	await tag.focus();
	await tag.press('Shift+F10');
	await workbench.dialogs.confirm(application, 'Delete Tag…', 'Delete', () => page.getByRole('menuitem', { name: 'Delete Tag…', exact: true }).click());
	await expect.poll(() => git('tag', '--list', 'release-review')).toBe('');
	await expect(tag).toHaveCount(0);
	const local = root.getByRole('button', { name: 'local-review', exact: true });
	await local.focus();
	await local.press('Shift+F10');
	await workbench.dialogs.confirm(application, 'Delete Branch…', 'Delete', () => page.getByRole('menuitem', { name: 'Delete Branch…', exact: true }).click());
	await expect.poll(() => git('branch', '--list', 'local-review')).toBe('');
	const remoteBadge = root.getByRole('button', { name: 'origin/remote-review', exact: true });
	await remoteBadge.focus();
	await remoteBadge.press('Shift+F10');
	const remoteConfirmation = await workbench.dialogs.confirm(application, 'Git: Delete Remote Branch', 'Delete', () => page.getByRole('menuitem', { name: 'Delete Branch…', exact: true }).click());
	expect(remoteConfirmation.message).toBe('Delete branch remote-review from remote origin?');
	await expect.poll(async () => (await run('git', ['--git-dir', remote, 'branch', '--list', 'remote-review'])).stdout.trim()).toBe('');
	await root.focus();
	await root.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Enter');
	await expect(root.locator('.ash-scm-graph-change')).toHaveCount(1);
	await history.locator('.ash-pane-view-header').getByRole('button', { name: 'More Actions', exact: true }).click();
	await page.getByRole('menuitemcheckbox', { name: 'View as Tree', exact: true }).click();
	await root.focus();
	await root.press('ArrowRight');
	const src = root.getByRole('button', { name: 'Folder src', exact: true });
	await expect(src).toBeFocused();
	await src.press('ArrowRight');
	const nested = root.getByRole('button', { name: 'Folder src/nested', exact: true });
	await expect(nested).toBeFocused();
	await nested.press('ArrowRight');
	const file = root.locator('.ash-scm-graph-change');
	await expect(file).toBeFocused();
	await file.press('PageDown');
	const initial = history.getByRole('treeitem', { name: /Initial/u });
	await expect(initial).toBeFocused();
	await root.focus();
	await root.press('ArrowRight');
	await src.press('ArrowRight');
	await nested.press('ArrowRight');
	await expect(file).toBeFocused();
	await file.press('ArrowLeft');
	await expect(nested).toBeFocused();
	await nested.press('ArrowUp');
	await expect(src).toBeFocused();
	const picker = history.locator('[data-action-id="workbench.scm.action.graph.pickRepository"] > button');
	await expect(picker).toBeVisible();
	await picker.click();
	await page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText('other-repo', { exact: true }) }).click();
	await expect(history.getByRole('treeitem', { name: /Other repository history/u })).toBeVisible();
	await expect(root).toHaveCount(0);
	await expect(history.locator('.ash-scm-graph-label.head')).toHaveText('other-main');
	await picker.click();
	await page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText(basename(cwd), { exact: true }) }).click();
	await expect(root).toBeVisible();
	await expect(history.locator('.ash-scm-graph-label.head')).toHaveText('main');
	await history.screenshot({ path: test.info().outputPath('scm-history-reference-repository.png') });
	await test.info().attach('scm-history-reference-repository', { path: test.info().outputPath('scm-history-reference-repository.png'), contentType: 'image/png' });
});


test('SCM history auto roots follow the remote default branch and publication establishes upstream', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench, restartWorkbench }) => {
	test.setTimeout(120_000);
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
	const base = await git('rev-parse', 'HEAD');
	const remote = join(cwd, '.git', 'publication-test-remote.git');
	await run('git', ['init', '--bare', remote]);
	await git('remote', 'add', 'origin', remote);
	await git('switch', '-c', 'feature');
	await writeFile(testWorkspace.file, 'export const unpublished = true;\n');
	await git('add', '.');
	await git('commit', '-m', 'Unpublished feature');
	const feature = await git('rev-parse', 'HEAD');
	await git('switch', 'main');
	await writeFile(testWorkspace.file, 'export const defaultAdvanced = true;\n');
	await git('add', '.');
	await git('commit', '-m', 'Remote default branch advanced');
	await git('push', 'origin', 'main');
	await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
	await git('switch', 'feature');
	let page = workbench.page;
	if (target.kind === 'electron' && process.platform === 'darwin') {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('layout');
		await workbench.settingsEditor.element.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Custom', exact: true }).click();
		await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	}
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	let history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	await expect(history.getByRole('treeitem', { name: /Unpublished feature/u })).toBeVisible();
	await expect(history.getByRole('treeitem', { name: /Remote default branch advanced/u })).toBeVisible();
	await expect(history.getByRole('button', { name: 'origin/main', exact: true })).toBeVisible();
	const publish = history.locator('[data-action-id="git.publish"] > button');
	await expect(publish).toBeVisible();
	await expect(publish).toHaveAttribute('aria-label', 'Publish Branch');
	await expect(history.locator('[data-action-id="git.push"] > button')).toHaveCount(0);
	await publish.click();
	await expect.poll(() => git('config', '--local', '--list')).toContain('branch.feature.remote=origin');
	expect(await git('config', 'branch.feature.merge')).toBe('refs/heads/feature');
	expect((await run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/feature'])).stdout.trim()).toBe(feature);
	await expect(history.locator('[data-action-id="git.push"] > button')).toBeVisible();
	await expect(publish).toHaveCount(0);
	const release = await git('commit-tree', 'HEAD^{tree}', '-p', base, '-m', 'Changed remote default');
	await git('update-ref', 'refs/remotes/origin/release', release);
	await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release');
	await expect(history.getByRole('treeitem', { name: /Changed remote default/u })).toBeVisible();
	await expect(history.getByRole('button', { name: 'origin/release', exact: true })).toBeVisible();
	await expect(history.getByRole('treeitem', { name: /Remote default branch advanced/u })).toHaveCount(0);
	expect(await git('rev-parse', 'HEAD')).toBe(feature);
	await git('branch', '--set-upstream-to=main', 'feature');
	await expect(history.getByRole('button', { name: 'main', exact: true })).toBeVisible();
	const selected = history.getByRole('treeitem', { name: /Unpublished feature/u });
	await selected.focus();
	await selected.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Compare with Remote…', exact: true }).click();
	await expect(page.locator('.stanza-multi-diff-editor:visible .stanza-multi-diff-editor-title')).toHaveText(['main.ts']);
	await git('branch', '--set-upstream-to=origin/feature', 'feature');

	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	history = page.locator('[data-view-id="ash.gitGraph"]');
	await expect(history.getByRole('treeitem', { name: /Changed remote default/u })).toBeVisible();
	const localizedCommit = history.getByRole('treeitem', { name: /Unpublished feature/u });
	await localizedCommit.focus();
	await localizedCommit.press('Shift+F10');
	await expect(page.getByRole('menuitem', { name: '与…比较', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await history.locator('[data-action-id="workbench.scm.action.graph.pickHistoryItemRefs"] > button').click();
	await expect(page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText('自动（当前分支、上游和基准分支）', { exact: true }) })).toBeVisible();
	await page.keyboard.press('Escape');
	await git('branch', '--unset-upstream', 'feature');
	await expect(history.locator('[data-action-id="git.publish"] > button')).toHaveAttribute('aria-label', '发布分支');
	await history.screenshot({ path: test.info().outputPath('scm-history-default-publication.png') });
	await test.info().attach('scm-history-default-publication', { path: test.info().outputPath('scm-history-default-publication.png'), contentType: 'image/png' });
});


test('SCM graph title shortcuts resolve the registered view without toolbar context', { tag: ['@electron-app-server'] }, async ({ application, testWorkspace, workbench }) => {
	if (!('windows' in application)) throw new Error('Requires Electron');
	const cwd = testWorkspace.directory;
	await mkdir(join(cwd, 'src'), { recursive: true });
	await writeFile(join(cwd, 'src', 'keyboard.txt'), 'keyboard history\n');
	await run('git', ['add', '.'], { cwd });
	await run('git', ['commit', '-m', 'History shortcut target'], { cwd });
	const profile = await application.evaluate(() => process.env.ASH_HOME);
	if (!profile) throw new Error('Test profile unavailable');
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const source = JSON.stringify([
		{ key: 'ctrl+alt+f6', command: 'workbench.scm.action.graph.setListViewMode' },
		{ key: 'ctrl+alt+f7', command: 'workbench.scm.action.graph.setTreeViewMode' },
		{ key: 'ctrl+alt+f8', command: 'workbench.scm.action.graph.revealCurrentHistoryItem' },
		{ key: 'ctrl+alt+f9', command: 'workbench.scm.action.graph.pickHistoryItemRefs' },
		{ key: 'ctrl+alt+f10', command: 'workbench.scm.action.graph.refresh' },
	]);
	await writeFile(join(profile, 'keybindings.json'), source);
	await workbench.editors.groupAt(0).editor.waitForEditorContents(content => content === source);
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Source Control(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	const current = history.getByRole('treeitem', { name: /History shortcut target/u });
	await expect(current).toBeVisible();
	await current.focus();
	await current.press('Enter');
	await expect(current.locator('.ash-scm-graph-change')).toHaveCount(1);
	await page.keyboard.press('Control+Alt+F7');
	await expect(current.getByRole('button', { name: 'Folder src', exact: true })).toBeVisible();
	await page.keyboard.press('Control+Alt+F6');
	await expect(current.locator('.ash-scm-graph-folder')).toHaveCount(0);
	await history.getByRole('treeitem', { name: /Initial/u }).focus();
	await page.keyboard.press('Control+Alt+F8');
	await expect(current).toBeFocused();
	await page.keyboard.press('Control+Alt+F9');
	await expect(page.locator('.ash-quick-pick').getByRole('combobox')).toBeFocused();
	await expect(page.getByRole('option').filter({ has: page.locator('.ash-quick-pick-row-label').getByText('All References', { exact: true }) })).toBeVisible();
	await page.keyboard.press('Escape');
	await current.focus();
	await page.keyboard.press('Control+Alt+F10');
	await expect(current.locator('.ash-scm-graph-change')).toHaveCount(1);
	await expect(history.locator('[data-action-id="workbench.scm.action.graph.refresh"] > button')).toBeEnabled();
});
