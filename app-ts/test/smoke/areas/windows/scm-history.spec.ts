import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.use({ gitRepository: true });

test('SCM history shows Git commits and opens a changed file', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');

	const cwd = testWorkspace.directory;
	await run('git', ['remote', 'add', 'origin', 'https://github.com/ash-test/history.git'], { cwd });
	await run('git', ['branch', 'topic'], { cwd });
	await run('git', ['branch', 'feature'], { cwd });
	await run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd });
	await run('git', ['update-ref', 'refs/remotes/origin/release', 'HEAD'], { cwd });
	const page = workbench.page;
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
		return { subjectVisible: subject.width > 0, separated: subject.right <= badges.left };
	});
	expect(geometry).toEqual({ subjectVisible: true, separated: true });
	await expect(commit.locator('.ash-scm-graph-label .ash-icon').first()).toHaveAttribute('aria-hidden', 'true');
	await expect(commit).toHaveAttribute('aria-current', 'true');
	for (const theme of ['Ash Dark', 'Ash Light', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		await workbench.quickaccess.select(theme);
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
});

test('SCM history pane opens without a connected repository', async ({ target, workbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode === 'required', 'Checks disconnected Workbench hosts.');

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
	test.use({ gitRepository: false });
	test.beforeEach(async ({ target, testWorkspace }) => {
		if (target.appServerMode !== 'required') { return; }
		test.skip(target.kind === 'browser' && process.env.ASH_PLAYWRIGHT_GIT_REPOSITORY !== '1', 'Requires Web Git setup before server startup (ASH_PLAYWRIGHT_GIT_REPOSITORY=1).');
		const cwd = testWorkspace.directory;
		await mkdir(join(cwd, 'src'));
		await writeFile(join(cwd, 'src', 'details.ts'), 'export const details = 1;\n');
		await run('git', ['init', '-b', 'main'], { cwd });
		await run('git', ['add', 'main.ts', 'src/details.ts'], { cwd });
		await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Initial'], { cwd });
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
