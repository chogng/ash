import { expect, test, writeEditorExtensionFixture } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { readUserSettings } from '../../../automation/settings.js';
import { parseJsonc } from '../../../../src/ash/base/common/jsonc.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

test.beforeEach(async ({ workbench }) => {
	// Fresh profiles restore Welcome after startup services; earlier input can be replaced during restoration.
	await expect(workbench.page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
});

for (const window of ['Code', 'Agents']) {
	test(`Independent MCP configuration persists across reload and can be removed in ${window}`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
		const page = window === 'Code' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		const quickaccess = new QuickAccess(page);
		const command = window === 'Code' ? 'ash.extensions.open' : 'workbench.action.chat.configure.skills';
		await quickaccess.runCommand(command);
		let mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
		await mcp.getByRole('button', { name: 'Connections', exact: true }).click();
		const search = mcp.getByRole('searchbox');
		await search.focus();
		await search.press('Alt+F1');
		await expect(page.getByRole('dialog', { name: 'Accessibility Help', exact: true }).getByRole('textbox')).toHaveValue(/Add MCP server/u);
		await page.keyboard.press('Escape');
		await expect(search).toBeFocused();
		await mcp.getByRole('button', { name: 'Add MCP server', exact: true }).click();
		const add = page.getByRole('dialog', { name: 'Add MCP server', exact: true });
		await add.getByRole('button', { name: 'HTTP server', exact: true }).click();
		await add.getByPlaceholder('Server ID', { exact: true }).fill('persistent-test');
		await add.getByPlaceholder('Display name', { exact: true }).fill('Persistent MCP test');
		await add.getByPlaceholder('HTTP or HTTPS server URL', { exact: true }).fill('http://127.0.0.1:9/mcp');
		await add.getByRole('button', { name: 'Save', exact: true }).click();
		let details = page.locator('.ash-extension-editor');
		await expect(details.getByRole('heading', { name: 'Persistent MCP test', exact: true })).toBeVisible();
		await expect(details.getByRole('status')).toHaveText('Disabled');
		await workbench.reloadWindow(page);
		await quickaccess.runCommand(command);
		mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
		const header = mcp.getByRole('button', { name: 'Connections', exact: true });
		if (await header.getAttribute('aria-expanded') !== 'true') { await header.click(); }
		await mcp.getByRole('option').filter({ hasText: 'Persistent MCP test' }).click();
		details = page.locator('.ash-extension-editor');
		await expect(details.getByRole('status')).toHaveText('Disabled');
		await details.getByRole('button', { name: 'Edit MCP server', exact: true }).click();
		const edit = page.getByRole('dialog', { name: 'Edit MCP server', exact: true });
		await edit.getByRole('button', { name: 'HTTP server', exact: true }).click();
		await expect(edit.getByPlaceholder('HTTP or HTTPS server URL', { exact: true })).toHaveValue('http://127.0.0.1:9/mcp');
		await page.keyboard.press('Escape');
		await details.getByRole('button', { name: 'Remove MCP server', exact: true }).click();
		await page.getByRole('dialog', { name: 'Remove MCP server', exact: true }).getByRole('button', { name: 'Remove', exact: true }).click();
		await expect(mcp.getByRole('option').filter({ hasText: 'Persistent MCP test' })).toHaveCount(0);
	});
}

