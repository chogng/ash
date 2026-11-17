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
 const tree = views.registerTreeDataProvider({
  onDidChangeTreeData: changes.event,
  getChildren: element => element ? [] : [node],
  getTreeItem: element => ({ id: 'item', label: { label: element.label, highlights: [[0, 3]] }, iconPath: { id: 'file' }, tooltip: new ash.MarkdownString('**Provider** item'), checkboxState: element.checked, editable: true }),
  rename(element, value) { element.label = value; changes.fire(); },
  setCheckboxState(element, value) { element.checked = value; changes.fire(); }
 }, { id: 'acme.treeSmoke', title: 'Extension Tree Smoke' });
 context.subscriptions.push(changes, tree,
 commands.register('acme.treeSmoke.refresh', () => { node.label = 'Provider refreshed'; changes.fire(node); }),
 commands.register('acme.treeSmoke.configure', async () => {
  await tree.configure({ title: 'Updated Extension Tree', description: 'Provider description', badge: { value: 2, tooltip: 'Two items' }, canSelectMany: true, showCollapseAllAction: true });
  await tree.reveal(node, { focus: true });
 }));
};`);
	const page = workbench.page;
	await expect(page.getByRole('region', { name: 'Editor', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('tree-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/tree-smoke 1.0.0');
	const details = page.locator('.ash-extension-editor:visible').filter({ hasText: 'Extension tree smoke' });
	const manage = async () => {
		await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
		const option = page.locator('[data-view-id="ash.extensions.plugins"]').getByRole('option').filter({ hasText: 'Extension tree smoke' });
		await expect(option).toBeVisible();
		await option.click();
	};
	await manage();
	await workbench.dialogs.confirm(application, 'Extension tree smoke', 'Grant permissions', () => details.getByRole('button', { name: 'Grant permissions', exact: true }).click());
	await details.getByRole('switch').press('Space');
	await expect(details.getByRole('switch')).toBeChecked();
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
	await workbench.quickaccess.runCommand('acme.treeSmoke.configure');
	await expect(pane.getByRole('tree')).toHaveAttribute('aria-label', 'Updated Extension Tree');
	await expect(pane.getByRole('treeitem')).toHaveAttribute('aria-selected', 'true');
	await expect(pane.locator('.ash-custom-tree-badge')).toHaveText('2');
	await expect(pane.locator('.ash-icon-label-highlight')).toHaveText('Pro');
	await manage();
	await details.getByRole('switch').press('Space');
	await expect(pane).toHaveCount(0);
});
