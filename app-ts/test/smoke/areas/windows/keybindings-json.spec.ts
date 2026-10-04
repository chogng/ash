import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

async function replaceJson(input: Locator, source: string): Promise<void> {
	await input.press('ControlOrMeta+A');
	await input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, source);
}

test('Keybindings JSON saves the profile file, applies shortcuts after reload and uses Chinese labels', async ({ target, application, workbench, reloadWorkbench, restartWorkbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires Code Preferences');
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	let group = workbench.editors.groupAt(0);
	let tab = group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' });
	await expect(tab).toHaveCount(1);
	await expect(tab.locator('..')).not.toHaveClass(/preview/u);
	await expect(group.editor.input).toBeFocused();
	const source = '// keep this comment\n[{"key":"ctrl+alt+y","command":"workbench.action.openKeyboardShortcuts","args":{"source":"json"}},]\n';
	await replaceJson(group.editor.input, source);
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	if (target.kind === 'electron' && 'windows' in application) {
		const profile = await application.evaluate(() => process.env.ASH_HOME);
		if (!profile) throw new Error('Test profile unavailable');
		await expect.poll(() => readFile(join(profile, 'keybindings.json'), 'utf8')).toBe(source);
	}
	({ workbench } = await reloadWorkbench());
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorContents(content => content === source);
	await group.editor.input.press('Control+Alt+Y');
	await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts', hasNotText: '(JSON)' })).toHaveCount(1);
	await expect(group.content.getByRole('searchbox')).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	group = workbench.editors.groupAt(0);
	await expect(group.tabs.filter({ hasText: '键盘快捷方式（JSON）' })).toHaveCount(1);
	await group.editor.waitForEditorContents(content => content === source);
});

test('Keybindings JSON completes paste command arguments and ordered provider preferences', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Requires product JSON language declarations');
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const group = workbench.editors.groupAt(0);
	const options = group.content.locator('.stanza-editor-completion-option');
	for (const argument of ['kind', 'preferences']) {
		await replaceJson(group.editor.input, `[{"key":"ctrl+alt+y","command":"editor.action.pasteAs","args":{${argument === 'kind' ? '"kind":""' : '"preferences":[""]'}}}]`);
		await group.editor.input.press('ControlOrMeta+End');
		for (let count = 0; count < (argument === 'kind' ? 4 : 5); count++) await group.editor.input.press('ArrowLeft');
		await group.editor.input.press('Control+Space');
		await expect(options.filter({ hasText: 'uri.path.relative' })).toBeVisible();
		const relative = options.filter({ hasText: 'uri.path.relative' });
		const index = Number(await relative.getAttribute('data-completion-index'));
		for (let count = 0; count < index; count++) await group.editor.input.press('ArrowDown');
		await expect(relative).toHaveAttribute('aria-selected', 'true');
		await group.editor.input.press('Enter');
		await group.editor.waitForEditorContents(content => content.includes('uri.path.relative'));
		await workbench.quickaccess.runCommand('workbench.action.files.save');
		await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	}
});

test('Keybindings external changes reload clean models and preserve dirty text on save conflict', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'Uses an external profile-file writer');
	if (!('windows' in application)) throw new Error('Requires Electron');
	const profile = await application.evaluate(() => process.env.ASH_HOME);
	if (!profile) throw new Error('Test profile unavailable');
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const group = workbench.editors.groupAt(0);
	const source = '[{"key":"ctrl+alt+y","command":"workbench.action.openKeyboardShortcuts"}]';
	await writeFile(join(profile, 'keybindings.json'), source);
	await group.editor.waitForEditorContents(content => content === source);
	await replaceJson(group.editor.input, '// unsaved\n' + source);
	await writeFile(join(profile, 'keybindings.json'), '[]');
	await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).toHaveAttribute('data-state', /conflict/u);
	await workbench.dialogs.expectMessage(application, 'File changed on disk', () => workbench.quickaccess.runCommand('workbench.action.files.save'));
	await group.editor.waitForEditorContents(content => content.startsWith('// unsaved'));
	expect(await readFile(join(profile, 'keybindings.json'), 'utf8')).toBe('[]');
});
