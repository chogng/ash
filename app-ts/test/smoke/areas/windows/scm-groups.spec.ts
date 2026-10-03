import { execFile } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.describe('SCM editor groups', () => {
	test.beforeEach(async ({ target, testWorkspace }) => {
		test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
		test.skip(target.kind === 'browser' && process.env.ASH_PLAYWRIGHT_GIT_REPOSITORY !== '1', 'Requires a Web Git workspace before startup.');
		const cwd = testWorkspace.directory;
		await run('git', ['init', '-b', 'main'], { cwd });
		await run('git', ['add', '.'], { cwd });
		await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'SCM group baseline'], { cwd });
		await writeFile(testWorkspace.file, 'const value = 2;\n');
	});

	test('SCM filenames keep priority over long directories when the sidebar resizes', async ({ testWorkspace, workbench }) => {
		const page = workbench.page;
		const directory = 'app-ts/src/ash/workbench/contrib/scm/browser';
		const path = `${directory}/details.ts`;
		await mkdir(join(testWorkspace.directory, directory), { recursive: true });
		await writeFile(join(testWorkspace.directory, path), 'export const details = 1;\n');
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const open = page.getByRole('button', { name: `Open changes for ${path}`, exact: true });
		await expect(open).toBeVisible();
		await expect(open.locator('.ash-icon-label-text')).toHaveText('details.ts');
		await expect(open.locator('.ash-icon-label-description')).toHaveText(directory);
		const sidebar = page.locator('[data-part="sidebar"]');
		const sash = sidebar.locator('xpath=../../..').locator(':scope > .ash-sash').first();
		const geometry = async () => open.evaluate(element => {
			const name = element.querySelector('.ash-icon-label-text')!;
			const description = element.querySelector('.ash-icon-label-description')!;
			return { nameFits: name.clientWidth >= name.scrollWidth, directoryFits: description.clientWidth >= description.scrollWidth };
		});
		for (const width of [220, 400]) {
			const sidebarBounds = (await sidebar.boundingBox())!;
			const sashBounds = (await sash.boundingBox())!;
			const x = sashBounds.x + sashBounds.width / 2;
			const y = sashBounds.y + sashBounds.height / 2;
			await page.mouse.move(x, y);
			await page.mouse.down();
			await page.mouse.move(x + width - sidebarBounds.width, y);
			await page.mouse.up();
			await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(width, 0);
			await expect.poll(geometry).toEqual({ nameFits: true, directoryFits: false });
		}
		await open.hover();
		await expect(page.locator('.ash-hover')).toContainText(path);
		await open.click();
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'details.ts' })).toHaveCount(1);
	});

	test('SCM and Files share tree indentation and update arrow spacing with file icons', async ({ application, target, testWorkspace, workbench }) => {
		const page = workbench.page;
		await mkdir(join(testWorkspace.directory, 'src'), { recursive: true });
		await writeFile(join(testWorkspace.directory, 'src/details.ts'), 'export const details = 1;\n');
		if (target.kind === 'electron' && 'windows' in application) {
			const home = await application.evaluate(() => process.env.ASH_HOME!);
			await cp('../extensions/theme-seti', join(home, 'extensions', 'theme-seti'), { recursive: true });
			await page.reload();
			await workbench.waitForReady();
		}
		const explorer = page.locator('.ash-explorer');
		const folder = explorer.getByRole('treeitem', { name: 'src', exact: true });
		await folder.locator('.ash-tree-twistie').click();
		const file = explorer.getByRole('treeitem').filter({ has: page.getByText('details.ts', { exact: true }) });
		await expect(file).toBeVisible();
		const hasFileIcons = await file.locator('.ash-file-icon').count() > 0;
		if (target.kind === 'electron') expect(hasFileIcons).toBe(true);
		const metrics = (row: typeof file) => row.evaluate(element => {
			const bounds = element.getBoundingClientRect();
			const twistie = element.querySelector('.ash-tree-twistie')!.getBoundingClientRect();
			const contents = element.querySelector('.ash-tree-contents')!.getBoundingClientRect();
			const guide = element.querySelector('.ash-tree-indent-guide')!.getBoundingClientRect();
			return { arrowWidth: twistie.width, contentOffset: contents.x - bounds.x, guideOffset: guide.x - bounds.x };
		});
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const tree = page.getByRole('tree', { name: 'Source control changes', exact: true });
		const row = tree.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Open changes for src/details.ts', exact: true }) });
		await expect(row).toBeVisible();
		const retained = await row.elementHandle();
		await expect.poll(() => metrics(row)).toEqual({ arrowWidth: hasFileIcons ? 0 : 16, contentOffset: hasFileIcons ? 16 : 38, guideOffset: 16 });

		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		const settings = page.getByRole('dialog', { name: 'Ash Settings' });
		const search = settings.getByRole('searchbox', { name: 'Search settings' });
		await search.fill('@id:workbench.tree.indent');
		const indent = settings.getByRole('spinbutton', { name: 'Tree indentation', exact: true });
		await indent.fill('16');
		await indent.press('Tab');
		await expect.poll(() => metrics(row)).toEqual({ arrowWidth: hasFileIcons ? 0 : 16, contentOffset: hasFileIcons ? 24 : 46, guideOffset: 16 });
		await search.fill('@id:workbench.tree.renderIndentGuides');
		const mode = settings.locator('[data-configuration-key="workbench.tree.renderIndentGuides"]').getByRole('combobox');
		await mode.click();
		await page.getByRole('option', { name: 'None', exact: true }).click();
		await expect(tree).toHaveClass(/ash-tree-indent-guides-none/u);
		await settings.locator('.ash-modal-editor-close').click();
		for (const theme of ['None', 'Seti']) {
			await workbench.quickaccess.runCommand('workbench.action.selectIconTheme');
			await workbench.quickaccess.select(theme);
			const icons = theme === 'Seti' && hasFileIcons;
			const expected = { arrowWidth: icons ? 0 : 16, contentOffset: icons ? 24 : 46, guideOffset: 16 };
			await expect.poll(() => metrics(row)).toEqual(expected);
			expect(await retained!.evaluate(element => element.isConnected)).toBe(true);
			await page.locator('.ash-composite-bar-item[data-action-id="ash.sidebar"]').click();
			await expect(explorer.getByRole('tree')).toHaveClass(/ash-tree-indent-guides-none/u);
			await expect.poll(() => metrics(file)).toEqual(expected);
			await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		}
		const group = tree.getByRole('treeitem').filter({ has: page.getByText('Changes', { exact: true }) });
		await group.locator('.ash-tree-twistie').click();
		await expect(row).toHaveCount(0);
		await group.locator('.ash-tree-twistie').click();
		await row.locator('.ash-scm-change-open').click();
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'details.ts' })).toHaveCount(1);
	});

	test('Git badges and file decorations update together across Explorer, tabs, Open Editors and SCM', async ({ testWorkspace, workbench }) => {
		const page = workbench.page;
		const gitTab = page.locator('.ash-composite-bar-item[data-action-id="ash.git"]');
		const activity = gitTab.locator('.ash-count-badge');
		await expect(activity).toHaveText('1');
		await expect(gitTab).toHaveAttribute('aria-label', 'Git, 1 changed file');
		const explorerLabel = page.locator('.ash-explorer .ash-icon-label').filter({ has: page.getByText('main.ts', { exact: true }) });
		await expect(explorerLabel).toHaveAttribute('aria-label', 'main.ts, Modified');
		await explorerLabel.dblclick();
		const editorLabel = workbench.editors.groupAt(0).tabs.filter({ hasText: 'main.ts' }).locator('.ash-icon-label');
		await expect(editorLabel).toHaveAttribute('aria-label', 'main.ts, Modified');
		await workbench.quickaccess.runCommand('workbench.files.action.focusOpenEditorsView');
		const openEditorLabel = page.locator('.ash-open-editors-label').filter({ hasText: 'main.ts' });
		await expect(openEditorLabel).toHaveAttribute('aria-label', 'main.ts, Modified');
		await gitTab.click();
		await run('git', ['add', 'main.ts'], { cwd: testWorkspace.directory });
		await writeFile(testWorkspace.file, 'const value = 3;\n');
		const sections = page.locator('.ash-scm-section-count');
		await expect(sections).toHaveCount(2);
		await expect(sections).toHaveText(['1', '1']);
		await expect(activity).toHaveText('1');
		await run('git', ['restore', '--staged', '--worktree', 'main.ts'], { cwd: testWorkspace.directory });
		await expect(activity).toHaveCount(0);
		await expect(gitTab).toHaveAttribute('aria-label', 'Git');
		await expect(editorLabel).toHaveAttribute('aria-label', 'main.ts');
		await page.locator('.ash-composite-bar-item[data-action-id="ash.sidebar"]').click();
		await expect(openEditorLabel).toHaveAttribute('aria-label', 'main.ts');
		await expect(explorerLabel).not.toHaveAttribute('aria-label', /Modified/u);
	});

	test('SCM side previews retain focus and reuse the side group for keyboard opens', async ({ testWorkspace, workbench }) => {
		const page = workbench.page;
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
		const original = workbench.editors.groupAt(0);
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		await original.editor.waitForEditorFocus();
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const open = page.getByRole('button', { name: 'Open changes for main.ts', exact: true });
		await expect(open).toBeEnabled();
		await open.click({ modifiers: ['Alt'] });
		await expect(workbench.editors.groups).toHaveCount(2);
		const side = workbench.editors.groupAt(1);
		await expect(side.content.locator('.stanza-diff-editor')).toBeVisible();
		await expect(side.content).toContainText('const value = 2;');
		await expect(page.getByRole('tree', { name: 'Source control changes' })).toBeFocused();
		await writeFile(join(testWorkspace.directory, 'refresh.ts'), 'export const refreshed = true;\n');
		await expect(page.getByRole('button', { name: 'Open changes for refresh.ts', exact: true })).toBeVisible();
		await expect(page.getByRole('tree', { name: 'Source control changes' })).toBeFocused();
		await expect(original.content.locator('.stanza-diff-editor')).toHaveCount(0);
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);

		await page.getByRole('tree', { name: 'Source control changes' }).press('Control+Enter');
		await expect(workbench.editors.groups).toHaveCount(2);
		await expect(side.tabs).toHaveCount(1);
		await expect.poll(() => side.content.evaluate(node => node.contains(document.activeElement))).toBe(true);
		await expect(original.content.locator('.stanza-diff-editor')).toHaveCount(0);
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		await expect(original.content.locator('.stanza-diff-editor')).toHaveCount(0);
	});

	test('SCM Multi Diff splits keep collapse state and closing independent', async ({ workbench }) => {
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		await page.getByRole('button', { name: 'View All Changes', exact: true }).click();
		const original = workbench.editors.groupAt(0);
		await expect(original.content.locator('.stanza-multi-diff-editor-section')).toHaveCount(1);
		await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
		await expect(workbench.editors.groups).toHaveCount(2);
		const side = workbench.editors.groupAt(1);
		await expect(side.content.locator('.stanza-multi-diff-editor-section')).toHaveCount(1);
		await workbench.quickaccess.runCommand('multiDiffEditor.collapseAll');
		await expect(side.content.locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
		await expect(original.content.locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'true');
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect(original.tabs.filter({ hasText: 'Changes' })).toHaveCount(1);
		await expect(original.content.locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'true');
	});

	test('SCM TypeScript test diffs retain file icons and syntax colors', async ({ testWorkspace, workbench }) => {
		const page = workbench.page;
		const filename = 'example.test.ts';
		const file = join(testWorkspace.directory, filename);
		const source = 'import type { Thing } from "./thing.js";\nexport const value: Thing = "before";\n';
		await writeFile(file, source);
		await run('git', ['add', filename], { cwd: testWorkspace.directory });
		await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Add TypeScript test'], { cwd: testWorkspace.directory });
		await writeFile(file, source.replace('before', 'after'));
		await page.locator('.ash-explorer').getByRole('treeitem', { name: filename, exact: true }).dblclick();
		const group = workbench.editors.groupAt(0);
		const fileIcon = group.tabs.filter({ hasText: filename }).locator('.ash-icon-label-icon');
		await expect(fileIcon).toHaveClass(/typescript-lang-file-icon/u);
		const appearance = await fileIcon.evaluate(element => ({ glyph: element.textContent, color: getComputedStyle(element).color }));
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		await page.getByRole('button', { name: `Open changes for ${filename}`, exact: true }).click();
		const editor = group.content.locator('.stanza-diff-editor-side.modified .stanza-editor');
		await expect(editor).toBeVisible();
		const comparison = group.title.locator('.ash-tab.checked');
		const icon = comparison.getByRole('tab').locator('.ash-icon-label-icon');
		await expect(icon).toHaveClass(/typescript-lang-file-icon/u);
		await expect(icon).toHaveAttribute('aria-hidden', 'true');
		expect(await icon.evaluate(element => ({ glyph: element.textContent, color: getComputedStyle(element).color }))).toEqual(appearance);
		const foreground = await editor.evaluate(element => getComputedStyle(element).color);
		for (const lexeme of ['import', 'const', 'after']) {
			const token = editor.locator('.stanza-editor-token').filter({ hasText: lexeme }).first();
			await expect(token).toBeVisible();
			await expect(token).not.toHaveCSS('color', foreground);
		}
		const tab = comparison.getByRole('tab');
		const tabId = await tab.getAttribute('id');
		const panelId = await tab.getAttribute('aria-controls');
		await tab.press('Alt+Enter');
		const pinned = group.title.locator('.ash-sticky-editor-tabs-row .ash-tab.checked');
		await expect(pinned.getByRole('tab')).toHaveAttribute('id', tabId!);
		await expect(pinned.getByRole('tab')).toHaveAttribute('aria-controls', panelId!);
		await expect(pinned.getByRole('tab').locator('.ash-icon-label-icon')).toHaveClass(/typescript-lang-file-icon/u);
	});
});

test.describe('SCM merge editor groups', () => {
	test.use({ gitRepository: true, gitMergeConflict: true });

	test('SCM opens a merge editor to the side and preserves the original file', async ({ target, workbench }) => {
		test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop merge-conflict workspace.');
		const page = workbench.page;
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
		const original = workbench.editors.groupAt(0);
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		await original.editor.waitForEditorFocus();
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const open = page.getByRole('button', { name: 'Open merge conflict in main.ts', exact: true });
		await expect(open).toBeEnabled();
		await open.focus();
		await open.press('Control+Enter');
		await expect(workbench.editors.groups).toHaveCount(2);
		const side = workbench.editors.groupAt(1);
		await expect(side.content.locator('.ash-merge-inputs')).toBeVisible();
		await expect(original.content.locator('.ash-merge-inputs')).toHaveCount(0);
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		await expect.poll(() => side.content.evaluate(node => node.contains(document.activeElement))).toBe(true);
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		await expect(original.content.locator('.ash-merge-inputs')).toHaveCount(0);
	});
});
