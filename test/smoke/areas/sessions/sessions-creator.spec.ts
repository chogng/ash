import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Menus } from '../../../automation/menus.js';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

test('Sessions Prototype expressions, ordered conditional actions and custom springs run without changing variables', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Prototype', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]');
	const prototype = properties.locator('.ash-prototype-properties'), resources = properties.locator('.ash-design-resources');
	const workspace = page.locator('.ash-creator-workspace[data-creator-mode="prototype"]'), layers = page.getByRole('tree', { name: 'Layers', exact: true });
	for (const name of ['Home', 'Cart', 'Empty', 'Confirmation']) {
		await workspace.getByRole('button', { name: 'Add screen', exact: true }).click();
		const input = properties.getByRole('textbox', { name: 'Layer name', exact: true }); await input.fill(name); await input.press('Tab');
	}
	await layers.getByRole('treeitem', { name: 'Home', exact: true }).click();
	await resources.locator(':scope > summary').click(); await resources.locator('[data-resource-section="variables"] > summary').click();
	await resources.getByRole('button', { name: 'Create collection', exact: true }).click();
	await resources.getByRole('combobox', { name: 'Variable type', exact: true }).selectOption('number');
	await resources.getByRole('button', { name: 'Create variable', exact: true }).click();
	const name = resources.getByRole('textbox', { name: 'Variable name', exact: true }); await name.fill('count'); await name.press('Tab');
	const initial = resources.getByRole('spinbutton', { name: 'Default: value', exact: true }); await initial.fill('0'); await initial.press('Tab');
	await resources.locator(':scope > summary').click();
	const control = (key: string) => prototype.locator(`[data-prototype-control="${key}"]`);
	const choose = async (key: string, value: string): Promise<void> => { await control(key).selectOption(value); };
	const field = async (key: string, value: string): Promise<void> => { await control(key).fill(value); await control(key).press('Tab'); };
	await control('add').click(); await choose('actions.0.action', 'setVariable'); await field('actions.0.value', 'count + 1');
	await control('actions.add').click(); await choose('actions.1.action', 'conditional'); await field('actions.1.branch.0.condition', 'count == 1');
	await control('actions.1.branch.0.add').click(); await choose('actions.1.branch.0.0.action', 'navigate'); await control('actions.1.branch.0.0.destination').selectOption({ label: 'Cart' });
	await choose('actions.1.branch.0.0.transition', 'smart'); await choose('actions.1.branch.0.0.easing', 'spring'); await field('actions.1.branch.0.0.mass', '1.5'); await field('actions.1.branch.0.0.damping', '14');
	await expect(prototype.getByRole('img', { name: /Spring curve/u })).toBeVisible();
	await control('actions.1.branch.0.0.damping').focus(); await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/animations run in sequence.*Custom spring/u); await page.keyboard.press('Escape');
	await control('actions.1.branch.0.0.mass').scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('prototype-custom-spring.png') });
	await control('actions.1.branch.1.add').click(); await choose('actions.1.branch.1.0.action', 'navigate'); await control('actions.1.branch.1.0.destination').selectOption({ label: 'Empty' });
	await control('actions.add').click(); await choose('actions.2.action', 'overlay'); await control('actions.2.destination').selectOption({ label: 'Confirmation' });
	const homeId = await canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id]').nth(0).getAttribute('data-shape-id');
	const cartId = await control('actions.1.branch.0.0.destination').inputValue(), emptyId = await control('actions.1.branch.1.0.destination').inputValue(), confirmationId = await control('actions.2.destination').inputValue();
	await workspace.getByRole('button', { name: 'Preview flow', exact: true }).click();
	const preview = canvas.getByRole('region', { name: 'Prototype preview', exact: true }), scene = preview.locator('.ash-prototype-preview-scene');
	const activate = async (): Promise<void> => { await preview.getByRole('button', { name: /Home: On click/u }).focus(); await page.keyboard.press('Enter'); await expect(scene).toHaveAttribute('data-screen-id', confirmationId); };
	await activate(); await expect(scene.locator(':scope > svg')).toHaveAttribute('data-shape-id', cartId);
	await preview.focus(); await page.keyboard.press('Escape'); await preview.getByRole('button', { name: 'Back', exact: true }).click(); await expect(scene).toHaveAttribute('data-screen-id', homeId!);
	await activate(); await expect(scene.locator(':scope > svg')).toHaveAttribute('data-shape-id', emptyId);
	await preview.getByRole('button', { name: 'Restart flow', exact: true }).click(); await activate(); await expect(scene.locator(':scope > svg')).toHaveAttribute('data-shape-id', cartId);
	await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
	await control('actions.0.down').click(); await page.emulateMedia({ reducedMotion: 'reduce' });
	await workspace.getByRole('button', { name: 'Preview flow', exact: true }).click(); await activate(); await expect(scene.locator(':scope > svg')).toHaveAttribute('data-shape-id', emptyId);
	await preview.getByRole('button', { name: 'Close preview', exact: true }).click(); await canvas.press('ControlOrMeta+z');
	await field('actions.1.branch.0.condition', 'count + true'); await expect(control('actions.1.branch.0.condition')).toHaveAttribute('aria-invalid', 'true');
	await field('actions.1.branch.0.condition', 'count == 1'); await control('actions.1.branch.0.condition').scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('prototype-conditional-actions.png') });
	await resources.locator(':scope > summary').click(); await expect(resources.getByRole('spinbutton', { name: 'Default: value', exact: true })).toHaveValue('0');
});

test('Sessions Prototype connects screens by dragging and plays transitions, branches and overlays', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Prototype', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	const properties = page.locator('[data-part="auxiliarybar"]');
	const prototype = properties.locator('.ash-prototype-properties');
	const layers = page.getByRole('tree', { name: 'Layers', exact: true });
	const workspace = page.locator('.ash-creator-workspace[data-creator-mode="prototype"]');
	for (const name of ['Home', 'Detail']) {
		await workspace.getByRole('button', { name: 'Add screen', exact: true }).click();
		const input = properties.getByRole('textbox', { name: 'Layer name', exact: true }); await input.fill(name); await input.press('Tab');
		for (const [field, value] of [['Width', '180'], ['Height', '300']]) { const size = properties.getByRole('spinbutton', { name: field, exact: true }); await size.fill(value); await size.press('Tab'); }
	}
	await layers.getByRole('treeitem', { name: 'Home', exact: true }).click();
	await canvas.press('0');
	const roots = canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id]');
	const homeId = await roots.nth(0).getAttribute('data-shape-id'); const detailId = await roots.nth(1).getAttribute('data-shape-id');
	const handle = canvas.locator(`[data-prototype-handle="${homeId}"]`);
	const from = await handle.boundingBox(); const to = await roots.nth(1).boundingBox(); expect(from).not.toBeNull(); expect(to).not.toBeNull();
	await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2); await page.mouse.down(); await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 }); await page.mouse.up();
	await expect(prototype.getByRole('combobox', { name: 'Destination', exact: true })).toHaveValue(detailId!);
	await expect(canvas.locator('.ash-prototype-connections > path')).toHaveCount(2);
	await canvas.press('Escape'); await page.mouse.click((from!.x + from!.width / 2 + to!.x) / 2, from!.y + from!.height / 2);
	await expect(prototype.getByRole('combobox', { name: 'Destination', exact: true })).toHaveValue(detailId!);
	await prototype.getByRole('combobox', { name: 'Transition', exact: true }).selectOption('smart');
	const duration = prototype.getByRole('spinbutton', { name: 'Duration (ms)', exact: true }); await duration.fill('200'); await duration.press('Tab');
	await prototype.getByRole('combobox', { name: 'Easing', exact: true }).focus(); await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Smart animate matches layer names and hierarchy/u); await page.keyboard.press('Escape');
	await page.screenshot({ path: testInfo.outputPath('prototype-connections.png') });
	await workspace.getByRole('button', { name: 'Preview flow', exact: true }).click();
	const preview = canvas.getByRole('region', { name: 'Prototype preview', exact: true }); const scene = preview.locator('.ash-prototype-preview-scene');
	await expect(scene).toHaveAttribute('data-screen-id', homeId!);
	await preview.getByRole('button', { name: /Home: On click/u }).focus(); await page.keyboard.press('Enter');
	await expect(scene).toHaveAttribute('data-screen-id', detailId!);
	await preview.getByRole('button', { name: 'Back', exact: true }).click(); await expect(scene).toHaveAttribute('data-screen-id', homeId!);
	await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
	await prototype.getByRole('combobox', { name: 'Action', exact: true }).selectOption('overlay');
	await prototype.getByRole('combobox', { name: 'Transition', exact: true }).selectOption('dissolve');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await workspace.getByRole('button', { name: 'Preview flow', exact: true }).click(); await preview.getByRole('button', { name: /Home: On click/u }).click();
	await expect(scene).toHaveAttribute('data-screen-id', detailId!); await preview.focus(); await page.keyboard.press('Escape');
	await expect(scene).toHaveAttribute('data-screen-id', homeId!); await expect(preview).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('prototype-preview.png') });
	await page.keyboard.press('Escape'); await expect(preview).toBeHidden();
	await canvas.press('ControlOrMeta+z'); await expect(prototype.getByRole('combobox', { name: 'Transition', exact: true })).toHaveValue('smart');
});

test('Sessions Prototype Change to previews interactive component variants without editing the instance', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	const properties = page.locator('[data-part="auxiliarybar"]'); const prototype = properties.locator('.ash-prototype-properties');
	const layers = page.getByRole('tree', { name: 'Layers', exact: true });
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('textbox', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('t'); await canvas.locator('.ash-canvas-viewport').click({ position: { x: 200, y: 100 } }); await page.keyboard.press('Escape'); await field('Text content', 'Off'); await canvas.press('ControlOrMeta+Alt+k'); await field('Layer name', 'Toggle');
	await properties.getByRole('button', { name: 'Add variant', exact: true }).click();
	await layers.getByRole('treeitem', { name: 'Off', exact: true }).first().click(); await field('Text content', 'On');
	await layers.getByRole('treeitem', { name: 'Main component: Toggle', exact: true }).last().click();
	await prototype.locator(':scope > summary').click(); await prototype.getByRole('button', { name: 'Add interaction', exact: true }).click();
	await expect(prototype.getByRole('combobox', { name: 'Action', exact: true })).toHaveValue('changeTo');
	await properties.getByRole('button', { name: 'Create instance', exact: true }).click();
	await prototype.getByRole('button', { name: 'Prototype preview', exact: true }).click();
	const preview = canvas.getByRole('region', { name: 'Prototype preview', exact: true });
	await expect(preview.locator('[data-design-text]')).toHaveText('Off');
	await preview.getByRole('button', { name: /Toggle: On click/u }).focus(); await page.keyboard.press('Enter');
	await expect(preview.locator('[data-design-text]')).toHaveText('On');
	await page.screenshot({ path: testInfo.outputPath('prototype-component.png') });
	await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
	await expect(properties.getByRole('combobox', { name: 'Variant: State', exact: true })).toHaveValue('Variant 1');
});

test('Sessions Design resources bind variable modes and reuse styles with keyboard controls', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	const properties = page.locator('[data-part="auxiliarybar"]');
	const resources = properties.locator('.ash-design-resources');
	const field = async (name: string, value: string): Promise<void> => { const input = resources.getByRole('textbox', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('r');
	await resources.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
	await resources.locator('[data-resource-section="variables"] > summary').click();
	await resources.getByRole('button', { name: 'Create collection', exact: true }).click(); await field('Collection name', 'Theme');
	await resources.getByRole('button', { name: 'Add mode', exact: true }).click(); await field('Mode name: Mode', 'Dark');
	await resources.getByRole('button', { name: 'Create variable', exact: true }).click(); await field('Variable name', 'Brand');
	await field('Default: value', '#6688cc'); await field('Dark: value', '#223355');
	await resources.locator('[data-resource-section="variables"] > summary').click();
	await resources.locator('[data-resource-section="bindings"] > summary').click();
	await resources.getByRole('combobox', { name: 'Variable', exact: true }).selectOption({ label: 'Brand' });
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('fill', '#6688cc');
	await resources.getByRole('combobox', { name: 'Theme mode', exact: true }).selectOption({ label: 'Dark' });
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('fill', '#223355');
	await resources.locator('[data-resource-section="styles"] > summary').click();
	await resources.getByRole('button', { name: 'Create style from selection', exact: true }).click(); await field('Style name', 'Surface');
	await resources.locator('[data-resource-section="variables"] > summary').click(); await field('Dark: value', '#884466');
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('fill', '#884466');
	await resources.locator('[data-resource-section="variables"] > summary').click();
	await canvas.press('ControlOrMeta+z'); await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('fill', '#223355');
	await resources.getByRole('combobox', { name: 'Apply style', exact: true }).focus(); await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Variables support color, number, string and boolean/u);
	await page.keyboard.press('Escape'); await expect(resources.getByRole('combobox', { name: 'Apply style', exact: true })).toBeFocused();
	await resources.locator('[data-resource-section="bindings"] > summary').scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath('design-resources.png') });
	await canvas.locator('.ash-design-tools-widget').getByRole('button', { name: 'Code', exact: true }).click();
	const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	expect(code).toContain('"resources"'); expect(code).toContain('"styleBindings"'); expect(code).toContain('Surface'); expect(code).toContain('Brand');
});

test('Sessions Design components inherit overrides and switch variants with keyboard-accessible controls', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	const properties = page.locator('[data-part="auxiliarybar"]');
	const layers = page.getByRole('tree', { name: 'Layers', exact: true });
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('textbox', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('t'); await canvas.locator('.ash-canvas-viewport').click({ position: { x: 200, y: 100 } }); await page.keyboard.press('Escape'); await field('Text content', 'Default label');
	await canvas.press('ControlOrMeta+Alt+k'); await field('Layer name', 'Button');
	await properties.getByRole('button', { name: 'Add variant', exact: true }).click();
	await field('Value: State', 'Hover');
	await properties.getByRole('button', { name: 'Add variant property', exact: true }).click();
	await field('Property name: Property 2', 'Size');
	await properties.getByRole('button', { name: 'Create instance', exact: true }).click();
	await expect(properties.getByRole('combobox', { name: 'Variant: State', exact: true })).toHaveValue('Hover');
	await layers.getByRole('treeitem', { name: 'Default label', exact: true }).first().click();
	await field('Text content', 'My instance');
	await expect(properties.getByRole('spinbutton', { name: 'X', exact: true })).toBeDisabled();
	await layers.getByRole('treeitem', { name: 'Instance: Button', exact: true }).click();
	await properties.getByRole('combobox', { name: 'Variant: State', exact: true }).selectOption({ value: 'Variant 1' });
	await expect(canvas.locator('.ash-sessions-design-shapes [data-design-text]')).toContainText(['Default label', 'Default label', 'My instance']);
	await canvas.press('-'); await canvas.press('-');
	await properties.getByRole('combobox', { name: 'Variant: State', exact: true }).scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath('design-components.png') });
	await properties.getByRole('button', { name: 'Reset all overrides', exact: true }).click();
	await expect(canvas.locator('.ash-sessions-design-shapes [data-design-text]')).toContainText(['Default label', 'Default label', 'Default label']);
	await canvas.press('ControlOrMeta+z'); await canvas.press('ControlOrMeta+Alt+b');
	await expect(layers.getByRole('treeitem', { name: 'Instance: Button', exact: true })).toHaveCount(0);
	await expect(canvas.locator('.ash-sessions-design-shapes [data-design-text]')).toContainText(['Default label', 'Default label', 'My instance']);
	await canvas.press('ControlOrMeta+z');
	await expect(layers.getByRole('treeitem', { name: 'Instance: Button', exact: true })).toBeVisible();
	await canvas.locator('.ash-design-tools-widget').getByRole('button', { name: 'Code', exact: true }).click();
	const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	expect(code).toContain('"componentId"'); expect(code).toContain('"overrides"'); expect(code).toContain('My instance');
});

