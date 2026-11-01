import { expect, test, writeEditorExtensionFixture } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Dialogs } from '../../../automation/dialogs.js';
import { readUserSettings } from '../../../automation/settings.js';
import { parseJsonc } from '../../../../src/ash/base/common/jsonc.js';
import { mkdir, readdir, stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

test.beforeEach(async ({ workbench }) => {
	// Fresh profiles restore Welcome after startup services; earlier input can be replaced during restoration.
	await expect(workbench.page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
});

const durableExtensionTest = test.extend({
	useInMemorySecretStorage: async ({ target }, use) => { await use(target.kind === 'browser'); },
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

for (const window of ['Code', 'Agents']) {
	for (const recovery of ['none', 'online', 'offline'] as const) {
		const durable = recovery !== 'none';
		const localMcp = recovery === 'online';
		const accountTest = durable ? durableExtensionTest : test;
		accountTest(`Add connection authorizes an installed service account in ${window}${durable ? ' and survives restart' : ''}${recovery === 'offline' ? ' with offline MCP' : ''}`, { tag: durable ? ['@electron-app-server', '@darwin'] : ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, application, workbench, runningApplication }, testInfo) => {
			const root = join(testWorkspace.directory, 'account-extension');
			await mkdir(join(root, '.ash-plugin'), { recursive: true });
			await mkdir(join(root, 'mcp'), { recursive: true });
			await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
				schemaVersion: 1, id: 'acme/account-smoke', version: '1.0.0', displayName: 'Account smoke',
				compatibility: { ash: '>=0.1.0' },
				contributions: {
					mcpServers: [{ id: 'tools', definition: 'mcp/tools.json' }],
					connectors: [{ id: 'account', displayName: 'Smoke service account', description: 'Synthetic service account authorization', mcpServer: 'tools' }],
				},
				permissions: localMcp ? [{ type: 'process', executable: 'mcp/server.cjs' }] : [{ type: 'network', hosts: ['127.0.0.1'] }],
				credentialSlots: [{ name: 'token', kind: 'secretText', requiredFor: ['connector:account', 'mcp:tools'] }],
			}));
			await writeFile(join(root, 'mcp', 'tools.json'), JSON.stringify({
				transport: localMcp
					? { type: 'stdio', executable: 'mcp/server.cjs', credentialEnv: 'ASH_ACCOUNT_SMOKE_TOKEN' }
					: { type: 'streamableHttp', url: 'https://127.0.0.1:9/mcp' },
			}));
			if (localMcp) {
				// A real local MCP process proves that restart recovers the credential, while
				// avoiding an external service or a test-only TLS trust exception.
				await writeFile(join(root, 'mcp', 'server.cjs'), String.raw`#!/usr/bin/env node
if (process.env.ASH_ACCOUNT_SMOKE_TOKEN !== 'synthetic-account-token') process.exit(2);
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'account-persistence-smoke', version: '1.0.0' } }
    : message.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
`, { mode: 0o700 });
			}
			const code = workbench.page;
			await workbench.quickaccess.runCommand('ash.extensions.installLocal');
			const installation = code.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
			await installation.getByRole('textbox').fill('account-extension');
			const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
			expect(installed.message).toContain('Installed acme/account-smoke 1.0.0');
			if (localMcp) {
				if (!('windows' in application)) throw new Error('Durable account recovery requires Desktop');
				const profile = await application.evaluate(() => process.env.ASH_HOME!);
				const objects = join(profile, 'plugins', 'objects');
				const entries = await readdir(objects);
				expect(entries).toHaveLength(1);
				// Installation must retain the source program's executable bit without a
				// test-side repair. Permission grants remain a separate user action below.
				expect((await stat(join(objects, entries[0]!, 'mcp', 'server.cjs'))).mode & 0o7777).toBe(0o700);
			}
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			const search = code.locator('.ash-extensions-view-container').getByRole('searchbox');
			await search.fill('@plugins acme/account-smoke');
			await search.press('Enter');
			await code.locator('[data-view-id="ash.extensions.plugins"]').getByRole('option').filter({ hasText: 'acme/account-smoke' }).click();
			const packageDetails = code.locator('.ash-extension-editor:visible').filter({ hasText: 'acme/account-smoke' });
			await packageDetails.getByRole('switch').press('Space');
			await expect(packageDetails.getByRole('switch')).toBeChecked();
			await workbench.dialogs.confirm(application, 'Account smoke', 'Grant permissions', () => packageDetails.getByRole('button', { name: 'Grant permissions', exact: true }).click());
			await expect(packageDetails.getByRole('button', { name: 'Revoke permissions', exact: true })).toBeVisible();
			let page = window === 'Code' ? code : await workbench.openAgentsWindow(target.kind);
			await new QuickAccess(page).runCommand('ash.extensions.showInstalled');
			let pane = page.locator('[data-view-id="ash.extensions.mcp"]');
			await pane.getByRole('button', { name: 'Connections', exact: true }).press('ArrowRight');
			await expect(pane.getByRole('option').filter({ hasText: 'Smoke service account' })).toBeVisible();
			await pane.getByRole('button', { name: 'Add connection', exact: true }).click();
			const chooserImage = testInfo.outputPath(`add-connection-${window}.png`);
			await page.screenshot({ path: chooserImage });
			await testInfo.attach('Add connection methods', { path: chooserImage, contentType: 'image/png' });
			await page.getByRole('dialog', { name: 'Add connection', exact: true }).getByRole('option').filter({ hasText: 'Service account' }).click();
			const picker = page.getByRole('combobox', { name: 'Choose a service account', exact: true });
			await picker.fill('Smoke service account');
			if (window === 'Code') {
				const authorization = await workbench.dialogs.confirm(application, 'Smoke service account', 'Connect with API token', () => picker.press('Enter'));
				expect(authorization.message).toBe('Choose how to authorize Smoke service account.');
			} else {
				await picker.press('Enter');
				await page.getByRole('dialog', { name: 'Smoke service account', exact: true }).getByRole('button', { name: 'Connect with API token', exact: true }).click();
			}
			const token = page.getByRole('dialog', { name: 'Smoke service account', exact: true });
			await token.getByPlaceholder('Account ID', { exact: true }).fill('smoke-user');
			await token.getByPlaceholder('Account name', { exact: true }).fill('Smoke user');
			await expect(token.getByPlaceholder('API token', { exact: true })).toHaveAttribute('type', 'password');
			await token.getByPlaceholder('API token', { exact: true }).fill('synthetic-account-token');
			await token.getByRole('button', { name: 'Connect', exact: true }).click();
			let details = page.locator('.ash-extension-editor:visible');
			await expect(details.getByRole('heading', { name: 'Smoke service account', exact: true })).toBeVisible();
			await expect(details.getByRole('status')).toHaveText('Connected · Smoke user');
			await expect(pane.getByRole('option').filter({ hasText: 'Smoke service account' })).toHaveCount(1);
			await expect(pane.getByRole('option').filter({ hasText: 'acme/account-smoke' })).toHaveCount(0);
			const accountImage = testInfo.outputPath(`account-connected-${window}.png`);
			await page.screenshot({ path: accountImage });
			await testInfo.attach('Authorized service account', { path: accountImage, contentType: 'image/png' });
			if (durable) {
				await details.getByRole('switch').press('Space');
				await expect(details.getByRole('status')).toHaveText('Disconnected');
				await expect(details.locator('.extension-detail-info')).toContainText('smoke-user');
				// Desktop restarts both application and backend; Browser reloads its page.
				// The Desktop fixture persists synthetic secrets independently of the memory store.
				({ workbench, application } = await runningApplication.reload('quit'));
				page = window === 'Code' ? workbench.page : await workbench.openAgentsWindow(target.kind);
				await new QuickAccess(page).runCommand('ash.extensions.showInstalled');
				pane = page.locator('[data-view-id="ash.extensions.mcp"]');
				const header = pane.getByRole('button', { name: 'Connections', exact: true });
				if (await header.getAttribute('aria-expanded') !== 'true') { await header.click(); }
				await expect(pane.getByRole('option').filter({ hasText: 'Smoke service account' })).toHaveCount(1);
				await expect(pane.getByRole('option').filter({ hasText: 'acme/account-smoke' })).toHaveCount(0);
				await pane.getByRole('option').filter({ hasText: 'Smoke service account' }).click();
				details = page.locator('.ash-extension-editor:visible');
				await expect(details.getByRole('status')).toHaveText('Disconnected');
				await expect(details.getByRole('switch')).not.toBeChecked();
				await expect(details.locator('.extension-detail-info')).toContainText('smoke-user');
				await details.getByRole('switch').press('Space');
				await expect(details.getByRole('status')).toHaveText('Connected · Smoke user');
				const restoredImage = testInfo.outputPath(`account-restored-${window}.png`);
				await page.screenshot({ path: restoredImage });
				await testInfo.attach('Service account restored after restart', { path: restoredImage, contentType: 'image/png' });
				await details.getByRole('button', { name: 'Open MCP server details', exact: true }).click();
				await expect(page.locator('.ash-extension-editor:visible').getByRole('status')).toHaveText(recovery === 'offline' ? /^Unavailable · MCP initialize failed:/u : 'Connected');
				if (recovery === 'offline') {
					await expect(page.locator('.ash-extension-editor:visible')).toContainText('MCP initialize failed');
					const offlineImage = testInfo.outputPath(`offline-mcp-${window}.png`);
					await page.screenshot({ path: offlineImage });
					await testInfo.attach('Unavailable MCP after cold restart', { path: offlineImage, contentType: 'image/png' });
				}
				await pane.getByRole('option').filter({ hasText: 'Smoke service account' }).click();
				await expect(details.getByRole('status')).toHaveText('Connected · Smoke user');
			}
			await details.getByRole('switch').press('Space');
			await expect(details.getByRole('status')).toHaveText('Disconnected');
		});
	}

	for (const reason of window === 'Code' ? ['windowClose', 'quit'] as const : ['windowClose'] as const) {
		test(`Independent MCP configuration persists across reopening and can be removed in ${window}${reason === 'quit' ? ' after application quit' : ''}`, { tag: reason === 'quit' ? ['@electron-app-server'] : ['@browser-app-server', '@electron-app-server'] }, async ({ target, application, workbench, runningApplication }) => {
			let page = window === 'Code' ? workbench.page : await workbench.openAgentsWindow(target.kind);
			let quickaccess = new QuickAccess(page);
			const command = window === 'Code' ? 'ash.extensions.open' : 'workbench.action.chat.configure.skills';
			await quickaccess.runCommand(command);
			let mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
			const connections = mcp.getByRole('button', { name: 'Connections', exact: true });
			await connections.press('ArrowRight');
			await connections.press('Alt+F1');
			await expect(page.getByRole('dialog', { name: 'Accessibility Help', exact: true }).getByRole('textbox')).toHaveValue(/Add connection/u);
			await page.keyboard.press('Escape');
			await expect(connections).toBeFocused();
			let dialogs = new Dialogs(page);
			const confirm = async (title: string, button: string, open: () => Promise<unknown>) => {
				// Agents uses in-window dialogs on both hosts; Desktop Code routes prompts through Main.
				if (window === 'Code') { return dialogs.confirm(application, title, button, open); }
				await open();
				const dialog = page.getByRole('dialog', { name: title, exact: true });
				const message = await dialog.locator('.ash-dialog-message').innerText();
				const detail = dialog.locator('.ash-dialog-detail');
				const result = { message, detail: await detail.count() ? await detail.innerText() : '' };
				await dialog.getByRole('button', { name: button, exact: true }).click();
				return result;
			};
			await mcp.getByRole('button', { name: 'Add connection', exact: true }).click();
			const methods = page.getByRole('dialog', { name: 'Add connection', exact: true });
			await expect(methods.getByRole('option').filter({ hasText: 'Service account' })).toBeVisible();
			await expect(methods).toContainText('authorize with an API token');
			const choice = await confirm('Add connection', 'HTTP server', () => methods.getByRole('option').filter({ hasText: 'Custom MCP server' }).click());
			expect(choice.message).toBe('Choose a connection method.');
			expect(choice.detail).toContain('for a service URL');
			expect(choice.detail).toContain('on this computer');
			const add = page.getByRole('dialog', { name: 'Add connection', exact: true });
			await add.getByPlaceholder('Server ID', { exact: true }).fill('persistent-test');
			await add.getByPlaceholder('Display name', { exact: true }).fill('Persistent MCP test');
			await add.getByPlaceholder('HTTP or HTTPS server URL', { exact: true }).fill('http://127.0.0.1:9/mcp');
			await add.getByPlaceholder('Credential reference (optional)', { exact: true }).fill('persistent-http-credential');
			await add.getByRole('button', { name: 'Save', exact: true }).click();
			let details = page.locator('.ash-extension-editor:visible');
			await expect(details.getByRole('heading', { name: 'Persistent MCP test', exact: true })).toBeVisible();
			await expect(details.getByRole('status')).toHaveText('Disabled');
			await mcp.getByRole('button', { name: 'Add connection', exact: true }).click();
			await confirm('Add connection', 'Local process (stdio)', () => page.getByRole('dialog', { name: 'Add connection', exact: true }).getByRole('option').filter({ hasText: 'Custom MCP server' }).click());
			const local = page.getByRole('dialog', { name: 'Add connection', exact: true });
			await local.getByPlaceholder('Server ID', { exact: true }).fill('persistent-local');
			await local.getByPlaceholder('Display name', { exact: true }).fill('Persistent stdio test');
			await local.getByPlaceholder('Executable path', { exact: true }).fill('/synthetic/mcp-server');
			await local.getByPlaceholder('Arguments (JSON array of strings)', { exact: true }).fill('["--path","folder with spaces"]');
			await local.getByRole('button', { name: 'Save', exact: true }).click();
			await expect(details.getByRole('heading', { name: 'Persistent stdio test', exact: true })).toBeVisible();
			await expect(details.getByRole('status')).toHaveText('Disabled');
			if (window === 'Code') {
				({ workbench, application } = await runningApplication.reload(reason));
				page = workbench.page;
			} else {
				page = await workbench.reopenAgentsWindow(application, page);
			}
			quickaccess = new QuickAccess(page);
			dialogs = new Dialogs(page);
			await quickaccess.runCommand(command);
			mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
			const header = mcp.getByRole('button', { name: 'Connections', exact: true });
			if (await header.getAttribute('aria-expanded') !== 'true') { await header.click(); }
			await mcp.getByRole('option').filter({ hasText: 'Persistent MCP test' }).click();
			details = page.locator('.ash-extension-editor:visible');
			await expect(details.getByRole('status')).toHaveText('Disabled');
			await confirm('Edit MCP server', 'HTTP server', () => details.getByRole('button', { name: 'Edit MCP server', exact: true }).click());
			const edit = page.getByRole('dialog', { name: 'Edit MCP server', exact: true });
			await expect(edit.getByPlaceholder('HTTP or HTTPS server URL', { exact: true })).toHaveValue('http://127.0.0.1:9/mcp');
			await expect(edit.getByPlaceholder('Display name', { exact: true })).toHaveValue('Persistent MCP test');
			await expect(edit.getByPlaceholder('Credential reference (optional)', { exact: true })).toHaveValue('persistent-http-credential');
			await expect(edit.getByRole('checkbox', { name: 'Enable this server', exact: true })).not.toBeChecked();
			await page.keyboard.press('Escape');
			await confirm('Remove MCP server', 'Remove', () => details.getByRole('button', { name: 'Remove MCP server', exact: true }).click());
			await expect(mcp.getByRole('option').filter({ hasText: 'Persistent MCP test' })).toHaveCount(0);
			await mcp.getByRole('option').filter({ hasText: 'Persistent stdio test' }).click();
			await expect(details.getByRole('status')).toHaveText('Disabled');
			await confirm('Edit MCP server', 'Local process (stdio)', () => details.getByRole('button', { name: 'Edit MCP server', exact: true }).click());
			await expect(edit.getByPlaceholder('Display name', { exact: true })).toHaveValue('Persistent stdio test');
			await expect(edit.getByPlaceholder('Executable path', { exact: true })).toHaveValue('/synthetic/mcp-server');
			await expect(edit.getByPlaceholder('Arguments (JSON array of strings)', { exact: true })).toHaveValue('["--path","folder with spaces"]');
			await expect(edit.getByRole('checkbox', { name: 'Enable this server', exact: true })).not.toBeChecked();
			await page.keyboard.press('Escape');
			await confirm('Remove MCP server', 'Remove', () => details.getByRole('button', { name: 'Remove MCP server', exact: true }).click());
			await expect(mcp.getByRole('option').filter({ hasText: 'Persistent stdio test' })).toHaveCount(0);
		});
	}
}

