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

test('runCommands executes a saved shortcut in order and stops on a failed command', async ({ workbench, reloadWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	let group = workbench.editors.groupAt(0);
	await replaceJson(group.editor.input, JSON.stringify([
		{
			key: 'ctrl+alt+y', command: 'runCommands', when: String.raw`true && !false && resourceFilename =~ /keybindings[.]json$/`, args: {
				commands: [
					'workbench.action.files.newUntitledFile',
					{ command: 'workbench.action.files.newUntitledFile', args: [] },
				]
			}
		},
		{
			key: 'ctrl+alt+z', command: 'runCommands', args: {
				commands: [
					'workbench.action.files.newUntitledFile',
					'ash.test.missingCommand',
					'workbench.action.files.newUntitledFile',
				]
			}
		},
	]));
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	({ workbench } = await reloadWorkbench());
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	group = workbench.editors.groupAt(0);
	await group.editor.input.press('Control+Alt+Y');
	await expect(group.element.getByRole('tab', { name: /^Untitled-/u })).toHaveCount(2);
	await expect(group.element.getByRole('tab', { name: 'Untitled-2', exact: true })).toHaveAttribute('aria-selected', 'true');
	await group.editor.input.press('Control+Alt+Z');
	await expect(workbench.page.locator('.ash-notification', { hasText: 'Unknown command: ash.test.missingCommand' })).toBeVisible();
	await expect(group.element.getByRole('tab', { name: /^Untitled-/u })).toHaveCount(3);
	await expect(group.element.getByRole('tab', { name: 'Untitled-3', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('runCommands loads in Sessions and executes the saved shortcut through its editor services', async ({ target, workbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const group = workbench.editors.groupAt(0);
	await replaceJson(group.editor.input, JSON.stringify([
		{ key: 'ctrl+alt+y', command: 'runCommands', args: { commands: [
			'sessions.open.code',
			'workbench.action.files.newUntitledFile',
			{ command: 'workbench.action.files.newUntitledFile', args: [] },
		] } },
	]));
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(group.tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	const page = await workbench.openAgentsWindow(target.kind);
	await page.keyboard.press('Control+Alt+Y');
	const editors = page.locator('[data-part="editor"]');
	await expect(editors.getByRole('tab', { name: /^Untitled-/u })).toHaveCount(2);
	await expect(editors.getByRole('tab', { name: 'Untitled-2', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(editors.getByRole('textbox', { name: 'Untitled-2', exact: true })).toBeVisible();
});

test('Keybindings JSON saves the profile file, applies shortcuts after reload and uses Chinese labels', async ({ target, application, workbench, reloadWorkbench, restartWorkbench }) => {
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

test('runCommands offers command names and nested batch arguments in Keybindings JSON', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires product JSON language declarations');
	await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
	const group = workbench.editors.groupAt(0);
	const commandNames = '[{"key":"ctrl+alt+y","command":"runCommands","args":{"commands":["run"]}}]';
	const nestedArguments = '[{"key":"ctrl+alt+y","command":"runCommands","args":{"commands":[{"command":"runCommands","args":{}}]}}]';
	for (const [source, offset, suggestion] of [
		[commandNames, commandNames.indexOf('["run"]') + '["run'.length, 'runCommands'],
		[nestedArguments, nestedArguments.lastIndexOf('{}') + 1, 'commands'],
	] as const) {
		await replaceJson(group.editor.input, source);
		await group.editor.input.press('ControlOrMeta+End');
		for (let count = offset; count < source.length; count++) await group.editor.input.press('ArrowLeft');
		await group.editor.input.press('Control+Space');
		await expect(group.content.locator('.stanza-editor-completion-option').filter({ hasText: suggestion })).toBeVisible();
		await group.editor.input.press('Escape');
	}
});

test('Keybindings JSON completes paste command arguments and ordered provider preferences', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires product JSON language declarations');
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
	test.skip(target.kind !== 'electron', 'Uses an external profile-file writer');
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
