import { expect, test as base, type Page } from '@playwright/test';
import { paintColor, paintPixel } from '../../automation/design.js';

// Exercise the production Creator renderer with the existing disconnected Sessions host.
const test = base.extend({
	page: async ({ page }, use) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
		await page.goto('/sessions.html?creator');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await use(page);
		expect(errors).toEqual([]);
		expect(await page.evaluate(() => [...window.ashSessionsIntegration.errors])).toEqual([]);
	},
});

test('Sessions Prototype expressions, ordered conditional actions and custom springs run without changing variables', async ({ page }, testInfo) => {
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

test('Sessions Prototype connects screens by dragging and plays transitions, branches and overlays', async ({ page }, testInfo) => {
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

test('Sessions Prototype Change to previews interactive component variants without editing the instance', async ({ page }, testInfo) => {
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

test('Sessions Design resources bind variable modes and reuse styles with keyboard controls', async ({ page }, testInfo) => {
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

test('Sessions Design components inherit overrides and switch variants with keyboard-accessible controls', async ({ page }, testInfo) => {
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

test('Sessions Creator Slides presents reordered pages and Brand undoes an entire variant batch', async ({ page }) => {
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

test('Sessions Prototype scrolls with wheel, drag and keyboard, pins layers and animates Scroll to', async ({ page }, testInfo) => {
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

test('Sessions Design composites fill order, opacity and plus darker against the backdrop', async ({ page }, testInfo) => {
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

test('Sessions Design paints editable text gradients and exports matching blended glyphs', async ({ page }, testInfo) => {
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

test('Sessions Design pen closes paths, inserts exact curve nodes and outlines strokes', async ({ page }, testInfo) => {
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

test('Sessions Design outlines square caps and dashed strokes as editable contours', async ({ page }) => {
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

test('Sessions Design background blur clips to ellipses, ignores previous blurs and exports the same backdrop', async ({ page }, testInfo) => {
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

test('Sessions Design shares color widgets and picker behavior for strokes and shadows', async ({ page }, testInfo) => {
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

test('Sessions Design layout edits reflow the canvas and preserve layer identity through undo', async ({ page }, testInfo) => {
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
	{
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

test('Sessions Design grid and wrap respect size limits in the canvas and responsive HTML', async ({ page }, testInfo) => {
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
	{
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
	{
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
	{
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

test('Sessions Design edits rich text on canvas with one typing undo', async ({ page }, testInfo) => {
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
	{
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

test('Sessions Design typography wraps, preserves rich ranges and exports responsive text', async ({ page }, testInfo) => {
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
	{
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
