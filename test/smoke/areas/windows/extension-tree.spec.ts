import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, writeEditorExtensionFixture } from '../../../automation/test.js';

test.use({ actionTimeout: 10_000 });

test('an admitted extension tree survives a missing sibling container, reads, renames, checks, refreshes and retires in Ash', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ testWorkspace, application, workbench }) => {
	test.setTimeout(120_000);
	const root = join(testWorkspace.directory, 'tree-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/tree-smoke', version: '1.0.0', displayName: 'Extension tree smoke',
		compatibility: { ash: '>=0.1.0' }, permissions: [],
		contributions: {
			editorExtensions: [{
				id: 'tree', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1,
				activationEvents: [{ type: 'startup' }], capabilities: ['command', 'treeView'],
			}]
		},
	}));
	await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk'); const { commands, views } = ash;
exports.activate = context => {
 context.subscriptions.push(views.registerTreeDataProvider({ getChildren: () => [], getTreeItem: item => item },
  { id: 'acme.missingTree', title: 'Unavailable tree', containerId: 'acme.missingContainer' }));
 const changes = new ash.EventEmitter(); const node = { label: 'Provider item', checked: 0 };
 context.subscriptions.push(changes, views.registerTreeDataProvider({
  onDidChangeTreeData: changes.event,
  getChildren: element => element ? [] : [node],
  getTreeItem: element => ({ id: 'item', label: element.label, checkboxState: element.checked, editable: true }),
  rename(element, value) { element.label = value; changes.fire(); },
  setCheckboxState(element, value) { element.checked = value; changes.fire(); }
 }, { id: 'acme.treeSmoke', title: 'Extension Tree Smoke' }),
 commands.register('acme.treeSmoke.refresh', () => { node.label = 'Provider refreshed'; changes.fire(); }));
};`);
	const page = workbench.page;
	await expect(page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('tree-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/tree-smoke 1.0.0');
	const details = page.locator('.ash-extension-editor:visible').filter({ hasText: 'acme/tree-smoke' });
	const manage = async () => {
		await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
		const option = page.locator('[data-view-id="ash.extensions.plugins"]').getByRole('option').filter({ hasText: 'acme/tree-smoke' });
		await expect(option).toBeVisible();
		await option.click();
	};
	await manage();
	await workbench.dialogs.confirm(application, 'Extension tree smoke', 'Grant permissions', () => details.getByRole('button', { name: 'Grant permissions', exact: true }).click());
	await details.getByRole('button', { name: 'Enable', exact: true }).click();
	await expect(details.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
	await workbench.openExplorer();
	const pane = page.locator('[data-view-id="acme.treeSmoke"]');
	const label = pane.locator('.ash-custom-tree-label');
	await expect(label).toHaveText('Provider item');
	await expect(page.locator('[data-view-id="acme.missingTree"]')).toHaveCount(0);
	const checkbox = pane.getByRole('checkbox');
	await checkbox.focus();
	await checkbox.press('Space');
	await expect(checkbox).toBeChecked();
	await label.click();
	await page.keyboard.press('F2');
	const rename = pane.getByRole('textbox', { name: 'Rename Provider item', exact: true });
	await expect(rename).toBeFocused();
	await rename.fill('From Ash');
	await rename.press('Enter');
	await expect(label).toHaveText('From Ash');
	await workbench.quickaccess.runCommand('acme.treeSmoke.refresh');
	await expect(label).toHaveText('Provider refreshed');
	await manage();
	await details.getByRole('button', { name: 'Disable', exact: true }).click();
	await expect(pane).toHaveCount(0);
});
