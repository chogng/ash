import type { ElectronApplication } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.use({ gitRepository: true });

test('SCM history shows Git commits and opens file and multi-file comparisons', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');

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
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await expect(history).toBeVisible();
	await history.locator('.ash-pane-view-header').click();
	await history.locator('[data-action-id="ash.git.graph.refresh"] > button').click();
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
	await history.locator('[data-action-id="ash.git.graph.refresh"] > button').click();
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
	await toolbar.locator('.ash-toolbar-more-actions button').click();
	await expect(page.getByRole('menuitem', { name: 'Stage All', exact: true })).toHaveCount(0);
	await expect(page.getByRole('menuitem', { name: 'Discard All', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(comparisons.locator('.stanza-multi-diff-editor-title')).toHaveText(['Cargo.toml', 'main.rs', 'main.ts', 'paper.ash-academic', 'paper.pdf']);
	await expect(comparisons.locator('.stanza-multi-diff-editor-section')).toHaveCount(5);

	await writeFile(join(cwd, 'main.ts'), 'const value = 2;\n');
	await writeFile(join(cwd, 'other.ts'), 'export const other = true;\n');
	await run('git', ['add', 'main.ts', 'other.ts'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Review all files'], { cwd });
	await history.locator('[data-action-id="ash.git.graph.refresh"] > button').click();
	const latest = history.getByRole('treeitem', { name: /Review all files/ });
	await expect(latest).toBeVisible();
	await latest.hover();
	await latest.getByRole('button', { name: 'Open Changes', exact: true }).click();
	await expect(latest).toHaveAttribute('aria-expanded', 'false');
	await expect(comparisons.locator('.stanza-multi-diff-editor-title')).toHaveText(['main.ts', 'other.ts']);
	await expect(comparisons.locator('.stanza-multi-diff-editor-section')).toHaveCount(2);
	await latest.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Open Changes', exact: true }).click();
	await expect(comparisons.locator('.stanza-multi-diff-editor-title')).toHaveText(['main.ts', 'other.ts']);
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Review all files' })).toHaveCount(1);
});

test('SCM history reserves title width and reveals commit details on pointer and keyboard focus', async ({ application, target, testWorkspace, workbench, restartWorkbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
	const cwd = testWorkspace.directory;
	const subject = 'History metadata: a long title that uses the space previously occupied by the commit hash and date';
	const body = '    The complete explanation remains available without taking space from the history title.';
	await writeFile(join(cwd, 'details.txt'), 'first line\nsecond line\n');
	await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 1, 2]));
	await run('git', ['add', 'details.txt', 'binary.dat'], { cwd });
	await run('git', ['-c', 'user.name=History Author', '-c', 'user.email=history@example.invalid', 'commit', '-m', subject, '-m', body], { cwd });
	await run('git', ['remote', 'add', 'origin', 'https://github.com/ash-test/history.git'], { cwd });
	const { stdout } = await run('git', ['show', '-s', '--format=%H%n%ct', 'HEAD'], { cwd });
	const [hash, timestamp] = stdout.trim().split('\n');
	const page = workbench.page;
	if (target.kind === 'browser') { await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); }
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	const header = history.locator('.ash-pane-view-header');
	await header.click();
	const commit = history.getByRole('treeitem', { name: /History metadata:/u });
	await expect(commit).toBeVisible();
	const sidebar = page.locator('[data-part="sidebar"]');
	const sash = sidebar.locator('xpath=../../..').locator(':scope > .ash-sash').first();
	for (const width of [280, 560]) {
		const sidebarBounds = (await sidebar.boundingBox())!;
		const sashBounds = (await sash.boundingBox())!;
		const x = sashBounds.x + sashBounds.width / 2;
		const y = sashBounds.y + sashBounds.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + width - sidebarBounds.width, y);
		await page.mouse.up();
		await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(width, 0);
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
	const hover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
	await commit.locator('.ash-scm-graph-subject').hover();
	await expect(hover.locator('.ash-scm-graph-hover-subject')).toHaveText(subject);
	await expect(hover.locator('.ash-scm-graph-hover-author > span')).toHaveText('History Author');
	await expect(hover.locator('.ash-scm-graph-hover-author > span')).toHaveAttribute('title', 'history@example.invalid');
	await expect(hover.locator('time')).toHaveAttribute('datetime', new Date(Number(timestamp) * 1000).toISOString());
	await expect(hover.locator('.ash-scm-graph-hover-message')).toHaveText(body);
	expect(await hover.locator('.ash-scm-graph-hover-message').textContent()).toBe(body);
	await expect(hover.locator('.ash-scm-graph-hover-statistics > span')).toHaveText(['2 files changed', '2 insertions(+)', '0 deletions(-)']);
	await expect(hover.locator('.ash-scm-graph-hover-hash')).toHaveAttribute('title', hash);
	const openOnGitHub = hover.getByRole('button', { name: 'Open on GitHub', exact: true });
	await expect(openOnGitHub).toBeVisible();
	await expect(openOnGitHub).toHaveText('Open on GitHub');
	await expect(openOnGitHub.locator('.ash-icon')).toHaveAttribute('aria-hidden', 'true');
	await hover.locator('.ash-scm-graph-hover-message').hover();
	await expect(hover).toBeVisible();
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
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	const localizedHistory = workbench.page.locator('[data-view-id="ash.gitGraph"]');
	await expect(localizedHistory).toBeVisible();
	const localizedCommit = localizedHistory.getByRole('treeitem', { name: /History metadata:/u });
	await localizedCommit.focus();
	await localizedCommit.press('Alt+ArrowDown');
	const localizedHover = workbench.page.getByRole('tooltip').filter({ has: workbench.page.locator('.ash-scm-graph-hover') });
	await expect(localizedHover.getByRole('button', { name: '复制提交哈希', exact: true })).toHaveText('');
	await expect(localizedHover.getByRole('button', { name: '在 GitHub 上打开', exact: true })).toHaveText('在 GitHub 上打开');
});

test('SCM history references and actions overlay long titles without changing row widths', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
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
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
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

test('SCM graph menus copy complete commit information and compare explicit remote and merge bases', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
	await git('remote', 'add', 'origin', 'https://github.com/ash-test/history.git');
	await writeFile(join(cwd, 'main-only.ts'), 'export const main = true;\n');
	await git('add', 'main-only.ts');
	await git('commit', '-m', 'Main side');
	await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
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
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
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
		['Compare with Merge Base…', ['topic-only.ts']],
		['Compare with Remote…', ['main-only.ts', 'topic-only.ts']],
	] as const) {
		await commit.focus();
		await commit.press('Shift+F10');
		await page.getByRole('menuitem', { name: action, exact: true }).click();
		if (action !== 'Compare with Remote…') {
			const picker = page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill('main');
			await picker.locator('.ash-quick-pick-row-label', { hasText: /^main$/u }).click();
		}
		await expect(comparisons.locator('.stanza-multi-diff-editor-title')).toHaveText([...paths]);
	}
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'origin/main' })).toHaveCount(1);
	expect(await git('rev-parse', 'HEAD')).toBe(selected);
	expect(await git('status', '--porcelain')).toBe('');
});