for (const window of ['Code', 'Agents']) {
	test(`Built-in extension details open in the registered Editor in ${window}`, { tag: ['@electron-app-server'] }, async ({ target, workbench }, testInfo) => {
		const page = window === 'Code' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await new QuickAccess(page).runCommand('ash.extensions.manageBuiltIn');
		const extensions = page.locator('[data-view-id="ash.extensions.view"]');
		for (const id of ['ash.markdown-language-features', 'ash.markdown-math']) {
			await extensions.getByRole('option').filter({ hasText: id }).click();
			// Details inputs retain their panes; only the selected extension is visible.
			const editor = page.locator('.ash-extension-editor:visible');
			await expect(editor.locator('.extension-detail-header h1')).toBeVisible();
			await editor.getByRole('tab', { name: 'Details', exact: true }).click();
			await expect(editor.getByRole('tab', { name: 'Details', exact: true })).toHaveAttribute('aria-selected', 'true');
			await expect(editor.getByRole('complementary', { name: 'Additional information', exact: true }).getByText(id, { exact: true })).toBeVisible();
			await expect(editor).not.toContainText(id.replace('ash.', 'vscode.'));
			await editor.getByRole('tab', { name: 'Features', exact: true }).click();
			await expect(editor.getByRole('tabpanel', { name: 'Features', exact: true })).toBeVisible();
			await expect(editor.getByRole('status')).toHaveText(/^Enabled · (running|starts on demand)$/u);
			if (id === 'ash.markdown-math') {
				await expect(editor.getByRole('tabpanel', { name: 'Features', exact: true })).toContainText('math.render.v2');
			}
			await expect(page.locator('.ash-settings-editor')).toHaveCount(0);
			const screenshot = testInfo.outputPath(`${window}-${id}.png`);
			await editor.screenshot({ path: screenshot });
			await testInfo.attach(`${window}-${id}`, { path: screenshot, contentType: 'image/png' });
		}
	});
}

for (const window of ['Code', 'Agents']) {
	test(`Skills command opens a readonly SKILL.md snapshot from the shared backend in ${window}`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
		const page = window === 'Code' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
		await page.locator('[data-view-id="ash.extensions.skills"]').getByRole('option').filter({ hasText: 'skill-creator' }).click();
		await page.locator('.ash-extension-editor').getByRole('button', { name: 'Open instructions', exact: true }).click();
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

test('Skills command opens Extensions with keyboard help and no Settings management', async ({ workbench }) => {
	const page = workbench.page;
	await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
	const skills = page.locator('[data-view-id="ash.extensions.skills"]');
	await expect(skills).toBeVisible();
	await expect(page.locator('.ash-settings-editor')).toHaveCount(0);
	await expect(skills.getByRole('button', { name: 'Skills', exact: true })).toHaveAttribute('aria-expanded', 'true');
	const recommended = page.locator('[data-view-id="ash.extensions.recommended"]');
	await recommended.getByRole('button', { name: 'Recommended', exact: true }).click();
	await expect(recommended.getByRole('status')).toContainText('0 items');
	const search = skills.getByRole('searchbox');
	await search.focus();
	await search.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/collapsible Extensions, Installed Extensions, Skills, Connections and Recommended panes/u);
	await page.keyboard.press('Escape');
	await expect(search).toBeFocused();
});

test('Skills configuration command opens Extensions in the Agents window', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
	const skills = page.locator('[data-view-id="ash.extensions.skills"]');
	await expect(skills).toBeVisible();
	await expect(skills.getByRole('button', { name: 'Skills', exact: true })).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('.ash-sessions-settings-dialog')).toHaveCount(0);
	const recommended = page.locator('[data-view-id="ash.extensions.recommended"]');
	await recommended.getByRole('button', { name: 'Recommended', exact: true }).click();
	await expect(recommended.getByRole('status')).toContainText('0 items');
});

test('Skill enablement updates Chat completion and survives a window reload', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	let page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.chat.configure.skills');
	let skills = page.locator('.ash-extension-editor');
	const list = page.locator('[data-view-id="ash.extensions.skills"]').getByRole('listbox');
	await list.getByRole('option').filter({ hasText: 'skill-creator' }).click();
	await skills.getByRole('button', { name: 'Disable skill', exact: true }).click();
	await expect(skills.getByRole('button', { name: 'Enable skill', exact: true })).toBeEnabled();
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
	skills = page.locator('.ash-extension-editor');
	const restored = page.locator('[data-view-id="ash.extensions.skills"]').getByRole('listbox');
	await expect(restored.getByRole('option').filter({ hasText: 'skill-creator' })).toContainText('Disabled');
	await restored.getByRole('option').filter({ hasText: 'skill-creator' }).click();
	await skills.getByRole('button', { name: 'Enable skill', exact: true }).click();
	await expect(skills.getByRole('button', { name: 'Disable skill', exact: true })).toBeEnabled();
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
	const extensions = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
	await expect(extensions).toBeVisible();
	await expect(extensionManagementTab).toHaveAttribute('aria-selected', 'true');
	const search = extensions.getByRole('searchbox', { name: 'Search Extensions', exact: true });
	await search.focus();
	await search.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Enable or Disable.*whole editor extension.*scripts, themes, syntax and snippets/u);
	await expect(help.getByRole('textbox')).toHaveValue(/Execution authorization and permissions are reviewed separately in details/u);
	await expect(help.getByRole('textbox')).toHaveValue(/Install extension from Git repository.*repository revision and package directory/u);
	await page.keyboard.press('Escape');
	await expect(search).toBeFocused();
});