test('Sessions mode and page-tab activation reuse Parts while retaining the conversation and dirty document', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	const chat = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await chat.waitForEditorFocus();
	await chat.waitForTypeInEditor('Retained conversation draft');
	const parts = await page.locator('[data-part]').elementHandles();
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await new QuickAccess(page).runCommand('workbench.action.files.newUntitledFile');
	const document = new Editor(page.locator('[data-part="editor"]'));
	await document.waitForEditorFocus();
	await document.waitForTypeInEditor('Retained dirty document');
	await chat.waitForEditorFocus();
	await expect(navigation.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-current', 'page');
	await navigation.getByRole('button', { name: 'Creator', exact: true }).click();
	const creatorNavigation = page.locator('.ash-creator-navigation');
	await creatorNavigation.getByRole('button', { name: 'Design', exact: true }).focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Design/);
	await page.keyboard.press('Escape');
	await expect(creatorNavigation.getByRole('button', { name: 'Design', exact: true })).toBeFocused();
	await creatorNavigation.getByRole('button', { name: 'Design', exact: true }).press('Enter');
	await expect(page.locator('[data-part="sidebar"]')).toContainText('Layers');
	await expect(page.locator('[data-part="auxiliarybar"]')).toContainText('Page');
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	await page.locator('[data-part="editor"]').getByRole('tab', { name: 'Creator', exact: true }).click();
	await expect(navigation.getByRole('button', { name: 'Creator', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-part="sidebar"]')).toContainText('Layers');
	await page.locator('[data-part="editor"]').getByRole('tab', { name: 'Library', exact: true }).click();
	await expect(navigation.getByRole('button', { name: 'Library', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-part="sidebar"]').getByRole('navigation', { name: 'Library categories' })).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toContainText('Asset details');
	for (const part of parts) {
		try { expect(await part.evaluate(element => element.isConnected && element === element.ownerDocument!.querySelector(`[data-part="${(element as HTMLElement).dataset.part}"]`))).toBe(true); }
		finally { await part.dispose(); }
	}
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await chat.waitForEditorContents(text => text === 'Retained conversation draft');
	await document.waitForEditorContents(text => text === 'Retained dirty document');
	await expect(page.getByRole('dialog', { name: 'Save Changes', exact: true })).toHaveCount(0);
	await page.locator('[data-part="editor"]').getByRole('tab', { name: /^Untitled-1(?:,|$)/u }).press('Delete');
	await page.getByRole('dialog', { name: 'Save Changes', exact: true }).getByRole('button', { name: "Don't Save", exact: true }).click();
});

test('Sessions Creator opens seven workspaces and retains each canvas independently', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	const creator = page.locator('.ash-creator');
	await expect(creator.getByRole('heading', { name: 'Creator', exact: true })).toBeVisible();
	await expect(creator.locator('.ash-creator-mode-card')).toHaveCount(7);
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(page.locator('[data-part="editor"] .ash-creator')).toBeVisible();
	await expect(page.locator('[data-part="creator"], [data-part="library"]')).toHaveCount(0);
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	const design = creator.getByRole('button', { name: 'Design', exact: true });
	await design.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Each|Design/);
	await page.keyboard.press('Escape');
	await expect(design).toBeFocused();
	await design.press('Enter');
	for (const part of ['sidebar', 'auxiliarybar']) {
		await expect(page.locator(`[data-part="${part}"]`)).toBeVisible();
		await expect.poll(() => page.locator(`[data-part="${part}"]`).evaluate(element => Math.round(element.parentElement!.getBoundingClientRect().width))).toBe(240);
	}
	let workspace = creator.locator('.ash-creator-workspace:visible');
	let canvas = workspace.getByRole('region', { name: 'Design canvas' });
	await canvas.press('r');
	await canvas.press('+');
	const world = canvas.locator('.ash-canvas-world');
	const transform = await world.evaluate(element => (element as HTMLElement).style.transform);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await expect(design).toBeFocused();
	for (const [mode, action] of [['Whiteboard', 'Add note'], ['Slides', 'Add slide'], ['Brand', 'Square asset'], ['Sites', 'Add web page'], ['Prototype', 'Add screen']]) {
		await creator.getByRole('button', { name: mode, exact: true }).click();
		workspace = creator.locator('.ash-creator-workspace:visible');
		canvas = workspace.getByRole('region', { name: 'Design canvas' });
		await expect(canvas.locator('[data-shape-id]')).toHaveCount(0);
		await workspace.getByRole('button', { name: action, exact: true }).click();
		await expect(canvas.locator('[data-shape-id]').first()).toBeVisible();
		await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	}
	await creator.getByRole('button', { name: 'Make', exact: true }).click();
	await expect(creator.getByRole('textbox', { name: 'Describe what to build' })).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await design.click();
	canvas = creator.locator('.ash-creator-workspace:visible').getByRole('region', { name: 'Design canvas' });
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
	await expect.poll(() => world.evaluate(element => (element as HTMLElement).style.transform)).toBe(transform);
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(0);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.setViewportSize({ width: 620, height: 860 });
	await expect(creator).toHaveClass(/narrow/);
	await expect.poll(() => creator.locator('.ash-creator-modes').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2);
	await expect(design).toHaveCSS('min-height', '36px');
});

test('Sessions Creator resets side panel widths and retains them across page changes and reopening', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const sidebar = page.locator('[data-part="sidebar"]');
	const leftSash = sidebar.locator('xpath=../../..').locator(':scope > .ash-sash:not(.ash-sash-disabled):visible').first();
	const rightSash = page.locator('[data-part="auxiliarybar"]').locator('xpath=../../..').locator(':scope > .ash-sash:not(.ash-sash-disabled):visible').last();
	const panelWidths = () => page.locator('.ash-workbench-part-frame').evaluateAll(frames => frames.filter(frame => frame.querySelector(':scope > [data-part="sidebar"], :scope > [data-part="auxiliarybar"]')).map(frame => Math.round(frame.getBoundingClientRect().width)));
	await expect.poll(panelWidths).toEqual([240, 240]);
	for (const width of [1226, 1400, 1100]) {
		let contentWidth = width;
		if ('windows' in application) {
			const window = await application.browserWindow(page);
			try {
				contentWidth = await window.evaluate((window, width) => {
					window.setSize(width, 800);
					return window.getContentSize()[0];
				}, width);
			} finally { await window.dispose(); }
		} else {
			await page.setViewportSize({ width, height: 800 });
		}
		// Electron DIP sizes and Chromium viewport sizes can round to adjacent pixels under Windows display scaling.
		await expect.poll(async () => Math.abs(await page.evaluate(() => window.innerWidth) - contentWidth)).toBeLessThanOrEqual(1);
		await expect.poll(panelWidths).toEqual([240, 240]);
	}
	await leftSash.focus();
	await leftSash.press('ArrowRight');
	await expect.poll(panelWidths).not.toEqual([240, 240]);
	await leftSash.dblclick();
	await rightSash.focus();
	await rightSash.press('ArrowLeft');
	await rightSash.dblclick();
	await expect.poll(panelWidths).toEqual([240, 240]);
	const canvas = page.locator('.ash-creator').getByRole('region', { name: 'Design canvas' });
	await canvas.press('t'); await canvas.locator('.ash-canvas-viewport').click({ position: { x: 200, y: 100 } }); await page.keyboard.press('Escape');
	const text = page.locator('[data-part="auxiliarybar"]').getByRole('textbox', { name: 'Text content', exact: true });
	await text.fill('A long dashboard headline whose complete layer name needs more room');
	await text.press('Tab');
	await leftSash.dblclick();
	await expect.poll(async () => (await panelWidths())[0]).toBeGreaterThan(240);
	await canvas.press('ControlOrMeta+z');
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(0);
	await leftSash.dblclick();
	await expect.poll(panelWidths).toEqual([240, 240]);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	await expect.poll(panelWidths).toEqual([240, 240]);
	await leftSash.focus();
	await leftSash.press('ArrowRight');
	const resized = await panelWidths();
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.getByRole('region', { name: 'Design canvas', exact: true })).toBeVisible();
	await expect.poll(panelWidths).toEqual(resized);
});

test('Sessions Creator Slides presents reordered pages and Brand undoes an entire variant batch', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	const creator = page.locator('.ash-creator');
	await creator.getByRole('button', { name: 'Slides', exact: true }).click();
	const slides = creator.locator('[data-creator-mode="slides"].ash-creator-workspace');
	await slides.getByRole('button', { name: 'Add slide', exact: true }).click();
	await slides.getByRole('button', { name: 'Add slide', exact: true }).click();
	const selected = await slides.getByRole('combobox', { name: 'Pages', exact: true }).inputValue();
	await slides.getByRole('button', { name: 'Move slide earlier', exact: true }).click();
	await expect(slides.getByRole('combobox', { name: 'Pages', exact: true }).locator('option').first()).toHaveAttribute('value', selected);
	await slides.getByRole('button', { name: 'Present', exact: true }).click();
	const preview = slides.getByRole('region', { name: 'Presentation preview' });
	await expect(preview).toBeFocused();
	await expect(preview.getByRole('status')).toHaveText('1 of 2');
	await preview.press('ArrowRight');
	await expect(preview.getByRole('status')).toHaveText('2 of 2');
	await preview.press('Escape');
	await expect(preview).toBeHidden();
	await expect(slides.getByRole('combobox', { name: 'Pages', exact: true })).toBeFocused();
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await creator.getByRole('button', { name: 'Brand', exact: true }).click();
	const brand = creator.locator('.ash-creator-workspace:visible');
	await brand.getByRole('button', { name: 'Square asset', exact: true }).click();
	await brand.getByRole('button', { name: 'Create size variants', exact: true }).click();
	const canvas = brand.getByRole('region', { name: 'Design canvas' });
	await expect(canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id]')).toHaveCount(4);
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id]')).toHaveCount(1);
});

test('Sessions Creator Make runs preview and prepares a Code draft with source attached', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	await navigation.getByRole('button', { name: 'Creator', exact: true }).click();
	const creator = page.locator('.ash-creator');
	await creator.getByRole('button', { name: 'Make', exact: true }).click();
	const make = creator.locator('.ash-creator-workspace:visible');
	await make.getByRole('button', { name: 'Edit canvas', exact: true }).click();
	await make.getByRole('region', { name: 'Design canvas' }).press('r');
	await expect(make.frameLocator('iframe').locator('[data-design-kind="rectangle"]')).toHaveCount(1);
	await make.getByRole('textbox', { name: 'Describe what to build' }).fill('Add a sign-in form to this page');
	await make.getByRole('button', { name: 'Build with Agent', exact: true }).click();
	await expect(navigation.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-current', 'page');
	await new Editor(page.locator('.ash-sessions-chat-slot.active:visible')).waitForEditorContents(text => text === 'Add a sign-in form to this page');
	await expect(page.locator('.ash-sessions-chat-slot.active:visible')).toContainText('creator.html');
	await navigation.getByRole('button', { name: 'Creator', exact: true }).click();
	await creator.getByRole('button', { name: 'Make', exact: true }).click();
	await expect(make.getByRole('textbox', { name: 'Describe what to build' })).toHaveValue('Add a sign-in form to this page');
	await expect(make.frameLocator('iframe').locator('[data-design-kind="rectangle"]')).toHaveCount(1);
});

test('Sessions Creator uses Chinese mode names, actions and keyboard help', async ({ application, target, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench, application } = await restartWorkbench());
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	const creator = page.locator('.ash-creator');
	for (const title of ['设计', '白板', '幻灯片', '品牌', '网站', 'Make', '原型']) { await expect(creator.getByRole('button', { name: title, exact: true })).toBeVisible(); }
	await creator.getByRole('button', { name: '幻灯片', exact: true }).focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Creator 活动图标.*Design 画布右键菜单/);
	await page.keyboard.press('Escape');
	await creator.getByRole('button', { name: '幻灯片', exact: true }).press('Enter');
	await expect(creator.getByRole('button', { name: '添加幻灯片', exact: true })).toBeVisible();
	await creator.getByRole('button', { name: '添加幻灯片', exact: true }).click();
	await expect(creator.getByRole('combobox', { name: '页面', exact: true })).toHaveText('第 1 页');
	await creator.getByRole('button', { name: 'Creator 首页', exact: true }).click();
	await creator.getByRole('button', { name: '设计', exact: true }).click();
	await expect(creator.locator('.ash-creator-header')).toBeHidden();
	await expect(creator.locator('[data-creator-mode="design"] .ash-creator-workspace-actions')).toHaveCount(0);
	const canvas = page.getByRole('region', { name: '设计画布', exact: true });
	await canvas.press('r');
	const menu = await new Menus(page).inspect(application, () => canvas.press('Shift+F10'));
	expect(menu).toEqual(expect.arrayContaining(['添加画板 (F)', '导入图片', '保存副本', '导出 SVG'].map(label => expect.objectContaining({ label, enabled: true }))));
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await expect(creator.getByRole('button', { name: '设计', exact: true })).toBeVisible();
});