test('SCM graph menus create at an old commit, switch references, delete branches, checkout and cherry-pick', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
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
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	const initial = history.getByRole('treeitem', { name: /Initial/u });
	const latest = history.getByRole('treeitem', { name: /Graph latest/u });
	const enterName = async (name: string) => {
		const input = page.getByRole('dialog', { name: 'Quick Input', exact: true }).getByRole('textbox');
		await input.fill(name);
		await input.press('Enter');
	};
	await initial.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Create Branch…', exact: true }).click();
	await enterName('graph-review');
	await expect.poll(() => git('branch', '--list', 'graph-review')).toBe('graph-review');
	expect(await git('rev-parse', 'refs/heads/graph-review')).toBe(root);
	expect(await git('branch', '--show-current')).toBe('main');
	await initial.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'More…', exact: true }).hover();
	await page.getByRole('menuitem', { name: 'Create Tag…', exact: true }).click();
	await enterName('graph-tag');
	await expect.poll(() => git('tag', '--list', 'graph-tag')).toBe('graph-tag');
	expect(await git('rev-parse', 'refs/tags/graph-tag')).toBe(root);
	const branch = initial.getByRole('button', { name: 'graph-review', exact: true });
	await branch.focus();
	await branch.press('Enter');
	await page.getByRole('menuitem', { name: 'Switch to Branch…', exact: true }).click();
	await expect.poll(() => git('branch', '--show-current')).toBe('graph-review');
	await branch.press('Enter');
	await expect(page.getByRole('menuitem', { name: 'Delete Branch…', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await latest.getByRole('button', { name: 'main', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Switch to Branch…', exact: true }).click();
	await expect.poll(() => git('branch', '--show-current')).toBe('main');
	await workbench.dialogs.confirm(application, 'Delete Branch…', 'Delete', async () => {
		await branch.press('Enter');
		await page.getByRole('menuitem', { name: 'Delete Branch…', exact: true }).click();
	});
	await expect.poll(() => git('branch', '--list', 'graph-review')).toBe('');
	await workbench.dialogs.confirm(application, 'Checkout Commit (Detached)', 'Checkout', async () => {
		await initial.click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Checkout', exact: true }).hover();
		await page.getByRole('menuitem', { name: 'Checkout Commit (Detached)', exact: true }).click();
	});
	await expect.poll(() => git('rev-parse', 'HEAD')).toBe(root);
	expect(await git('branch', '--show-current')).toBe('');
	await expect(initial).toHaveAttribute('aria-current', 'true');
	await latest.getByRole('button', { name: 'origin/latest', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Switch to Branch…', exact: true }).click();
	await enterName('graph-tracked');
	await expect.poll(() => git('branch', '--show-current')).toBe('graph-tracked');
	expect(await git('rev-parse', 'HEAD')).toBe(latestId);
	expect(await git('rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/latest');
	await history.getByRole('treeitem', { name: /Graph pick/u }).click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Cherry Pick', exact: true }).click();
	await expect.poll(() => git('log', '-1', '--format=%s')).toBe('Graph pick');
	expect(await git('show', 'HEAD:picked.ts')).toBe('export const picked = true;');
});

test('SCM history pane opens without a connected repository', async ({ target, workbench }) => {
	test.skip(target.appServerMode === 'required', 'Checks disconnected Workbench hosts.');

	const page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	const changes = page.locator('[data-view-id="ash.gitView"]');
	await expect(changes.locator('.ash-scm-status')).toContainText('source control');
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

	test('SCM groups fold with pointer and keyboard input and retain state after Git refresh', async ({ target, testWorkspace, workbench }) => {
		test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
		const page = workbench.page;
		const cwd = testWorkspace.directory;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const tree = page.getByRole('tree', { name: 'Source control changes' });
		const working = tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-section-label', { hasText: /^Changes$/ }) });
		const staged = tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-section-label', { hasText: /^Staged Changes$/ }) });
		const workingFile = tree.getByRole('button', { name: 'Open changes for main.ts', exact: true });
		const stagedFile = tree.getByRole('button', { name: 'Open staged changes for main.ts', exact: true });
		await expect(workingFile).toBeVisible();
		await expect(stagedFile).toBeVisible();
		const workingRow = tree.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Open changes for main.ts', exact: true }) });
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
		await page.getByRole('textbox', { name: 'Commit message', exact: true }).hover();
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
		const fileRow = tree.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Open changes for main.ts', exact: true }) });
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
		await expect(tree.getByRole('button', { name: 'Open changes for refreshed.ts', exact: true })).toBeVisible();
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
			const selected = tree.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Open staged changes for main.ts', exact: true }) });
			await expect(selected).toHaveAttribute('aria-selected', 'true');
			await expect.poll(() => selected.evaluate(element => {
				const style = getComputedStyle(element);
				const token = style.getPropertyValue('--ash-list-active-selection-background').trim();
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
			const nestedFile = tree.getByRole('button', { name: 'Open staged changes for src/details.ts', exact: true });
			await nestedFile.click();
			const nestedRow = tree.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Open staged changes for src/details.ts', exact: true }) });
			await expect(nestedRow).toHaveAttribute('aria-selected', 'true');
			const nestedForeground = await nestedRow.evaluate(element => getComputedStyle(element).color);
			await expect(nestedFile.locator('.ash-icon-label-description')).toHaveText('src');
			await expect(nestedFile.locator('.ash-icon-label-description')).toHaveCSS('color', nestedForeground);
			await staged.locator('.ash-tree-twistie').click();
			await expect(staged).toHaveAttribute('aria-expanded', 'false');
		}
	});
});
