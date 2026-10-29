import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SignedExtensionRegistry } from '../../../automation/extensionRegistry.js';
import { expect, test as base } from '../../../automation/test.js';

const distribution = process.env.ASH_PRODUCT_RECOMMENDATIONS_DISTRIBUTION;
const trustedRoot = process.env.ASH_PRODUCT_RECOMMENDATIONS_TRUSTED_ROOT;
const liveCatalog = process.env.ASH_PRODUCT_RECOMMENDATIONS_LIVE === '1';
const test = base.extend({
	useDefaultLanguageServer: false,
	backendFixture: async ({ testWorkspace }, use) => {
		await rm(join(testWorkspace.directory, 'Cargo.toml'));
		await writeFile(join(testWorkspace.directory, 'ssh_config'), 'Host example\n    HostName example.test\n');
		if (liveCatalog) {
			await use(undefined);
			return;
		}
		if (!distribution || !trustedRoot) {
			throw new Error('Provide a signed distribution with the keymap, remote-workspace and product recommendation packages.');
		}
		const registry = await SignedExtensionRegistry.createEditor(join(testWorkspace.directory, 'product-registry'), distribution, trustedRoot, 'marketplace.keymap-sublime@ash', [
			'ash',
			'marketplace',
		]);
		try {
			await use(registry);
		} finally {
			await registry.close();
		}
	},
});
test.skip(!liveCatalog && (!distribution || !trustedRoot), 'Supply the signed fixture distribution and trusted root, or ASH_PRODUCT_RECOMMENDATIONS_LIVE=1 to test the published registry.');
test.setTimeout(90_000);

test('Tool and keymap discovery installs a real optional keymap and cleans up its bindings', { tag: ['@electron-app-server'] }, async ({ application, workbench }, testInfo) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.open');
	const search = page.locator('.ash-extensions-view-container').getByRole('searchbox');
	await search.fill('@recommended');
	await search.press('Enter');
	const recommended = page.locator('[data-view-id="ash.extensions.recommended"]');
	await expect(recommended.getByRole('option').filter({ hasText: 'Python Language Support' })).toContainText('Python is available on this host');
	await workbench.quickaccess.runCommand('ash.extensions.showRecommendedKeymaps');
	const keymap = recommended.getByRole('option').filter({ hasText: 'Sublime Text' });
	await expect(keymap).toBeVisible();
	await keymap.click();
	const details = page.locator('.ash-extension-editor');
	await workbench.dialogs.confirm(application, 'Install', 'Install', () => details.getByRole('button', { name: 'Install', exact: true }).click());
	await expect(details.getByRole('switch', { name: 'Enable extension', exact: true })).toBeChecked();
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await editor.waitForTypeInEditor('keymap contribution');
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+D' : 'Control+Shift+D');
	await editor.waitForEditorContents(text => text === 'keymap contribution\nkeymap contribution');
	await workbench.quickaccess.runCommand('ash.extensions.showRecommendedKeymaps');
	await expect(recommended.getByRole('option')).toHaveCount(0);
	await workbench.quickaccess.runCommand('ash.extensions.showInstalled');
	await page.locator('[data-package-id="marketplace.keymap-sublime@ash"]').click();
	await workbench.dialogs.confirm(application, 'Uninstall extension', 'Uninstall', () => details.getByRole('button', { name: 'Uninstall', exact: true }).click());
	await expect(details.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('ash.extensions.showRecommendedKeymaps');
	await expect(keymap).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	await editor.waitForEditorFocus();
	await editor.waitForTypeInEditor('after uninstall');
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+D' : 'Control+Shift+D');
	await editor.waitForEditorContents(text => text === 'after uninstall');
	await page.screenshot({ path: testInfo.outputPath('keymap-uninstalled.png') });
});

test('The optional Remote package registers SSH configuration and snippets through the existing host', { tag: ['@electron-app-server'] }, async ({ application, workbench }, testInfo) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.open');
	const search = page.locator('.ash-extensions-view-container').getByRole('searchbox');
	await search.fill('SSH Configuration');
	await search.press('Enter');
	await workbench.dialogs.confirm(application, 'Install', 'Install', () =>
		page.locator('[data-package-id="marketplace.remote-workspace@ash"]').getByRole('button', { name: 'Install', exact: true }).click(),
	);
	await page
		.locator('[data-part="activitybar"]')
		.getByRole('tab', { name: /^Explorer/u })
		.click();
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'ssh_config', exact: true }).dblclick();
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await expect(page.locator('[data-statusbar-item-id="ash.status.editor.language"]')).toContainText('SSH Config');
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
	await editor.waitForTypeInEditor('ssh-host');
	await editor.input.press('Control+Space');
	const snippet = workbench.editors.groupAt(0).content.locator('.stanza-editor-completion-option').filter({ hasText: 'ssh-host' });
	await expect(snippet).toHaveCount(1);
	await snippet.click();
	await editor.waitForEditorContents(text => text.includes('HostName example.com') && text.includes('IdentityFile'));
	await page.screenshot({ path: testInfo.outputPath('ssh-configuration-snippet.png') });
	await workbench.quickaccess.runCommand('ash.extensions.showInstalled');
	await page.locator('[data-package-id="marketplace.remote-workspace@ash"]').click();
	await workbench.dialogs.confirm(application, 'Uninstall extension', 'Uninstall', () => page.locator('.ash-extension-editor').getByRole('button', { name: 'Uninstall', exact: true }).click());
	await expect(page.locator('.ash-extension-editor').getByRole('button', { name: 'Install', exact: true })).toBeVisible();
	await page
		.locator('[data-part="activitybar"]')
		.getByRole('tab', { name: /^Explorer/u })
		.click();
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'ssh_config', exact: true }).dblclick();
	await editor.waitForEditorFocus();
	await expect(page.locator('[data-statusbar-item-id="ash.status.editor.language"]')).not.toContainText('SSH Config');
	await workbench.quickaccess.runCommand('workbench.action.editor.changeLanguageMode');
	await workbench.quickaccess.search('SSH Config');
	await expect(workbench.quickaccess.items.filter({ hasText: 'SSH Config' })).toHaveCount(0);
	await workbench.quickaccess.close();
});