test('Sessions Design layout edits reflow the canvas and preserve layer identity through undo', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	const properties = page.locator('[data-part="auxiliarybar"]');
	const layers = page.getByRole('tree', { name: 'Layers', exact: true });
	await canvas.press('r'); await canvas.press('e');
	await canvas.press('ControlOrMeta+a'); await canvas.press('Shift+A');
	await properties.getByRole('textbox', { name: 'Layer name', exact: true }).fill('Navigation');
	await properties.getByRole('textbox', { name: 'Layer name', exact: true }).press('Tab');
	await expect(layers.getByRole('treeitem', { name: 'Navigation', exact: true })).toBeVisible();
	await properties.getByRole('combobox', { name: 'Layout flow', exact: true }).selectOption('vertical');
	const gap = properties.getByRole('spinbutton', { name: 'Gap', exact: true });
	await gap.fill('24'); await gap.press('Tab');
	await expect(properties.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('208');
	await layers.getByRole('treeitem', { name: 'Rectangle', exact: true }).click();
	await properties.getByRole('combobox', { name: 'Width sizing', exact: true }).selectOption('fill');
	await expect(properties.getByRole('spinbutton', { name: 'X', exact: true })).toBeDisabled();
	const rectangle = canvas.locator('rect[data-shape-id]');
	const id = await rectangle.getAttribute('data-shape-id');
	await layers.getByRole('treeitem', { name: 'Navigation', exact: true }).click();
	const width = properties.getByRole('spinbutton', { name: 'Width', exact: true });
	await width.fill('300'); await width.press('Tab');
	await expect(rectangle).toHaveAttribute('width', '276');
	await canvas.press('ControlOrMeta+z');
	await expect(rectangle).toHaveAttribute('width', '120');
	await canvas.press('ControlOrMeta+Shift+z');
	await expect(rectangle).toHaveAttribute('width', '276');
	await expect(rectangle).toHaveAttribute('data-shape-id', id!);
	await page.screenshot({ path: testInfo.outputPath('design-layout.png') });
	await canvas.locator('.ash-design-tools-widget').getByRole('button', { name: 'Code', exact: true }).click();
	const source = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	if (target.kind === 'browser') {
		const preview = await page.context().newPage();
		try {
			await preview.setContent(source);
			const exported = preview.locator(`[data-design-id="${id}"]`);
			await expect(exported).toHaveCSS('width', '276px');
			await preview.locator('[data-design-kind="frame"]').evaluate(element => { (element as HTMLElement).style.width = '400px'; });
			await expect(exported).toHaveCSS('width', '376px');
		} finally { await preview.close(); }
	}
	await canvas.locator('.ash-design-tools-widget').getByRole('button', { name: 'Design', exact: true }).click();
	await canvas.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Shift\+A[\s\S]*Constraints/);
	await page.keyboard.press('Escape');
	await expect(canvas).toBeFocused();
	await properties.getByRole('combobox', { name: 'Layout flow', exact: true }).selectOption('none');
	await layers.getByRole('treeitem', { name: 'Rectangle', exact: true }).click();
	await properties.getByRole('combobox', { name: 'Horizontal constraint', exact: true }).selectOption('end');
	await layers.getByRole('treeitem', { name: 'Navigation', exact: true }).click();
	await width.fill('400'); await width.press('Tab');
	await layers.getByRole('treeitem', { name: 'Rectangle', exact: true }).click();
	await expect(properties.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('112');
	await canvas.press('ControlOrMeta+Shift+]');
	await expect(layers.getByRole('treeitem').nth(1)).toHaveAccessibleName('Rectangle');
	await canvas.press('ControlOrMeta+Shift+[');
	await expect(layers.getByRole('treeitem').nth(1)).toHaveAccessibleName('Ellipse');
	await canvas.press('ControlOrMeta+d');
	await expect(canvas.locator('rect[data-shape-id]')).toHaveCount(2);
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('rect[data-shape-id]')).toHaveCount(1);
});

test('Sessions Design grid and wrap respect size limits in the canvas and responsive HTML', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	const properties = page.locator('[data-part="auxiliarybar"]');
	const layers = page.getByRole('tree', { name: 'Layers', exact: true });
	const number = async (name: string, value: string): Promise<void> => {
		const field = properties.getByRole('spinbutton', { name, exact: true });
		await field.fill(value); await field.press('Tab');
	};
	const select = async (name: string, value: string): Promise<void> => { await properties.getByRole('combobox', { name, exact: true }).selectOption({ value }); };
	await canvas.press('r'); await canvas.press('e'); await canvas.press('r'); await canvas.press('e');
	await canvas.press('ControlOrMeta+a'); await canvas.press('Shift+A');
	await select('Wrap', 'wrap'); await number('Width', '300'); await number('Line gap', '16');
	await expect(properties.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('200');
	const source = async (): Promise<string> => {
		await canvas.locator('.ash-design-tools-widget').getByRole('button', { name: 'Code', exact: true }).click();
		const value = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
		await canvas.locator('.ash-design-tools-widget').getByRole('button', { name: 'Design', exact: true }).click();
		return value;
	};
	const wrapped = await source();
	if (target.kind === 'browser') {
		const preview = await page.context().newPage();
		try {
			await preview.setContent(wrapped);
			const frame = preview.locator('[data-design-kind="frame"]');
			const children = frame.locator(':scope > .ash-design-object');
			await expect(frame).toHaveCSS('height', '200px');
			await expect(children.nth(2)).toHaveJSProperty('offsetTop', 108);
			await frame.evaluate(element => { (element as HTMLElement).style.width = '200px'; });
			await expect(frame).toHaveCSS('height', '392px');
			await expect(children.nth(3)).toHaveJSProperty('offsetTop', 300);
		} finally { await preview.close(); }
	}
	await select('Layout flow', 'vertical'); await number('Height', '200'); await select('Frame width sizing', 'hug');
	await expect(properties.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('280');
	const vertical = await source();
	if (target.kind === 'browser') {
		const preview = await page.context().newPage();
		try {
			await preview.setContent(vertical);
			const frame = preview.locator('[data-design-kind="frame"]');
			await expect(frame).toHaveCSS('width', '280px');
			await frame.evaluate(element => { (element as HTMLElement).style.height = '400px'; });
			await expect(frame).toHaveCSS('width', '144px');
		} finally { await preview.close(); }
	}
	await select('Layout flow', 'grid');
	await number('Max width', '360'); await number('Width', '500');
	await expect(properties.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('360');
	await select('Column track', '1');
	await expect(properties.getByRole('combobox', { name: 'Column track', exact: true })).toHaveValue('1');
	await number('Column pixels / fraction', '2');
	await layers.getByRole('treeitem', { name: 'Rectangle', exact: true }).last().click();
	await number('Column span', '2');
	await expect(properties.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('336');
	await number('Max width', '200');
	await select('Horizontal cell alignment', 'end');
	await expect(properties.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('148');
	await canvas.press('ControlOrMeta+z');
	await expect(properties.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('12');
	await canvas.press('ControlOrMeta+Shift+z');
	await expect(properties.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('148');
	await number('Max width', '');
	await expect(properties.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('336');
	await layers.getByRole('treeitem', { name: 'Frame', exact: true }).click();
	await number('Height', '300');
	await page.screenshot({ path: testInfo.outputPath('design-grid.png') });
	await properties.getByRole('spinbutton', { name: 'Row pixels / fraction', exact: true }).scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath('design-grid-controls.png') });
	const gridSource = await source();
	expect(gridSource).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 2fr)');
	if (target.kind === 'browser') {
		const preview = await page.context().newPage();
		try {
			await preview.setContent(gridSource);
			const frame = preview.locator('[data-design-kind="frame"]');
			const spanning = frame.locator(':scope > .ash-design-object').first();
			await expect(spanning).toHaveCSS('width', '336px');
			await frame.evaluate(element => { (element as HTMLElement).style.width = '320px'; });
			// Chromium rounds fractional grid tracks to layout subpixels.
			await expect.poll(async () => (await spanning.boundingBox())!.width).toBeCloseTo(296, 1);
			await frame.evaluate(element => { (element as HTMLElement).style.width = '800px'; });
			await expect(frame).toHaveCSS('width', '360px');
			await expect(spanning).toHaveCSS('width', '336px');
		} finally { await preview.close(); }
	}
	await canvas.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Wrap moves[\s\S]*Grid[\s\S]*Size limits/u);
});

test('Sessions Prototype scrolls with wheel, drag and keyboard, pins layers and animates Scroll to', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Prototype', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]'), layers = page.getByRole('tree', { name: 'Layers', exact: true });
	const workspace = page.locator('.ash-creator-workspace[data-creator-mode="prototype"]'), prototype = properties.locator('.ash-prototype-properties');
	const text = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('textbox', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	const number = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await workspace.getByRole('button', { name: 'Add screen', exact: true }).click(); await text('Layer name', 'Scrolling page');
	for (const [name, x, y, width, height] of [['Jump to footer', '20', '10', '100', '40'], ['Sticky heading', '150', '90', '130', '40'], ['Footer', '20', '900', '260', '60']]) {
		await canvas.press('r'); await text('Layer name', name); await number('X', x); await number('Y', y); await number('Width', width); await number('Height', height);
	}
	await layers.getByRole('treeitem', { name: 'Scrolling page', exact: true }).click(); await number('Width', '300'); await number('Height', '300');
	await prototype.getByRole('combobox', { name: 'Overflow scrolling', exact: true }).selectOption('vertical');
	await layers.getByRole('treeitem', { name: 'Sticky heading', exact: true }).click(); await prototype.getByRole('combobox', { name: 'Scroll position', exact: true }).selectOption('sticky');
	await layers.getByRole('treeitem', { name: 'Jump to footer', exact: true }).click(); await prototype.getByRole('combobox', { name: 'Scroll position', exact: true }).selectOption('fixed');
	await prototype.getByRole('button', { name: 'Add interaction', exact: true }).click();
	await prototype.getByRole('combobox', { name: 'Action', exact: true }).selectOption('scrollTo'); await prototype.getByRole('combobox', { name: 'Destination', exact: true }).selectOption({ label: 'Footer' });
	await prototype.getByRole('combobox', { name: 'Transition', exact: true }).selectOption('scroll'); await number('Duration (ms)', '250');
	const footerId = await prototype.getByRole('combobox', { name: 'Destination', exact: true }).inputValue();
	await workspace.getByRole('button', { name: 'Preview flow', exact: true }).click();
	const preview = canvas.getByRole('region', { name: 'Prototype preview', exact: true }), scene = preview.locator('.ash-prototype-preview-scene'), frame = scene.locator(':scope > svg');
	const bounds = await frame.locator(':scope > rect').first().boundingBox(); expect(bounds).not.toBeNull();
	await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height * 0.8); await page.mouse.wheel(0, 180);
	await expect.poll(async () => Number(await frame.getAttribute('data-scroll-y'))).toBeGreaterThan(0);
	await frame.focus(); await page.keyboard.press('End'); await expect(frame).toHaveAttribute('data-scroll-y', '660');
	await expect(scene.locator(`[data-shape-id="${footerId}"]`)).toHaveAttribute('y', '240');
	await page.keyboard.press('Home'); await expect(frame).toHaveAttribute('data-scroll-y', '0');
	await page.mouse.move(bounds!.x + bounds!.width * 0.8, bounds!.y + bounds!.height * 0.8); await page.mouse.down(); await page.mouse.move(bounds!.x + bounds!.width * 0.8, bounds!.y + bounds!.height * 0.45, { steps: 6 }); await page.mouse.up();
	await expect.poll(async () => Number(await frame.getAttribute('data-scroll-y'))).toBeGreaterThan(50);
	await preview.getByRole('button', { name: /Jump to footer: On click/u }).focus(); await page.keyboard.press('Enter'); await expect(frame).toHaveAttribute('data-scroll-y', '660');
	await expect(preview.getByRole('button', { name: /Jump to footer: On click/u })).toHaveAttribute('y', '10');
	await page.screenshot({ path: testInfo.outputPath('prototype-scrolling.png') });
	await preview.getByRole('button', { name: 'Restart flow', exact: true }).click(); await expect(frame).toHaveAttribute('data-scroll-y', '0');
	await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
	await layers.getByRole('treeitem', { name: 'Footer', exact: true }).click(); await expect(properties.getByRole('spinbutton', { name: 'Y', exact: true })).toHaveValue('900');
	await layers.getByRole('treeitem', { name: 'Jump to footer (Fixed)', exact: true }).click();
	await prototype.getByRole('combobox', { name: 'Scroll position', exact: true }).focus(); await page.keyboard.press('Alt+F1'); await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Sticky layers stop at the top.*Reset scroll position/u); await page.keyboard.press('Escape');
});


test('Sessions Design edits rich text on canvas with one typing undo', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await canvas.focus(); await canvas.press('t'); await canvas.locator('.ash-canvas-viewport').click({ position: { x: 200, y: 100 } }); await page.keyboard.press('Escape'); await canvas.press('Enter');
	const editor = canvas.getByRole('textbox', { name: 'Edit text', exact: true });
	await expect(editor).toBeFocused();
	await page.keyboard.type('Hello world');
	await expect(editor).toHaveText('Hello world');
	await page.keyboard.press('ControlOrMeta+z'); await expect(editor).toHaveText('Text');
	await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(editor).toHaveText('Hello world');
	await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+b');
	await expect(editor.locator('span').first()).toHaveCSS('font-weight', '700');
	if (target.kind === 'browser') {
		const cdp = await page.context().newCDPSession(page);
		await page.keyboard.press('ControlOrMeta+a');
		await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
		await expect(page.locator('[data-part="auxiliarybar"]').getByRole('textbox', { name: 'Text content', exact: true })).toHaveValue('Hello world');
		await cdp.send('Input.insertText', { text: '中文排版' });
		await expect(editor).toHaveText('中文排版');
		await expect(page.locator('[data-part="auxiliarybar"]').getByRole('textbox', { name: 'Text content', exact: true })).toHaveValue('中文排版');
		await page.keyboard.press('ControlOrMeta+z'); await expect(editor).toHaveText('Hello world');
		await cdp.detach();
	}
	await page.screenshot({ path: testInfo.outputPath('design-rich-text-editing.png') });
	await page.keyboard.press('Escape'); await expect(editor).toHaveCount(0);
	await expect(canvas.locator('[data-design-text]')).toHaveText('Hello world');
	await canvas.press('r'); await canvas.press('ControlOrMeta+a'); await canvas.press('g');
	const properties = page.locator('[data-part="auxiliarybar"]');
	const width = properties.getByRole('spinbutton', { name: 'Width', exact: true });
	await width.fill(String(Number(await width.inputValue()) * 2)); await width.press('Tab');
	const rotation = properties.getByRole('spinbutton', { name: 'Rotation', exact: true }); await rotation.fill('30'); await rotation.press('Tab');
	await canvas.press('v');
	const artwork = canvas.locator('[data-shape-id] [data-design-text]').first();
	const textBounds = await artwork.boundingBox();
	await page.mouse.dblclick(textBounds!.x + textBounds!.width / 2, textBounds!.y + textBounds!.height / 2); await expect(editor).toBeFocused();
	const before = await artwork.boundingBox(), editing = await editor.boundingBox();
	for (const key of ['x', 'y', 'width', 'height'] as const) { expect(Math.abs(editing![key] - before![key])).toBeLessThan(1); }
	await expect(editor).toHaveCSS('user-select', 'text');
	await page.screenshot({ path: testInfo.outputPath('design-grouped-text.png') });
	await page.keyboard.press('Escape');
});

