import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

for (const surface of ['IDE', 'Agent Window']) {
	test(`Speech instructions save to the speech Profile and preserve drafts in ${surface}`, { tag: ['@electron-app-server'] }, async ({ application, target, workbench }) => {
		if (!('evaluate' in application)) throw new Error('This scenario requires the native speech host');
		const profile = await application.evaluate(() => process.env.ASH_HOME);
		if (!profile) throw new Error('Missing isolated speech Profile');
		await expect(workbench.page.getByRole('tab', { name: /Welcome/u }).first()).toBeVisible();
		const page = surface === 'Agent Window' ? await workbench.openAgentsWindow(target.kind) : workbench.page;
		await page.bringToFront();
		if (surface === 'Agent Window') await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const commands = new QuickAccess(page);
		await commands.runCommand('workbench.action.chat.newChat');
		const chat = page.locator(surface === 'Agent Window' ? '.ash-sessions-chat-slot.active:visible .ash-chat' : '.ash-chat-view-pane .ash-chat:visible').first();
		await expect(chat.locator('.stanza-editor-input')).toBeFocused();
		await page.keyboard.insertText('Speech settings draft');
		const editor = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)'));
		for (const kind of ['voice', 'dictation'] as const) {
			await commands.runCommand(kind === 'voice' ? 'workbench.action.chat.configureVoiceInstructions' : 'workbench.action.chat.configureDictationInstructions');
			await expect(page.getByRole('tab', { name: `${kind}.md`, exact: true })).toBeVisible();
			await expect(editor.input).toBeFocused();
			await page.keyboard.insertText(kind === 'voice' ? 'Reply briefly in Chinese.' : 'Project terms: Ash, Stanza and MCP.');
			await editor.input.press('ControlOrMeta+s');
			await expect.poll(() => readFile(join(profile, `${kind}.md`), 'utf8')).toBe(kind === 'voice' ? 'Reply briefly in Chinese.' : 'Project terms: Ash, Stanza and MCP.');
		}
		await writeFile(join(profile, 'voice.md'), 'Changed by another editor.');
		await commands.runCommand('workbench.action.chat.configureVoiceInstructions');
		await editor.waitForEditorContents(text => text === 'Changed by another editor.');
		await expect(editor.input).toBeFocused();
		await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Speech settings draft');
	});
}
