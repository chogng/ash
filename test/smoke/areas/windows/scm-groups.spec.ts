import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import type { Workbench } from '../../../automation/workbench.js';

const run = promisify(execFile);
const altKeyLabel = process.platform === 'darwin' ? 'Option' : 'Alt';

const groupChangeFiles = ['root.ts', 'src/one.ts', 'src/nested/two.ts', 'other/three.ts'];

async function prepareGroupChanges(directory: string): Promise<void> {
	await mkdir(join(directory, 'src/nested'), { recursive: true });
	await mkdir(join(directory, 'other'), { recursive: true });
	for (const path of groupChangeFiles) {
		await writeFile(join(directory, path), 'export const value = 1;\n');
	}
	await run('git', ['add', '--', ...groupChangeFiles], { cwd: directory });
	for (const path of groupChangeFiles) {
		await writeFile(join(directory, path), 'export const value = 2;\n');
	}
	await writeFile(join(directory, 'untracked.txt'), 'Keep this untracked file.\n');
}

async function groupRepositoryState(directory: string, files: readonly string[] = ['main.ts', 'untracked.txt', ...groupChangeFiles]): Promise<unknown> {
	const [head, index, status, contents] = await Promise.all([
		run('git', ['rev-parse', 'HEAD'], { cwd: directory }),
		run('git', ['ls-files', '--stage', '-z'], { cwd: directory }),
		run('git', ['status', '--porcelain=v1', '-z'], { cwd: directory }),
		Promise.all(files.map(path => readFile(join(directory, path), 'utf8'))),
	]);
	return { head: head.stdout, index: index.stdout, status: status.stdout, contents };
}

async function bindResourceGroupNavigation(workbench: Workbench): Promise<void> {
	// Each scenario owns its profile; saving the real shortcuts file exercises production binding reload.
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const editor = workbench.editors.groupAt(0).editor;
	const bindings = JSON.stringify([
		{ key: 'ctrl+alt+k', command: 'workbench.scm.action.focusPreviousResourceGroup' },
		{ key: 'ctrl+alt+j', command: 'workbench.scm.action.focusNextResourceGroup' },
	]);
	await editor.input.press('ControlOrMeta+A');
	await editor.input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, bindings);
	await editor.waitForEditorContents(content => content === bindings);
	await workbench.quickaccess.runCommand('workbench.action.files.save');
}

