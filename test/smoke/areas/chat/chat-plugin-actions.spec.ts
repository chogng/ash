import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, writeEditorExtensionFixture } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Workbench } from '../../../automation/workbench.js';

for (const surface of ['IDE', 'Agent Window']) {
	test(`Chat Plugins opens the installed catalog with keyboard navigation in ${surface}`, { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, testWorkspace, workbench }, testInfo) => {
		const root = join(testWorkspace.directory, 'chat-plugin-fixture');
		await mkdir(join(root, '.ash-plugin'), { recursive: true });
		await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
			schemaVersion: 1, id: 'acme/chat-plugin', version: '1.0.0', displayName: 'Chat plugin fixture',
			compatibility: { ash: '>=0.1.0' }, permissions: [],
			contributions: {
				editorExtensions: [{
					id: 'fixture', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1,
					activationEvents: [{ type: 'startup' }], capabilities: ['command'],
				}]
			},
		}));
		await writeEditorExtensionFixture(root, 'exports.activate = () => {};');
		const source = workbench.page;
		await workbench.waitForReady();
		await workbench.quickaccess.runCommand('ash.extensions.installLocal');
		const installation = source.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
		await installation.getByRole('textbox').fill('chat-plugin-fixture');
		const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
		expect(installed.message).toContain('Installed acme/chat-plugin 1.0.0');

		const page = surface === 'Agent Window' ? await workbench.openAgentsWindow(target.kind) : source;
		await page.bringToFront();
		if (surface === 'Agent Window') await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const commands = new QuickAccess(page);
		await commands.runCommand('workbench.action.chat.newChat');
		const chat = page.locator(surface === 'Agent Window' ? '.ash-sessions-chat-slot :is(.ash-chat,.ash-native-chat):visible' : '.ash-chat-view-pane .ash-chat:visible').first();
		const input = chat.locator('.stanza-editor-input');
		await expect(input).toBeFocused();
		await page.keyboard.insertText('Plugin draft');
		await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Plugin draft');
		await commands.runCommand('workbench.action.chat.managePlugins');
		if (surface === 'Agent Window') {
			const customize = page.locator('.ash-customize');
			await expect(customize.getByRole('tab', { name: 'Plugins', exact: true })).toHaveAttribute('aria-selected', 'true');
			await expect(page.locator('.ash-extensions-view-container')).toHaveCount(0);
			await customize.getByRole('button', { name: 'Chat plugin fixture', exact: true }).press('Enter');
			const details = customize.locator('.ash-extension-editor:visible');
			await expect(details.locator('.extension-detail-header')).toContainText('Chat plugin fixture');
			await expect(details.getByRole('switch')).not.toBeChecked();
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Plugin draft');
			return;
		}
		const container = page.locator('.ash-extensions-view-container');
		const search = container.getByRole('searchbox');
		const plugins = container.locator('[data-view-id="ash.extensions.plugins"]');
		const row = plugins.getByRole('option').filter({ hasText: 'Chat plugin fixture' });
		await expect(search).toHaveValue('@plugins ');
		await expect(search).toBeFocused();
		await expect(row).toBeVisible();
		await expect(container.locator('[data-view-id="ash.extensions.skills"]')).toBeHidden();
		await expect(container.locator('[data-view-id="ash.extensions.mcp"]')).toBeHidden();

		await search.fill('@skills previous-filter');
		await search.press('Enter');
		await expect(plugins).toBeHidden();
		await commands.runCommand('workbench.action.chat.managePlugins');
		await expect(container).toHaveCount(1);
		await expect(search).toHaveValue('@plugins ');
		await expect(search).toBeFocused();
		await expect(row).toBeVisible();
		await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Plugin draft');
		await testInfo.attach('plugin-navigation.json', {
			body: JSON.stringify({
				surface, query: await search.inputValue(), draft: await chat.locator('.stanza-editor-line-text').allTextContents(),
				focused: await search.evaluate(element => element === document.activeElement),
				themes: await page.locator('[data-color-theme]').evaluateAll(elements => elements.map(element => ({ theme: element.getAttribute('data-color-theme'), scheme: element.getAttribute('data-color-scheme') }))),
			}),
			contentType: 'application/json',
		});
		await search.fill('@plugins Chat plugin fixture');
		await search.press('Enter');
		await expect(plugins.getByRole('option')).toHaveCount(1);
		await search.press('ArrowDown');
		await page.keyboard.press('Enter');
		const details = page.locator('.ash-extension-editor:visible');
		await expect(details.locator('.extension-detail-header')).toContainText('Chat plugin fixture');
		await expect(details.getByRole('switch')).not.toBeChecked();
	});
}