test('Sessions Design typography wraps, preserves rich ranges and exports responsive text', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	const properties = page.locator('[data-part="auxiliarybar"]');
	const typography = properties.locator('.ash-design-text-properties').first();
	const number = async (label: string, value: string) => { const input = properties.getByRole('spinbutton', { name: label, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('t');
	const viewport = await canvas.locator('.ash-canvas-viewport').boundingBox();
	await page.mouse.move(viewport!.x + 200, viewport!.y + 100); await page.mouse.down(); await page.mouse.move(viewport!.x + 420, viewport!.y + 220, { steps: 4 }); await page.mouse.up();
	const edit = canvas.getByRole('textbox', { name: 'Edit text', exact: true });
	await expect(edit).toBeFocused(); await page.keyboard.type('A thoughtful headline with enough words to wrap across several lines.');
	await page.keyboard.press('Escape');
	await expect(typography.getByRole('combobox', { name: 'Text resizing', exact: true })).toHaveValue('none');
	await typography.getByRole('combobox', { name: 'Text resizing', exact: true }).selectOption('height');
	await number('Width', '180');
	await expect(typography.getByRole('combobox', { name: 'Text resizing', exact: true })).toHaveValue('height');
	const heightBefore = Number(await properties.getByRole('spinbutton', { name: 'Height', exact: true }).inputValue());
	expect(heightBefore).toBeGreaterThan(60);
	await number('Width', '340');
	const heightAfter = Number(await properties.getByRole('spinbutton', { name: 'Height', exact: true }).inputValue());
	expect(heightAfter).toBeLessThan(heightBefore);
	await canvas.press('Enter');
	await page.keyboard.press('Home');
	for (let index = 0; index < 12; index++) { await page.keyboard.press('Shift+ArrowRight'); }
	await typography.getByRole('combobox', { name: 'Font style', exact: true }).selectOption('italic');
	await expect(edit.locator('span').first()).toHaveCSS('font-style', 'italic');
	await expect(edit.locator('span').last()).toHaveCSS('font-style', 'normal');
	await edit.press('ControlOrMeta+a');
	await expect(typography.getByRole('combobox', { name: 'Font style', exact: true })).toHaveValue('');
	await edit.press('Escape');
	await typography.locator('summary').click();
	await typography.getByRole('combobox', { name: 'Line height unit', exact: true }).selectOption('percent'); await number('Line height', '150');
	await typography.getByRole('combobox', { name: 'Wrap style', exact: true }).selectOption('balance');
	const features = typography.getByRole('textbox', { name: 'OpenType features', exact: true }); await features.fill('liga=0, kern=1'); await features.press('Tab');
	await expect(canvas.locator('[data-design-text]').first()).toHaveCSS('font-feature-settings', '"kern", "liga" 0');
	await typography.getByRole('checkbox', { name: 'Truncate text', exact: true }).check(); await number('Max lines', '2');
	await expect(properties.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('72');
	await number('Max lines', ''); await number('Height', '72');
	await expect(canvas.locator('[data-design-text]').first()).toHaveCSS('-webkit-line-clamp', '2');
	await typography.getByRole('combobox', { name: 'Text resizing', exact: true }).selectOption('height');
	await typography.getByRole('checkbox', { name: 'Truncate text', exact: true }).uncheck();
	await features.focus(); await page.keyboard.press('Alt+F1'); await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Auto width grows.*Max lines/u); await page.keyboard.press('Escape');
	await page.screenshot({ path: testInfo.outputPath('design-typography.png') });
	await canvas.locator('.ash-design-tools-widget').getByRole('button', { name: 'Code', exact: true }).click();
	const source = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	if (target.kind === 'browser') {
		const preview = await page.context().newPage();
		try {
			await preview.setContent(source);
			const text = preview.locator('[data-design-kind="text"]'); const before = (await text.boundingBox())!.height;
			await text.evaluate(element => { (element as HTMLElement).style.width = '120px'; });
			expect((await text.boundingBox())!.height).toBeGreaterThan(before);
			await expect(text.locator('span').first()).toHaveCSS('font-style', 'italic');
			await expect(text.locator('span').last()).toHaveCSS('font-style', 'normal');
		} finally { await preview.close(); }
	}
});

test('Sessions Design vector booleans keep editable operands, holes, history and exported paths', async ({ target, workbench }, testInfo) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	let canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	let properties = page.locator('[data-part="auxiliarybar"]');
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('r'); await field('X', '0'); await field('Y', '0'); await field('Width', '200'); await field('Height', '160');
	await canvas.press('e'); await field('X', '50'); await field('Y', '40'); await field('Width', '100'); await field('Height', '80');
	await canvas.press('ControlOrMeta+a'); await properties.getByRole('button', { name: 'Subtract selection', exact: true }).click();
	const result = () => canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id] > path');
	await expect(result()).toHaveCount(1); await expect(result()).not.toHaveAttribute('d', '');
	const original = await result().getAttribute('d');
	const inside = async (x: number, y: number): Promise<boolean> => result().evaluate((path, point) => (path as SVGGeometryElement).isPointInFill(new DOMPoint(point.x, point.y)), { x, y });
	expect(await inside(10, 10)).toBe(true); expect(await inside(100, 80)).toBe(false);
	await canvas.press('Tab'); await field('Width', '180'); await expect(result()).not.toHaveAttribute('d', original!);
	await canvas.press('ControlOrMeta+z'); await expect(result()).toHaveAttribute('d', original!);
	await canvas.press('ControlOrMeta+a');
	await page.locator('.ash-design-layers').getByRole('tree', { name: 'Layers', exact: true }).press('Alt+Shift+u'); await expect.poll(() => inside(100, 80)).toBe(true);
	await properties.getByRole('button', { name: 'Intersect selection', exact: true }).click(); expect(await inside(10, 10)).toBe(false); expect(await inside(100, 80)).toBe(true);
	await properties.getByRole('button', { name: 'Exclude selection', exact: true }).click(); expect(await inside(100, 80)).toBe(false);
	await canvas.press('ControlOrMeta+e');
	await expect(canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]')).toHaveCount(1);
	await expect(properties.getByRole('combobox', { name: 'Contour', exact: true }).locator('option')).toHaveCount(2);
	await properties.getByRole('combobox', { name: 'Contour', exact: true }).selectOption('1');
	const anchor = properties.getByRole('spinbutton', { name: 'Anchor X', exact: true }); const before = Number(await anchor.inputValue());
	await canvas.press('ArrowRight'); await expect(anchor).toHaveValue(String(before + 1));
	await canvas.press('ControlOrMeta+z'); await expect(anchor).toHaveValue(String(before));
	await page.screenshot({ path: testInfo.outputPath('design-vector-booleans.png') });
	if (target.kind === 'browser') {
		await page.evaluate(async () => { const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(`ash-vector-${crypto.randomUUID()}`, { create: true }); Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder }); });
		await canvas.press('Shift+F10'); await page.getByRole('menuitem', { name: 'Save a copy', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Save a copy', exact: true });
		await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('vectors.ash-design'); await dialog.getByRole('button', { name: 'OK', exact: true }).click();
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Saved vectors.ash-design');
		await canvas.press('Escape'); await canvas.press('Shift+F10'); await page.getByRole('menuitem', { name: 'Open design', exact: true }).click();
		await page.locator('.ash-quick-pick-row-label').filter({ hasText: /^vectors\.ash-design$/u }).click();
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Opened vectors.ash-design');
		await canvas.press('Tab'); await expect(properties.getByRole('combobox', { name: 'Contour', exact: true }).locator('option')).toHaveCount(2);
	}
	await canvas.getByRole('button', { name: 'Code', exact: true }).click();
	const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	expect(code).toContain('"subpaths"'); expect(code).toContain('fill-rule="nonzero"');
	expect(code).toContain('<path');
});

async function paintColor(page: Page, value: string): Promise<void> {
	await page.locator('[data-part="auxiliarybar"]').getByRole('button', { name: 'Fill', exact: true }).click();
	const input = page.getByRole('textbox', { name: 'Color value', exact: true }); await input.fill(value); await input.press('Enter'); await input.press('Escape');
}
async function paintPixel(page: Page, x: number, y: number): Promise<number[]> {
	const png = await page.screenshot();
	return page.evaluate(async ({ png, x, y }) => { const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); return [...context.getImageData(Math.round(x * devicePixelRatio), Math.round(y * devicePixelRatio), 1, 1).data]; }, { png: png.toString('base64'), x, y });
}

test('Sessions Design edits four gradient types, canvas stops and paint stacks through save and reopen', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click(); await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]');
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('r'); await field('X', '100'); await field('Y', '100'); await field('Width', '240'); await field('Height', '160'); await paintColor(page, '#ff0000');
	const type = properties.getByRole('combobox', { name: 'Fill type', exact: true }); await type.selectOption('linear');
	await expect(canvas.locator('linearGradient')).toHaveCount(1); await expect(canvas.locator('[data-gradient-stop]')).toHaveCount(2);
	await properties.getByRole('button', { name: 'Add gradient stop', exact: true }).click(); await field('Gradient stop position (%)', '50'); await paintColor(page, '#0000ff');
	const stops = properties.getByRole('combobox', { name: 'Gradient stop', exact: true }); await expect(stops.locator('option')).toHaveCount(3);
	await canvas.press('ArrowRight'); await expect(properties.getByRole('spinbutton', { name: 'Gradient stop position (%)', exact: true })).toHaveValue('51');
	const handle = canvas.locator('[data-gradient-stop]').nth(1), box = await handle.boundingBox(); expect(box).toBeTruthy();
	await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down(); await page.mouse.move(box!.x + box!.width / 2 + 24, box!.y + box!.height / 2, { steps: 4 }); await page.mouse.up();
	await expect(properties.getByRole('spinbutton', { name: 'Gradient stop position (%)', exact: true })).toHaveValue('61'); await canvas.press('ControlOrMeta+z'); await expect(properties.getByRole('spinbutton', { name: 'Gradient stop position (%)', exact: true })).toHaveValue('51');
	for (const next of ['radial', 'angular', 'diamond']) { await type.selectOption(next); if (next === 'radial') { await expect(canvas.locator('radialGradient')).toHaveCount(1); } else { await expect(canvas.locator('pattern image')).toHaveAttribute('href', /^data:image\/png;base64,/u); } }
	await field('Gradient start X (%)', '50'); await field('Gradient start Y (%)', '50'); await field('Gradient end X (%)', '100'); await field('Gradient end Y (%)', '50'); await field('Gradient axis X (%)', '50'); await field('Gradient axis Y (%)', '100');
	await properties.getByRole('button', { name: 'Duplicate fill', exact: true }).click(); await field('Paint opacity (%)', '35'); await properties.getByRole('combobox', { name: 'Fill blend mode', exact: true }).selectOption('screen');
	await properties.getByRole('button', { name: 'Move fill down', exact: true }).click(); await expect(properties.getByRole('combobox', { name: 'Fill layer', exact: true }).locator('option')).toHaveCount(2);
	await properties.getByRole('checkbox', { name: 'Fill visible', exact: true }).uncheck(); await expect(canvas.locator('[data-paint-id]')).toHaveCount(1); await properties.getByRole('checkbox', { name: 'Fill visible', exact: true }).check();
	if (target.kind === 'browser') { await reopenOutlinedDesign(page, 'gradients.ash-design'); await canvas.press('Tab'); }
	await expect(type).toHaveValue('diamond'); await expect(stops.locator('option')).toHaveCount(3); await expect(canvas.locator('[data-paint-id]')).toHaveCount(2);
	const paintedBox = await canvas.locator('.ash-sessions-design-shapes > [data-shape-id]').boundingBox(); expect(paintedBox).toBeTruthy();
	const corner = await paintPixel(page, paintedBox!.x + 12, paintedBox!.y + 12); expect(corner.slice(0, 3)).toEqual([255, 255, 255]);
	const center = await paintPixel(page, paintedBox!.x + paintedBox!.width / 2, paintedBox!.y + paintedBox!.height / 2); expect(center[0]).toBeGreaterThan(240); expect(center[1]).toBeLessThan(20); expect(center[2]).toBeLessThan(20);
	await page.screenshot({ path: testInfo.outputPath('design-gradients.png') });
	await canvas.getByRole('button', { name: 'Code', exact: true }).click(); const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue(); expect(code).toContain('data:image/png;base64,'); expect(code).toContain('mix-blend-mode: screen'); expect(code).toContain('"type": "diamond"');
});

test('Sessions Design composites fill order, opacity and plus darker against the backdrop', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click(); await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]');
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('r'); await field('X', '100'); await field('Y', '100'); await field('Width', '200'); await field('Height', '160'); await paintColor(page, '#808080');
	await canvas.press('ControlOrMeta+d'); await field('X', '100'); await field('Y', '100'); await paintColor(page, '#c0c0c0');
	const fillBlend = properties.getByRole('combobox', { name: 'Fill blend mode', exact: true }), layerBlend = properties.getByRole('combobox', { name: 'Layer blend mode', exact: true });
	const rect = canvas.locator('.ash-sessions-design-shapes > [data-shape-id]').first(); const box = await rect.boundingBox(); expect(box).toBeTruthy();
	const color = () => paintPixel(page, box!.x + box!.width * .4, box!.y + box!.height * .7);
	const expectGray = async (expected: number) => { await expect.poll(async () => (await color()).slice(0, 3).every(value => Math.abs(value - expected) <= 2)).toBe(true); };
	await fillBlend.selectOption('multiply'); await expectGray(96);
	await layerBlend.selectOption('normal'); await expectGray(192); await layerBlend.selectOption('pass-through');
	await fillBlend.selectOption('plus-darker'); await expectGray(65); await layerBlend.selectOption('normal'); await expectGray(192); await layerBlend.selectOption('pass-through'); await field('Paint opacity (%)', '50'); await expectGray(96);
	await field('Paint opacity (%)', '100'); await fillBlend.selectOption('normal'); await field('Layer opacity (%)', '50'); await expectGray(160); await field('Layer opacity (%)', '100'); await layerBlend.selectOption('plus-darker'); await expectGray(65); await layerBlend.selectOption('pass-through');
	await properties.getByRole('button', { name: 'Add fill', exact: true }).click(); await paintColor(page, '#ff0000'); await field('Paint opacity (%)', '100');
	await expect.poll(async () => (await color()).slice(0, 3)).toEqual([255, 0, 0]);
	await properties.getByRole('button', { name: 'Move fill down', exact: true }).click(); await expectGray(192); await properties.getByRole('button', { name: 'Move fill up', exact: true }).click();
	await properties.getByRole('checkbox', { name: 'Fill visible', exact: true }).uncheck(); await expectGray(192);
	await properties.getByRole('button', { name: 'Remove fill', exact: true }).click(); await properties.getByRole('button', { name: 'Remove fill', exact: true }).click(); await expectGray(128);
	await canvas.press('ControlOrMeta+z'); await expectGray(192); await fillBlend.selectOption('plus-darker'); await expectGray(65);
	await page.screenshot({ path: testInfo.outputPath('design-paint-blend.png') });
	await canvas.getByRole('button', { name: 'Code', exact: true }).click(); const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	const preview = await page.context().newPage(); try { await preview.setContent(code); expect((await paintPixel(preview, 80, 112)).slice(0, 3)).toEqual([65, 65, 65]); } finally { await preview.close(); }
});