const durableExtensionTest = test.extend({
	useInMemorySecretStorage: false,
	backendFixture: async ({ testWorkspace }, use) => {
		const productServicesPath = join(testWorkspace.directory, 'private-services.json');
		await writeFile(productServicesPath, JSON.stringify({ schemaVersion: 3 }));
		await use({
			productServicesPath,
			async prepareProfile(profileDirectory) {
				// Explicit private-file mode in this disposable profile avoids OS prompts.
				// Encrypted recovery is covered separately with an injected keyring.
				const secrets = join(profileDirectory, 'secrets');
				await mkdir(secrets, { recursive: true, mode: 0o700 });
				await writeFile(join(secrets, 'storage-mode'), 'file', { mode: 0o600 });
			},
		});
	},
});

durableExtensionTest('Local standard extension shares durable state and private secrets across windows and restart, and retires on revoke', { tag: ['@electron-app-server', '@darwin'] }, async ({ target, testWorkspace, application, workbench, reloadWorkbench, runningApplication }) => {
	test.setTimeout(120_000);
	const root = join(testWorkspace.directory, 'standard-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/standard-smoke', version: '1.0.0', displayName: 'Standard extension smoke',
		compatibility: { ash: '>=0.1.0' },
		contributions: {
			editorExtensions: [{
				id: 'inspect', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1,
				activationEvents: ['inspect', 'stateFirst', 'stateSecond', 'stateRegrant', 'stateRead', 'secretStore', 'secretRead', 'secretDelete', 'secretHold'].map(name => ({ type: 'onCommand', id: 'acme.standardSmoke.' + name })), capabilities: ['command']
			}]
		},
		permissions: [{ type: 'directory', access: 'read' }],
	}));
	await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk'); const { commands, window } = ash;
