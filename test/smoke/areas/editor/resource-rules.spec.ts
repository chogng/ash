import type { Workbench } from '../../../automation/workbench.js';
import { expect, test } from '../../../automation/test.js';

test('resource pattern settings validate structured rules and persist their types', async ({ workbench }) => {
	await setRule(workbench, 'explorer.autoRevealExclude', '**/*.ts', '{"when":42}', false);
	const rules = workbench.page.locator('[data-configuration-key="explorer.autoRevealExclude"]');
	await expect(workbench.settingsEditor.element).toContainText('Invalid rule');
	const value = rules.locator('[data-pattern-part="value"]');
	await value.fill('{"when":"$(basename).js"}');
	await value.press('Tab');
	await expect(rules.locator('.ash-settings-indicators')).toBeHidden();
	await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	await setRule(workbench, 'files.readonlyExclude', '**/main.ts', 'true');
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(source => {
		const configuration = JSON.parse(source);
		return configuration['explorer.autoRevealExclude']?.['**/*.ts']?.when === '$(basename).js' && configuration['files.readonlyExclude']?.['**/main.ts'] === true;
	});
});

test('resource rules control readonly editing, automatic reveal and saved history', async ({ target, workbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Workspace files require App Server on desktop.');
	const page = workbench.page;
	if (target.kind === 'browser' && target.appServerMode === 'disabled') {
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const folder = await root.getDirectoryHandle(`resource-rules-${crypto.randomUUID()}`, { create: true });
			for (const [name, content] of [['main.ts', 'const value = 1;\n'], ['main.rs', 'fn main() {}\n']] as const) {
				const writer = await (await folder.getFileHandle(name, { create: true })).createWritable();
				await writer.write(content);
				await writer.close();
			}
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		});
		await workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Open folder', exact: true }).click();
	}
	const explorer = page.locator('.ash-explorer');
	await expect(explorer).toBeVisible();
	const file = explorer.getByRole('treeitem', { name: 'main.ts', exact: true });
	const other = explorer.getByRole('treeitem', { name: 'main.rs', exact: true });
	await file.dblclick();
	const group = workbench.editors.groupAt(0);
	const editor = group.editor;
	await editor.waitForEditorFocus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('const saved = 2;');
	await page.keyboard.press('ControlOrMeta+S');
	await expect(group.element.getByRole('tab', { name: 'main.ts', exact: true })).toHaveAttribute('aria-selected', 'true');
	await workbench.quickaccess.runCommand('workbench.action.localHistory.open');
	const versions = workbench.quickaccess.items.filter({ has: page.locator('.ash-quick-pick-row-description').getByText('main.ts', { exact: true }) });
	await expect(versions).toHaveCount(1);
	await versions.first().click();
	await editor.waitForEditorContents(text => text === 'const saved = 2;');
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('forbidden');
	await editor.waitForEditorContents(text => text === 'const saved = 2;');
	await group.element.getByRole('tab', { name: 'main.ts', exact: true }).click();
	await setRule(workbench, 'files.readonlyInclude', '**/*.ts', 'true');
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('forbidden');
	await editor.waitForEditorContents(text => text === 'const saved = 2;');
	await setRule(workbench, 'files.readonlyExclude', '**/main.ts', 'true');
	await setRule(workbench, 'workbench.localHistory.exclude', '**/*.ts', 'true');
	await editor.waitForEditorFocus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('const saved = 3;');
	await page.keyboard.press('ControlOrMeta+S');
	await workbench.quickaccess.runCommand('workbench.action.localHistory.open');
	await expect(versions).toHaveCount(1);
	await workbench.quickaccess.close();
	await setRule(workbench, 'explorer.autoRevealExclude', '**/main.ts', 'true');
	await other.dblclick();
	await expect(other).toHaveAttribute('aria-selected', 'true');
	await group.element.getByRole('tab', { name: 'main.ts', exact: true }).click();
	await editor.waitForEditorFocus();
	await expect(other).toHaveAttribute('aria-selected', 'true');
	await expect(editor.input).toBeFocused();
	await setRule(workbench, 'explorer.autoRevealExclude', '**/main.ts', 'false');
	await expect(file).toHaveAttribute('aria-selected', 'true');
});

async function setRule(workbench: Workbench, key: string, pattern: string, rule: string, close = true): Promise<void> {
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = workbench.settingsEditor.element;
	await settings.getByRole('searchbox').fill(key);
	const control = settings.locator(`[data-configuration-key="${key}"]`);
	await expect(control).toBeVisible();
	if (await control.locator('[data-pattern-part="key"]').count() === 0) await control.getByRole('button', { name: 'Add pattern', exact: true }).click();
	await control.locator('[data-pattern-part="key"]').fill(pattern);
	const value = control.locator('[data-pattern-part="value"]');
	await value.fill(rule);
	await value.press('Tab');
	if (close) {
		await expect(control.locator('.ash-settings-indicators')).toBeHidden();
		await settings.locator('.ash-modal-editor-close').click();
	}
}