test('Sessions Design paints editable text gradients and exports matching blended glyphs', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click(); await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]');
	await canvas.press('t'); await canvas.locator('.ash-canvas-viewport').click({ position: { x: 100, y: 100 } }); await page.keyboard.press('Escape');
	const content = properties.getByRole('textbox', { name: 'Text content', exact: true }); await content.fill('MMMMMM'); await content.press('Tab');
	const size = properties.getByRole('spinbutton', { name: 'Font size', exact: true }); await size.fill('72'); await size.press('Tab');
	await paintColor(page, '#ff0000'); await properties.getByRole('combobox', { name: 'Fill type', exact: true }).selectOption('linear');
	await properties.getByRole('combobox', { name: 'Gradient stop', exact: true }).selectOption({ index: 1 }); await paintColor(page, '#0000ff');
	await canvas.press('Escape');
	const colors = async (preview: Page) => { const png = await preview.screenshot(); return preview.evaluate(async png => { const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); const data = context.getImageData(0, 0, canvas.width, canvas.height).data; let red = 0, blue = 0; for (let i = 0; i < data.length; i += 4) { if (data[i] > 150 && data[i + 1] < 50 && data[i + 2] < 100) { red++; } if (data[i + 2] > 150 && data[i + 1] < 50 && data[i] < 100) { blue++; } } return { red, blue }; }, png.toString('base64')); };
	const painted = await colors(page); expect(painted.red).toBeGreaterThan(200); expect(painted.blue).toBeGreaterThan(200);
	await page.screenshot({ path: testInfo.outputPath('design-gradient-text.png') });
	for (const blend of ['normal', 'plus-darker']) {
		await properties.getByRole('combobox', { name: 'Fill blend mode', exact: true }).selectOption(blend);
		await canvas.getByRole('button', { name: 'Code', exact: true }).click(); const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
		const preview = await page.context().newPage(); try { await preview.setContent(code); await expect.poll(async () => (await colors(preview)).red).toBeGreaterThan(200); expect((await colors(preview)).blue).toBeGreaterThan(200); } finally { await preview.close(); }
		await canvas.getByRole('button', { name: 'Design', exact: true }).click();
	}
});

test('Sessions Design smooths corners and preserves aligned strokes around holes through outlining and reopen', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]');
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('r'); await field('X', '0'); await field('Y', '0'); await field('Width', '200'); await field('Height', '100');
	await properties.getByRole('button', { name: 'Convert to path', exact: true }).click(); await canvas.press('Escape'); await field('Node corner radius', '20');
	const plain = canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]'); const circular = await plain.getAttribute('d');
	await properties.getByRole('button', { name: 'iOS smoothing (60%)', exact: true }).click();
	await expect(properties.getByRole('spinbutton', { name: 'Corner smoothing (%)', exact: true })).toHaveValue('60'); await expect(plain).not.toHaveAttribute('d', circular!);
	await canvas.press('ControlOrMeta+z'); await expect(plain).toHaveAttribute('d', circular!); await canvas.press('ControlOrMeta+Shift+z');
	await field('X', '100'); await field('Y', '100'); await page.screenshot({ path: testInfo.outputPath('design-corner-smoothing.png') }); await field('X', '0'); await field('Y', '0');
	await field('Node corner radius', '0');
	await canvas.press('e'); await field('X', '50'); await field('Y', '25'); await field('Width', '100'); await field('Height', '50');
	await canvas.press('ControlOrMeta+a'); await properties.getByRole('button', { name: 'Subtract selection', exact: true }).click(); await canvas.press('ControlOrMeta+e');
	await field('Stroke width', '10'); const alignment = properties.getByRole('combobox', { name: 'Stroke alignment', exact: true });
	const inside = (x: number, y: number) => plain.evaluate((path, p) => (path as SVGGeometryElement).isPointInFill(new DOMPoint(p.x, p.y)), { x, y });
	await alignment.selectOption('inside'); await expect(canvas.locator('path[clip-path]')).toHaveCount(1);
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click();
	expect(await inside(-5, 50)).toBe(false); expect(await inside(5, 50)).toBe(true); expect(await inside(45, 50)).toBe(true); expect(await inside(55, 50)).toBe(false); expect(await inside(100, 50)).toBe(false);
	await canvas.press('ControlOrMeta+z'); await alignment.selectOption('outside'); await expect(canvas.locator('path[mask]')).toHaveCount(1);
	if (target.kind === 'browser') { await reopenOutlinedDesign(page, 'aligned.ash-design'); await canvas.press('Tab'); }
	await expect(alignment).toHaveValue('outside');
	await page.screenshot({ path: testInfo.outputPath('design-stroke-alignment.png') });
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click();
	expect(await inside(-5, 50)).toBe(true); expect(await inside(5, 50)).toBe(false); expect(await inside(45, 50)).toBe(false); expect(await inside(55, 50)).toBe(true); expect(await inside(100, 50)).toBe(false);
	await canvas.press('ControlOrMeta+z'); await canvas.getByRole('button', { name: 'Code', exact: true }).click();
	const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue(); expect(code).toContain('maskUnits="userSpaceOnUse"'); expect(code).toContain('"strokeAlignment": "outside"');
});

test('Sessions Design edits independent arrow endpoints, preserves network endpoints and outlines exported tips', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]'), viewport = canvas.locator('.ash-canvas-viewport');
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('p'); await viewport.click({ position: { x: 100, y: 180 } }); await viewport.click({ position: { x: 340, y: 180 } }); await canvas.press('Enter'); await canvas.press('v'); await canvas.press('Tab');
	await field('Stroke width', '12');
	const start = properties.getByRole('combobox', { name: 'Start endpoint', exact: true }), end = properties.getByRole('combobox', { name: 'End endpoint', exact: true });
	await start.selectOption('round'); await end.selectOption('triangle-arrow');
	const group = canvas.locator('.ash-sessions-design-shapes > g[data-shape-id]'); const tips = group.locator(':scope > path[fill]:not([fill="none"])');
	const geometry = await tips.getAttribute('d'); await expect(tips).not.toHaveAttribute('d', '');
	const tipBounds = await tips.evaluate(path => { const b = (path as SVGGraphicsElement).getBBox(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
	const besideTip = { x: tipBounds.x + tipBounds.width - 1, y: tipBounds.y + tipBounds.height / 2 + 5 };
	expect(await group.locator('path[stroke]').evaluate((path, p) => (path as SVGGeometryElement).isPointInStroke(new DOMPoint(p.x, p.y)), besideTip)).toBe(false);
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click();
	const outlined = canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]');
	const outlinedBounds = await outlined.evaluate(path => { const b = (path as SVGGraphicsElement).getBBox(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
	expect(await outlined.evaluate((path, p) => (path as SVGGeometryElement).isPointInFill(new DOMPoint(p.x, p.y)), besideTip)).toBe(false);
	for (const key of ['x', 'y', 'width', 'height'] as const) { expect(Math.abs(tipBounds[key] - outlinedBounds[key])).toBeLessThan(.1); }
	await canvas.press('ControlOrMeta+z'); await expect(tips).toHaveAttribute('d', geometry!); await canvas.press('Escape');
	await end.selectOption('diamond-arrow'); await properties.getByRole('combobox', { name: 'Width profile', exact: true }).selectOption('both');
	await expect(end).toHaveValue('butt'); await end.selectOption('line-arrow'); await expect(properties.getByRole('combobox', { name: 'Width profile', exact: true })).toHaveValue('uniform');
	if (target.kind === 'browser') { await reopenOutlinedDesign(page, 'arrows.ash-design'); await canvas.press('Tab'); }
	await expect(end).toHaveValue('line-arrow');
	await properties.getByRole('button', { name: 'Convert to vector network', exact: true }).click();
	const node = properties.getByRole('combobox', { name: 'Path node', exact: true }); await node.selectOption({ value: '1' });
	const endpoint = properties.getByRole('combobox', { name: 'Endpoint style', exact: true }); await expect(endpoint).toHaveValue('line-arrow'); await endpoint.selectOption('reverse-triangle');
	await page.screenshot({ path: testInfo.outputPath('design-arrow-endpoints.png') });
	await canvas.getByRole('button', { name: 'Code', exact: true }).click(); const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue(); expect(code).toContain('"endpoint": "reverse-triangle"');
});

test('Sessions Design rounds editable nodes and previews signed offsets with holes and undo', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]');
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('r'); await field('X', '0'); await field('Y', '0'); await field('Width', '200'); await field('Height', '100');
	await properties.getByRole('button', { name: 'Convert to path', exact: true }).click();
	await canvas.press('Escape'); await field('Node corner radius', '20');
	const artwork = canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]');
	const inside = (x: number, y: number) => artwork.evaluate((path, p) => (path as SVGGeometryElement).isPointInFill(new DOMPoint(p.x, p.y)), { x, y });
	expect(await inside(1, 1)).toBe(false); expect(await inside(20, 20)).toBe(true);
	await canvas.press('Enter'); const nodes = properties.getByRole('combobox', { name: 'Path node', exact: true }); await expect(nodes.locator('option')).toHaveCount(4);
	await nodes.selectOption({ value: '0' }); await field('Node corner radius', '0'); expect(await inside(1, 1)).toBe(true);
	await canvas.press('ControlOrMeta+z'); expect(await inside(1, 1)).toBe(false);
	await canvas.press('Escape'); await field('Node corner radius', '0');
	const original = await artwork.getAttribute('d');
	await properties.getByRole('button', { name: 'Offset vector', exact: true }).click();
	await field('Offset amount', '10'); await expect(artwork).not.toHaveAttribute('d', original!); expect(await inside(-5, 50)).toBe(true);
	await properties.getByRole('button', { name: 'Cancel offset', exact: true }).click(); await expect(artwork).toHaveAttribute('d', original!);
	await properties.getByRole('button', { name: 'Offset vector', exact: true }).click(); await field('Offset amount', '-10');
	expect(await inside(5, 50)).toBe(false); expect(await inside(20, 50)).toBe(true);
	await canvas.press('Enter'); await expect(properties.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('180');
	await canvas.press('ControlOrMeta+z'); await expect(artwork).toHaveAttribute('d', original!);
	await properties.getByRole('button', { name: 'Offset vector', exact: true }).click(); await field('Offset amount', '10');
	await properties.getByRole('combobox', { name: 'Offset join', exact: true }).selectOption('round'); expect(await inside(-9, -9)).toBe(false);
	await properties.getByRole('combobox', { name: 'Offset join', exact: true }).selectOption('miter'); expect(await inside(-9, -9)).toBe(true);
	await field('Offset amount', '-1000'); await properties.getByRole('button', { name: 'Apply offset', exact: true }).click(); await expect(artwork).toHaveCount(0);
	await canvas.press('ControlOrMeta+z'); await expect(artwork).toHaveAttribute('d', original!);
	await canvas.press('Escape'); await canvas.press('e'); await field('X', '50'); await field('Y', '25'); await field('Width', '100'); await field('Height', '50');
	await canvas.press('ControlOrMeta+a'); await properties.getByRole('button', { name: 'Subtract selection', exact: true }).click(); await canvas.press('ControlOrMeta+e');
	await properties.getByRole('button', { name: 'Offset vector', exact: true }).click(); await field('Offset amount', '5');
	expect(await inside(100, 50)).toBe(false); expect(await inside(-3, 50)).toBe(true);
	await properties.getByRole('combobox', { name: 'Offset join', exact: true }).selectOption('round');
	await properties.getByRole('button', { name: 'Apply offset', exact: true }).click();
	if (target.kind === 'browser') { await reopenOutlinedDesign(page, 'offsets.ash-design'); }
	expect(await inside(100, 50)).toBe(false);
	await page.screenshot({ path: testInfo.outputPath('design-vector-offset.png') });
});

test('Sessions Design variable width supports canvas points, numeric editing, outlining and persistence', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]'), viewport = canvas.locator('.ash-canvas-viewport');
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('p'); await viewport.click({ position: { x: 100, y: 180 } }); await viewport.click({ position: { x: 340, y: 180 } }); await canvas.press('Enter'); await canvas.press('v'); await canvas.press('Tab');
	await field('Stroke width', '20'); await properties.getByRole('combobox', { name: 'Width profile', exact: true }).selectOption('both');
	const points = properties.getByRole('combobox', { name: 'Width point', exact: true }); await expect(points.locator('option')).toHaveCount(3);
	await points.selectOption({ index: 1 }); await field('Width at point', '60');
	const ribbon = canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path'); await expect(ribbon).toHaveCount(1);
	const wide = await ribbon.getAttribute('d');
	const center = canvas.locator('[data-width-handle="center"]').nth(1), bounds = (await center.boundingBox())!;
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + bounds.height / 2, { steps: 4 }); await page.mouse.up();
	await expect.poll(async () => Number(await properties.getByRole('spinbutton', { name: 'Width point position (%)', exact: true }).inputValue())).toBeGreaterThan(60);
	await canvas.press('ControlOrMeta+z'); await expect(ribbon).toHaveAttribute('d', wide!);
	const side = canvas.locator('[data-width-handle="edge"]').nth(2), sideBounds = (await side.boundingBox())!;
	await page.mouse.move(sideBounds.x + sideBounds.width / 2, sideBounds.y + sideBounds.height / 2); await page.mouse.down(); await page.mouse.move(sideBounds.x + sideBounds.width / 2, sideBounds.y + sideBounds.height / 2 - 15, { steps: 4 }); await page.mouse.up();
	await expect(ribbon).not.toHaveAttribute('d', wide!); await canvas.press('ControlOrMeta+z'); await expect(ribbon).toHaveAttribute('d', wide!);
	await viewport.click({ position: { x: 160, y: 180 }, modifiers: ['Control'] }); await expect(points.locator('option')).toHaveCount(4);
	await canvas.press('Delete'); await expect(points.locator('option')).toHaveCount(3); await canvas.press('ControlOrMeta+z'); await expect(points.locator('option')).toHaveCount(4);
	if (target.kind === 'browser') { await reopenOutlinedDesign(page, 'widths.ash-design'); await canvas.press('Tab'); }
	await expect(points.locator('option')).toHaveCount(4);
	const ribbonBounds = await ribbon.evaluate(path => { const b = (path as SVGGraphicsElement).getBBox(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click();
	const outlinedBounds = await canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]').evaluate(path => { const b = (path as SVGGraphicsElement).getBBox(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
	for (const key of ['x', 'y', 'width', 'height'] as const) { expect(Math.abs(ribbonBounds[key] - outlinedBounds[key])).toBeLessThan(.1); }
	await expect(canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]')).toHaveCount(1); await expect(properties.getByRole('spinbutton', { name: 'Stroke width', exact: true })).toHaveValue('0');
	await canvas.press('ControlOrMeta+z'); await expect(points.locator('option')).toHaveCount(4);
	await page.screenshot({ path: testInfo.outputPath('design-variable-width.png') });
});