for (const window of ['Code', 'Agents']) {
	test(`Built-in extension details open in the registered Editor in ${window}`, { tag: ['@electron-app-server'] }, async ({ target, workbench }, testInfo) => {
		const page = window === 'Code' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await new QuickAccess(page).runCommand('ash.extensions.manageBuiltIn');
		const extensions = page.locator('[data-view-id="ash.extensions.plugins"]');
		for (const id of ['ash.git', 'ash.markdown-language-features', 'ash.markdown-math', 'ash.rust']) {
			const row = extensions.locator(`[data-package-id="${id}"]`);
			await row.click();
			// Details inputs retain their panes; only the selected extension is visible.
			const editor = page.locator('.ash-extension-editor:visible');
			await expect(editor.locator('.extension-detail-header h1')).toBeVisible();
			await expect(editor.locator('.extension-info-section dd').getByText(id === 'ash.rust' ? 'Editor' : 'Editor and Agent', { exact: true })).toBeVisible();
			if (id === 'ash.git') { await expect(row.locator('.extension-metadata')).toHaveCount(0); }
			if (id === 'ash.rust') {
				await expect(extensions.locator(`[data-package-id="${id}"] .extension-body > .ash-icon-label`)).toHaveText(['Rust', 'The Rust Programming Language', 'Rust language configuration, syntax highlighting and language server support.']);
				await expect(editor.locator('.extension-detail-attribution')).toHaveText('The Rust Programming Language');
			}
			await editor.getByRole('tab', { name: 'Details', exact: true }).click();
			await expect(editor.getByRole('tab', { name: 'Details', exact: true })).toHaveAttribute('aria-selected', 'true');
			await expect(editor.getByRole('complementary', { name: 'Additional information', exact: true }).getByText(id, { exact: true })).toBeVisible();
			await expect(editor).not.toContainText(id.replace('ash.', 'vscode.'));
			await editor.getByRole('tab', { name: 'Features', exact: true }).click();
			await expect(editor.getByRole('tabpanel', { name: 'Features', exact: true })).toBeVisible();
			await expect(editor.getByRole('switch')).toBeChecked();
			await expect(editor.locator('.extension-detail-header [role="status"]')).toBeEmpty();
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
	test(`Skills command shows metadata and readonly instructions from the shared backend in ${window}`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
		const page = window === 'Code' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
		const row = page.locator('[data-view-id="ash.extensions.skills"]').getByRole('option').filter({ hasText: 'skill-creator' });
		await expect(row.locator('.extension-description')).toHaveText('Create and update Ash skills.');
		await expect(row.locator('.extension-metadata')).toHaveText('Ash · Enabled');
		await expect(row).not.toContainText('builtin:skill-source:ash-release');
		await row.click();
		const editor = page.locator('.ash-extension-editor');
		await expect(editor.locator('.extension-metadata')).toHaveText('Developer: Ash · Version: 1.0.0 · Updated: 2026-10-22');
		await expect(editor.locator('.extension-detail-description > p')).toHaveText('Create and update Ash skills.');
		await expect(editor.locator('.extension-actions')).toBeHidden();
		await editor.getByRole('tab', { name: 'Instructions', exact: true }).focus();
		await editor.getByRole('tab', { name: 'Instructions', exact: true }).press('Enter');
		const instructions = editor.getByRole('tabpanel', { name: 'Instructions', exact: true });
		await expect(instructions.getByRole('heading', { name: 'Skill creator', exact: true })).toBeVisible();
		await expect(instructions).toContainText('Create a Skill that adds reusable procedural knowledge');
		await expect(instructions.locator('textarea, input, [contenteditable="true"]')).toHaveCount(0);
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
	await skills.getByRole('switch').press('Space');
	await expect(skills.getByRole('switch')).not.toBeChecked();
	await expect(skills.getByRole('switch')).toBeEnabled();
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
	await skills.getByRole('switch').press('Space');
	await expect(skills.getByRole('switch')).toBeChecked();
	await expect(skills.getByRole('switch')).toBeEnabled();
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	editor = page.locator('.ash-chat-input-editor');
	await editor.locator('.stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('Backspace');
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
	await expect(extensionManagementTab.locator('[data-ash-icon-id="extensions"]')).toBeVisible();
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
		const action = () => button === 'Enable' || button === 'Disable' ? details.getByRole('switch').press('Space') : details.getByRole('button', { name: button, exact: true }).click();
		if (button === 'Grant permissions' || button === 'Revoke permissions') {
			const review = await workbench.dialogs.confirm(application, 'Standard extension smoke', button, action);
			expect(review.detail).toContain('Read workspace files');
			expect(review.detail).toContain('Package digest: sha256:');
		} else if (button === 'Uninstall') {
			await workbench.dialogs.confirm(application, 'Uninstall extension', button, action);
		} else {
			await action();
			await expect(details.getByRole('switch')).toBeChecked({ checked: button === 'Enable' });
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
	await workbench.settingsEditor.selectGroup('application');
	await workbench.settingsEditor.selectCategory('display-language');
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
