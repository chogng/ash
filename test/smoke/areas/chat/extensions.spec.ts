import { expect, test, writeEditorExtensionFixture } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test.beforeEach(async ({ workbench }) => {
	// Fresh profiles restore Welcome after startup services; earlier input can be replaced during restoration.
	await expect(workbench.page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
});

for (const window of ['Code', 'Agents']) {
	test(`Skills command opens a readonly SKILL.md snapshot from the shared backend in ${window}`, async ({ target, workbench }) => {
		test.skip(target.appServerMode !== 'required', 'Requires the shared App Server Skill catalog.');
		const page = window === 'Code' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
		await new QuickAccess(page).select('skill-creator');
		await expect(page.getByRole('tab', { name: 'skill-creator/SKILL.md', exact: true })).toBeVisible();
		const editor = page.getByRole('region', { name: 'skill-creator/SKILL.md', exact: true });
		const input = editor.locator('.stanza-editor-input');
		await expect(editor.locator('.view-lines')).toContainText('name: skill-creator');
		await expect(input).toHaveAttribute('aria-readonly', 'true');
		await input.focus();
		await page.keyboard.insertText('forbidden edit');
		await expect(editor.locator('.view-lines')).toContainText('name: skill-creator');
		await expect(editor.locator('.view-lines')).not.toContainText('forbidden edit');
	});
}

test('Skills command opens Settings after the Skills sidebar is removed', async ({ application, workbench }) => {
	const page = workbench.page;
	await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
	await new QuickAccess(page).select('Manage skill enablement…');
	const settings = page.locator('.ash-settings-editor');
	await expect(settings).toBeVisible();
	const skills = settings.locator('.ash-skills');
	await expect(skills).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Skills', exact: true })).toHaveCount(0);
	const helpButton = skills.getByRole('button', { name: 'Help', exact: true });
	await workbench.dialogs.expectMessage(application, 'Skills help', () => helpButton.click());
	await expect(helpButton).toBeFocused();
	await helpButton.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Select a skill by name and source/u);
	await page.keyboard.press('Escape');
	await expect(helpButton).toBeFocused();
	await page.locator('.ash-modal-editor-close').click();
});

test('Skills configuration command opens Customize in the Agents window', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
	await new QuickAccess(page).select('Manage skill enablement…');
	const settings = page.locator('.ash-sessions-settings-dialog');
	await expect(settings).toBeVisible();
	await expect(settings.getByRole('tab', { name: 'Skills', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(settings.locator('.ash-skills').getByLabel('Skills', { exact: true })).toBeVisible();
});

test('Skill enablement updates Chat completion and survives a window reload', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the shared App Server Skill catalog.');
	let page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.chat.configure.skills');
	await new QuickAccess(page).select('Manage skill enablement…');
	let skills = page.locator('.ash-skills');
	const list = skills.getByLabel('Skills', { exact: true });
	await expect(list.locator('option').filter({ hasText: 'skill-creator' })).toHaveCount(1);
	await list.selectOption({ label: await list.locator('option').filter({ hasText: 'skill-creator' }).textContent() ?? '' });
	await skills.getByRole('button', { name: 'Disable skill', exact: true }).click();
	await expect(skills.getByRole('button', { name: 'Enable skill', exact: true })).toBeEnabled();
	await page.locator('.ash-modal-editor-close').click();
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	let editor = page.locator('.ash-chat-input-editor');
	await editor.locator('.stanza-editor-input').focus();
	await page.keyboard.insertText('$');
	await page.keyboard.press('Control+Space');
	await expect(editor.getByRole('option', { name: /^\$create-instructions /u })).toBeVisible();
	await expect(editor.getByRole('option', { name: /^\$skill-creator /u })).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.chat.configure.skills');
	await new QuickAccess(page).select('Manage skill enablement…');
	skills = page.locator('.ash-skills');
	const restored = skills.getByLabel('Skills', { exact: true });
	await expect(restored.locator('option').filter({ hasText: 'skill-creator' })).toContainText('Disabled');
	await restored.selectOption({ label: await restored.locator('option').filter({ hasText: 'skill-creator' }).textContent() ?? '' });
	await skills.getByRole('button', { name: 'Enable skill', exact: true }).click();
	await expect(skills.getByRole('button', { name: 'Disable skill', exact: true })).toBeEnabled();
	await page.locator('.ash-modal-editor-close').click();
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	editor = page.locator('.ash-chat-input-editor');
	await editor.locator('.stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('$');
	await page.keyboard.press('Control+Space');
	await expect(editor.getByRole('option', { name: /^\$skill-creator /u })).toBeVisible();
});

test('Extensions view tab uses the extensions icon', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.getByRole('region', { name: 'Primary sidebar' }).isVisible()) {
		await page.getByRole('button', { name: 'Show Primary Side Bar', exact: true }).click();
	}
	const extensionManagementTab = page.getByRole('tab', { name: 'Extensions', exact: true });
	await expect(extensionManagementTab.locator('svg[data-ash-icon-id="extensions"]')).toBeVisible();
	await extensionManagementTab.click();
	await expect(page.locator('.ash-extensions')).toBeVisible();
	await expect(extensionManagementTab).toHaveAttribute('aria-selected', 'true');
	const search = page.locator('.ash-extensions').getByRole('searchbox', { name: 'Search Extensions', exact: true });
	await search.focus();
	await search.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Installation includes all capabilities in a package/u);
	await expect(help.getByRole('textbox')).toHaveValue(/Execution and permissions are managed separately/u);
	await expect(help.getByRole('textbox')).toHaveValue(/Use Sources to add or pause an Ash open source/u);
	await page.keyboard.press('Escape');
	await expect(search).toBeFocused();
});