exports.activate = async function(context) {
	const secretRestored = (await context.secrets.get('token')) === 'synthetic-extension-private-你好';
	context.subscriptions.push(commands.register('acme.standardSmoke.secretStore', async () => { await context.secrets.store('token', 'synthetic-extension-private-你好'); await window.showInformationMessage('Private secret stored'); }));
	context.subscriptions.push(commands.register('acme.standardSmoke.secretRead', async () => { const matched = (await context.secrets.get('token')) === 'synthetic-extension-private-你好'; await window.showInformationMessage('Private secret matched: ' + matched + '; activation: ' + secretRestored); }));
	context.subscriptions.push(commands.register('acme.standardSmoke.secretDelete', async () => { await window.showInformationMessage('Private secret deleted: ' + await context.secrets.delete('token')); }));
	context.subscriptions.push(commands.register('acme.standardSmoke.secretHold', async () => {
		await window.showInformationMessage('Private access pending');
		await new Promise(resolve => { const timer = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(join(testWorkspace.directory, 'resume-private-call'))})) { clearInterval(timer); resolve(); } }, 25); });
		await context.secrets.get('token');
		require('node:fs').writeFileSync(${JSON.stringify(join(testWorkspace.directory, 'retired-private-result'))}, 'accessed');
	}));
	const readState = async () => ({first:await context.storage.get('first'), second:await context.storage.get('second'), afterRegrant:await context.storage.get('afterRegrant')});
	const report = async label => { await window.showInformationMessage(label + ': ' + JSON.stringify(await readState())); };
	context.subscriptions.push(commands.register('acme.standardSmoke.stateFirst', async () => { await context.storage.update('first', '你好'); await report('First state'); }));
	context.subscriptions.push(commands.register('acme.standardSmoke.stateSecond', async () => { await context.storage.update('second', null); await report('Second state'); }));
	context.subscriptions.push(commands.register('acme.standardSmoke.stateRegrant', async () => { await context.storage.update('afterRegrant', true); await report('Regranted state'); }));
	context.subscriptions.push(commands.register('acme.standardSmoke.stateRead', async () => report('Read state')));
	context.subscriptions.push(commands.register('acme.standardSmoke.inspect', async () => {
		const text = new TextDecoder().decode(await ash.workspace.fs.readFile(ash.Uri.joinPath(ash.workspace.workspaceFolders[0].uri, 'main.ts')));
		const configuration = ash.workspace.getConfiguration('editor');
		const inspection = configuration.inspect('fontSize');
		const restored = inspection.globalValue === 19 && inspection.workspaceValue === 22;
		await configuration.update('fontSize', restored ? undefined : 19, 'user');
		await configuration.update('fontSize', restored ? undefined : 22, 'workspace');
		await window.showInformationMessage('Standard disk: ' + text.trim() + '; globals: ' + [typeof process, typeof fetch, typeof WebAssembly].join(',') + '; settings: ' + (restored ? 'restored and reset' : 'created'));
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
		await page.bringToFront();
		await workbench.quickaccess.open('>acme.standardSmoke.inspect');
		await expect(workbench.quickaccess.items.filter({ has: page.locator('.ash-quick-pick-row-description').getByText('acme.standardSmoke.inspect', { exact: true }) })).toHaveCount(0);
		await workbench.quickaccess.close();
	};
	const manage = async (button: string): Promise<void> => {
		await page.bringToFront();
		await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
		await page.getByRole('listbox', { name: 'Installed Extensions', exact: true }).locator('[data-package-id="acme/standard-smoke"]').click();
		const details = page.locator('.ash-extension-editor:visible').filter({ hasText: 'acme/standard-smoke' });
		const action = () => details.getByRole('button', { name: button, exact: true }).click();
		if (button === 'Grant permissions' || button === 'Revoke permissions') {
			const review = await workbench.dialogs.confirm(application, 'Standard extension smoke', button, action);
			expect(review.detail).toContain('Read workspace files');
			expect(review.detail).toContain('Package digest: sha256:');
		} else if (button === 'Uninstall') {
			await workbench.dialogs.confirm(application, 'Uninstall extension', button, action);
		} else {
			await action();
			await expect(details.getByRole('button', { name: button === 'Enable' ? 'Disable' : 'Enable', exact: true })).toBeVisible();
		}
	};
	await absent();
	await manage('Enable');
	await absent();
	await manage('Grant permissions');
	await workbench.quickaccess.runCommand('acme.standardSmoke.inspect');
	await expect(page.locator('.ash-notification', { hasText: 'Standard disk: const value = 1;; globals: object,function,object; settings: created' })).toBeVisible();
	const userFontSize = async () => (parseJsonc((await readUserSettings(page)).content) as Record<string, unknown>)['editor.fontSize'];
	const workspaceSettings = join(testWorkspace.directory, '.vscode', 'settings.json');
	const workspaceFontSize = async () => (parseJsonc(await readFile(workspaceSettings, 'utf8')) as Record<string, unknown>)['editor.fontSize'];
	await expect.poll(userFontSize).toBe(19);
	await expect.poll(workspaceFontSize).toBe(22);
	let agents = await workbench.openAgentsWindow(target.kind);
	let agentsCommands = new QuickAccess(agents);
	await page.bringToFront();
	await workbench.quickaccess.runCommand('acme.standardSmoke.stateFirst');
	await expect(page.locator('.ash-notification', { hasText: 'First state:' })).toBeVisible();
	await agents.bringToFront();
	await agentsCommands.runCommand('acme.standardSmoke.stateSecond');
	await expect(agents.locator('.ash-notification', { hasText: 'Second state:' })).toBeVisible();
	const savedState = '{"first":"你好","second":null}';
	for (const [commands, windowPage] of [[workbench.quickaccess, page], [agentsCommands, agents]] as const) {
		await windowPage.bringToFront();
		await commands.runCommand('acme.standardSmoke.stateRead');
		await expect(windowPage.locator('.ash-notification', { hasText: 'Read state: ' + savedState })).toBeVisible();
	}
	await page.bringToFront();
	await workbench.quickaccess.runCommand('acme.standardSmoke.secretStore');
	await expect(page.locator('.ash-notification', { hasText: 'Private secret stored' })).toBeVisible();
	await agents.bringToFront();
	await agentsCommands.runCommand('acme.standardSmoke.secretRead');
	await expect(agents.locator('.ash-notification', { hasText: 'Private secret matched: true; activation: false' })).toBeVisible();
	await page.bringToFront();
	await workbench.quickaccess.runCommand('acme.standardSmoke.secretDelete');
	await expect(page.locator('.ash-notification', { hasText: 'Private secret deleted: true' })).toBeVisible();
	await agents.bringToFront();
	await agentsCommands.runCommand('notifications.clearAll');
	await agentsCommands.runCommand('acme.standardSmoke.secretRead');
	await expect(agents.locator('.ash-notification', { hasText: 'Private secret matched: false; activation: false' })).toBeVisible();
	await page.bringToFront();
	await workbench.quickaccess.runCommand('acme.standardSmoke.secretRead');
	await expect(page.locator('.ash-notification', { hasText: 'Private secret matched: false; activation: false' })).toBeVisible();
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('acme.standardSmoke.secretStore');
	await expect(page.locator('.ash-notification', { hasText: 'Private secret stored' })).toBeVisible();

	({ workbench, application } = await reloadWorkbench());
	page = workbench.page;
	await expect(page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('acme.standardSmoke.inspect');
	await expect(page.locator('.ash-notification', { hasText: 'Standard disk: const value = 1;; globals: object,function,object; settings: restored and reset' })).toBeVisible();
	await expect.poll(userFontSize).toBeUndefined();
	await expect.poll(workspaceFontSize).toBeUndefined();
	await workbench.quickaccess.runCommand('acme.standardSmoke.stateRead');
	await expect(page.locator('.ash-notification', { hasText: 'Read state: ' + savedState })).toBeVisible();
	await workbench.quickaccess.runCommand('acme.standardSmoke.secretRead');
	await expect(page.locator('.ash-notification', { hasText: 'Private secret matched: true; activation: true' })).toBeVisible();
	agents = await workbench.openAgentsWindow(target.kind);
	agentsCommands = new QuickAccess(agents);
	await agentsCommands.runCommand('acme.standardSmoke.secretHold');
	await expect(agents.locator('.ash-notification', { hasText: 'Private access pending' })).toBeVisible();
	await manage('Revoke permissions');
	// Revoking the extension ends the pending command through the normal
	// command error dialog; acknowledge it before using that window again.
	const retiredCommand = agents.getByRole('dialog', { name: 'Error', exact: true });
	await expect(retiredCommand).toContainText('acme.standardSmoke.secretHold');
	await expect(retiredCommand).toContainText('ExtensionHostInvocationNotFound');
	await retiredCommand.getByRole('button', { name: 'OK', exact: true }).click();
	await absent();
	await agents.bringToFront();
	await agentsCommands.open('>acme.standardSmoke.stateFirst');
	await expect(agentsCommands.items.filter({ has: agents.locator('.ash-quick-pick-row-description').getByText('acme.standardSmoke.stateFirst', { exact: true }) })).toHaveCount(0);
	await agentsCommands.close();
	await manage('Grant permissions');
	await writeFile(join(testWorkspace.directory, 'resume-private-call'), 'resume');
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('acme.standardSmoke.stateRead');
	await expect(page.locator('.ash-notification', { hasText: 'Read state: ' + savedState })).toBeVisible();
	await workbench.quickaccess.runCommand('acme.standardSmoke.secretRead');
	await expect(page.locator('.ash-notification', { hasText: 'Private secret matched: true; activation: true' })).toBeVisible();
	await workbench.quickaccess.runCommand('acme.standardSmoke.secretStore');
	await expect(page.locator('.ash-notification', { hasText: 'Private secret stored' })).toBeVisible();
	await workbench.quickaccess.runCommand('acme.standardSmoke.stateRegrant');
	await expect(page.locator('.ash-notification', { hasText: 'Regranted state: {"first":"你好","second":null,"afterRegrant":true}' })).toBeVisible();
	await manage('Revoke permissions');
	await manage('Disable');
	await manage('Uninstall');
	await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
	await expect(page.getByRole('listbox', { name: 'Installed Extensions', exact: true }).locator('[data-package-id="acme/standard-smoke"]')).toHaveCount(0);
	await absent();
	for (const windowPage of [page, agents]) await expect(windowPage.locator('body')).not.toContainText('synthetic-extension-private-你好');
	expect(await readFile(join(testWorkspace.directory, 'retired-private-result'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; })).toBeUndefined();
	expect(runningApplication.diagnostics.consoleErrors.join('\n')).not.toContain('synthetic-extension-private-你好');
	expect(runningApplication.diagnostics.pageErrors.join('\n')).not.toContain('synthetic-extension-private-你好');
	expect(await readFile(workspaceSettings, 'utf8')).not.toContain('synthetic-extension-private-你好');
});

test('Extensions slash commands open their Workbench owners without sending a chat message', async ({ target, application, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const input = page.locator('.ash-chat-input-editor .stanza-editor-input');
	const editor = new Editor(page.locator('.ash-chat-input-editor'));
	for (const [command, selector] of [['/extensions rust tools', '[data-view-id="ash.extensions.view"] .ash-extensions'], ['/plugins', '[data-view-id="ash.extensions.plugins"] .ash-extensions'], ...(target.appServerMode === 'required' ? [['/skills', '[data-view-id="ash.extensions.skills"]']] : []), ['/lsp rust', '.ash-language-server-settings'], ['/extensions', '[data-view-id="ash.extensions.view"] .ash-extensions'], ['/lsp', '.ash-language-server-settings']]) {
		await input.focus();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.insertText(command);
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-action-id="ash.chat.input.send"] button')).toBeEnabled();
		await page.keyboard.press('Enter');
		await expect(page.locator(selector)).toBeVisible();
		if (command === '/skills') { await expect(page.locator('.ash-settings-editor')).toHaveCount(0); }
		if (command === '/plugins') {
			await expect(page.locator(selector).getByRole('searchbox', { name: 'Search installed extensions', exact: true })).toBeFocused();
			await expect(page.locator(selector).getByRole('listbox', { name: 'Installed Extensions', exact: true })).toBeAttached();
		}
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

test('Language server Settings replaces the sidebar and saves backend configuration', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench, restartWorkbench }) => {
	let page = workbench.page;
	await workbench.quickaccess.runCommand('ash.languageServers.open');
	let settings = page.locator('.ash-settings-editor');
	let lsp = settings.locator('.ash-language-server-settings');
	await expect(lsp).toBeVisible();
	await expect(settings.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'editor-language');
	await expect(page.getByRole('tab', { name: 'Language servers', exact: true })).toHaveCount(0);
	await expect(settings.getByRole('region', { name: /^Language Servers/u })).toBeInViewport();
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
	await workbench.settingsEditor.selectGroup('workbench');
	await workbench.settingsEditor.selectCategory('general');
	const locale = settings.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox');
	await locale.click();
	await page.getByRole('option', { name: '简体中文', exact: true }).click();
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	settings = page.locator('.ash-settings-editor');
	lsp = settings.locator('.ash-language-server-settings');
	await workbench.quickaccess.runCommand('ash.languageServers.open');
	await expect(settings.getByRole('region', { name: /^语言服务器/u })).toBeInViewport();
	await expect(lsp).toHaveAttribute('aria-busy', 'false');
	await lsp.getByLabel('语言 ID', { exact: true }).fill('python');
	await lsp.getByRole('button', { name: '在 Extensions 中查找语言服务器', exact: true }).click();
	await expect(settings).toBeHidden();
	const extensions = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
	await expect(extensions).toBeVisible();
	await expect(extensions.getByRole('searchbox', { name: '搜索扩展', exact: true })).toBeFocused();
});


test('Extensions sources persist and share the same authority between Code and Agents', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench, reloadWorkbench }) => {
	let page = workbench.page;
	await new QuickAccess(page).runCommand('ash.extensions.manageSources');
	const picker = page.getByRole('dialog', { name: 'Manage extension sources', exact: true });
	if (target.kind === 'electron') {
		await expect(picker).not.toContainText('open-vsx');
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