test('Sessions Design pen closes paths, inserts exact curve nodes and outlines strokes', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]');
	const viewport = canvas.locator('.ash-canvas-viewport');
	await canvas.press('p'); await viewport.click({ position: { x: 120, y: 120 } }); await viewport.click({ position: { x: 280, y: 120 } }); await viewport.click({ position: { x: 200, y: 260 } }); await viewport.click({ position: { x: 120, y: 120 } });
	const artwork = canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]');
	await expect(artwork).toHaveCount(1); await expect(properties.getByRole('checkbox', { name: 'Closed path', exact: true })).toBeChecked();
	await canvas.press('ControlOrMeta+z'); await expect(artwork).toHaveCount(0); await canvas.press('ControlOrMeta+Shift+z'); await expect(artwork).toHaveCount(1);
	await canvas.press('v'); await canvas.press('Tab'); await canvas.press('Enter');
	await properties.getByRole('button', { name: 'Make smooth', exact: true }).click();
	const nodeCount = await properties.getByRole('combobox', { name: 'Path node', exact: true }).locator('option').count();
	const before = await artwork.evaluate(node => (node as SVGPathElement).getTotalLength());
	const point = await artwork.evaluate(node => { const path = node as SVGPathElement; const point = path.getPointAtLength(path.getTotalLength() * .15).matrixTransform(path.getScreenCTM()!); return { x: point.x, y: point.y }; });
	await canvas.press('p'); await page.mouse.click(point.x, point.y);
	await expect(properties.getByRole('combobox', { name: 'Path node', exact: true }).locator('option')).toHaveCount(nodeCount + 1);
	expect(Math.abs(await artwork.evaluate(node => (node as SVGPathElement).getTotalLength()) - before)).toBeLessThan(.02);
	await canvas.press('v'); await canvas.press('ControlOrMeta+a');
	const layerX = await properties.getByRole('spinbutton', { name: 'X', exact: true }).inputValue(); await canvas.press('ArrowRight');
	await expect(properties.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue(layerX);
	await properties.getByRole('checkbox', { name: 'Closed path', exact: true }).uncheck();
	const stroke = properties.getByRole('spinbutton', { name: 'Stroke width', exact: true }); await stroke.fill('12'); await stroke.press('Tab');
	await properties.getByRole('combobox', { name: 'Stroke cap', exact: true }).selectOption('round');
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click(); await expect(stroke).toHaveValue('0'); await expect(artwork).toHaveAttribute('fill', '#808080');
	await canvas.press('ControlOrMeta+z'); await expect(stroke).toHaveValue('12');
	await canvas.press('Alt+F1'); await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Alt\+Shift\+U\/S\/I\/E.*Original layers remain editable/u); await page.keyboard.press('Escape');
	await page.screenshot({ path: testInfo.outputPath('design-vector-path-tools.png') });
});

test('Sessions Design outlines square caps and dashed strokes as editable contours', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]'), viewport = canvas.locator('.ash-canvas-viewport');
	await canvas.press('p'); await viewport.click({ position: { x: 100, y: 150 } }); await viewport.click({ position: { x: 220, y: 150 } }); await canvas.press('Enter'); await canvas.press('v');
	const path = canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]');
	const before = await path.evaluate(node => { const bounds = (node as SVGGraphicsElement).getBBox(); return { x: bounds.x, y: bounds.y }; });
	const stroke = properties.getByRole('spinbutton', { name: 'Stroke width', exact: true }); await stroke.fill('12'); await stroke.press('Tab');
	await properties.getByRole('combobox', { name: 'Stroke cap', exact: true }).selectOption('square');
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click(); await expect(stroke).toHaveValue('0');
	const bounds = await path.evaluate(node => { const value = (node as SVGGraphicsElement).getBBox(); return { x: value.x, y: value.y, width: value.width, height: value.height }; });
	expect(bounds.x).toBeCloseTo(before.x - 6, 2); expect(bounds.y).toBeCloseTo(before.y - 6, 2); expect(bounds.width).toBeCloseTo(132, 2); expect(bounds.height).toBeCloseTo(12, 2);
	await canvas.press('ControlOrMeta+z');
	const dash = properties.getByRole('textbox', { name: 'Dash pattern', exact: true }); await dash.fill('12 6'); await dash.press('Tab');
	await properties.getByRole('combobox', { name: 'Stroke cap', exact: true }).selectOption('butt');
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click(); await expect(stroke).toHaveValue('0');
	await expect(properties.getByRole('combobox', { name: 'Contour', exact: true }).locator('option')).toHaveCount(7);
	await canvas.press('r'); await properties.getByRole('button', { name: 'Convert to path', exact: true }).click();
	await stroke.fill('12'); await stroke.press('Tab'); await dash.fill('12 6'); await dash.press('Tab');
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click(); await expect(stroke).toHaveValue('0');
	await canvas.press('ControlOrMeta+z'); await expect(stroke).toHaveValue('12'); await expect(properties.getByRole('checkbox', { name: 'Closed path', exact: true })).toBeChecked();
});

test('Sessions Design branches shared vector nodes and paints network regions', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]'), viewport = canvas.locator('.ash-canvas-viewport');
	await canvas.press('p');
	for (const position of [{ x: 140, y: 130 }, { x: 300, y: 130 }, { x: 220, y: 270 }, { x: 140, y: 130 }]) { await viewport.click({ position }); }
	await canvas.press('v'); await canvas.press('Tab'); await canvas.press('Enter');
	await properties.getByRole('button', { name: 'Convert to vector network', exact: true }).click();
	const nodes = properties.getByRole('combobox', { name: 'Path node', exact: true });
	await expect(nodes.locator('option')).toHaveCount(3);
	const anchors = canvas.locator('.ash-sessions-design-path-handle[data-path-point="anchor"]');
	await canvas.press('p'); await anchors.nth(0).click(); const viewportBox = (await viewport.boundingBox())!; await page.mouse.move(viewportBox.x + 80, viewportBox.y + 240); await page.mouse.down(); await page.mouse.move(viewportBox.x + 100, viewportBox.y + 260); await page.mouse.up();
	await expect(nodes.locator('option')).toHaveCount(4);
	await expect(properties.getByRole('combobox', { name: 'Network segment', exact: true }).locator('option')).toHaveCount(4);
	await canvas.press('Escape'); await canvas.press('v');
	await nodes.selectOption('0');
	const before = await canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path').last().getAttribute('d');
	await canvas.press('ArrowRight');
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path').last()).not.toHaveAttribute('d', before!);
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path').last()).toHaveAttribute('d', before!);
	await properties.getByRole('checkbox', { name: 'Region filled', exact: true }).uncheck();
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path').first()).toHaveAttribute('d', '');
	await canvas.press('ControlOrMeta+z'); await expect(properties.getByRole('checkbox', { name: 'Region filled', exact: true })).toBeChecked();
	await properties.getByRole('button', { name: 'Split segment', exact: true }).click(); await expect(nodes.locator('option')).toHaveCount(5);
	await properties.getByRole('spinbutton', { name: 'Segment start handle Y', exact: true }).fill('45'); await properties.getByRole('spinbutton', { name: 'Segment start handle Y', exact: true }).press('Tab');
	await expect(canvas.locator('[data-network-edge="0"][data-path-point="outgoing"]')).toHaveCount(1);
	const regionColor = properties.getByRole('textbox', { name: 'Region color', exact: true }); await regionColor.fill('#2266cc'); await regionColor.press('Tab');
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path[fill="#2266cc"]')).toHaveCount(1);
	if (target.kind === 'browser') { await reopenOutlinedDesign(page, 'network.ash-design'); await canvas.press('Tab'); await expect(nodes.locator('option')).toHaveCount(5); await expect(regionColor).toHaveValue('#2266cc'); }
	await page.screenshot({ path: testInfo.outputPath('design-vector-network.png') });
	await canvas.getByRole('button', { name: 'Code', exact: true }).click(); const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue(); expect(code).toContain('"network"'); expect(code).toContain('fill="#2266cc"');
});

test('Sessions Design connects crossings, merges anchors and previews simplification with atomic undo', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]'), viewport = canvas.locator('.ash-canvas-viewport');
	await canvas.press('p');
	for (const position of [{ x: 120, y: 120 }, { x: 320, y: 320 }, { x: 120, y: 320 }, { x: 320, y: 120 }, { x: 120, y: 120 }]) { await viewport.click({ position }); }
	await canvas.press('v'); await canvas.press('Tab'); await canvas.press('Enter');
	const nodes = properties.getByRole('combobox', { name: 'Path node', exact: true }), segments = properties.getByRole('combobox', { name: 'Network segment', exact: true });
	await properties.getByRole('button', { name: 'Add intersection nodes', exact: true }).click();
	await expect(nodes.locator('option')).toHaveCount(5); await expect(segments.locator('option')).toHaveCount(6);
	await expect(properties.getByRole('combobox', { name: 'Fill region', exact: true }).locator('option')).toHaveCount(2);
	await canvas.press('ControlOrMeta+z'); await expect(nodes.locator('option')).toHaveCount(4);
	await canvas.press('p'); await viewport.click({ position: { x: 220, y: 220 } });
	await expect(nodes.locator('option')).toHaveCount(5); await expect(segments.locator('option')).toHaveCount(6);
	await canvas.press('v');
	const anchors = canvas.locator('.ash-sessions-design-path-handle[data-path-point="anchor"]');
	const junction = await anchors.evaluateAll(elements => {
		const points = elements.map(element => ({ index: element.getAttribute('data-path-node')!, rect: element.getBoundingClientRect() }));
		const x = (Math.min(...points.map(point => point.rect.x)) + Math.max(...points.map(point => point.rect.x))) / 2, y = (Math.min(...points.map(point => point.rect.y)) + Math.max(...points.map(point => point.rect.y))) / 2;
		return points.sort((a, b) => Math.hypot(a.rect.x - x, a.rect.y - y) - Math.hypot(b.rect.x - x, b.rect.y - y))[0].index;
	});
	await nodes.selectOption({ value: junction });
	await properties.getByRole('button', { name: 'Cut at node', exact: true }).click(); await expect(nodes.locator('option')).toHaveCount(8);
	await nodes.selectOption({ value: '7' }); await canvas.press('Shift+ArrowRight'); await canvas.press('Shift+ArrowRight');
	const from = (await anchors.nth(7).boundingBox())!, to = (await anchors.nth(Number(junction)).boundingBox())!;
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down(); await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 }); await page.mouse.up();
	await expect(nodes.locator('option')).toHaveCount(7); await canvas.press('ControlOrMeta+z'); await expect(nodes.locator('option')).toHaveCount(8);
	await anchors.nth(0).click(); await anchors.nth(1).click({ modifiers: ['Shift'] });
	await properties.getByRole('button', { name: 'Merge selected nodes', exact: true }).click(); await expect(nodes.locator('option')).toHaveCount(7);
	await canvas.press('ControlOrMeta+z'); await expect(nodes.locator('option')).toHaveCount(8);
	await canvas.press('Escape'); await canvas.press('Escape'); await canvas.press('p');
	for (const position of [{ x: 100, y: 380 }, { x: 150, y: 380 }, { x: 200, y: 380 }, { x: 250, y: 380 }, { x: 300, y: 380 }]) { await viewport.click({ position }); }
	await canvas.press('Enter'); await canvas.press('v'); await canvas.press('Tab'); await canvas.press('Tab'); await canvas.press('Enter');
	await expect(nodes.locator('option')).toHaveCount(5);
	await properties.getByRole('button', { name: 'Simplify vector', exact: true }).click();
	const slider = properties.getByRole('slider', { name: 'Simplification', exact: true }); await expect(slider).toBeVisible();
	await slider.fill('60'); await expect(properties.getByRole('status').filter({ hasText: '5 → 2 points' })).toBeVisible();
	await expect(nodes.locator('option')).toHaveCount(5); // Preview never changes the saved document or its history.
	await slider.press('Escape'); await expect(slider).toBeHidden(); await expect(nodes.locator('option')).toHaveCount(5);
	await properties.getByRole('button', { name: 'Simplify vector', exact: true }).click(); await properties.getByRole('button', { name: 'Apply simplification', exact: true }).click(); await expect(nodes.locator('option')).toHaveCount(2);
	await canvas.press('ControlOrMeta+z'); await expect(nodes.locator('option')).toHaveCount(5);
	await nodes.selectOption({ value: '2' }); await canvas.press('Shift+Delete'); await expect(nodes.locator('option')).toHaveCount(4);
	await canvas.press('ControlOrMeta+z'); await expect(nodes.locator('option')).toHaveCount(5);
	await properties.getByRole('button', { name: 'Simplify vector', exact: true }).click(); await properties.getByRole('button', { name: 'Apply simplification', exact: true }).click();
	if (target.kind === 'browser') { await reopenOutlinedDesign(page, 'topology.ash-design'); }
	await page.screenshot({ path: testInfo.outputPath('design-vector-topology.png') });
});

test('Sessions Design resolves overlapping lines, self-crossing cubics and tangent contacts', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click(); await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]'), viewport = canvas.locator('.ash-canvas-viewport');
	const nodes = properties.getByRole('combobox', { name: 'Path node', exact: true }), segments = properties.getByRole('combobox', { name: 'Network segment', exact: true });
	const draw = async (points: { x: number; y: number; }[], closed = false): Promise<void> => { await canvas.press('p'); for (const position of points) { await viewport.click({ position }); } if (!closed) { await canvas.press('Enter'); } await canvas.press('v'); await canvas.press('Tab'); await canvas.press('Enter'); };
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await draw([{ x: 100, y: 150 }, { x: 300, y: 150 }, { x: 200, y: 150 }, { x: 400, y: 150 }]);
	await properties.getByRole('button', { name: 'Add intersection nodes', exact: true }).click(); await expect(nodes.locator('option')).toHaveCount(4); await expect(segments.locator('option')).toHaveCount(3);
	await canvas.press('Escape'); await canvas.press('Delete');
	await draw([{ x: 120, y: 180 }, { x: 320, y: 180 }]);
	await properties.getByRole('button', { name: 'Convert to vector network', exact: true }).click();
	for (const [name, value] of [['Segment start handle X', '200'], ['Segment start handle Y', '200'], ['Segment end handle X', '-200'], ['Segment end handle Y', '200']]) { await field(name, value); }
	await properties.getByRole('button', { name: 'Add intersection nodes', exact: true }).click(); await expect(nodes.locator('option')).toHaveCount(4); await expect(segments.locator('option')).toHaveCount(4);
	await canvas.press('ControlOrMeta+z'); await expect(nodes.locator('option')).toHaveCount(2);
	await canvas.press('Escape'); await canvas.press('Delete');
	await draw([{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }], true);
	await properties.getByRole('button', { name: 'Convert to vector network', exact: true }).click();
	const anchors = canvas.locator('.ash-sessions-design-path-handle[data-path-point="anchor"]');
	await anchors.nth(0).click(); await anchors.nth(2).click({ modifiers: ['Shift'] }); await properties.getByRole('button', { name: 'Connect selected nodes', exact: true }).click(); await expect(segments.locator('option')).toHaveCount(5);
	await anchors.nth(1).click(); await anchors.nth(3).click({ modifiers: ['Shift'] }); await properties.getByRole('button', { name: 'Connect selected nodes', exact: true }).click(); await expect(nodes.locator('option')).toHaveCount(5); await expect(segments.locator('option')).toHaveCount(8);
	await canvas.press('ControlOrMeta+z'); await expect(nodes.locator('option')).toHaveCount(4); await expect(segments.locator('option')).toHaveCount(5);
	await canvas.press('ControlOrMeta+z'); await expect(segments.locator('option')).toHaveCount(4);
	await field('Segment start handle Y', String(800 / 3)); await field('Segment end handle Y', String(800 / 3));
	await properties.getByRole('button', { name: 'Add intersection nodes', exact: true }).click(); await expect(nodes.locator('option')).toHaveCount(5); await expect(segments.locator('option')).toHaveCount(6);
	await canvas.press('ControlOrMeta+z'); await expect(nodes.locator('option')).toHaveCount(4);
	await field('Segment start handle Y', '400'); await field('Segment end handle Y', '400');
	await properties.getByRole('button', { name: 'Add intersection nodes', exact: true }).click(); await expect(nodes.locator('option')).toHaveCount(6); await expect(segments.locator('option')).toHaveCount(8);
	if (target.kind === 'browser') { await reopenOutlinedDesign(page, 'curve-intersections.ash-design'); await canvas.press('Tab'); await expect(nodes.locator('option')).toHaveCount(6); await expect(segments.locator('option')).toHaveCount(8); }
});