test('Local standard extension installs, runs only after grant, survives restart and retires on revoke', async ({ target, testWorkspace, application, workbench, reloadWorkbench }) => {
	test.skip(process.platform !== 'darwin' || target.kind !== 'electron' || target.appServerMode !== 'required', 'Product JS confinement currently supports macOS Electron with App Server');
	test.setTimeout(90_000);
	const root = join(testWorkspace.directory, 'standard-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/standard-smoke', version: '1.0.0', displayName: 'Standard extension smoke',
		compatibility: { ash: '>=0.1.0' },
		contributions: {
			editorExtensions: [{
				id: 'inspect', runtime: 'javascript', entrypoint: 'extension.js', runtimeApiVersion: 1,
				activationEvents: [{ type: 'onCommand', id: 'acme.standardSmoke.inspect' }], capabilities: ['command']
			}]
		},
		permissions: [{ type: 'directory', access: 'read' }],
	}));
	await writeEditorExtensionFixture(root, `
const vscode = require('vscode'); const { commands, window } = vscode;
exports.activate = function(context) {
	context.subscriptions.push(commands.registerCommand('acme.standardSmoke.inspect', async () => {
		const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'main.ts')));
		await window.showInformationMessage('Standard disk: ' + text.trim() + '; globals: ' + [typeof process, typeof fetch, typeof WebAssembly].join(','));
		return text;
	}));
}`);
	let page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('standard-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/standard-smoke 1.0.0');

	const absent = async (): Promise<void> => {
		await workbench.quickaccess.open('>acme.standardSmoke.inspect');
		await expect(workbench.quickaccess.items.filter({ has: page.locator('.ash-quick-pick-row-description').getByText('acme.standardSmoke.inspect', { exact: true }) })).toHaveCount(0);
		await workbench.quickaccess.close();
	};
	const manage = async (button: string): Promise<void> => {
		const review = await workbench.dialogs.confirm(application, 'Standard extension smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Standard extension smoke', { exact: true }) }).click();
		});
		expect(review.detail).toContain('Read workspace files');
		expect(review.detail).toContain('Package digest: sha256:');
	};
	await absent();
	await manage('Enable');
	await absent();
	await manage('Grant permissions');
	await workbench.quickaccess.runCommand('acme.standardSmoke.inspect');
	await expect(page.locator('.ash-notification', { hasText: 'Standard disk: const value = 1;; globals: object,function,object' })).toBeVisible();

	({ workbench, application } = await reloadWorkbench());
	page = workbench.page;
	await expect(page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('acme.standardSmoke.inspect');
	await expect(page.locator('.ash-notification', { hasText: 'Standard disk: const value = 1;; globals: object,function,object' })).toBeVisible();
	await manage('Revoke permissions');
	await absent();
	await manage('Disable');
	await manage('Uninstall');
	const empty = await workbench.dialogs.expectMessage(application, 'Information', () => workbench.quickaccess.runCommand('ash.extensions.manageLocal'));
	expect(empty.message).toContain('No local editor extensions are installed.');
});