for (const surface of ['IDE', 'Agent Window']) {
	test(`Chat creates an installable Skill plugin and cancels credential access in ${surface}`, { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, testWorkspace, workbench }) => {
		const source = join(testWorkspace.directory, 'skill-source');
		await mkdir(join(source, 'scripts'), { recursive: true });
		const instructions = '---\nname: review-fixture\ndescription: Review the fixture project\n---\nRead scripts/check.txt when reviewing.\n';
		const asset = new Uint8Array([0, 1, 2, 255]);
		await writeFile(join(source, 'SKILL.md'), instructions);
		await writeFile(join(source, 'scripts', 'check.txt'), asset);
		await workbench.waitForReady();
		const page = surface === 'Agent Window' ? await workbench.openAgentsWindow(target.kind) : workbench.page;
		await page.bringToFront();
		if (surface === 'Agent Window') await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const window = new Workbench(page);
		await window.quickaccess.runCommand('workbench.action.chat.newChat');
		const chat = page.locator(surface === 'Agent Window' ? '.ash-sessions-chat-slot.active:visible .ash-chat' : '.ash-chat-view-pane .ash-chat:visible').first();
		await expect(chat.locator('.stanza-editor-input')).toBeFocused();
		await page.keyboard.insertText('Authoring draft');
		await window.quickaccess.runCommand('workbench.action.chat.manageLanguageModelAuthentication');
		const picker = page.locator('.ash-quick-pick');
		await expect(picker.getByRole('option').first()).toBeVisible();
		await picker.getByRole('combobox').press('Escape');
		await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Authoring draft');
		await expect(chat.locator('.stanza-editor-input')).toBeFocused();

		await window.quickaccess.runCommand('workbench.action.chat.createPlugin');
		const identifier = page.getByRole('textbox', { name: 'Plugin identifier', exact: true });
		await identifier.fill('acme/created-skill'); await identifier.press('Enter');
		const folder = page.getByRole('textbox', { name: 'Skill folder to include', exact: true });
		await folder.fill('skill-source'); await folder.press('Enter');
		const output = join(testWorkspace.directory, 'created-skill');
		await expect.poll(async () => {
			try { return JSON.parse(await readFile(join(output, '.ash-plugin', 'plugin.json'), 'utf8')).id; } catch { return undefined; }
		}).toBe('acme/created-skill');
		await expect(page.getByRole('tab', { name: 'plugin.json', exact: true })).toBeVisible();
		expect(await readFile(join(output, 'skills', 'created-skill', 'SKILL.md'), 'utf8')).toBe(instructions);
		expect(new Uint8Array(await readFile(join(output, 'skills', 'created-skill', 'scripts', 'check.txt')))).toEqual(asset);
		expect((await readdir(testWorkspace.directory)).some(name => name.startsWith('.ash-plugin-'))).toBe(false);
		await window.quickaccess.runCommand('workbench.action.chat.managePlugins');
		const catalog = surface === 'Agent Window' ? page.locator('.ash-customize') : page.locator('[data-view-id="ash.extensions.plugins"]');
		await expect(catalog).toBeVisible();
		await expect(catalog.getByText('created-skill', { exact: true })).toHaveCount(0);
		await window.quickaccess.runCommand('ash.extensions.installLocal');
		const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
		await installation.getByRole('textbox').fill('created-skill');
		if (surface === 'Agent Window') {
			// Sessions owns a themed dialog handler on both product hosts.
			await installation.getByRole('textbox').press('Enter');
			const installed = page.getByRole('dialog', { name: 'Information', exact: true });
			await expect(installed).toContainText('Installed acme/created-skill 0.1.0');
			await installed.getByRole('button', { name: 'OK', exact: true }).click();
		} else {
			const installed = await window.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
			expect(installed.message).toContain('Installed acme/created-skill 0.1.0');
		}
	});
}