test('Sessions Design converts shaped variable-font text to editable outlines and restores text with undo', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]');
	await canvas.press('t'); await canvas.locator('.ash-canvas-viewport').click({ position: { x: 160, y: 160 } }); await page.keyboard.press('Escape');
	const content = properties.getByRole('textbox', { name: 'Text content', exact: true }); await content.fill('office AV\nB8'); await content.press('Tab');
	const family = properties.getByRole('combobox', { name: 'Font family', exact: true }); await family.fill('Noto Sans'); await family.press('Tab');
	await properties.getByLabel('Font file for outlines', { exact: true }).setInputFiles('test/smoke/fixtures/design-fonts/NotoSans.ttf');
	await expect(properties.getByRole('status').filter({ hasText: 'Font loaded.' })).toBeVisible();
	const ink = await canvas.locator('[data-text-paragraph]').first().evaluate(element => {
		const span = element.querySelector('span')!, style = getComputedStyle(span), node = span.firstChild!;
		const range = document.createRange(); range.selectNodeContents(node); const rect = range.getBoundingClientRect();
		const context = document.createElement('canvas').getContext('2d')!; context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
		const metrics = context.measureText(node.textContent!); return { left: rect.left - metrics.actualBoundingBoxLeft, top: rect.top + metrics.fontBoundingBoxAscent - metrics.actualBoundingBoxAscent, width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight };
	});
	await canvas.press('Alt+Shift+f');
	await expect(canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]')).toHaveCount(1);
	const outlineBox = await canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]').boundingBox();
	expect(Math.abs(outlineBox!.x - ink.left)).toBeLessThan(1); expect(Math.abs(outlineBox!.y - ink.top)).toBeLessThan(1); expect(Math.abs(outlineBox!.width - ink.width)).toBeLessThan(1);
	await expect(canvas.locator('[data-design-text]')).toHaveCount(0);
	const path = canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]');
	expect(await path.evaluate(element => (element as SVGPathElement).getTotalLength())).toBeGreaterThan(100);
	await expect(properties.getByRole('button', { name: 'Edit vector', exact: true })).toBeVisible();
	await canvas.press('ArrowRight'); await canvas.press('ControlOrMeta+z'); await canvas.press('ControlOrMeta+z');
	await expect(content).toHaveValue('office AV\nB8');
	await canvas.press('ControlOrMeta+Alt+o');
	const glyphs = canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id] > path[data-shape-id]');
	await expect(glyphs).toHaveCount(8);
	expect(await glyphs.first().evaluate(element => (element as SVGPathElement).getBBox().width)).toBeLessThan(30); // ffi forms one glyph; spaces and line breaks have no outlines.
	await canvas.press('ControlOrMeta+z'); await expect(content).toHaveValue('office AV\nB8');
	await content.fill('q\u0301q\u0301'); await content.press('Tab');
	await canvas.press('ControlOrMeta+Alt+o'); await expect(glyphs).toHaveCount(4);
	const untracked = await glyphs.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
	await canvas.press('ControlOrMeta+z');
	const tracking = properties.getByRole('spinbutton', { name: 'Letter spacing', exact: true }); await tracking.fill('20'); await tracking.press('Tab');
	await canvas.press('ControlOrMeta+Alt+o'); await expect(glyphs).toHaveCount(4);
	const tracked = await glyphs.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
	// Tracking separates grapheme clusters, while each acute stays attached to its base glyph.
	expect(Math.abs((tracked[1] - tracked[0]) - (untracked[1] - untracked[0]))).toBeLessThan(.1);
	expect(Math.abs((tracked[3] - tracked[2]) - (untracked[3] - untracked[2]))).toBeLessThan(.1);
	expect(Math.abs((tracked[2] - tracked[0]) - (untracked[2] - untracked[0]) - 20)).toBeLessThan(.1);
	await canvas.press('ControlOrMeta+z'); await tracking.fill('0'); await tracking.press('Tab');
	await content.fill('Aa0'); await content.press('Tab'); await properties.locator('summary').filter({ hasText: /^Type details$/u }).click();
	const features = properties.getByRole('textbox', { name: 'OpenType features', exact: true }); await features.fill('aalt=1'); await features.press('Tab');
	await properties.getByRole('button', { name: 'Flatten selection', exact: true }).click(); await expect(path).toHaveCount(1); const firstAlternate = await path.getAttribute('d');
	await canvas.press('ControlOrMeta+z'); await features.fill('aalt=2'); await features.press('Tab'); await properties.getByRole('button', { name: 'Flatten selection', exact: true }).click();
	await expect(path).not.toHaveAttribute('d', firstAlternate!);
	await page.evaluate(() => document.fonts.clear());
	if (target.kind === 'browser') { const before = await path.getAttribute('d'); await reopenOutlinedDesign(page, 'alternate-outlines.ash-design'); await expect(path).toHaveAttribute('d', before!); }
	await page.screenshot({ path: testInfo.outputPath('design-text-outlines.png') });
});

async function reopenOutlinedDesign(page: Page, name: string): Promise<void> {
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await page.evaluate(async () => { const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(`ash-outline-${crypto.randomUUID()}`, { create: true }); Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder }); });
	await canvas.press('Shift+F10'); await page.getByRole('menuitem', { name: 'Save a copy', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Save a copy', exact: true });
	await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill(name); await dialog.getByRole('button', { name: 'OK', exact: true }).click();
	await expect(canvas.locator('.ash-sessions-design-message')).toHaveText(`Saved ${name}`);
	await canvas.press('Escape'); await canvas.press('Shift+F10'); await page.getByRole('menuitem', { name: 'Open design', exact: true }).click();
	await page.locator('.ash-quick-pick-row-label').getByText(name, { exact: true }).click();
	await expect(canvas.locator('.ash-sessions-design-message')).toHaveText(`Opened ${name}`);
}

test('Sessions Design keeps rich outline colors, truncation and font failures atomic across save and reopen', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]');
	await page.evaluate(() => Object.defineProperty(window, 'queryLocalFonts', { configurable: true, value: async () => { throw new DOMException('Denied', 'NotAllowedError'); } }));
	await canvas.press('t'); await canvas.locator('.ash-canvas-viewport').click({ position: { x: 160, y: 160 } }); await page.keyboard.press('Escape');
	const content = properties.getByRole('textbox', { name: 'Text content', exact: true }); await content.fill('AB'); await content.press('Tab');
	await properties.getByRole('button', { name: 'Flatten selection', exact: true }).click();
	await expect(properties.getByRole('status').filter({ hasText: 'Allow local font access' })).toBeVisible(); await expect(content).toHaveValue('AB');
	const family = properties.getByRole('combobox', { name: 'Font family', exact: true }); await family.fill('Noto Sans'); await family.press('Tab');
	await properties.getByLabel('Font file for outlines', { exact: true }).setInputFiles('test/smoke/fixtures/design-fonts/NotoSans.ttf');
	await expect(properties.getByRole('status').filter({ hasText: 'Font loaded.' })).toBeVisible();
	const weight = properties.getByRole('spinbutton', { name: 'Font weight', exact: true }); await weight.fill('650'); await weight.press('Tab');
	await canvas.press('Enter'); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Shift+ArrowRight');
	const color = properties.getByRole('textbox', { name: 'Text color', exact: true }); await color.fill('#cc2200'); await color.press('Tab'); await canvas.press('Escape'); await canvas.press('Tab');
	await properties.getByRole('button', { name: 'Flatten selection', exact: true }).click();
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path[fill="#cc2200"]')).toHaveCount(1);
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path[fill="#808080"]')).toHaveCount(1);
	if (target.kind === 'browser') { await reopenOutlinedDesign(page, 'outlined-text.ash-design'); await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path[fill="#cc2200"]')).toHaveCount(1); }
	await canvas.press('Escape'); await canvas.press('t'); await canvas.locator('.ash-canvas-viewport').click({ position: { x: 160, y: 260 } }); await page.keyboard.press('Escape');
	await content.fill('office office office office'); await content.press('Tab'); await family.fill('Noto Sans'); await family.press('Tab');
	await properties.getByRole('combobox', { name: 'Text resizing', exact: true }).selectOption('none');
	for (const [label, value] of [['Width', '120'], ['Height', '50']]) { const field = properties.getByRole('spinbutton', { name: label, exact: true }); await field.fill(value); await field.press('Tab'); }
	await properties.locator('summary').filter({ hasText: /^Type details$/u }).click();
	await properties.getByRole('checkbox', { name: 'Truncate text', exact: true }).check();
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click();
	await expect(page.getByRole('treeitem', { name: '…', exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('design-rich-text-outlines.png') });
});

test('Sessions Design stacks shadow and blur effects with cutouts, spread, undo and persistence', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]');
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	const action = (name: string) => properties.getByRole('button', { name, exact: true }).click();
	const color = async (value: string): Promise<void> => { const input = properties.getByRole('textbox', { name: 'Shadow color', exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('r'); await field('X', '160'); await field('Y', '160'); await field('Width', '200'); await field('Height', '140'); await paintColor(page, '#ffffff00');
	await action('Add effect'); await field('Effect blur', '0'); await field('Shadow X', '0'); await field('Shadow Y', '0'); await field('Shadow spread', '20'); await color('#ff0000ff');
	const layer = canvas.locator('.ash-sessions-design-shapes > [data-shape-id]').last();
	const box = await layer.locator(':scope > rect').boundingBox(); expect(box).toBeTruthy();
	const pixel = (x: number, y: number) => paintPixel(page, box!.x + x, box!.y + y);
	await expect.poll(async () => (await pixel(100, 70)).slice(0, 3).every(value => value >= 245)).toBe(true);
	await expect.poll(async () => (await pixel(-10, 70)).slice(0, 3)).toEqual([255, 0, 0]);
	await properties.getByRole('checkbox', { name: 'Show shadow behind transparent areas', exact: true }).check();
	await expect.poll(async () => (await pixel(100, 70)).slice(0, 3)).toEqual([255, 0, 0]);
	await action('Duplicate effect'); await color('#0000ffff');
	await expect.poll(async () => (await pixel(-10, 70)).slice(0, 3)).toEqual([0, 0, 255]);
	await action('Move effect down');
	await expect.poll(async () => (await pixel(-10, 70)).slice(0, 3)).toEqual([255, 0, 0]);
	await action('Remove effect'); await paintColor(page, '#ffffffff');
	await properties.getByRole('combobox', { name: 'Effect type', exact: true }).selectOption('inner-shadow');
	await field('Shadow spread', '12');
	await expect.poll(async () => (await pixel(8, 70)).slice(0, 3)).toEqual([255, 0, 0]);
	await expect.poll(async () => (await pixel(100, 70)).slice(0, 3)).toEqual([255, 255, 255]);
	await properties.getByRole('checkbox', { name: 'Effect visible', exact: true }).uncheck();
	await expect.poll(async () => (await pixel(8, 70)).slice(0, 3)).toEqual([255, 255, 255]);
	await canvas.press('ControlOrMeta+z');
	await expect(properties.getByRole('checkbox', { name: 'Effect visible', exact: true })).toBeChecked();
	await action('Add effect'); await properties.getByRole('combobox', { name: 'Effect type', exact: true }).selectOption('layer-blur'); await field('Effect blur', '16');
	await expect.poll(async () => { const value = await pixel(8, 70); return value[1] > 20 && value[1] < 180; }).toBe(true);
	await expect(properties.getByRole('button', { name: 'Duplicate effect', exact: true })).toBeDisabled();
	await action('Add effect'); await properties.getByRole('combobox', { name: 'Effect type', exact: true }).selectOption('background-blur');
	await action('Add effect');
	await expect(properties.getByRole('combobox', { name: 'Effect', exact: true }).locator('option')).toHaveCount(4);
	await reopenOutlinedDesign(page, 'Effects stack.ash-design');
	await canvas.press('ControlOrMeta+a');
	await expect(properties.getByRole('combobox', { name: 'Effect', exact: true }).locator('option')).toHaveCount(4);
	await page.screenshot({ path: testInfo.outputPath('design-effects-stack.png') });
});

test('Sessions Design background blur clips to ellipses, ignores previous blurs and exports the same backdrop', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }), properties = page.locator('[data-part="auxiliarybar"]');
	const field = async (name: string, value: string): Promise<void> => { const input = properties.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); };
	await canvas.press('r'); await field('X', '100'); await field('Y', '100'); await field('Width', '240'); await field('Height', '160'); await paintColor(page, '#ffffff');
	await canvas.press('r'); await field('X', '100'); await field('Y', '100'); await field('Width', '120'); await field('Height', '160'); await paintColor(page, '#000000');
	await canvas.press('e'); await field('X', '120'); await field('Y', '120'); await field('Width', '200'); await field('Height', '120'); await paintColor(page, '#ffffff00');
	await properties.getByRole('button', { name: 'Add effect', exact: true }).click();
	await properties.getByRole('combobox', { name: 'Effect type', exact: true }).selectOption('background-blur'); await field('Effect blur', '24');
	const ellipse = canvas.locator('.ash-sessions-design-shapes > [data-shape-id]').last().locator('ellipse').last();
	const box = await ellipse.boundingBox(); expect(box).toBeTruthy();
	const sample = () => paintPixel(page, box!.x + 92, box!.y + 60);
	await expect.poll(async () => { const color = await sample(); return color[0] > 30 && color[0] < 110 && color[1] === color[0]; }).toBe(true);
	const before = (await sample())[0];
	await canvas.press('ControlOrMeta+d'); await field('X', '120'); await field('Y', '120');
	await expect.poll(async () => Math.abs((await sample())[0] - before)).toBeLessThanOrEqual(2);
	await expect.poll(async () => (await paintPixel(page, box!.x + 5, box!.y + 5)).slice(0, 3)).toEqual([0, 0, 0]);
	await page.screenshot({ path: testInfo.outputPath('design-background-blur.png') });
	await canvas.getByRole('button', { name: 'Code', exact: true }).click();
	const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	const preview = await page.context().newPage();
	try {
		await preview.setContent(code);
		const exported = await preview.locator('[data-design-kind="ellipse"]').last().boundingBox(); expect(exported).toBeTruthy();
		await expect.poll(async () => Math.abs((await paintPixel(preview, exported!.x + 92, exported!.y + 60))[0] - before)).toBeLessThanOrEqual(2);
		await preview.screenshot({ path: testInfo.outputPath('design-background-blur-export.png') });
	} finally { await preview.close(); }
});

