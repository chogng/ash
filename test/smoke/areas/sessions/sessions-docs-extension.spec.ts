import { join } from 'node:path';
import { realpath, writeFile } from 'node:fs/promises';
import { SignedExtensionRegistry } from '../../../automation/extensionRegistry.js';
import { expect, test as base } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

const distribution = process.env.ASH_ACADEMY_DISTRIBUTION;
const trustedRoot = process.env.ASH_ACADEMY_TRUSTED_ROOT;
const test = base.extend({
	backendFixture: async ({ testWorkspace }, use) => {
		if (!distribution || !trustedRoot) throw new Error('Provide a signed Academy editor distribution and its trusted root.');
		const registry = await SignedExtensionRegistry.createEditor(join(testWorkspace.directory, 'docs-registry'), distribution, trustedRoot, 'ash.academy@ash');
		try { await use(registry); } finally { await registry.close(); }
	},
});
test.skip(!distribution || !trustedRoot, 'Optional real editor package acceptance; supply ASH_ACADEMY_DISTRIBUTION and ASH_ACADEMY_TRUSTED_ROOT.');

test('Optional Academy opens research papers alongside built-in Docs', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, backendFixture, testWorkspace }) => {
	const registry = backendFixture as SignedExtensionRegistry;
	if (!('windows' in application)) throw new Error('Expected Electron');
	const page = await workbench.openAgentsWindow(target.kind);
	const quick = new QuickAccess(page);
	await quick.runCommand('workbench.action.chat.managePlugins');
	const customize = page.locator('.ash-customize');
	await expect(customize.getByRole('tab', { name: 'Plugins', exact: true })).toHaveAttribute('aria-selected', 'true');
	await customize.getByRole('button', { name: 'Discover', exact: true }).click();
	await customize.locator(`[data-resource-id^="${registry.packageId}/"] .ash-customize-card-name`).click();
	const details = customize.locator('.ash-extension-editor');
	await details.getByRole('button', { name: 'Install', exact: true }).click();
	await page.getByRole('dialog', { name: 'Install', exact: true }).getByRole('button', { name: 'Install', exact: true }).click();
	await expect.poll(() => registry.installations()).toMatchObject([{ package: { id: registry.packageId }, state: 'installed' }]);
	const installation = (await registry.installations())[0];
	const enable = details.getByRole('switch', { name: 'Enable extension', exact: true });
	await expect(enable).toBeVisible();
	if (!await enable.isChecked()) await enable.press('Space');
	await details.getByRole('button', { name: 'Authorize execution', exact: true }).click();
	await page.getByRole('dialog', { name: registry.packageId, exact: true }).getByRole('button', { name: 'Authorize execution', exact: true }).click();
	await expect(details.getByRole('button', { name: 'Revoke execution authorization', exact: true })).toBeVisible();
	await quick.runCommand('ash.extensions.showInstalled');
	await expect(customize.locator(`[data-resource-id="${installation.installationId}"]`)).toBeVisible();
	await expect(page.locator('.ash-extensions-view-container')).toHaveCount(0);

	const ide = workbench.page;
	await ide.bringToFront();
	await workbench.quickaccess.runCommand('ash.extensions.browse');
	const search = ide.locator('.ash-extensions-view-container').getByRole('searchbox');
	await search.fill('academy');
	await search.press('Enter');
	const marketplace = ide.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
	await expect(marketplace).toHaveAttribute('aria-busy', 'false');
	await expect(marketplace.locator(`[data-package-id="${registry.packageId}"]`)).toHaveCount(0);
	await page.bringToFront();
	const paper = join(await realpath(testWorkspace.directory), 'Research.ash-paper');
	await writeFile(paper, '');
	await application.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
	}, paper);
	await quick.runCommand('workbench.action.files.openFile');
	await expect(page.locator('.stanza-structured-editor-pane[data-ash-editor-client]:visible')).toBeVisible();
	await quick.runCommand('sessions.docs.chooseEditor');
	await quick.select('New blank document');
	const rich = page.locator('.ash-docs-workspace:visible .stanza-arkdown-prose').first();
	await expect(rich).toBeVisible({ timeout: 20_000 });
	await rich.fill('Arkdown Docs draft');
	await expect(rich).toHaveText('Arkdown Docs draft');
	await expect(page.locator('.stanza-structured-editor-pane[data-ash-editor-client]:visible')).toHaveCount(0);
});