test.describe('SCM editor groups', () => {
	test.use({ gitRepository: true });
	test.beforeEach(async ({ target, testWorkspace }) => {
		test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
		await writeFile(testWorkspace.file, 'const value = 2;\n');
	});

	test('SCM resource group navigation uses saved bindings, reveals groups and preserves collapse in tree and list views', async ({ application, testWorkspace, workbench }) => {
		await prepareGroupChanges(testWorkspace.directory);
		await mkdir(join(testWorkspace.directory, 'bulk'));
		const bulkFiles = Array.from({ length: 40 }, (_, index) => `bulk/${index}.ts`);
		await Promise.all(bulkFiles.map(path => writeFile(join(testWorkspace.directory, path), 'export const bulk = 1;\n')));
		await run('git', ['add', '--', ...bulkFiles], { cwd: testWorkspace.directory });
		await bindResourceGroupNavigation(workbench);
		const page = workbench.page;
		const tree = page.getByRole('tree', { name: 'Source control changes', exact: true });
		const group = (label: string) => tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-section-label').getByText(label, { exact: true }) });
		const focused = async (label: string): Promise<void> => {
			await expect(group(label)).toBeVisible();
			await expect(tree).toBeFocused();
			await expect(tree).toHaveAttribute('aria-activedescendant', (await group(label).getAttribute('id'))!);
			await expect(tree.locator('[aria-selected="true"] .ash-scm-section-label')).toHaveText(label);
		};
		const files = ['main.ts', 'untracked.txt', ...groupChangeFiles, ...bulkFiles];
		const before = await groupRepositoryState(testWorkspace.directory, files);
		await page.keyboard.press('Control+Alt+J');
		await focused('Staged Changes');
		await page.keyboard.press('Control+Alt+J');
		await focused('Changes');
		expect(await group('Changes').evaluate(row => {
			const bounds = row.getBoundingClientRect();
			const viewport = row.closest('[role="tree"]')!.getBoundingClientRect();
			return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
		})).toBe(true);
		await page.keyboard.press('Control+Alt+K');
		await focused('Staged Changes');
		await tree.press('ArrowLeft');
		await expect(group('Staged Changes')).toHaveAttribute('aria-expanded', 'false');
		await page.keyboard.press('Control+Alt+K');
		await focused('Changes');
		await page.keyboard.press('Control+Alt+J');
		await focused('Staged Changes');
		await expect(group('Staged Changes')).toHaveAttribute('aria-expanded', 'false');
		await workbench.menus.select(application, () => page.getByRole('toolbar', { name: 'Source control actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click(), ['View as List']);
		await expect(tree.locator('.ash-scm-folder')).toHaveCount(0);
		await tree.focus();
		await page.keyboard.press('Control+Alt+J');
		await focused('Changes');
		await page.keyboard.press('Control+Alt+J');
		await focused('Staged Changes');
		await expect(group('Staged Changes')).toHaveAttribute('aria-expanded', 'false');
		for (const close of ['Escape', 'button', 'Escape']) {
			const focus = await tree.getAttribute('aria-activedescendant');
			await tree.press('Alt+F1');
			const help = page.getByRole('dialog');
			await expect(help.getByRole('textbox')).toHaveValue(new RegExp(`Previous resource group: Control\\+${altKeyLabel}\\+K[\\s\\S]*Next resource group: Control\\+${altKeyLabel}\\+J`, 'u'));
			if (close === 'button') await help.getByRole('button', { name: 'Close', exact: true }).click();
			else await page.keyboard.press('Escape');
			await expect(help).toHaveCount(0);
			await expect(tree).toBeFocused();
			await expect(tree).toHaveAttribute('aria-activedescendant', focus!);
		}
		expect(await groupRepositoryState(testWorkspace.directory, files)).toEqual(before);
	});

	test('SCM resource group navigation handles a single collapsed group and an empty repository', async ({ testWorkspace, workbench }) => {
		await bindResourceGroupNavigation(workbench);
		const page = workbench.page;
		const tree = page.getByRole('tree', { name: 'Source control changes', exact: true });
		await page.keyboard.press('Control+Alt+J');
		await expect(tree).toBeFocused();
		const group = tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-section-label') });
		await expect(group).toHaveCount(1);
		await tree.press('ArrowLeft');
		const focus = await tree.getAttribute('aria-activedescendant');
		const before = await groupRepositoryState(testWorkspace.directory, ['main.ts']);
		for (const key of ['Control+Alt+J', 'Control+Alt+K']) {
			await page.keyboard.press(key);
			await expect(tree).toHaveAttribute('aria-activedescendant', focus!);
			await expect(group).toHaveAttribute('aria-expanded', 'false');
			await expect(group).toHaveAttribute('aria-selected', 'true');
		}
		expect(await groupRepositoryState(testWorkspace.directory, ['main.ts'])).toEqual(before);
		await writeFile(testWorkspace.file, 'const value = 1;\n');
		await expect(group).toHaveCount(0);
		const empty = await groupRepositoryState(testWorkspace.directory, ['main.ts']);
		const editor = workbench.editors.groupAt(0).editor;
		await editor.input.focus();
		await page.keyboard.press('Control+Alt+J');
		await page.keyboard.press('Control+Alt+K');
		await expect(editor.input).toBeFocused();
		await expect(group).toHaveCount(0);
		expect(await groupRepositoryState(testWorkspace.directory, ['main.ts'])).toEqual(empty);
	});

	test('SCM group Collapse All folds only the target group recursively and survives Git refresh', async ({ application, testWorkspace, workbench }) => {
		await prepareGroupChanges(testWorkspace.directory);
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const tree = page.getByRole('tree', { name: 'Source control changes', exact: true });
		const group = (label: string) => tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-section-label').getByText(label, { exact: true }) });
		const folder = (groupId: string, label: string) => tree.locator(`[role="treeitem"][data-tree-id*='${JSON.stringify(groupId)}']`).filter({ has: page.locator('.ash-scm-folder').getByText(label, { exact: true }) });
		await expect(tree.getByRole('button', { name: 'Open changes for src/nested/two.ts', exact: true })).toBeVisible();
		await expect(tree.getByRole('button', { name: 'Open staged changes for src/nested/two.ts', exact: true })).toBeVisible();
		await expect(group('Changes').locator('.ash-count-badge')).toHaveText('6');
		await expect(group('Staged Changes').locator('.ash-count-badge')).toHaveText('4');
		await tree.focus();
		await tree.press('Home');
		const focus = await tree.getAttribute('aria-activedescendant');
		const selection = await tree.locator('[aria-selected="true"]').evaluateAll(rows => rows.map(row => row.id));
		const before = await groupRepositoryState(testWorkspace.directory);
		await workbench.menus.select(application, () => group('Changes').locator('.ash-scm-section-label').click({ button: 'right' }), ['Collapse All']);
		await expect(group('Changes')).toHaveAttribute('aria-expanded', 'true');
		await expect(folder('changes', 'src')).toHaveAttribute('aria-expanded', 'false');
		await expect(folder('changes', 'other')).toHaveAttribute('aria-expanded', 'false');
		await expect(folder('staged', 'src')).toHaveAttribute('aria-expanded', 'true');
		await expect(tree.getByRole('button', { name: 'Open changes for root.ts', exact: true })).toBeVisible();
		await expect(tree.getByRole('button', { name: 'Open staged changes for root.ts', exact: true })).toBeVisible();
		await expect(tree).toBeFocused();
		await expect(tree).toHaveAttribute('aria-activedescendant', focus!);
		expect(await tree.locator('[aria-selected="true"]').evaluateAll(rows => rows.map(row => row.id))).toEqual(selection);
		expect(await groupRepositoryState(testWorkspace.directory)).toEqual(before);
		await writeFile(join(testWorkspace.directory, 'src/added.ts'), 'export const added = 3;\n');
		await page.getByRole('toolbar', { name: 'Source control actions', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(group('Changes').locator('.ash-count-badge')).toHaveText('7');
		await expect(folder('changes', 'src')).toHaveAttribute('aria-expanded', 'false');
		await folder('changes', 'src').locator('.ash-scm-folder').click();
		await expect(folder('changes', 'nested')).toHaveAttribute('aria-expanded', 'false');
		await expect(tree.getByRole('button', { name: 'Open changes for src/added.ts', exact: true })).toBeVisible();
		await expect(tree.getByRole('button', { name: 'Open changes for src/nested/two.ts', exact: true })).toHaveCount(0);
		await expect(tree.getByRole('button', { name: 'Open staged changes for src/nested/two.ts', exact: true })).toBeVisible();
	});

	test('SCM group Collapse All supports keyboard dismissal and stays out of list mode', async ({ application, testWorkspace, workbench }) => {
		await prepareGroupChanges(testWorkspace.directory);
		const page = workbench.page;
		// Escape and DOM focus need the browser menu; the other cases retain the desktop's default menu.
		if (await workbench.menus.isSystemMenu(application)) {
			await workbench.settingsEditor.openUserSettingsUI();
			await workbench.settingsEditor.selectGroup('workbench');
			await workbench.settingsEditor.selectCategory('layout');
			await workbench.settingsEditor.element.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
			await page.getByRole('option', { name: 'Custom', exact: true }).click();
			await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
			await expect.poll(() => workbench.menus.isSystemMenu(application)).toBe(false);
		}
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const tree = page.getByRole('tree', { name: 'Source control changes', exact: true });
		await expect(tree.getByRole('button', { name: 'Open staged changes for src/nested/two.ts', exact: true })).toBeVisible();
		await tree.focus();
		await tree.press('Home');
		const focus = await tree.getAttribute('aria-activedescendant');
		const before = await groupRepositoryState(testWorkspace.directory);
		if (process.platform === 'darwin') {
			await tree.press('ContextMenu');
			await expect(page.getByRole('menuitem', { name: 'Collapse All', exact: true })).toHaveCount(0);
			await expect(tree.getByRole('button', { name: 'Open staged changes for src/nested/two.ts', exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(tree).toBeFocused();
			await expect(tree).toHaveAttribute('aria-activedescendant', focus!);
		}
		for (const key of ['Shift+F10', 'Control+Shift+F10']) {
			await tree.press(key);
			await expect(page.getByRole('menuitem', { name: 'Collapse All', exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(page.getByRole('menuitem', { name: 'Collapse All', exact: true })).toHaveCount(0);
			await expect(tree).toBeFocused();
			await expect(tree).toHaveAttribute('aria-activedescendant', focus!);
			await expect(tree.getByRole('button', { name: 'Open staged changes for src/nested/two.ts', exact: true })).toBeVisible();
		}
		await tree.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Collapse All', exact: true }).click();
		await expect(tree.getByRole('button', { name: 'Open staged changes for src/nested/two.ts', exact: true })).toHaveCount(0);
		await expect(tree.getByRole('button', { name: 'Open changes for src/nested/two.ts', exact: true })).toBeVisible();
		await expect(tree).toBeFocused();
		await expect(tree).toHaveAttribute('aria-activedescendant', focus!);
		expect(await groupRepositoryState(testWorkspace.directory)).toEqual(before);
		await workbench.menus.select(application, () => page.getByRole('toolbar', { name: 'Source control actions', exact: true }).getByRole('button', { name: 'More Actions', exact: true }).click(), ['View as List']);
		await expect(tree.locator('.ash-scm-folder')).toHaveCount(0);
		await tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-section-label').getByText('Staged Changes', { exact: true }) }).locator('.ash-scm-section-label').click({ button: 'right' });
		await expect(page.getByRole('menuitem', { name: 'Collapse All', exact: true })).toHaveCount(0);
		await tree.focus();
		await tree.press('Home');
		await tree.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: 'Collapse All', exact: true })).toHaveCount(0);
		expect(await groupRepositoryState(testWorkspace.directory)).toEqual(before);
	});

	test('SCM group Collapse All localizes after restarting in Chinese', async ({ application, testWorkspace, workbench, restartWorkbench }) => {
		await prepareGroupChanges(testWorkspace.directory);
		await workbench.quickaccess.runCommand('workbench.action.configureLocale');
		const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
		await picker.getByRole('combobox').fill('简体中文');
		await picker.getByRole('combobox').press('Enter');
		({ application, workbench } = await restartWorkbench());
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const tree = page.getByRole('tree', { name: '源代码管理更改', exact: true });
		await expect(tree.getByRole('button', { name: 'Open staged changes for src/nested/two.ts', exact: true })).toBeVisible();
		await expect(tree).toHaveAttribute('aria-description', /Shift\+F10.*全部折叠/u);
		const before = await groupRepositoryState(testWorkspace.directory);
		await tree.focus();
		await tree.press('Home');
		await workbench.menus.select(application, () => tree.press('Shift+F10'), ['全部折叠']);
		await expect(tree.getByRole('button', { name: 'Open staged changes for src/nested/two.ts', exact: true })).toHaveCount(0);
		await expect(tree.getByRole('button', { name: 'Open changes for src/nested/two.ts', exact: true })).toBeVisible();
		await expect(tree).toBeFocused();
		expect(await groupRepositoryState(testWorkspace.directory)).toEqual(before);
	});

	test('SCM directories fold with the keyboard and retain state across Git refreshes', async ({ testWorkspace, workbench }) => {
		await mkdir(join(testWorkspace.directory, 'src/nested'), { recursive: true });
		await writeFile(join(testWorkspace.directory, 'src/first.ts'), 'export const first = 1;\n');
		await writeFile(join(testWorkspace.directory, 'src/nested/second.ts'), 'export const second = 2;\n');
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const tree = page.getByRole('tree', { name: 'Source control changes', exact: true });
		const folder = tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-folder').filter({ has: page.getByText('src', { exact: true }) }) });
		const first = tree.getByRole('button', { name: 'Open changes for src/first.ts', exact: true });
		await expect(first).toBeVisible();
		await expect(first.locator('xpath=ancestor::*[@role="treeitem"][1]')).toHaveAttribute('aria-level', '3');
		await expect(tree.getByRole('button', { name: 'Open changes for src/nested/second.ts', exact: true }).locator('xpath=ancestor::*[@role="treeitem"][1]')).toHaveAttribute('aria-level', '4');
		await tree.press('Home');
		await tree.press('ArrowDown');
		await expect(folder).toHaveAttribute('aria-expanded', 'true');
		await folder.locator('.ash-scm-folder').click();
		await expect(folder).toHaveAttribute('aria-expanded', 'false');
		await expect(first).toHaveCount(0);
		await writeFile(join(testWorkspace.directory, 'src/third.ts'), 'export const third = 3;\n');
		await expect(page.locator('.ash-scm-section-count')).toHaveText('4');
		await expect(folder).toHaveAttribute('aria-expanded', 'false');
		await expect(first).toHaveCount(0);
		await tree.press('ArrowRight');
		await expect(folder).toHaveAttribute('aria-expanded', 'true');
		await tree.press('Enter');
		await expect(folder).toHaveAttribute('aria-expanded', 'false');
		await tree.press('Space');
		await expect(folder).toHaveAttribute('aria-expanded', 'true');
		await expect(tree.getByRole('button', { name: 'Open changes for src/third.ts', exact: true })).toBeVisible();
		await first.click();
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'first.ts' })).toHaveCount(1);
		await expect(tree).toBeFocused();
	});

	test('Git Quick Diff opens its baseline and updates decorations for unsaved edits', async ({ testWorkspace, workbench }) => {
		const page = workbench.page;
		await workbench.openExplorer();
		await page.locator('.ash-explorer').getByRole('treeitem', { name: /^main\.ts(?:,|$)/u }).dblclick();
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		const marker = page.locator('.stanza-editor-line-decoration.ash-quick-diff-modified');
		await expect(marker).toHaveCount(1);
		await expect.poll(() => marker.evaluate(element => getComputedStyle(element, '::before').width)).toBe('4px');
		await expect(marker).toHaveCSS('cursor', 'pointer');
		await page.emulateMedia({ forcedColors: 'active' });
		await expect.poll(() => marker.evaluate(element => {
			const paint = getComputedStyle(element, '::before').backgroundColor;
			return paint === getComputedStyle(element).color && paint !== 'rgba(0, 0, 0, 0)';
		})).toBe(true);
		await page.emulateMedia({ forcedColors: 'none' });
		await marker.click({ position: { x: 2, y: 8 } });
		const peek = page.locator('.ash-quick-diff-peek');
		await expect(peek).toBeVisible();
		await expect(peek).toContainText('Index — Modified — 1 of 1');
		await expect(peek.locator('.original .stanza-editor-line-text')).toContainText(['const value = 1;']);
		await expect(peek.locator('.modified .stanza-editor-input')).toHaveAttribute('aria-readonly', 'true');
		await workbench.quickaccess.runCommand('scm.quickDiff.close');
		await expect(peek).toHaveCount(0);
		await workbench.quickaccess.runCommand('scm.quickDiff.next');
		await expect(peek).toBeVisible();
		await peek.getByRole('button', { name: 'Close Quick Diff', exact: true }).click();
		await expect(peek).toHaveCount(0);
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+A');
		await page.keyboard.insertText('const value = 1;\n');
		await editor.waitForEditorContents(contents => contents.includes('const value = 1;'));
		await expect(marker).toHaveCount(0);
		await workbench.quickaccess.runCommand('scm.quickDiff.next');
		await expect(editor.element.locator('.stanza-editor-accessibility-status')).toHaveText('No Quick Diff changes');
		await expect(peek).toHaveCount(0);
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 2;\n');
	});

	test('SCM compares edits inside a moved block and exits through the keyboard in a read-only view', async ({ testWorkspace, workbench }) => {
		const block = ['function load(input) {', '  const value = parse(input);', '  return value;', '}'];
		const edited = ['function load(input) {', '  const value = parse(updated);', '  log(value);', '  return value;', '}'];
		const stay = Array.from({ length: 6 }, (_, index) => `stay ${index}`);
		await writeFile(testWorkspace.file, ['head', ...block, ...stay, 'tail'].join('\n'));
		await run('git', ['add', 'main.ts'], { cwd: testWorkspace.directory });
		await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Moved block baseline'], { cwd: testWorkspace.directory });
		await writeFile(testWorkspace.file, ['head', ...stay, ...edited, 'tail'].join('\n'));
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
		const settingsEditor = workbench.editors.groupAt(0).editor;
		await settingsEditor.waitForEditorFocus();
		await settingsEditor.input.press('ControlOrMeta+A');
		await settingsEditor.input.evaluate(element => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', '{ "diffEditor.experimental.showMoves": true, "diffEditor.useInlineViewWhenSpaceIsLimited": false }');
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		});
		await settingsEditor.waitForEditorContents(contents => contents === '{ "diffEditor.experimental.showMoves": true, "diffEditor.useInlineViewWhenSpaceIsLimited": false }');
		await settingsEditor.input.press('ControlOrMeta+S');
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		await page.getByRole('button', { name: 'Open changes for main.ts', exact: true }).click();
		const diff = page.locator('.stanza-diff-editor');
		await diff.locator('.ash-diff-moved-links').getByRole('button').click();
		const comparison = diff.getByRole('toolbar', { name: 'Moved code comparison' });
		await expect(comparison).toContainText('Comparing original lines 2–5 with modified lines 8–12');
		await expect(diff.locator('.ash-diff-revert')).toHaveCount(0);
		await expect(diff.locator('.original .stanza-diff-line-removed')).toHaveCount(1);
		const input = diff.locator('.modified .stanza-editor-input');
		await expect(input).toHaveAttribute('aria-readonly', 'true');
		await input.press('F7');
		const content = diff.getByRole('textbox', { name: 'Difference content' });
		await expect(content).toHaveValue(/Original line 3:.*parse\(input\)/u);
		await content.press('Escape');
		await expect(comparison).toBeVisible();
		await input.press('Escape');
		await expect(comparison).toBeHidden();
		await expect(input).toBeFocused();
		await expect(diff.locator('.original .stanza-diff-line-removed')).toHaveCount(4);
	});

	test('SCM filenames keep full row width under overlay actions when the sidebar resizes', async ({ testWorkspace, workbench }) => {
		const page = workbench.page;
		const directory = 'src/ash/workbench/contrib/scm/browser';
		const path = `${directory}/details.ts`;
		await mkdir(join(testWorkspace.directory, directory), { recursive: true });
		await writeFile(join(testWorkspace.directory, path), 'export const details = 1;\n');
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const open = page.getByRole('button', { name: `Open changes for ${path}`, exact: true });
		await expect(open).toBeVisible();
		await expect(open.locator('.ash-icon-label-text')).toHaveText('details.ts');
		await expect(open.locator('.ash-icon-label-description')).toHaveText(directory);
		const sidebar = page.locator('[data-part="sidebar"]');
		const row = open.locator('xpath=..');
		const actions = row.locator('.ash-scm-change-actions');
		const badge = row.locator('.ash-scm-change-status');
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
			await expect(actions).toBeHidden();
			const resting = await open.boundingBox();
			const status = (await badge.boundingBox())!;
			expect(resting!.x + resting!.width).toBeCloseTo(status.x - 4, 1);
			await open.hover();
			await expect(actions).toBeVisible();
			expect(await open.boundingBox()).toEqual(resting);
			expect(await badge.boundingBox()).toEqual(status);
			const overlay = (await actions.boundingBox())!;
			expect(overlay.x).toBeLessThan(resting!.x + resting!.width);
			expect(overlay.x + overlay.width).toBeCloseTo(status.x - 4, 1);
		}
		await open.hover();
		await expect(page.locator('.ash-hover')).toContainText(path);
		const stage = actions.getByRole('button', { name: `Stage ${path}`, exact: true });
		await stage.hover();
		await expect(page.locator('.ash-hover')).toContainText('Stage');
		await open.focus();
		await page.mouse.move(0, 0);
		await expect(actions).toBeVisible();
		await open.press('Tab');
		await expect(actions.locator(':focus')).toHaveCount(1);
		await expect(badge).toHaveText('U');
		await open.click();
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'details.ts' })).toHaveCount(1);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`SCM inline Open File opens the editable working file from staged changes in ${locale}`, async ({ testWorkspace, workbench, restartWorkbench }) => {
			await run('git', ['add', '--', 'main.ts'], { cwd: testWorkspace.directory });
			await writeFile(testWorkspace.file, 'const value = 3;\n');
			if (locale === 'zh-CN') {
				await workbench.quickaccess.runCommand('workbench.action.configureLocale');
				const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
				await picker.getByRole('combobox').fill('简体中文');
				await picker.getByRole('combobox').press('Enter');
				({ workbench } = await restartWorkbench());
			}
			const page = workbench.page;
			await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
			const tree = page.getByRole('tree', { name: locale === 'zh-CN' ? '源代码管理更改' : 'Source control changes', exact: true });
			const staged = tree.getByRole('button', { name: 'Open staged changes for main.ts', exact: true });
			await staged.click();
			await expect(page.locator('.stanza-diff-editor')).toBeVisible();
			const tabCount = await workbench.editors.groupAt(0).tabs.count();
			await tree.focus();
			await tree.press('Alt+F1');
			await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue(locale === 'zh-CN' ? /行内“打开文件”/u : /inline Open File/u);
			await page.keyboard.press('Escape');
			await staged.hover();
			const openFile = staged.locator('xpath=..').getByRole('button', { name: locale === 'zh-CN' ? '打开文件：main.ts' : 'Open File: main.ts', exact: true });
			await openFile.hover();
			await expect(page.locator('.ash-hover')).toContainText(locale === 'zh-CN' ? '打开文件：main.ts' : 'Open File: main.ts');
			if (locale === 'zh-CN') {
				await staged.focus();
				await staged.press('Tab');
				await expect(openFile).toBeFocused();
				await openFile.press('Enter');
			} else {
				await openFile.click();
			}
			await expect(page.locator('.stanza-diff-editor')).toBeHidden();
			await expect(workbench.editors.groupAt(0).tabs).toHaveCount(tabCount);
			const editor = workbench.editors.groupAt(0).editor;
			await editor.waitForEditorContents(content => content === 'const value = 3;\n');
			await editor.waitForEditorFocus();
			await editor.input.press('ControlOrMeta+A');
			await page.keyboard.insertText('const value = 4;\n');
			await workbench.quickaccess.runCommand('workbench.action.files.save');
			await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const value = 4;\n');
			expect((await run('git', ['show', ':main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('const value = 2;\n');
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`SCM diff title actions navigate changes and reuse file preview tabs in ${locale}`, async ({ testWorkspace, workbench, restartWorkbench }) => {
			const original = Array.from({ length: 24 }, (_, index) => `const line${index + 1} = ${index + 1};`);
			await writeFile(testWorkspace.file, `${original.join('\n')}\n`);
			await run('git', ['add', '--', 'main.ts'], { cwd: testWorkspace.directory });
			await run('git', ['commit', '-m', 'Prepare separated changes'], { cwd: testWorkspace.directory });
			const modified = [...original];
			modified[1] = 'const line2 = 200;';
			modified[19] = 'const line20 = 2000;';
			await writeFile(testWorkspace.file, `${modified.join('\n')}\n`);
			await writeFile(join(testWorkspace.directory, 'other.ts'), 'export const other = 1;\n');
			if (locale === 'zh-CN') {
				await workbench.quickaccess.runCommand('workbench.action.configureLocale');
				const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
				await picker.getByRole('combobox').fill('简体中文');
				await picker.getByRole('combobox').press('Enter');
				({ workbench } = await restartWorkbench());
			}
			const page = workbench.page;
			await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
			const tree = page.getByRole('tree', { name: locale === 'zh-CN' ? '源代码管理更改' : 'Source control changes', exact: true });
			await tree.getByRole('button', { name: 'Open changes for main.ts', exact: true }).click();
			const group = workbench.editors.groupAt(0);
			const diff = group.content.locator('.stanza-diff-editor:visible');
			await expect(diff).toBeVisible();
			const next = group.title.getByRole('button', { name: locale === 'zh-CN' ? '转到下一个更改' : 'Go to Next Change', exact: true });
			const previous = group.title.getByRole('button', { name: locale === 'zh-CN' ? '转到上一个更改' : 'Go to Previous Change', exact: true });
			const location = diff.locator('.stanza-diff-editor-accessibility-status');
			const collapse = group.title.getByRole('button', { name: locale === 'zh-CN' ? '切换折叠未变更区域' : 'Toggle Collapse Unchanged Regions', exact: true });
			await expect(collapse.locator('svg')).toHaveAttribute('data-ash-icon-id', 'map');
			await expect(collapse).toHaveAttribute('aria-pressed', 'false');
			await expect(diff.locator('.ash-diff-hidden-region')).toHaveCount(0);
			await collapse.hover();
			await expect(page.locator('.ash-hover')).toContainText(locale === 'zh-CN' ? '切换折叠未变更区域' : 'Toggle Collapse Unchanged Regions');
			await collapse.click();
			await expect(collapse).toHaveAttribute('aria-pressed', 'true');
			await expect.poll(() => diff.locator('.ash-diff-hidden-region').count()).toBeGreaterThan(0);
			await group.title.getByRole('button', { name: locale === 'zh-CN' ? '打开文件' : 'Open File', exact: true }).click();
			await group.editor.waitForEditorContents(content => content.includes('const line2 = 200;'));
			await tree.getByRole('button', { name: 'Open changes for main.ts', exact: true }).click();
			await expect(collapse).toHaveAttribute('aria-pressed', 'true');
			await expect.poll(() => diff.locator('.ash-diff-hidden-region').count()).toBeGreaterThan(0);
			await collapse.focus();
			await collapse.press('Space');
			await expect(collapse).toHaveAttribute('aria-pressed', 'false');
			await expect(diff.locator('.ash-diff-hidden-region')).toHaveCount(0);
			await expect(location).toContainText(locale === 'zh-CN' ? '第 1 处差异' : 'Change 1 of');
			await next.click();
			await expect(location).toContainText(locale === 'zh-CN' ? '第 2 处差异' : 'Change 2 of');
			await previous.focus();
			await previous.press('Enter');
			await expect(location).toContainText(locale === 'zh-CN' ? '第 1 处差异' : 'Change 1 of');
			const tabCount = await group.tabs.count();
			const openFile = group.title.getByRole('button', { name: locale === 'zh-CN' ? '打开文件' : 'Open File', exact: true });
			await expect(openFile.locator('svg')).toHaveAttribute('data-ash-icon-id', 'go-to-file');
			await openFile.hover();
			await expect(page.locator('.ash-hover')).toContainText(locale === 'zh-CN' ? '打开文件' : 'Open File');
			await openFile.click();
			await group.editor.waitForEditorContents(content => content.includes('const line2 = 200;') && content.includes('const line20 = 2000;'));
			await expect(group.tabs).toHaveCount(tabCount);
			await expect(next).toHaveCount(0);
			await expect(collapse).toHaveCount(0);
			const openWorkingFile = async (path: string): Promise<void> => {
				const row = tree.getByRole('button', { name: `Open changes for ${path}`, exact: true });
				await row.hover();
				await row.locator('xpath=..').getByRole('button', { name: locale === 'zh-CN' ? `打开文件：${path}` : `Open File: ${path}`, exact: true }).click();
			};
			await openWorkingFile('other.ts');
			await group.editor.waitForEditorContents(content => content === 'export const other = 1;\n');
			await expect(group.tabs).toHaveCount(tabCount);
			await openWorkingFile('main.ts');
			await group.editor.waitForEditorFocus();
			await group.editor.input.press('ControlOrMeta+End');
			await page.keyboard.insertText('// unsaved edit');
			await expect(group.tabs.filter({ hasText: 'main.ts' })).toHaveAttribute('aria-label', locale === 'zh-CN' ? /未保存的更改/u : /unsaved changes/u);
			await openWorkingFile('other.ts');
			await expect(group.tabs).toHaveCount(tabCount + 1);
			await openWorkingFile('main.ts');
			await group.editor.waitForEditorContents(content => content.includes('// unsaved edit'));
			await expect(group.tabs).toHaveCount(tabCount + 1);
			expect(await readFile(testWorkspace.file, 'utf8')).not.toContain('// unsaved edit');
		});
	}

	test('SCM Open File reveals an existing file in another editor group', async ({ testWorkspace, workbench }) => {
		await writeFile(join(testWorkspace.directory, 'other.ts'), 'export const other = 1;\n');
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const tree = page.getByRole('tree', { name: 'Source control changes', exact: true });
		const openFile = async (path: string): Promise<void> => {
			const row = tree.getByRole('button', { name: `Open changes for ${path}`, exact: true });
			await row.hover();
			await row.locator('xpath=..').getByRole('button', { name: `Open File: ${path}`, exact: true }).click();
		};
		await openFile('main.ts');
		await workbench.editors.groupAt(0).editor.waitForEditorContents(content => content === 'const value = 2;\n');
		await expect(workbench.editors.groupAt(0).editor.input).toBeFocused();
		await workbench.quickaccess.runCommand('workbench.action.keepEditor');
		await openFile('other.ts');
		await workbench.editors.groupAt(0).editor.waitForEditorContents(content => content === 'export const other = 1;\n');
		await expect(workbench.editors.groupAt(0).editor.input).toBeFocused();
		await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
		await expect(workbench.editors.groups).toHaveCount(2);
		const first = workbench.editors.groupAt(0);
		const second = workbench.editors.groupAt(1);
		const otherTab = first.tabs.filter({ hasText: 'other.ts' });
		await otherTab.hover();
		await otherTab.locator('xpath=..').locator('.ash-tab-close-action button').click();
		await second.tabs.filter({ hasText: 'other.ts' }).click();
		const count = await first.tabs.count() + await second.tabs.count();
		await openFile('main.ts');
		await expect(first.tabs.filter({ hasText: 'main.ts' })).toHaveAttribute('aria-selected', 'true');
		await expect(second.tabs.filter({ hasText: 'main.ts' })).toHaveCount(0);
		await expect(first.editor.input).toBeFocused();
		expect(await first.tabs.count() + await second.tabs.count()).toBe(count);
	});

	test('SCM and Files share tree indentation and update arrow spacing with file icons', async ({ application, target, testWorkspace, workbench }) => {
		const page = workbench.page;
		await mkdir(join(testWorkspace.directory, 'src'), { recursive: true });
		await writeFile(join(testWorkspace.directory, 'src/details.ts'), 'export const details = 1;\n');
		if (target.kind === 'electron' && 'windows' in application) {
			const home = await application.evaluate(() => process.env.ASH_HOME!);
			await cp('extensions/theme-seti', join(home, 'extensions', 'theme-seti'), { recursive: true });
			await page.reload();
			await workbench.waitForReady();
		}
		await workbench.openExplorer();
		const explorer = page.locator('.ash-explorer');
		const folder = explorer.getByRole('treeitem', { name: /^src(?:,|$)/u });
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
		await expect.poll(() => metrics(row)).toEqual({ arrowWidth: hasFileIcons ? 0 : 16, contentOffset: hasFileIcons ? 24 : 46, guideOffset: 16 });

		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		const settings = page.getByRole('dialog', { name: 'Ash Settings' });
		const search = settings.getByRole('searchbox', { name: 'Search settings' });
		await search.fill('@id:workbench.tree.indent');
		const indent = settings.getByRole('spinbutton', { name: 'Tree indentation', exact: true });
		await indent.fill('16');
		await indent.press('Tab');
		await expect.poll(() => metrics(row)).toEqual({ arrowWidth: hasFileIcons ? 0 : 16, contentOffset: hasFileIcons ? 40 : 62, guideOffset: 16 });
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
			const expected = { arrowWidth: icons ? 0 : 16, contentOffset: icons ? 40 : 62, guideOffset: 16 };
			await expect.poll(() => metrics(row)).toEqual(expected);
			expect(await retained!.evaluate(element => element.isConnected)).toBe(true);
			await page.locator('.ash-composite-bar-item[data-action-id="ash.sidebar"]').click();
			await expect(explorer.getByRole('tree')).toHaveClass(/ash-tree-indent-guides-none/u);
			await expect.poll(() => metrics(file)).toEqual({ ...expected, contentOffset: icons ? 24 : 46 });
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
		await workbench.openExplorer();
		await page.locator('.ash-explorer').getByRole('treeitem', { name: /^main\.ts(?:,|$)/u }).dblclick();
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

	for (const locale of ['en', 'zh-CN']) {
		test(`SCM Multi Diff shares diff title actions and unchanged-region settings in ${locale}`, async ({ testWorkspace, workbench, restartWorkbench, reloadWorkbench }) => {
			const otherFile = join(testWorkspace.directory, 'other.ts');
			const original = Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1};`);
			await writeFile(testWorkspace.file, `${original.join('\n')}\n`);
			await writeFile(otherFile, `${original.join('\n')}\n`);
			await run('git', ['add', '--', 'main.ts', 'other.ts'], { cwd: testWorkspace.directory });
			await run('git', ['commit', '-m', 'Prepare multi diff hidden regions'], { cwd: testWorkspace.directory });
			const modified = [...original];
			modified[1] = 'const line2 = 200;';
			modified[31] = 'const line32 = 3200;';
			await writeFile(testWorkspace.file, `${modified.join('\n')}\n`);
			await writeFile(otherFile, `${modified.join('\n')}\n`);
			if (locale === 'zh-CN') {
				await workbench.quickaccess.runCommand('workbench.action.configureLocale');
				const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
				await picker.getByRole('combobox').fill('简体中文');
				await picker.getByRole('combobox').press('Enter');
				({ workbench } = await restartWorkbench());
			} else {
				// Start from the completed Git fixture rather than its intermediate commit statuses.
				({ workbench } = await reloadWorkbench());
			}
			const page = workbench.page;
			await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
			await page.getByRole('button', { name: 'View All Changes', exact: true }).click();
			const group = workbench.editors.groupAt(0);
			const multi = group.content.locator('.stanza-multi-diff-editor');
			await expect(multi).toBeVisible();
			const multiTabId = await group.title.locator('[role="tab"][aria-selected="true"]').getAttribute('id');
			const collapse = group.title.getByRole('button', { name: locale === 'zh-CN' ? '切换折叠未变更区域' : 'Toggle Collapse Unchanged Regions', exact: true });
			const next = group.title.getByRole('button', { name: locale === 'zh-CN' ? '转到下一个更改' : 'Go to Next Change', exact: true });
			const previous = group.title.getByRole('button', { name: locale === 'zh-CN' ? '转到上一个更改' : 'Go to Previous Change', exact: true });
			const openFile = group.title.getByRole('button', { name: locale === 'zh-CN' ? '打开文件' : 'Open File', exact: true });
			await expect(collapse.locator('svg')).toHaveAttribute('data-ash-icon-id', 'map');
			await expect(openFile.locator('svg')).toHaveAttribute('data-ash-icon-id', 'go-to-file');
			const positions = await Promise.all([previous, next, collapse, openFile].map(button => button.boundingBox()));
			expect(positions.every((box, index) => box && (index === 0 || box.x > positions[index - 1]!.x))).toBe(true);
			await expect(collapse).toHaveAttribute('aria-pressed', 'false');
			await collapse.hover();
			await expect(page.locator('.ash-hover')).toContainText(locale === 'zh-CN' ? '切换折叠未变更区域' : 'Toggle Collapse Unchanged Regions');
			await collapse.click();
			await expect(collapse).toHaveAttribute('aria-pressed', 'true');
			await expect.poll(() => multi.locator('.ash-diff-hidden-region').count()).toBeGreaterThan(0);
			const location = multi.locator('.stanza-multi-diff-editor-accessibility-status');
			await expect(location).toContainText('main.ts');
			await next.click();
			await expect(location).toContainText(locale === 'zh-CN' ? '第 2 处差异' : 'Change 2 of');
			const changedLine = multi.locator('.stanza-editor-line-text').filter({ hasText: /const line32\s*=\s*3200;/u }).first();
			await expect.poll(async () => {
				const line = await changedLine.boundingBox();
				const viewport = await multi.boundingBox();
				return Boolean(line && viewport && line.y >= viewport.y && line.y + line.height <= viewport.y + viewport.height);
			}).toBe(true);
			await next.click();
			await expect(location).toContainText('other.ts');
			await expect(multi.locator('.stanza-multi-diff-editor-section.active')).toContainText('other.ts');
			await expect.poll(() => multi.locator('.stanza-multi-diff-editor-section.active .ash-diff-hidden-region').count()).toBeGreaterThan(0);
			const count = await group.tabs.count();
			await openFile.click();
			await expect(group.tabs.filter({ hasText: 'other.ts' })).toHaveAttribute('aria-selected', 'true');
			await expect(group.content.locator('.stanza-editor:visible')).toHaveCount(1);
			await group.editor.waitForEditorContents(content => content.includes('const line2 = 200;'));
			await expect(group.tabs).toHaveCount(count + 1);
			const tree = page.getByRole('tree', { name: locale === 'zh-CN' ? '源代码管理更改' : 'Source control changes', exact: true });
			await tree.getByRole('button', { name: 'Open changes for other.ts', exact: true }).click();
			await expect(collapse).toHaveAttribute('aria-pressed', 'true');
			await expect.poll(() => group.content.locator('.ash-diff-hidden-region').count()).toBeGreaterThan(0);
			await collapse.focus();
			await collapse.press('Space');
			await expect(collapse).toHaveAttribute('aria-pressed', 'false');
			await expect(group.content.locator('.ash-diff-hidden-region')).toHaveCount(0);
			await page.locator(`[id="${multiTabId}"]`).click();
			await expect(multi).toBeVisible();
			await expect(collapse).toHaveAttribute('aria-pressed', 'false');
			await expect(multi.locator('.ash-diff-hidden-region')).toHaveCount(0);
		});
	}

	test('SCM diff synchronizes both sides and keeps its scroll when leaving inline view', async ({ testWorkspace, workbench, reloadWorkbench, runningApplication }) => {
		const lines = Array.from({ length: 120 }, (_, index) => `const line${index + 1} = ${index + 1};`);
		await writeFile(testWorkspace.file, `${lines.slice(0, 8).join('\n')}\n`);
		await run('git', ['add', '--', 'main.ts'], { cwd: testWorkspace.directory });
		await run('git', ['commit', '-m', 'Prepare diff scroll synchronization'], { cwd: testWorkspace.directory });
		await writeFile(testWorkspace.file, `${lines.join('\n')}\n`);
		({ workbench } = await reloadWorkbench());
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		await page.getByRole('button', { name: 'Open changes for main.ts', exact: true }).click();
		await runningApplication.driver.setWindowSize({ width: 1600, height: 1000 });
		await workbench.quickaccess.runCommand('workbench.action.toggleSideBar');
		const diff = workbench.editors.groupAt(0).content.locator('.stanza-diff-editor:visible');
		await expect(diff).not.toHaveClass(/inline-view/u);
		await workbench.quickaccess.runCommand('toggle.diff.renderSideBySide');
		await expect(diff).toHaveClass(/inline-view/u);
		const viewport = (side: string) => diff.locator(`.stanza-diff-editor-side.${side} .stanza-editor > .ash-smooth-scrollable`);
		await viewport('modified').evaluate(element => { element.scrollTop = 1000; element.dispatchEvent(new Event('scroll')); });
		await expect.poll(() => viewport('modified').evaluate(element => element.scrollTop)).toBe(1000);
		await workbench.quickaccess.runCommand('toggle.diff.renderSideBySide');
		await expect(diff).not.toHaveClass(/inline-view/u);
		await expect.poll(async () => Promise.all(['original', 'modified'].map(side => viewport(side).evaluate(element => element.scrollTop)))).toEqual([1000, 1000]);
		for (const [side, top] of [['original', 600], ['modified', 900]] as const) {
			await viewport(side).evaluate((element, top) => { element.scrollTop = top; element.dispatchEvent(new Event('scroll')); }, top);
			await expect.poll(async () => Promise.all(['original', 'modified'].map(side => viewport(side).evaluate(element => element.scrollTop)))).toEqual([top, top]);
		}
	});

	for (const multiDiff of [false, true]) {
		test(`SCM ${multiDiff ? 'multi diff' : 'diff'} initially reveals the first change and keeps its position across tab switches`, async ({ testWorkspace, workbench, reloadWorkbench, runningApplication }) => {
			const original = Array.from({ length: 120 }, (_, index) => `const line${index + 1} = ${index + 1};`);
			await writeFile(testWorkspace.file, `${original.join('\n')}\n`);
			await run('git', ['add', '--', 'main.ts'], { cwd: testWorkspace.directory });
			await run('git', ['commit', '-m', 'Prepare initial diff navigation'], { cwd: testWorkspace.directory });
			const modified = [...original];
			modified[59] = 'const line60 = 6000;';
			modified[99] = 'const line100 = 10000;';
			await writeFile(testWorkspace.file, `${modified.join('\n')}\n`);
			({ workbench } = await reloadWorkbench());
			const page = workbench.page;
			await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
			await page.getByRole('button', { name: multiDiff ? 'View All Changes' : 'Open changes for main.ts', exact: true }).click();
			await runningApplication.driver.setWindowSize({ width: 1600, height: 1000 });
			await workbench.quickaccess.runCommand('workbench.action.toggleSideBar');
			const group = workbench.editors.groupAt(0);
			const comparison = group.content.locator(multiDiff ? '.stanza-multi-diff-editor' : '.stanza-diff-editor:visible');
			const location = comparison.locator(multiDiff ? '.stanza-multi-diff-editor-accessibility-status' : '.stanza-diff-editor-accessibility-status');
			await expect(location).toContainText('Change 1 of');
			const tabId = await group.title.locator('[role="tab"][aria-selected="true"]').getAttribute('id');
			if (!multiDiff) {
				await workbench.quickaccess.runCommand('workbench.action.keepEditor');
			}
			const lineIsVisible = async (lineNumber: number): Promise<boolean> => {
				const lines = await Promise.all(['original', 'modified'].map(side => comparison.locator(`.stanza-diff-editor-side.${side} .stanza-editor-line-text`).filter({ hasText: new RegExp(`const line${lineNumber}\\s*=`, 'u') }).first().boundingBox()));
				const viewport = await comparison.boundingBox();
				return Boolean(viewport && lines.every(line => line && line.y >= viewport.y && line.y + line.height <= viewport.y + viewport.height) && Math.abs(lines[0]!.y - lines[1]!.y) < 1);
			};
			await expect.poll(() => lineIsVisible(60)).toBe(true);
			await group.title.getByRole('button', { name: 'Go to Next Change', exact: true }).click();
			await expect(location).toContainText('Change 2 of');
			await expect.poll(() => lineIsVisible(100)).toBe(true);
			await group.title.getByRole('button', { name: 'Open File', exact: true }).click();
			await expect(group.content.locator('.stanza-diff-editor:visible')).toHaveCount(0);
			await page.locator(`[id="${tabId}"]`).click();
			await expect(location).toContainText('Change 2 of');
			await expect.poll(() => lineIsVisible(100)).toBe(true);
		});
	}

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
		for (const lexeme of ['import', 'const']) {
			const token = editor.locator('.stanza-editor-token').filter({ hasText: lexeme }).first();
			await expect(token).toBeVisible();
			await expect(token).not.toHaveCSS('color', foreground);
		}
		// Character-level changes split a string into several colored spans.
		const modifiedString = editor.locator('.view-line[data-line-index="1"] .token-string');
		await expect.poll(async () => (await modifiedString.allTextContents()).join('')).toBe('after');
		const removed = editor.locator('.stanza-diff-inline-original-line');
		await expect(removed).toHaveAttribute('aria-label', 'Removed line 2: export const value: Thing = "before";');
		const removedMarker = editor.locator('.ash-diff-inline-original-margin .ash-icon');
		await expect(removedMarker).toBeVisible();
		await expect(removedMarker).toHaveAttribute('data-ash-icon-id', 'diff-remove');
		await expect(removedMarker).toHaveAttribute('aria-hidden', 'true');
		const originalString = removed.locator('.token-string');
		await expect.poll(async () => (await originalString.allTextContents()).join('')).toBe('before');
		await expect.poll(async () => (await removed.locator('.stanza-diff-inline-removed').allTextContents()).join('')).toBe('bfoe');
		for (const tokens of [modifiedString, originalString]) {
			for (const token of await tokens.all()) await expect(token).not.toHaveCSS('color', foreground);
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
		await workbench.openExplorer();
		await page.locator('.ash-explorer').getByRole('treeitem', { name: /^main\.ts(?:,|$)/u }).dblclick();
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

test.describe('SCM resource group navigation with conflicts', () => {
	test.use({ gitRepository: true, gitMergeConflict: true });
	test('SCM resource group navigation cycles all three real Git groups and localizes help after restart', async ({ target, testWorkspace, workbench, restartWorkbench }) => {
		test.skip(target.appServerMode !== 'required', 'Requires real Git conflict, index and worktree groups.');
		await prepareGroupChanges(testWorkspace.directory);
		await bindResourceGroupNavigation(workbench);
		await workbench.quickaccess.runCommand('workbench.action.configureLocale');
		const picker = workbench.page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill('简体中文');
		await picker.getByRole('combobox').press('Enter');
		({ workbench } = await restartWorkbench());
		const page = workbench.page;
		const tree = page.getByRole('tree', { name: '源代码管理更改', exact: true });
		const group = (label: string) => tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-section-label').getByText(label, { exact: true }) });
		const before = await groupRepositoryState(testWorkspace.directory);
		await page.keyboard.press('Control+Alt+K');
		await expect(group('Merge Changes')).toHaveAttribute('aria-selected', 'true');
		await tree.press('ArrowLeft');
		for (const [key, label] of [
			['Control+Alt+K', 'Changes'],
			['Control+Alt+J', 'Merge Changes'],
			['Control+Alt+J', 'Staged Changes'],
			['Control+Alt+J', 'Changes'],
			['Control+Alt+J', 'Merge Changes'],
		]) {
			await page.keyboard.press(key!);
			await expect(group(label!)).toHaveAttribute('aria-selected', 'true');
			await expect(tree).toBeFocused();
			await expect(tree).toHaveAttribute('aria-activedescendant', (await group(label!).getAttribute('id'))!);
		}
		await expect(group('Merge Changes')).toHaveAttribute('aria-expanded', 'false');
		await expect(tree).toHaveAttribute('aria-description', /上一个资源分组.*focusPreviousResourceGroup/u);
		await tree.press('Alt+F1');
		await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue(new RegExp(`上一个资源分组：Control\\+${altKeyLabel}\\+K[\\s\\S]*下一个资源分组：Control\\+${altKeyLabel}\\+J`, 'u'));
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(tree).toBeFocused();
		expect(await groupRepositoryState(testWorkspace.directory)).toEqual(before);
	});
});