test('Open VSX JavaScript extension starts on first command, survives restart and retires on revoke', async ({ target, application, workbench, reloadWorkbench }) => {
	test.skip(process.env.ASH_PLAYWRIGHT_OPEN_VSX !== '1' || process.platform !== 'darwin' || target.kind !== 'electron' || target.appServerMode !== 'required', 'Explicit live Open VSX execution check requires macOS Electron with App Server');
	test.setTimeout(120_000);
	let page = workbench.page;
	const packageId = 'mark-wiemer.helloworld-2022@open-vsx';
	if (!('evaluate' in application)) { throw new Error('This scenario requires Electron'); }
	const profile = await application.evaluate(({ app }) => app.getPath('userData'));
	const processes = async (): Promise<number> => {
		const { stdout } = await promisify(execFile)('ps', ['-axo', 'command=']);
		return stdout.split('\n').filter(line => line.includes('/ash-external-js-ext ') && line.includes(`--extension-id marketplace:${packageId}:vscode`) && line.includes(profile)).length;
	};
	await workbench.quickaccess.runCommand('ash.extensions.installed');
	let extensionManagement = page.locator('.ash-extensions');
	await extensionManagement.getByRole('button', { name: 'All capabilities', exact: true }).click();
	await page.getByRole('option', { name: 'Editor extensions (Open VSX)', exact: true }).click();
	await extensionManagement.getByRole('button', { name: 'Installed', exact: true }).click();
	await extensionManagement.getByLabel('Search Extensions', { exact: true }).fill('mark-wiemer.helloworld-2022');
	await extensionManagement.getByLabel('Search Extensions', { exact: true }).press('Enter');
	await expect(extensionManagement.getByRole('option').filter({ hasText: packageId })).toBeAttached({ timeout: 30_000 });
	await extensionManagement.getByRole('option').filter({ hasText: packageId }).click();
	await expect(page.locator('.ash-extension-editor')).toContainText('0.2.3');
	await workbench.dialogs.confirm(application, 'Install', 'Install', () => page.locator('.ash-extension-editor').getByRole('button', { name: 'Install', exact: true }).click());
	await page.locator('.ash-extension-editor').getByRole('button', { name: 'Show installed versions', exact: true }).click();
	await expect(extensionManagement.getByRole('listbox', { name: 'Extensions', exact: true })).toContainText(packageId);
	const installationId = await extensionManagement.getByRole('option').filter({ hasText: packageId }).getAttribute('data-installation-id');
	const absent = async (): Promise<void> => {
		await workbench.quickaccess.open('>helloworld.helloWorld');
		await expect(workbench.quickaccess.items.filter({ has: page.locator('.ash-quick-pick-row-description').getByText('helloworld.helloWorld', { exact: true }) })).toHaveCount(0);
		await workbench.quickaccess.close();
	};
	const manage = async (button: string): Promise<void> => {
		const review = await workbench.dialogs.confirm(application, packageId, button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageExtensions');
			await page.getByRole('option').filter({ has: page.getByText(packageId, { exact: true }) }).click();
		});
		expect(review.detail).toContain('Package digest: sha256:');
		expect(review.detail).toContain('Node modules, direct file access, networking and child processes are unavailable.');
	};
	await absent();
	await manage('Enable');
	await absent();
	await manage('Authorize execution');
	await workbench.quickaccess.open('>helloworld.helloWorld');
	await expect(workbench.quickaccess.items.filter({ has: page.locator('.ash-quick-pick-row-description').getByText('helloworld.helloWorld', { exact: true }) })).toHaveCount(1);
	await workbench.quickaccess.close();
	// A visible manifest command is not proof of a running extension process.
	await expect.poll(processes).toBe(0);
	await workbench.quickaccess.runCommand('helloworld.helloWorld');
	await expect(page.locator('.ash-notification', { hasText: 'Hello VS Code 2023 (the future!!)' })).toBeVisible();
	await expect.poll(processes).toBe(1);
	({ workbench, application } = await reloadWorkbench());
	page = workbench.page;
	await expect(page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
	await expect.poll(processes).toBe(0);
	await workbench.quickaccess.runCommand('helloworld.helloWorld');
	await expect(page.locator('.ash-notification', { hasText: 'Hello VS Code 2023 (the future!!)' })).toBeVisible();
	await expect.poll(processes).toBe(1);
	await manage('Revoke execution authorization');
	await expect.poll(processes).toBe(0);
	await absent();
	await manage('Disable');
	await workbench.quickaccess.runCommand('ash.extensions.installed');
	extensionManagement = page.locator('.ash-extensions');
	await extensionManagement.getByRole('listbox', { name: 'Extensions', exact: true }).locator(`[data-installation-id="${installationId}"]`).click();
	await workbench.dialogs.confirm(application, 'Uninstall extension', 'Uninstall', () => page.locator('.ash-extension-editor').getByRole('button', { name: 'Uninstall', exact: true }).click());
	await expect(extensionManagement.getByRole('listbox', { name: 'Extensions', exact: true }).getByRole('option')).toHaveCount(0);
});