for (const type of ['layer-blur', 'background-blur'] as const) {
	test(`Sessions Design progressive ${type} interpolates pixels and preserves editing, persistence and export`, async ({ target, workbench }, testInfo) => {
		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
		await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
		const canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
		const properties = page.locator('[data-part="auxiliarybar"]');
		const field = async (name: string, value: string): Promise<void> => {
			const input = properties.getByRole('spinbutton', { name, exact: true });
			await input.fill(value); await input.press('Tab');
		};
		const add = async (width: number, color: string): Promise<void> => {
			await canvas.press('r');
			await field('X', '100'); await field('Y', '100');
			await field('Width', String(width)); await field('Height', '240');
			await paintColor(page, color);
		};
		await add(360, '#ffffff');
		await field('X', '40'); await field('Y', '40'); await field('Height', '360');
		await add(120, '#000000');
		if (type === 'background-blur') { await add(240, '#ffffff00'); }
		const name = properties.getByRole('textbox', { name: 'Layer name', exact: true });
		await name.fill('Progressive blur'); await name.press('Tab');
		await properties.getByRole('button', { name: 'Add effect', exact: true }).click();
		await properties.getByRole('combobox', { name: 'Effect type', exact: true }).selectOption(type);
		await properties.getByRole('combobox', { name: 'Blur mode', exact: true }).selectOption('progressive');
		await field('End blur', '24'); await field('Blur start Y (%)', '25'); await field('Blur end Y (%)', '75');
		const layer = canvas.locator('.ash-sessions-design-shapes > [data-shape-id]').last();
		const box = await layer.locator('rect').last().boundingBox(); expect(box).toBeTruthy();
		const pixel = (x: number, y: number) => paintPixel(page, box!.x + x, box!.y + y);
		await expect.poll(async () => (await pixel(112, 40))[0]).toBeLessThan(3);
		await expect.poll(async () => (await pixel(112, 200))[0]).toBeGreaterThan(50);
		const values: number[] = [];
		for (const y of [80, 100, 120, 140, 160]) { values.push((await pixel(112, y))[0]); }
		for (let index = 1; index < values.length; index++) { expect(values[index]).toBeGreaterThan(values[index - 1]); }
		const blurred = (await pixel(112, 200))[0];
		if (type === 'layer-blur') {
			await paintColor(page, '#00000080');
			for (const y of [80, 100, 120, 140, 160]) {
				const alpha = (await pixel(40, y))[0];
				expect(alpha).toBeGreaterThanOrEqual(126); expect(alpha).toBeLessThanOrEqual(130);
			}
			await paintColor(page, '#000000ff');
			await field('Rotation', '90');
			await expect.poll(async () => (await pixel(140, 172))[0]).toBeLessThan(3);
			await expect.poll(async () => Math.abs((await pixel(-20, 172))[0] - blurred)).toBeLessThanOrEqual(3);
			await field('Rotation', '0');
		}
		// Reversing both radii and endpoints leaves the field unchanged.
		await field('Start blur', '24'); await field('End blur', '0');
		await field('Blur start Y (%)', '75'); await field('Blur end Y (%)', '25');
		await expect.poll(async () => Math.abs((await pixel(112, 200))[0] - blurred)).toBeLessThanOrEqual(2);
		// A constant field must match uniform blur exactly.
		await field('End blur', '24');
		const equal = (await pixel(112, 120))[0];
		await properties.getByRole('combobox', { name: 'Blur mode', exact: true }).selectOption('uniform');
		await expect.poll(async () => Math.abs((await pixel(112, 120))[0] - equal)).toBeLessThanOrEqual(1);
		await canvas.press('ControlOrMeta+z');
		await field('Start blur', '0'); await field('Blur start Y (%)', '25'); await field('Blur end Y (%)', '75');
		await properties.getByRole('button', { name: 'Edit blur on canvas', exact: true }).click();
		const end = canvas.locator('[data-blur-handle="end"]');
		const endpoint = await end.boundingBox(); expect(endpoint).toBeTruthy();
		await page.mouse.move(endpoint!.x + endpoint!.width / 2, endpoint!.y + endpoint!.height / 2);
		await page.mouse.down(); await page.mouse.move(endpoint!.x + endpoint!.width / 2 + 24, endpoint!.y + endpoint!.height / 2 + 24); await page.mouse.up();
		await expect(properties.getByRole('spinbutton', { name: 'Blur end Y (%)', exact: true })).toHaveValue('85');
		await canvas.press('ControlOrMeta+z');
		await expect(properties.getByRole('spinbutton', { name: 'Blur end Y (%)', exact: true })).toHaveValue('75');
		await canvas.press('ArrowDown');
		await canvas.press('ControlOrMeta+z');
		await canvas.press('Escape'); await expect(end).toHaveCount(0);
		await field('Blur start X (%)', '-50'); await field('Blur end X (%)', '-50');
		await reopenOutlinedDesign(page, `Progressive ${type}.ash-design`);
		await page.getByRole('tree', { name: 'Layers', exact: true }).getByRole('treeitem', { name: 'Progressive blur', exact: true }).click();
		await expect(properties.getByRole('combobox', { name: 'Blur mode', exact: true })).toHaveValue('progressive');
		await expect(properties.getByRole('spinbutton', { name: 'Blur start X (%)', exact: true })).toHaveValue('-50');
		await expect.poll(async () => Math.abs((await pixel(112, 200))[0] - blurred)).toBeLessThanOrEqual(2);
		await page.screenshot({ path: testInfo.outputPath(`progressive-${type}.png`) });
		if (type === 'background-blur') {
			await canvas.press('ControlOrMeta+d'); await field('X', '100'); await field('Y', '100');
			await expect.poll(async () => Math.abs((await pixel(112, 200))[0] - blurred)).toBeLessThanOrEqual(2);
		}
		await canvas.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Export SVG', exact: true }).click();
		const exportDialog = page.getByRole('dialog', { name: 'Export SVG', exact: true });
		await exportDialog.getByRole('textbox', { name: 'File name, field 1' }).fill('progressive.svg');
		await exportDialog.getByRole('button', { name: 'OK', exact: true }).click();
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Exported progressive.svg');
		const svg = await page.evaluate(async () => {
			const folder = await (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle>; }).showDirectoryPicker();
			return (await (await folder.getFileHandle('progressive.svg')).getFile()).text();
		});

		await canvas.getByRole('button', { name: 'Code', exact: true }).click();
		const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
		const preview = await page.context().newPage();
		try {
			await preview.setContent(code);
			const exported = await preview.locator('[data-design-kind="rectangle"]').last().boundingBox(); expect(exported).toBeTruthy();
			await expect.poll(async () => Math.abs((await paintPixel(preview, exported!.x + 112, exported!.y + 200))[0] - blurred)).toBeLessThanOrEqual(2);
			await preview.screenshot({ path: testInfo.outputPath(`progressive-${type}-export.png`) });
			const svgBounds = await preview.evaluate(async content => {
				const root = new DOMParser().parseFromString(content, 'image/svg+xml').documentElement;
				const bounds = root.getAttribute('viewBox')!.split(' ').map(Number);
				const image = new Image();
				image.src = `data:image/svg+xml,${encodeURIComponent(content)}`;
				document.body.replaceChildren(image);
				await image.decode();
				return bounds;
			}, svg);
			const imageBox = await preview.locator('img').boundingBox(); expect(imageBox).toBeTruthy();
			await expect.poll(async () => Math.abs((await paintPixel(preview, imageBox!.x + 212 - svgBounds[0], imageBox!.y + 300 - svgBounds[1]))[0] - blurred)).toBeLessThanOrEqual(2);
			await preview.screenshot({ path: testInfo.outputPath(`progressive-${type}-svg.png`) });
		} finally { await preview.close(); }
	});
}


test('Sessions Design automatically retains an untitled draft across window reopen without save confirmation', async ({ target, workbench, application }, testInfo) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	let canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await expect(page.locator('.ash-creator-header')).toBeHidden();
	await expect(page.locator('[data-creator-mode="design"] .ash-creator-workspace-actions')).toHaveCount(0);
	// Removed tabs, controls and the footer reserve no space around the canvas.
	await expect.poll(async () => {
		const editor = await page.locator('[data-part="editor"]').boundingBox();
		const canvasBounds = await canvas.locator('.ash-canvas-viewport').boundingBox();
		return Math.max(Math.abs(canvasBounds!.y - editor!.y), Math.abs(canvasBounds!.y + canvasBounds!.height - editor!.y - editor!.height));
	}).toBeLessThanOrEqual(2);
	await canvas.press('r');
	const shape = canvas.locator('.ash-sessions-design-shapes > rect[data-shape-id]');
	await expect(shape).toHaveCount(1);
	const id = await shape.getAttribute('data-shape-id');
	await expect(canvas).not.toHaveClass(/\bdirty\b/u);
	await canvas.press('ControlOrMeta+s');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	const menu = await new Menus(page).inspect(application, () => canvas.press('Shift+F10'));
	expect(menu).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Save a copy', enabled: true }), expect.objectContaining({ label: 'Export SVG', enabled: true })]));
	await page.screenshot({ path: testInfo.outputPath('design-autosaved-draft.png') });
	page = await workbench.reopenAgentsWindow(application, page);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	const design = page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true });
	if (await design.isVisible()) { await design.click(); }
	canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await expect(canvas.locator('.ash-sessions-design-shapes > rect[data-shape-id]')).toHaveAttribute('data-shape-id', id!);
	await expect(canvas).not.toHaveClass(/\bdirty\b/u);
	await canvas.press('Tab'); await canvas.press('ArrowRight');
	const movedX = await canvas.locator('.ash-sessions-design-shapes > rect[data-shape-id]').getAttribute('x');
	if (target.kind === 'browser') { await expect(canvas).not.toHaveClass(/\bdirty\b/u); }
	page = await workbench.reopenAgentsWindow(application, page);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	const reopenDesign = page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true });
	if (await reopenDesign.isVisible()) { await reopenDesign.click(); }
	canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await expect(canvas.locator('.ash-sessions-design-shapes > rect[data-shape-id]')).toHaveAttribute('x', movedX!);
	await expect(page.getByRole('dialog')).toHaveCount(0);
	if ('windows' in application) {
		const profile = await application.evaluate(() => process.env.ASH_HOME!);
		const drafts = join(profile, 'creator');
		const manifests = (await readdir(drafts, { recursive: true })).filter(path => path.endsWith('manifest.json'));
		expect(manifests).toHaveLength(1);
		const saved = JSON.parse(await readFile(join(drafts, manifests[0]), 'utf8')) as { artifacts: Record<string, { objects: Record<string, { x: number; }>; }>; };
		expect(Object.values(saved.artifacts).map(artifact => artifact.objects[id!])).toContainEqual(expect.objectContaining({ x: Number(movedX) }));
	}
	await page.screenshot({ path: testInfo.outputPath('design-restored-after-close.png') });
});

test('Sessions Design color widgets edit page backgrounds and fills and restore them after closing', async ({ application, target, workbench }, testInfo) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	let properties = page.locator('[data-part="auxiliarybar"]');
	let canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await expect(properties.locator('.ash-design-page-name, .ash-design-page-summary')).toHaveCount(0);
	const background = properties.getByRole('textbox', { name: 'Page background color', exact: true });
	await background.fill('E8EEF6'); await background.press('Enter');
	await expect(canvas.locator('.ash-canvas-viewport')).toHaveCSS('background-color', 'rgb(232, 238, 246)');
	await canvas.press('ControlOrMeta+z');
	await expect(background).toHaveValue('FFFFFF');
	await canvas.press('ControlOrMeta+Shift+z');
	await expect(background).toHaveValue('E8EEF6');
	await properties.getByRole('button', { name: 'Page background', exact: true }).click();
	await expect(page.getByRole('dialog', { name: /^Color picker/u })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(properties.getByRole('button', { name: 'Page background', exact: true })).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('page-background-widget.png') });
	await canvas.press('r');
	const color = properties.getByRole('textbox', { name: 'Fill color', exact: true });
	await color.fill('invalid'); await color.press('Enter');
	await expect(color).toHaveAttribute('aria-invalid', 'true');
	await color.fill('2F6FED'); await color.press('Enter');
	const opacity = properties.getByRole('spinbutton', { name: 'Fill opacity (%)', exact: true });
	await opacity.fill('40'); await opacity.press('Enter');
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('fill', '#2f6fed66');
	const widget = color.locator('..');
	await widget.scrollIntoViewIfNeeded();
	await expect.poll(() => widget.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
	await page.screenshot({ path: testInfo.outputPath('fill-color-widget.png') });
	if (target.kind === 'browser') { await expect(canvas).not.toHaveClass(/\bdirty\b/u); }
	page = await workbench.reopenAgentsWindow(application, page);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	const design = page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true });
	if (await design.isVisible()) { await design.click(); }
	canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	properties = page.locator('[data-part="auxiliarybar"]');
	await expect(properties.getByRole('textbox', { name: 'Page background color', exact: true })).toHaveValue('E8EEF6');
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('fill', '#2f6fed66');
	await expect(canvas.locator('.ash-canvas-viewport')).toHaveCSS('background-color', 'rgb(232, 238, 246)');
});

test('Sessions Design shares color widgets and picker behavior for strokes and shadows', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Creator', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	const properties = page.locator('[data-part="auxiliarybar"]');
	await canvas.press('p');
	await canvas.locator('.ash-canvas-viewport').click({ position: { x: 120, y: 140 } });
	await canvas.locator('.ash-canvas-viewport').click({ position: { x: 260, y: 220 } });
	await canvas.press('Enter');
	const stroke = properties.getByRole('textbox', { name: 'Stroke color', exact: true });
	await stroke.fill('336699'); await stroke.press('Enter');
	const alpha = properties.getByRole('spinbutton', { name: 'Stroke opacity (%)', exact: true });
	await alpha.fill('40'); await alpha.press('Enter');
	await expect(canvas.locator('path[data-shape-id]')).toHaveAttribute('stroke', '#33669966');
	await properties.getByRole('button', { name: 'Stroke color', exact: true }).click();
	await expect(page.getByRole('dialog', { name: /^Color picker/u })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(properties.getByRole('button', { name: 'Stroke color', exact: true })).toBeFocused();
	await stroke.locator('..').scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath('stroke-color-widget.png') });
	await properties.getByRole('button', { name: 'Add effect', exact: true }).click();
	const shadow = properties.getByRole('textbox', { name: 'Shadow color', exact: true });
	await shadow.fill('123456'); await shadow.press('Enter');
	const shadowAlpha = properties.getByRole('spinbutton', { name: 'Shadow opacity (%)', exact: true });
	await shadowAlpha.fill('40'); await shadowAlpha.press('Enter');
	await expect(canvas.locator('feFlood[flood-color="#123456"]')).toHaveAttribute('flood-opacity', '0.4');
	await properties.getByRole('button', { name: 'Choose shadow color', exact: true }).click();
	await expect(page.getByRole('dialog', { name: /^Color picker/u })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(properties.getByRole('button', { name: 'Choose shadow color', exact: true })).toBeFocused();
	await shadow.locator('..').scrollIntoViewIfNeeded();
	await page.screenshot({ path: testInfo.outputPath('shadow-color-widget.png') });
});