test('Open VSX installs a real theme, restores it and removes its contributions', async ({ target, application, workbench, reloadWorkbench }) => {
	test.skip(process.env.ASH_PLAYWRIGHT_OPEN_VSX !== '1' || target.kind !== 'electron' || target.appServerMode !== 'required', 'Explicit live Open VSX check requires Electron with App Server');
	test.setTimeout(90_000);
	let page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installed');
	let extensionManagement = page.locator('.ash-extensions');
	await extensionManagement.getByRole('button', { name: 'All capabilities', exact: true }).click();
	await page.getByRole('option', { name: 'Editor extensions (Open VSX)', exact: true }).click();
	await extensionManagement.getByRole('button', { name: 'Installed', exact: true }).click();
	await extensionManagement.getByLabel('Search Extensions', { exact: true }).fill('dracula-theme.theme-dracula');
	await extensionManagement.getByLabel('Search Extensions', { exact: true }).press('Enter');
	await expect(extensionManagement.getByRole('status')).not.toHaveText('Loading Extensions…', { timeout: 30_000 });
	const packageId = 'dracula-theme.theme-dracula@open-vsx';
	await expect(extensionManagement.getByRole('option').filter({ hasText: packageId })).toBeAttached();
	await extensionManagement.getByRole('option').filter({ hasText: packageId }).click();
	await expect(page.locator('.ash-extension-editor').getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
	const confirmation = await workbench.dialogs.confirm(application, 'Install', 'Install', () => page.locator('.ash-extension-editor').getByRole('button', { name: 'Install', exact: true }).click());
	expect(confirmation.detail).toContain('without running scripts');
	await page.locator('.ash-extension-editor').getByRole('button', { name: 'Show installed versions', exact: true }).click();
	await expect(extensionManagement.getByRole('listbox', { name: 'Extensions', exact: true })).toContainText(packageId);
	const installationId = await extensionManagement.getByRole('option').filter({ hasText: packageId }).getAttribute('data-installation-id');

	await workbench.settingsEditor.openUserSettingsUI();
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="appearance"]').click();
	await page.locator('[data-settings-item-id="workbench.colorTheme"]').getByRole('combobox').click();
	await expect(page.getByRole('option', { name: 'Dracula Theme', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.locator('.ash-modal-editor-close').click();

	// Reopen the Electron process with the same profile; installation does not request a restart dialog.
	({ workbench, application } = await reloadWorkbench());
	page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installed');
	extensionManagement = page.locator('.ash-extensions');
	await expect(extensionManagement.getByRole('listbox', { name: 'Extensions', exact: true }).locator(`[data-installation-id="${installationId}"]`)).toContainText(packageId);
	await extensionManagement.getByRole('listbox', { name: 'Extensions', exact: true }).locator(`[data-installation-id="${installationId}"]`).click();
	await workbench.dialogs.confirm(application, 'Uninstall extension', 'Uninstall', () => page.locator('.ash-extension-editor').getByRole('button', { name: 'Uninstall', exact: true }).click());
	await expect(extensionManagement.getByRole('listbox', { name: 'Extensions', exact: true }).getByRole('option')).toHaveCount(0);
	await workbench.settingsEditor.openUserSettingsUI();
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="appearance"]').click();
	await page.locator('[data-settings-item-id="workbench.colorTheme"]').getByRole('combobox').click();
	await expect(page.getByRole('option', { name: 'Dracula Theme', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
});

test('Extensions slash commands open their Workbench owners without sending a chat message', async ({ target, application, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const input = page.locator('.ash-chat-input-editor .stanza-editor-input');
	const editor = new Editor(page.locator('.ash-chat-input-editor'));
	for (const [command, selector] of [['/extensions rust tools', '.ash-extensions'], ['/plugins', '.ash-extensions'], ...(target.appServerMode === 'required' ? [['/skills', '.ash-skills']] : []), ['/lsp rust', '.ash-language-server-settings'], ['/extensions', '.ash-extensions'], ['/lsp', '.ash-language-server-settings']]) {
		await input.focus();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.insertText(command);
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-action-id="ash.chat.input.send"] button')).toBeEnabled();
		await page.keyboard.press('Enter');
		if (command === '/skills') { await new QuickAccess(page).select('Manage skill enablement…'); }
		await expect(page.locator(selector)).toBeVisible();
		if (command === '/skills') {
			await expect(page.locator('.ash-settings-editor')).toBeVisible();
			await expect(page.getByRole('tab', { name: 'Skills', exact: true })).toHaveCount(0);
			await page.locator('.ash-modal-editor-close').click();
		}
		if (command === '/plugins') { await expect(page.locator(selector).getByRole('button', { name: 'Installed', exact: true })).toHaveAttribute('aria-pressed', 'true'); }
		if (command === '/extensions rust tools') { await expect(page.locator(selector).getByLabel('Search Extensions', { exact: true })).toHaveValue('rust tools'); }
		if (command === '/extensions') { await expect(page.locator(selector).getByLabel('Search Extensions', { exact: true })).toHaveValue(''); }
		if (command.startsWith('/lsp')) {
			await expect(page.locator('.ash-settings-editor')).toBeVisible();
			await expect(page.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'editor-language');
			await expect(page.getByRole('tab', { name: 'Language servers', exact: true })).toHaveCount(0);
			if (command === '/lsp rust') {
				await expect(page.locator(selector).getByLabel('Language ID', { exact: true })).toHaveValue('rust');
				await page.locator('.ash-modal-editor-close').click();
			}
		}
		// Opening a command surface can finish after it first becomes visible.
		await editor.waitForEditorContents(text => text === '');
	}
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
	const lsp = page.locator('.ash-language-server-settings');
	await expect(lsp).toHaveAttribute('aria-busy', 'false');
	await expect(lsp.getByLabel('Language ID', { exact: true })).toBeEnabled();
	await lsp.getByLabel('Language ID', { exact: true }).focus();
	await expect(lsp.getByLabel('Language ID', { exact: true })).toBeFocused();
	await page.keyboard.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Language Servers[\s\S]*Logs and startup failures are in Output/);
	await help.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(lsp.getByLabel('Language ID', { exact: true })).toBeFocused();
	if (target.appServerMode === 'required') {
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await lsp.getByLabel('Server ID', { exact: true }).fill('rust-analyzer');
		await lsp.getByLabel('Server ID', { exact: true }).press('Tab');
		await lsp.getByLabel('Enable server', { exact: true }).uncheck();
		await expect(lsp.getByRole('button', { name: 'Save server configuration', exact: true })).toBeEnabled();
		await lsp.getByRole('button', { name: 'Save server configuration', exact: true }).click();
		await expect(lsp.getByRole('combobox', { name: 'Language servers', exact: true })).toContainText('rust-analyzer');
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeEnabled();
		await lsp.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(lsp.getByLabel('Enable server', { exact: true })).not.toBeChecked();
		await lsp.getByRole('button', { name: 'Use default configuration', exact: true }).click();
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeDisabled();
	}
});

test('Language server Settings replaces the sidebar and saves backend configuration', async ({ target, workbench, restartWorkbench }) => {
	let page = workbench.page;
	await workbench.quickaccess.runCommand('ash.languageServers.open');
	let settings = page.locator('.ash-settings-editor');
	let lsp = settings.locator('.ash-language-server-settings');
	await expect(lsp).toBeVisible();
	await expect(settings.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'editor-language');
	await expect(page.getByRole('tab', { name: 'Language servers', exact: true })).toHaveCount(0);
	await expect(settings.getByRole('heading', { name: 'Language Servers', exact: true })).toBeInViewport();
	await expect(lsp).toHaveAttribute('aria-busy', 'false');
	if (target.appServerMode === 'required') {
		await expect(lsp.getByRole('status')).not.toContainText('Could not load');
		await lsp.getByLabel('Server ID', { exact: true }).fill('rust-analyzer');
		await lsp.getByLabel('Enable server', { exact: true }).uncheck();
		await lsp.getByRole('button', { name: 'Save server configuration', exact: true }).click();
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeEnabled();
		await expect(lsp.getByRole('combobox', { name: 'Language servers', exact: true })).toContainText('rust-analyzer');
		await lsp.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await expect(lsp.getByLabel('Enable server', { exact: true })).not.toBeChecked();
		await lsp.getByRole('button', { name: 'Use default configuration', exact: true }).click();
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeDisabled();
	}
	await settings.locator('[data-settings-category-id="general"]').click();
	const locale = settings.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox');
	await locale.click();
	await page.getByRole('option', { name: '简体中文', exact: true }).click();
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	settings = page.locator('.ash-settings-editor');
	lsp = settings.locator('.ash-language-server-settings');
	await workbench.quickaccess.runCommand('ash.languageServers.open');
	await expect(settings.getByRole('heading', { name: '语言服务器', exact: true })).toBeInViewport();
	await expect(lsp).toHaveAttribute('aria-busy', 'false');
	await lsp.getByLabel('语言 ID', { exact: true }).fill('python');
	await lsp.getByRole('button', { name: '在 Extensions 中查找语言服务器', exact: true }).click();
	await expect(settings).toBeHidden();
	await expect(page.locator('.ash-extensions').getByRole('button', { name: '提供程序 · python', exact: true })).toBeVisible();
});


test('Extensions sources persist and share the same authority between Code and Agents', async ({ target, workbench, reloadWorkbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the profile-owned Extensions source authority.');
	let page = workbench.page;
	await new QuickAccess(page).runCommand('ash.extensions.manageSources');
	const picker = page.getByRole('dialog', { name: 'Manage extension sources', exact: true });
	if (target.kind === 'electron') {
		await expect(picker).toContainText('open-vsx');
		await expect(picker).toContainText('ash');
	}
	await picker.getByRole('option').filter({ hasText: 'Add Ash open source…' }).click();
	const setup = page.getByRole('dialog', { name: 'Add Ash open source…', exact: true });
	const inputs = setup.getByRole('textbox');
	const root = await readFile(new URL('../../../../resources/product-services/extensions-root.json', import.meta.url), 'utf8');
	for (const [index, value] of ['community', 'https://extensions.example/metadata/', 'https://extensions.example/targets/', root].entries()) { await inputs.nth(index).fill(value); }
	await setup.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(setup).toHaveCount(0);
	page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('ash.extensions.manageSources');
	const shared = page.getByRole('dialog', { name: 'Manage extension sources', exact: true });
	const community = shared.getByRole('option').filter({ hasText: 'community' });
	await expect(community).toContainText('Enabled · select to pause');
	await community.click();
	await expect(shared).toHaveCount(0);
	if (target.kind === 'browser') {
		await workbench.reloadWindow(page);
		await page.locator('.ash-sessions-window').waitFor({ state: 'visible' });
	} else {
		({ workbench } = await reloadWorkbench());
		page = workbench.page;
	}
	await new QuickAccess(page).runCommand('ash.extensions.manageSources');
	const restored = page.getByRole('dialog', { name: 'Manage extension sources', exact: true });
	await expect(restored.getByRole('option').filter({ hasText: 'community' })).toContainText('Paused · select to resume');
	await page.keyboard.press('Escape');
});
