import { clickCanvasMenu, paintColor, paintPixel } from '../../../automation/design.js';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Menus } from '../../../automation/menus.js';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

test('Sessions mode and page-tab activation reuse Parts while retaining the conversation and dirty document', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await navigation.getByRole('button', { name: 'New', exact: true }).click();
	const chat = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await chat.waitForEditorFocus();
	await chat.waitForTypeInEditor('Retained conversation draft');
	const parts = await page.locator('[data-part]').elementHandles();
	await new QuickAccess(page).runCommand('workbench.action.files.newUntitledFile');
	const document = new Editor(page.locator('[data-part="editor"]'));
	await document.waitForEditorFocus();
	await document.waitForTypeInEditor('Retained dirty document');
	await chat.waitForEditorFocus();
	await expect(page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	const creatorNavigation = page.locator('.ash-creator-home');
	await expect(creatorNavigation).toBeVisible();
	const sidebarContent = page.locator('[data-part="sidebar"] [data-view-container-id]:visible');
	const retainedSidebar = await sidebarContent.elementHandle();
	await creatorNavigation.getByRole('button', { name: 'Design', exact: true }).focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Design/);
	await page.keyboard.press('Escape');
	await expect(creatorNavigation.getByRole('button', { name: 'Design', exact: true })).toBeFocused();
	await creatorNavigation.getByRole('button', { name: 'Design', exact: true }).press('Enter');
	expect(await sidebarContent.evaluate((element, retained) => element === retained, retainedSidebar)).toBe(true);
	await expect(page.locator('[data-part="auxiliarybar"]')).toContainText('Page');
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	await expect(navigation.getByRole('button', { name: 'Artifacts', exact: true })).toHaveAttribute('aria-current', 'page');
	await creatorNavigation.getByRole('button', { name: 'Design', exact: true }).click();
	expect(await sidebarContent.evaluate((element, retained) => element === retained, retainedSidebar)).toBe(true);
	await navigation.getByRole('button', { name: 'Projects', exact: true }).focus();
	await navigation.getByRole('button', { name: 'Projects', exact: true }).press('Enter');
	await expect(navigation.getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-projects')).toBeVisible();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	for (const part of parts) {
		try {
			expect(await part.evaluate(element => element.isConnected && element === element.ownerDocument!.querySelector(`[data-part="${(element as HTMLElement).dataset.part}"]`))).toBe(true);
		} finally {
			await part.dispose();
		}
	}
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await chat.waitForEditorContents(text => text === 'Retained conversation draft');
	await document.waitForEditorContents(text => text === 'Retained dirty document');
	await expect(page.getByRole('dialog', { name: 'Save Changes', exact: true })).toHaveCount(0);
	await retainedSidebar!.dispose();
	await page
		.locator('[data-part="editor"]')
		.getByRole('tab', { name: /^Untitled-1(?:,|$)/u })
		.press('Delete');
	await page.getByRole('dialog', { name: 'Save Changes', exact: true }).getByRole('button', { name: "Don't Save", exact: true }).click();
});

test('Sessions Artifacts retains Design and Slides canvases independently', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	const creator = page.locator('.ash-creator');
	await expect(creator.getByRole('heading', { name: 'Artifacts', exact: true })).toBeVisible();
	await expect(creator.locator('.ash-artifacts-create')).toHaveCount(3);
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(page.locator('[data-part="editor"] .ash-creator')).toBeVisible();
	await expect(page.locator('[data-part="creator"], [data-part="projects"]')).toHaveCount(0);
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
	}
	let workspace = creator.locator('.ash-creator-workspace:visible');
	let canvas = workspace.getByRole('region', { name: 'Design canvas' });
	await canvas.press('r');
	await canvas.press('+');
	const world = canvas.locator('.ash-canvas-world');
	const transform = await world.evaluate(element => (element as HTMLElement).style.transform);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await expect(creator.getByRole('button', { name: 'Docs', exact: true })).toBeFocused();
	await creator.getByRole('button', { name: 'Slides', exact: true }).click();
	workspace = creator.locator('.ash-creator-workspace:visible');
	canvas = workspace.getByRole('region', { name: 'Design canvas' });
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(0);
	await workspace.getByRole('button', { name: 'Add slide', exact: true }).click();
	await expect(canvas.locator('[data-shape-id]').first()).toBeVisible();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await design.click();
	canvas = creator.locator('.ash-creator-workspace:visible').getByRole('region', { name: 'Design canvas' });
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
	await expect.poll(() => world.evaluate(element => (element as HTMLElement).style.transform)).toBe(transform);
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(0);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.setViewportSize({ width: 620, height: 860 });
	await expect(creator).toHaveClass(/narrow/);
	await expect.poll(() => creator.locator('.ash-creator-modes').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
	await expect(design).toHaveCSS('min-width', '0px');
});

test('Sessions Creator resets side panel widths and retains them across page changes and reopening', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	await new QuickAccess(page).runCommand('workbench.sessions.sidebar.designLayers');
	const sidebar = page.locator('[data-part="sidebar"]');
	const leftSash = sidebar.locator('xpath=../../..').locator(':scope > .ash-sash:not(.ash-sash-disabled):visible').first();
	const rightSash = page.locator('[data-part="auxiliarybar"]').locator('xpath=../../..').locator(':scope > .ash-sash:not(.ash-sash-disabled):visible').last();
	const panelWidths = () =>
		page
			.locator('.ash-workbench-part-frame')
			.evaluateAll(frames =>
				frames.filter(frame => frame.querySelector(':scope > [data-part="sidebar"], :scope > [data-part="auxiliarybar"]')).map(frame => Math.round(frame.getBoundingClientRect().width)),
			);
	await expect.poll(panelWidths).toHaveLength(2);
	// Establish the reset baseline after explicitly activating the tool view.
	await leftSash.dblclick();
	await rightSash.dblclick();
	const initialWidths = await panelWidths();
	for (const width of [1226, 1400, 1100]) {
		let contentWidth = width;
		if ('windows' in application) {
			const window = await application.browserWindow(page);
			try {
				contentWidth = await window.evaluate((window, width) => {
					window.setSize(width, 800);
					return window.getContentSize()[0];
				}, width);
			} finally {
				await window.dispose();
			}
		} else {
			await page.setViewportSize({ width, height: 800 });
		}
		// Electron DIP sizes and Chromium viewport sizes can round to adjacent pixels under Windows display scaling.
		await expect.poll(async () => Math.abs((await page.evaluate(() => window.innerWidth)) - contentWidth)).toBeLessThanOrEqual(1);
		await expect.poll(panelWidths).toEqual(initialWidths);
	}
	await leftSash.focus();
	await leftSash.press('ArrowRight');
	await expect.poll(panelWidths).not.toEqual(initialWidths);
	await leftSash.dblclick();
	await rightSash.focus();
	await rightSash.press('ArrowLeft');
	await rightSash.dblclick();
	await expect.poll(panelWidths).toEqual(initialWidths);
	const canvas = page.locator('.ash-creator').getByRole('region', { name: 'Design canvas' });
	await canvas.press('t');
	await canvas.locator('.ash-canvas-viewport').click({ position: { x: 200, y: 100 } });
	await page.keyboard.press('Escape');
	const text = page.locator('[data-part="auxiliarybar"]').getByRole('textbox', { name: 'Text content', exact: true });
	await text.fill('A long dashboard headline whose complete layer name needs more room');
	await text.press('Tab');
	await leftSash.dblclick();
	await expect.poll(async () => (await panelWidths())[0]).toBeGreaterThan(initialWidths[0]!);
	await canvas.press('ControlOrMeta+z');
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(0);
	await leftSash.dblclick();
	await rightSash.dblclick();
	await expect.poll(panelWidths).toEqual(initialWidths);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	await expect.poll(panelWidths).toEqual(initialWidths);
	await leftSash.focus();
	await leftSash.press('ArrowRight');
	const resized = await panelWidths();
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.getByRole('region', { name: 'Design canvas', exact: true })).toBeVisible();
	await expect.poll(panelWidths).toEqual(resized);
});

test('Sessions Creator uses Chinese mode names, actions and keyboard help', async ({ application, target, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench, application } = await restartWorkbench());
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	const creator = page.locator('.ash-creator');
	for (const title of ['文档', '幻灯片', '设计']) {
		await expect(creator.getByRole('button', { name: title, exact: true })).toBeVisible();
	}
	await creator.getByRole('button', { name: '幻灯片', exact: true }).focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Artifacts 导航返回首页/);
	await page.keyboard.press('Escape');
	await creator.getByRole('button', { name: '幻灯片', exact: true }).press('Enter');
	await expect(creator.getByRole('button', { name: '添加幻灯片', exact: true })).toBeVisible();
	await creator.getByRole('button', { name: '添加幻灯片', exact: true }).click();
	await expect(creator.getByRole('combobox', { name: '页面', exact: true })).toHaveText('第 1 页');
	await creator.getByRole('button', { name: 'Artifacts 首页', exact: true }).click();
	await creator.getByRole('button', { name: '设计', exact: true }).click();
	await expect(creator.locator('.ash-creator-header')).toBeHidden();
	await expect(creator.locator('[data-creator-mode="design"] .ash-creator-workspace-actions')).toHaveCount(0);
	const canvas = page.getByRole('region', { name: '设计画布', exact: true });
	await canvas.press('r');
	await canvas.press('Shift+F10');
	for (const label of ['添加画板 (F)', '导入图片', '保存副本', '导出 SVG']) {
		await expect(page.getByRole('menu').getByRole('menuitem', { name: label, exact: true })).toBeEnabled();
	}
	await page.keyboard.press('Escape');
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await expect(creator.getByRole('button', { name: '设计', exact: true })).toBeVisible();
});

test('Sessions Design vector booleans keep editable operands, holes, history and exported paths', async ({ target, workbench }, testInfo) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	let canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	let properties = page.locator('[data-part="auxiliarybar"]');
	const field = async (name: string, value: string): Promise<void> => {
		const input = properties.getByRole('spinbutton', { name, exact: true });
		await input.fill(value);
		await input.press('Tab');
	};
	await canvas.press('r');
	await field('X', '0');
	await field('Y', '0');
	await field('Width', '200');
	await field('Height', '160');
	await canvas.press('e');
	await field('X', '50');
	await field('Y', '40');
	await field('Width', '100');
	await field('Height', '80');
	await canvas.press('ControlOrMeta+a');
	await properties.getByRole('button', { name: 'Subtract selection', exact: true }).click();
	const result = () => canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id] > path');
	await expect(result()).toHaveCount(1);
	await expect(result()).not.toHaveAttribute('d', '');
	const original = await result().getAttribute('d');
	const inside = async (x: number, y: number): Promise<boolean> =>
		result().evaluate((path, point) => (path as SVGGeometryElement).isPointInFill(new DOMPoint(point.x, point.y)), {
			x,
			y,
		});
	expect(await inside(10, 10)).toBe(true);
	expect(await inside(100, 80)).toBe(false);
	await canvas.press('Tab');
	await field('Width', '180');
	await expect(result()).not.toHaveAttribute('d', original!);
	await canvas.press('ControlOrMeta+z');
	await expect(result()).toHaveAttribute('d', original!);
	await canvas.press('ControlOrMeta+a');
	await new QuickAccess(page).runCommand('workbench.sessions.sidebar.designLayers');
	await page.locator('.ash-design-layers').getByRole('tree', { name: 'Layers', exact: true }).press('Alt+Shift+u');
	await expect.poll(() => inside(100, 80)).toBe(true);
	await properties.getByRole('button', { name: 'Intersect selection', exact: true }).click();
	expect(await inside(10, 10)).toBe(false);
	expect(await inside(100, 80)).toBe(true);
	await properties.getByRole('button', { name: 'Exclude selection', exact: true }).click();
	expect(await inside(100, 80)).toBe(false);
	await canvas.press('ControlOrMeta+e');
	await expect(canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]')).toHaveCount(1);
	await expect(properties.getByRole('combobox', { name: 'Contour', exact: true }).locator('option')).toHaveCount(2);
	await properties.getByRole('combobox', { name: 'Contour', exact: true }).selectOption('1');
	const anchor = properties.getByRole('spinbutton', { name: 'Anchor X', exact: true });
	const before = Number(await anchor.inputValue());
	await canvas.press('ArrowRight');
	await expect(anchor).toHaveValue(String(before + 1));
	await canvas.press('ControlOrMeta+z');
	await expect(anchor).toHaveValue(String(before));
	await page.screenshot({ path: testInfo.outputPath('design-vector-booleans.png') });
	if (target.kind === 'browser') {
		await page.evaluate(async () => {
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(`ash-vector-${crypto.randomUUID()}`, { create: true });
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		});
		await canvas.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Save a copy', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Save a copy', exact: true });
		await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('vectors.ash-design');
		await dialog.getByRole('button', { name: 'OK', exact: true }).click();
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Saved vectors.ash-design');
		await canvas.press('Escape');
		await canvas.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Open design', exact: true }).click();
		await page
			.locator('.ash-quick-pick-row-label')
			.filter({ hasText: /^vectors\.ash-design$/u })
			.click();
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Opened vectors.ash-design');
		await canvas.press('Tab');
		await expect(properties.getByRole('combobox', { name: 'Contour', exact: true }).locator('option')).toHaveCount(2);
	}
	await canvas.getByRole('button', { name: 'Code', exact: true }).click();
	const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	expect(code).toContain('"subpaths"');
	expect(code).toContain('fill-rule="nonzero"');
	expect(code).toContain('<path');
});

test('Sessions Design edits four gradient types, canvas stops and paint stacks through save and reopen', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }),
		properties = page.locator('[data-part="auxiliarybar"]');
	const field = async (name: string, value: string): Promise<void> => {
		const input = properties.getByRole('spinbutton', { name, exact: true });
		await input.fill(value);
		await input.press('Tab');
	};
	await canvas.press('r');
	await field('X', '100');
	await field('Y', '100');
	await field('Width', '240');
	await field('Height', '160');
	await paintColor(page, '#ff0000');
	const type = properties.getByRole('combobox', { name: 'Fill type', exact: true });
	await type.selectOption('linear');
	await expect(canvas.locator('linearGradient')).toHaveCount(1);
	await expect(canvas.locator('[data-gradient-stop]')).toHaveCount(2);
	await properties.getByRole('button', { name: 'Add gradient stop', exact: true }).click();
	await field('Gradient stop position (%)', '50');
	await paintColor(page, '#0000ff');
	const stops = properties.getByRole('combobox', { name: 'Gradient stop', exact: true });
	await expect(stops.locator('option')).toHaveCount(3);
	await canvas.press('ArrowRight');
	await expect(properties.getByRole('spinbutton', { name: 'Gradient stop position (%)', exact: true })).toHaveValue('51');
	const handle = canvas.locator('[data-gradient-stop]').nth(1),
		box = await handle.boundingBox();
	expect(box).toBeTruthy();
	await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
	await page.mouse.down();
	await page.mouse.move(box!.x + box!.width / 2 + 24, box!.y + box!.height / 2, { steps: 4 });
	await page.mouse.up();
	await expect(properties.getByRole('spinbutton', { name: 'Gradient stop position (%)', exact: true })).toHaveValue('61');
	await canvas.press('ControlOrMeta+z');
	await expect(properties.getByRole('spinbutton', { name: 'Gradient stop position (%)', exact: true })).toHaveValue('51');
	for (const next of ['radial', 'angular', 'diamond']) {
		await type.selectOption(next);
		if (next === 'radial') {
			await expect(canvas.locator('radialGradient')).toHaveCount(1);
		} else {
			await expect(canvas.locator('pattern image')).toHaveAttribute('href', /^data:image\/png;base64,/u);
		}
	}
	await field('Gradient start X (%)', '50');
	await field('Gradient start Y (%)', '50');
	await field('Gradient end X (%)', '100');
	await field('Gradient end Y (%)', '50');
	await field('Gradient axis X (%)', '50');
	await field('Gradient axis Y (%)', '100');
	await properties.getByRole('button', { name: 'Duplicate fill', exact: true }).click();
	await field('Paint opacity (%)', '35');
	await properties.getByRole('combobox', { name: 'Fill blend mode', exact: true }).selectOption('screen');
	await properties.getByRole('button', { name: 'Move fill down', exact: true }).click();
	await expect(properties.getByRole('combobox', { name: 'Fill layer', exact: true }).locator('option')).toHaveCount(2);
	await properties.getByRole('checkbox', { name: 'Fill visible', exact: true }).uncheck();
	await expect(canvas.locator('[data-paint-id]')).toHaveCount(1);
	await properties.getByRole('checkbox', { name: 'Fill visible', exact: true }).check();
	if (target.kind === 'browser') {
		await reopenOutlinedDesign(page, 'gradients.ash-design');
		await canvas.press('Tab');
	}
	await expect(type).toHaveValue('diamond');
	await expect(stops.locator('option')).toHaveCount(3);
	await expect(canvas.locator('[data-paint-id]')).toHaveCount(2);
	const paintedBox = await canvas.locator('.ash-sessions-design-shapes > [data-shape-id]').boundingBox();
	expect(paintedBox).toBeTruthy();
	const corner = await paintPixel(page, paintedBox!.x + 12, paintedBox!.y + 12);
	expect(corner.slice(0, 3)).toEqual([255, 255, 255]);
	const center = await paintPixel(page, paintedBox!.x + paintedBox!.width / 2, paintedBox!.y + paintedBox!.height / 2);
	expect(center[0]).toBeGreaterThan(240);
	expect(center[1]).toBeLessThan(20);
	expect(center[2]).toBeLessThan(20);
	await page.screenshot({ path: testInfo.outputPath('design-gradients.png') });
	await canvas.getByRole('button', { name: 'Code', exact: true }).click();
	const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	expect(code).toContain('data:image/png;base64,');
	expect(code).toContain('mix-blend-mode: screen');
	expect(code).toContain('"type": "diamond"');
});

test('Sessions Design smooths corners and preserves aligned strokes around holes through outlining and reopen', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }),
		properties = page.locator('[data-part="auxiliarybar"]');
	const field = async (name: string, value: string): Promise<void> => {
		const input = properties.getByRole('spinbutton', { name, exact: true });
		await input.fill(value);
		await input.press('Tab');
	};
	await canvas.press('r');
	await field('X', '0');
	await field('Y', '0');
	await field('Width', '200');
	await field('Height', '100');
	await properties.getByRole('button', { name: 'Convert to path', exact: true }).click();
	await canvas.press('Escape');
	await field('Node corner radius', '20');
	const plain = canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]');
	const circular = await plain.getAttribute('d');
	await properties.getByRole('button', { name: 'iOS smoothing (60%)', exact: true }).click();
	await expect(properties.getByRole('spinbutton', { name: 'Corner smoothing (%)', exact: true })).toHaveValue('60');
	await expect(plain).not.toHaveAttribute('d', circular!);
	await canvas.press('ControlOrMeta+z');
	await expect(plain).toHaveAttribute('d', circular!);
	await canvas.press('ControlOrMeta+Shift+z');
	await field('X', '100');
	await field('Y', '100');
	await page.screenshot({ path: testInfo.outputPath('design-corner-smoothing.png') });
	await field('X', '0');
	await field('Y', '0');
	await field('Node corner radius', '0');
	await canvas.press('e');
	await field('X', '50');
	await field('Y', '25');
	await field('Width', '100');
	await field('Height', '50');
	await canvas.press('ControlOrMeta+a');
	await properties.getByRole('button', { name: 'Subtract selection', exact: true }).click();
	await canvas.press('ControlOrMeta+e');
	await field('Stroke width', '10');
	const alignment = properties.getByRole('combobox', { name: 'Stroke alignment', exact: true });
	const inside = (x: number, y: number) => plain.evaluate((path, p) => (path as SVGGeometryElement).isPointInFill(new DOMPoint(p.x, p.y)), { x, y });
	await alignment.selectOption('inside');
	await expect(canvas.locator('path[clip-path]')).toHaveCount(1);
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click();
	expect(await inside(-5, 50)).toBe(false);
	expect(await inside(5, 50)).toBe(true);
	expect(await inside(45, 50)).toBe(true);
	expect(await inside(55, 50)).toBe(false);
	expect(await inside(100, 50)).toBe(false);
	await canvas.press('ControlOrMeta+z');
	await alignment.selectOption('outside');
	await expect(canvas.locator('path[mask]')).toHaveCount(1);
	if (target.kind === 'browser') {
		await reopenOutlinedDesign(page, 'aligned.ash-design');
		await canvas.press('Tab');
	}
	await expect(alignment).toHaveValue('outside');
	await page.screenshot({ path: testInfo.outputPath('design-stroke-alignment.png') });
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click();
	expect(await inside(-5, 50)).toBe(true);
	expect(await inside(5, 50)).toBe(false);
	expect(await inside(45, 50)).toBe(false);
	expect(await inside(55, 50)).toBe(true);
	expect(await inside(100, 50)).toBe(false);
	await canvas.press('ControlOrMeta+z');
	await canvas.getByRole('button', { name: 'Code', exact: true }).click();
	const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	expect(code).toContain('maskUnits="userSpaceOnUse"');
	expect(code).toContain('"strokeAlignment": "outside"');
});

test('Sessions Design edits independent arrow endpoints, preserves network endpoints and outlines exported tips', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }),
		properties = page.locator('[data-part="auxiliarybar"]'),
		viewport = canvas.locator('.ash-canvas-viewport');
	const field = async (name: string, value: string): Promise<void> => {
		const input = properties.getByRole('spinbutton', { name, exact: true });
		await input.fill(value);
		await input.press('Tab');
	};
	await canvas.press('p');
	await viewport.click({ position: { x: 100, y: 180 } });
	await viewport.click({ position: { x: 340, y: 180 } });
	await canvas.press('Enter');
	await canvas.press('v');
	await canvas.press('Tab');
	await field('Stroke width', '12');
	const start = properties.getByRole('combobox', { name: 'Start endpoint', exact: true }),
		end = properties.getByRole('combobox', { name: 'End endpoint', exact: true });
	await start.selectOption('round');
	await end.selectOption('triangle-arrow');
	const group = canvas.locator('.ash-sessions-design-shapes > g[data-shape-id]');
	const tips = group.locator(':scope > path[fill]:not([fill="none"])');
	const geometry = await tips.getAttribute('d');
	await expect(tips).not.toHaveAttribute('d', '');
	const tipBounds = await tips.evaluate(path => {
		const b = (path as SVGGraphicsElement).getBBox();
		return { x: b.x, y: b.y, width: b.width, height: b.height };
	});
	const besideTip = { x: tipBounds.x + tipBounds.width - 1, y: tipBounds.y + tipBounds.height / 2 + 5 };
	expect(await group.locator('path[stroke]').evaluate((path, p) => (path as SVGGeometryElement).isPointInStroke(new DOMPoint(p.x, p.y)), besideTip)).toBe(false);
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click();
	const outlined = canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]');
	const outlinedBounds = await outlined.evaluate(path => {
		const b = (path as SVGGraphicsElement).getBBox();
		return { x: b.x, y: b.y, width: b.width, height: b.height };
	});
	expect(await outlined.evaluate((path, p) => (path as SVGGeometryElement).isPointInFill(new DOMPoint(p.x, p.y)), besideTip)).toBe(false);
	for (const key of ['x', 'y', 'width', 'height'] as const) {
		expect(Math.abs(tipBounds[key] - outlinedBounds[key])).toBeLessThan(0.1);
	}
	await canvas.press('ControlOrMeta+z');
	await expect(tips).toHaveAttribute('d', geometry!);
	await canvas.press('Escape');
	await end.selectOption('diamond-arrow');
	await properties.getByRole('combobox', { name: 'Width profile', exact: true }).selectOption('both');
	await expect(end).toHaveValue('butt');
	await end.selectOption('line-arrow');
	await expect(properties.getByRole('combobox', { name: 'Width profile', exact: true })).toHaveValue('uniform');
	if (target.kind === 'browser') {
		await reopenOutlinedDesign(page, 'arrows.ash-design');
		await canvas.press('Tab');
	}
	await expect(end).toHaveValue('line-arrow');
	await properties.getByRole('button', { name: 'Convert to vector network', exact: true }).click();
	const node = properties.getByRole('combobox', { name: 'Path node', exact: true });
	await node.selectOption({ value: '1' });
	const endpoint = properties.getByRole('combobox', { name: 'Endpoint style', exact: true });
	await expect(endpoint).toHaveValue('line-arrow');
	await endpoint.selectOption('reverse-triangle');
	await page.screenshot({ path: testInfo.outputPath('design-arrow-endpoints.png') });
	await canvas.getByRole('button', { name: 'Code', exact: true }).click();
	const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	expect(code).toContain('"endpoint": "reverse-triangle"');
});

test('Sessions Design rounds editable nodes and previews signed offsets with holes and undo', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }),
		properties = page.locator('[data-part="auxiliarybar"]');
	const field = async (name: string, value: string): Promise<void> => {
		const input = properties.getByRole('spinbutton', { name, exact: true });
		await input.fill(value);
		await input.press('Tab');
	};
	await canvas.press('r');
	await field('X', '0');
	await field('Y', '0');
	await field('Width', '200');
	await field('Height', '100');
	await properties.getByRole('button', { name: 'Convert to path', exact: true }).click();
	await canvas.press('Escape');
	await field('Node corner radius', '20');
	const artwork = canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]');
	const inside = (x: number, y: number) => artwork.evaluate((path, p) => (path as SVGGeometryElement).isPointInFill(new DOMPoint(p.x, p.y)), { x, y });
	expect(await inside(1, 1)).toBe(false);
	expect(await inside(20, 20)).toBe(true);
	await canvas.press('Enter');
	const nodes = properties.getByRole('combobox', { name: 'Path node', exact: true });
	await expect(nodes.locator('option')).toHaveCount(4);
	await nodes.selectOption({ value: '0' });
	await field('Node corner radius', '0');
	expect(await inside(1, 1)).toBe(true);
	await canvas.press('ControlOrMeta+z');
	expect(await inside(1, 1)).toBe(false);
	await canvas.press('Escape');
	await field('Node corner radius', '0');
	const original = await artwork.getAttribute('d');
	await properties.getByRole('button', { name: 'Offset vector', exact: true }).click();
	await field('Offset amount', '10');
	await expect(artwork).not.toHaveAttribute('d', original!);
	expect(await inside(-5, 50)).toBe(true);
	await properties.getByRole('button', { name: 'Cancel offset', exact: true }).click();
	await expect(artwork).toHaveAttribute('d', original!);
	await properties.getByRole('button', { name: 'Offset vector', exact: true }).click();
	await field('Offset amount', '-10');
	expect(await inside(5, 50)).toBe(false);
	expect(await inside(20, 50)).toBe(true);
	await canvas.press('Enter');
	await expect(properties.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('180');
	await canvas.press('ControlOrMeta+z');
	await expect(artwork).toHaveAttribute('d', original!);
	await properties.getByRole('button', { name: 'Offset vector', exact: true }).click();
	await field('Offset amount', '10');
	await properties.getByRole('combobox', { name: 'Offset join', exact: true }).selectOption('round');
	expect(await inside(-9, -9)).toBe(false);
	await properties.getByRole('combobox', { name: 'Offset join', exact: true }).selectOption('miter');
	expect(await inside(-9, -9)).toBe(true);
	await field('Offset amount', '-1000');
	await properties.getByRole('button', { name: 'Apply offset', exact: true }).click();
	await expect(artwork).toHaveCount(0);
	await canvas.press('ControlOrMeta+z');
	await expect(artwork).toHaveAttribute('d', original!);
	await canvas.press('Escape');
	await canvas.press('e');
	await field('X', '50');
	await field('Y', '25');
	await field('Width', '100');
	await field('Height', '50');
	await canvas.press('ControlOrMeta+a');
	await properties.getByRole('button', { name: 'Subtract selection', exact: true }).click();
	await canvas.press('ControlOrMeta+e');
	await properties.getByRole('button', { name: 'Offset vector', exact: true }).click();
	await field('Offset amount', '5');
	expect(await inside(100, 50)).toBe(false);
	expect(await inside(-3, 50)).toBe(true);
	await properties.getByRole('combobox', { name: 'Offset join', exact: true }).selectOption('round');
	await properties.getByRole('button', { name: 'Apply offset', exact: true }).click();
	if (target.kind === 'browser') {
		await reopenOutlinedDesign(page, 'offsets.ash-design');
	}
	expect(await inside(100, 50)).toBe(false);
	await page.screenshot({ path: testInfo.outputPath('design-vector-offset.png') });
});

test('Sessions Design variable width supports canvas points, numeric editing, outlining and persistence', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }),
		properties = page.locator('[data-part="auxiliarybar"]'),
		viewport = canvas.locator('.ash-canvas-viewport');
	const field = async (name: string, value: string): Promise<void> => {
		const input = properties.getByRole('spinbutton', { name, exact: true });
		await input.fill(value);
		await input.press('Tab');
	};
	await canvas.press('p');
	await viewport.click({ position: { x: 100, y: 180 } });
	await viewport.click({ position: { x: 340, y: 180 } });
	await canvas.press('Enter');
	await canvas.press('v');
	await canvas.press('Tab');
	await field('Stroke width', '20');
	await properties.getByRole('combobox', { name: 'Width profile', exact: true }).selectOption('both');
	const points = properties.getByRole('combobox', { name: 'Width point', exact: true });
	await expect(points.locator('option')).toHaveCount(3);
	await points.selectOption({ index: 1 });
	await field('Width at point', '60');
	const ribbon = canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path');
	await expect(ribbon).toHaveCount(1);
	const wide = await ribbon.getAttribute('d');
	const center = canvas.locator('[data-width-handle="center"]').nth(1),
		bounds = (await center.boundingBox())!;
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + bounds.height / 2, { steps: 4 });
	await page.mouse.up();
	await expect.poll(async () => Number(await properties.getByRole('spinbutton', { name: 'Width point position (%)', exact: true }).inputValue())).toBeGreaterThan(60);
	await canvas.press('ControlOrMeta+z');
	await expect(ribbon).toHaveAttribute('d', wide!);
	const side = canvas.locator('[data-width-handle="edge"]').nth(2),
		sideBounds = (await side.boundingBox())!;
	await page.mouse.move(sideBounds.x + sideBounds.width / 2, sideBounds.y + sideBounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(sideBounds.x + sideBounds.width / 2, sideBounds.y + sideBounds.height / 2 - 15, { steps: 4 });
	await page.mouse.up();
	await expect(ribbon).not.toHaveAttribute('d', wide!);
	await canvas.press('ControlOrMeta+z');
	await expect(ribbon).toHaveAttribute('d', wide!);
	await viewport.click({ position: { x: 160, y: 180 }, modifiers: ['Control'] });
	await expect(points.locator('option')).toHaveCount(4);
	await canvas.press('Delete');
	await expect(points.locator('option')).toHaveCount(3);
	await canvas.press('ControlOrMeta+z');
	await expect(points.locator('option')).toHaveCount(4);
	if (target.kind === 'browser') {
		await reopenOutlinedDesign(page, 'widths.ash-design');
		await canvas.press('Tab');
	}
	await expect(points.locator('option')).toHaveCount(4);
	const ribbonBounds = await ribbon.evaluate(path => {
		const b = (path as SVGGraphicsElement).getBBox();
		return { x: b.x, y: b.y, width: b.width, height: b.height };
	});
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click();
	const outlinedBounds = await canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]').evaluate(path => {
		const b = (path as SVGGraphicsElement).getBBox();
		return { x: b.x, y: b.y, width: b.width, height: b.height };
	});
	for (const key of ['x', 'y', 'width', 'height'] as const) {
		expect(Math.abs(ribbonBounds[key] - outlinedBounds[key])).toBeLessThan(0.1);
	}
	await expect(canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]')).toHaveCount(1);
	await expect(properties.getByRole('spinbutton', { name: 'Stroke width', exact: true })).toHaveValue('0');
	await canvas.press('ControlOrMeta+z');
	await expect(points.locator('option')).toHaveCount(4);
	await page.screenshot({ path: testInfo.outputPath('design-variable-width.png') });
});

test('Sessions Design branches shared vector nodes and paints network regions', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }),
		properties = page.locator('[data-part="auxiliarybar"]'),
		viewport = canvas.locator('.ash-canvas-viewport');
	await canvas.press('p');
	for (const position of [
		{ x: 140, y: 130 },
		{ x: 300, y: 130 },
		{ x: 220, y: 270 },
		{ x: 140, y: 130 },
	]) {
		await viewport.click({ position });
	}
	await canvas.press('v');
	await canvas.press('Tab');
	await canvas.press('Enter');
	await properties.getByRole('button', { name: 'Convert to vector network', exact: true }).click();
	const nodes = properties.getByRole('combobox', { name: 'Path node', exact: true });
	await expect(nodes.locator('option')).toHaveCount(3);
	const anchors = canvas.locator('.ash-sessions-design-path-handle[data-path-point="anchor"]');
	await canvas.press('p');
	await anchors.nth(0).click();
	const viewportBox = (await viewport.boundingBox())!;
	await page.mouse.move(viewportBox.x + 80, viewportBox.y + 240);
	await page.mouse.down();
	await page.mouse.move(viewportBox.x + 100, viewportBox.y + 260);
	await page.mouse.up();
	await expect(nodes.locator('option')).toHaveCount(4);
	await expect(properties.getByRole('combobox', { name: 'Network segment', exact: true }).locator('option')).toHaveCount(4);
	await canvas.press('Escape');
	await canvas.press('v');
	await nodes.selectOption('0');
	const before = await canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path').last().getAttribute('d');
	await canvas.press('ArrowRight');
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path').last()).not.toHaveAttribute('d', before!);
	await canvas.press('ControlOrMeta+z');
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path').last()).toHaveAttribute('d', before!);
	await properties.getByRole('checkbox', { name: 'Region filled', exact: true }).uncheck();
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path').first()).toHaveAttribute('d', '');
	await canvas.press('ControlOrMeta+z');
	await expect(properties.getByRole('checkbox', { name: 'Region filled', exact: true })).toBeChecked();
	await properties.getByRole('button', { name: 'Split segment', exact: true }).click();
	await expect(nodes.locator('option')).toHaveCount(5);
	await properties.getByRole('spinbutton', { name: 'Segment start handle Y', exact: true }).fill('45');
	await properties.getByRole('spinbutton', { name: 'Segment start handle Y', exact: true }).press('Tab');
	await expect(canvas.locator('[data-network-edge="0"][data-path-point="outgoing"]')).toHaveCount(1);
	const regionColor = properties.getByRole('textbox', { name: 'Region color', exact: true });
	await regionColor.fill('#2266cc');
	await regionColor.press('Tab');
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path[fill="#2266cc"]')).toHaveCount(1);
	if (target.kind === 'browser') {
		await reopenOutlinedDesign(page, 'network.ash-design');
		await canvas.press('Tab');
		await expect(nodes.locator('option')).toHaveCount(5);
		await expect(regionColor).toHaveValue('2266CC');
	}
	await page.screenshot({ path: testInfo.outputPath('design-vector-network.png') });
	await canvas.getByRole('button', { name: 'Code', exact: true }).click();
	const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
	expect(code).toContain('"network"');
	expect(code).toContain('fill="#2266cc"');
});

test('Sessions Design connects crossings, merges anchors and previews simplification with atomic undo', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }),
		properties = page.locator('[data-part="auxiliarybar"]'),
		viewport = canvas.locator('.ash-canvas-viewport');
	await canvas.press('p');
	for (const position of [
		{ x: 120, y: 120 },
		{ x: 320, y: 320 },
		{ x: 120, y: 320 },
		{ x: 320, y: 120 },
		{ x: 120, y: 120 },
	]) {
		await viewport.click({ position });
	}
	await canvas.press('v');
	await canvas.press('Tab');
	await canvas.press('Enter');
	const nodes = properties.getByRole('combobox', { name: 'Path node', exact: true }),
		segments = properties.getByRole('combobox', { name: 'Network segment', exact: true });
	await properties.getByRole('button', { name: 'Add intersection nodes', exact: true }).click();
	await expect(nodes.locator('option')).toHaveCount(5);
	await expect(segments.locator('option')).toHaveCount(6);
	await expect(properties.getByRole('combobox', { name: 'Fill region', exact: true }).locator('option')).toHaveCount(2);
	await canvas.press('ControlOrMeta+z');
	await expect(nodes.locator('option')).toHaveCount(4);
	await canvas.press('p');
	await viewport.click({ position: { x: 220, y: 220 } });
	await expect(nodes.locator('option')).toHaveCount(5);
	await expect(segments.locator('option')).toHaveCount(6);
	await canvas.press('v');
	const anchors = canvas.locator('.ash-sessions-design-path-handle[data-path-point="anchor"]');
	const junction = await anchors.evaluateAll(elements => {
		const points = elements.map(element => ({
			index: element.getAttribute('data-path-node')!,
			rect: element.getBoundingClientRect(),
		}));
		const x = (Math.min(...points.map(point => point.rect.x)) + Math.max(...points.map(point => point.rect.x))) / 2,
			y = (Math.min(...points.map(point => point.rect.y)) + Math.max(...points.map(point => point.rect.y))) / 2;
		return points.sort((a, b) => Math.hypot(a.rect.x - x, a.rect.y - y) - Math.hypot(b.rect.x - x, b.rect.y - y))[0].index;
	});
	await nodes.selectOption({ value: junction });
	await properties.getByRole('button', { name: 'Cut at node', exact: true }).click();
	await expect(nodes.locator('option')).toHaveCount(8);
	await nodes.selectOption({ value: '7' });
	await canvas.press('Shift+ArrowRight');
	await canvas.press('Shift+ArrowRight');
	const from = (await anchors.nth(7).boundingBox())!,
		to = (await anchors.nth(Number(junction)).boundingBox())!;
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
	await page.mouse.up();
	await expect(nodes.locator('option')).toHaveCount(7);
	await canvas.press('ControlOrMeta+z');
	await expect(nodes.locator('option')).toHaveCount(8);
	await anchors.nth(0).click();
	await anchors.nth(1).click({ modifiers: ['Shift'] });
	await properties.getByRole('button', { name: 'Merge selected nodes', exact: true }).click();
	await expect(nodes.locator('option')).toHaveCount(7);
	await canvas.press('ControlOrMeta+z');
	await expect(nodes.locator('option')).toHaveCount(8);
	await canvas.press('Escape');
	await canvas.press('Escape');
	await canvas.press('p');
	for (const position of [
		{ x: 100, y: 380 },
		{ x: 150, y: 380 },
		{ x: 200, y: 380 },
		{ x: 250, y: 380 },
		{ x: 300, y: 380 },
	]) {
		await viewport.click({ position });
	}
	await canvas.press('Enter');
	await canvas.press('v');
	await canvas.press('Tab');
	await canvas.press('Tab');
	await canvas.press('Enter');
	await expect(nodes.locator('option')).toHaveCount(5);
	await properties.getByRole('button', { name: 'Simplify vector', exact: true }).click();
	const slider = properties.getByRole('slider', { name: 'Simplification', exact: true });
	await expect(slider).toBeVisible();
	await slider.fill('60');
	await expect(properties.getByRole('status').filter({ hasText: '5 → 2 points' })).toBeVisible();
	await expect(nodes.locator('option')).toHaveCount(5); // Preview never changes the saved document or its history.
	await slider.press('Escape');
	await expect(slider).toBeHidden();
	await expect(nodes.locator('option')).toHaveCount(5);
	await properties.getByRole('button', { name: 'Simplify vector', exact: true }).click();
	await properties.getByRole('button', { name: 'Apply simplification', exact: true }).click();
	await expect(nodes.locator('option')).toHaveCount(2);
	await canvas.press('ControlOrMeta+z');
	await expect(nodes.locator('option')).toHaveCount(5);
	await nodes.selectOption({ value: '2' });
	await canvas.press('Shift+Delete');
	await expect(nodes.locator('option')).toHaveCount(4);
	await canvas.press('ControlOrMeta+z');
	await expect(nodes.locator('option')).toHaveCount(5);
	await properties.getByRole('button', { name: 'Simplify vector', exact: true }).click();
	await properties.getByRole('button', { name: 'Apply simplification', exact: true }).click();
	if (target.kind === 'browser') {
		await reopenOutlinedDesign(page, 'topology.ash-design');
	}
	await page.screenshot({ path: testInfo.outputPath('design-vector-topology.png') });
});

test('Sessions Design resolves overlapping lines, self-crossing cubics and tangent contacts', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }),
		properties = page.locator('[data-part="auxiliarybar"]'),
		viewport = canvas.locator('.ash-canvas-viewport');
	const nodes = properties.getByRole('combobox', { name: 'Path node', exact: true }),
		segments = properties.getByRole('combobox', { name: 'Network segment', exact: true });
	const draw = async (points: { x: number; y: number }[], closed = false): Promise<void> => {
		await canvas.press('p');
		for (const position of points) {
			await viewport.click({ position });
		}
		if (!closed) {
			await canvas.press('Enter');
		}
		await canvas.press('v');
		await canvas.press('Tab');
		await canvas.press('Enter');
	};
	const field = async (name: string, value: string): Promise<void> => {
		const input = properties.getByRole('spinbutton', { name, exact: true });
		await input.fill(value);
		await input.press('Tab');
	};
	await draw([
		{ x: 100, y: 150 },
		{ x: 300, y: 150 },
		{ x: 200, y: 150 },
		{ x: 400, y: 150 },
	]);
	await properties.getByRole('button', { name: 'Add intersection nodes', exact: true }).click();
	await expect(nodes.locator('option')).toHaveCount(4);
	await expect(segments.locator('option')).toHaveCount(3);
	await canvas.press('Escape');
	await canvas.press('Delete');
	await draw([
		{ x: 120, y: 180 },
		{ x: 320, y: 180 },
	]);
	await properties.getByRole('button', { name: 'Convert to vector network', exact: true }).click();
	for (const [name, value] of [
		['Segment start handle X', '200'],
		['Segment start handle Y', '200'],
		['Segment end handle X', '-200'],
		['Segment end handle Y', '200'],
	]) {
		await field(name, value);
	}
	await properties.getByRole('button', { name: 'Add intersection nodes', exact: true }).click();
	await expect(nodes.locator('option')).toHaveCount(4);
	await expect(segments.locator('option')).toHaveCount(4);
	await canvas.press('ControlOrMeta+z');
	await expect(nodes.locator('option')).toHaveCount(2);
	await canvas.press('Escape');
	await canvas.press('Delete');
	await draw(
		[
			{ x: 100, y: 100 },
			{ x: 300, y: 100 },
			{ x: 300, y: 300 },
			{ x: 100, y: 300 },
			{ x: 100, y: 100 },
		],
		true,
	);
	await properties.getByRole('button', { name: 'Convert to vector network', exact: true }).click();
	const anchors = canvas.locator('.ash-sessions-design-path-handle[data-path-point="anchor"]');
	await anchors.nth(0).click();
	await anchors.nth(2).click({ modifiers: ['Shift'] });
	await properties.getByRole('button', { name: 'Connect selected nodes', exact: true }).click();
	await expect(segments.locator('option')).toHaveCount(5);
	await anchors.nth(1).click();
	await anchors.nth(3).click({ modifiers: ['Shift'] });
	await properties.getByRole('button', { name: 'Connect selected nodes', exact: true }).click();
	await expect(nodes.locator('option')).toHaveCount(5);
	await expect(segments.locator('option')).toHaveCount(8);
	await canvas.press('ControlOrMeta+z');
	await expect(nodes.locator('option')).toHaveCount(4);
	await expect(segments.locator('option')).toHaveCount(5);
	await canvas.press('ControlOrMeta+z');
	await expect(segments.locator('option')).toHaveCount(4);
	await field('Segment start handle Y', String(800 / 3));
	await field('Segment end handle Y', String(800 / 3));
	await properties.getByRole('button', { name: 'Add intersection nodes', exact: true }).click();
	await expect(nodes.locator('option')).toHaveCount(5);
	await expect(segments.locator('option')).toHaveCount(6);
	await canvas.press('ControlOrMeta+z');
	await expect(nodes.locator('option')).toHaveCount(4);
	await field('Segment start handle Y', '400');
	await field('Segment end handle Y', '400');
	await properties.getByRole('button', { name: 'Add intersection nodes', exact: true }).click();
	await expect(nodes.locator('option')).toHaveCount(6);
	await expect(segments.locator('option')).toHaveCount(8);
	if (target.kind === 'browser') {
		await reopenOutlinedDesign(page, 'curve-intersections.ash-design');
		await canvas.press('Tab');
		await expect(nodes.locator('option')).toHaveCount(6);
		await expect(segments.locator('option')).toHaveCount(8);
	}
});

test('Sessions Design converts shaped variable-font text to editable outlines and restores text with undo', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }),
		properties = page.locator('[data-part="auxiliarybar"]');
	await canvas.press('t');
	await canvas.locator('.ash-canvas-viewport').click({ position: { x: 160, y: 160 } });
	await page.keyboard.press('Escape');
	const content = properties.getByRole('textbox', { name: 'Text content', exact: true });
	await content.fill('office AV\nB8');
	await content.press('Tab');
	const family = properties.getByRole('combobox', { name: 'Font family', exact: true });
	await family.fill('Noto Sans');
	await family.press('Tab');
	await properties.getByLabel('Font file for outlines', { exact: true }).setInputFiles('test/smoke/fixtures/design-fonts/NotoSans.ttf');
	await expect(properties.getByRole('status').filter({ hasText: 'Font loaded.' })).toBeVisible();
	const ink = await canvas
		.locator('[data-text-paragraph]')
		.first()
		.evaluate(element => {
			const span = element.querySelector('span')!,
				style = getComputedStyle(span),
				node = span.firstChild!;
			const range = document.createRange();
			range.selectNodeContents(node);
			const rect = range.getBoundingClientRect();
			const context = document.createElement('canvas').getContext('2d')!;
			context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const metrics = context.measureText(node.textContent!);
			return {
				left: rect.left - metrics.actualBoundingBoxLeft,
				top: rect.top + metrics.fontBoundingBoxAscent - metrics.actualBoundingBoxAscent,
				width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
			};
		});
	await canvas.press('Alt+Shift+f');
	await expect(canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]')).toHaveCount(1);
	const outlineBox = await canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]').boundingBox();
	expect(Math.abs(outlineBox!.x - ink.left)).toBeLessThan(1);
	expect(Math.abs(outlineBox!.y - ink.top)).toBeLessThan(1);
	expect(Math.abs(outlineBox!.width - ink.width)).toBeLessThan(1);
	await expect(canvas.locator('[data-design-text]')).toHaveCount(0);
	const path = canvas.locator('.ash-sessions-design-shapes > path[data-shape-id]');
	expect(await path.evaluate(element => (element as SVGPathElement).getTotalLength())).toBeGreaterThan(100);
	await expect(properties.getByRole('button', { name: 'Edit vector', exact: true })).toBeVisible();
	await canvas.press('ArrowRight');
	await canvas.press('ControlOrMeta+z');
	await canvas.press('ControlOrMeta+z');
	await expect(content).toHaveValue('office AV\nB8');
	await canvas.press('ControlOrMeta+Alt+o');
	const glyphs = canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id] > path[data-shape-id]');
	await expect(glyphs).toHaveCount(8);
	expect(await glyphs.first().evaluate(element => (element as SVGPathElement).getBBox().width)).toBeLessThan(30); // ffi forms one glyph; spaces and line breaks have no outlines.
	await canvas.press('ControlOrMeta+z');
	await expect(content).toHaveValue('office AV\nB8');
	await content.fill('q\u0301q\u0301');
	await content.press('Tab');
	await canvas.press('ControlOrMeta+Alt+o');
	await expect(glyphs).toHaveCount(4);
	const untracked = await glyphs.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
	await canvas.press('ControlOrMeta+z');
	const tracking = properties.getByRole('spinbutton', { name: 'Letter spacing', exact: true });
	await tracking.fill('20');
	await tracking.press('Tab');
	await canvas.press('ControlOrMeta+Alt+o');
	await expect(glyphs).toHaveCount(4);
	const tracked = await glyphs.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
	// Tracking separates grapheme clusters, while each acute stays attached to its base glyph.
	expect(Math.abs(tracked[1] - tracked[0] - (untracked[1] - untracked[0]))).toBeLessThan(0.1);
	expect(Math.abs(tracked[3] - tracked[2] - (untracked[3] - untracked[2]))).toBeLessThan(0.1);
	expect(Math.abs(tracked[2] - tracked[0] - (untracked[2] - untracked[0]) - 20)).toBeLessThan(0.1);
	await canvas.press('ControlOrMeta+z');
	await tracking.fill('0');
	await tracking.press('Tab');
	await content.fill('Aa0');
	await content.press('Tab');
	await properties
		.locator('summary')
		.filter({ hasText: /^Type details$/u })
		.click();
	const features = properties.getByRole('textbox', { name: 'OpenType features', exact: true });
	await features.fill('aalt=1');
	await features.press('Tab');
	await properties.getByRole('button', { name: 'Flatten selection', exact: true }).click();
	await expect(path).toHaveCount(1);
	const firstAlternate = await path.getAttribute('d');
	await canvas.press('ControlOrMeta+z');
	await features.fill('aalt=2');
	await features.press('Tab');
	await properties.getByRole('button', { name: 'Flatten selection', exact: true }).click();
	await expect(path).not.toHaveAttribute('d', firstAlternate!);
	await page.evaluate(() => document.fonts.clear());
	if (target.kind === 'browser') {
		const before = await path.getAttribute('d');
		await reopenOutlinedDesign(page, 'alternate-outlines.ash-design');
		await expect(path).toHaveAttribute('d', before!);
	}
	await page.screenshot({ path: testInfo.outputPath('design-text-outlines.png') });
});

async function reopenOutlinedDesign(page: Page, name: string, application?: PlaywrightApplication, filePath?: string): Promise<void> {
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	if (application && 'windows' in application) {
		if (!filePath) throw new Error('Desktop persistence requires a test-owned path');
		// Replace the OS choice; save, reopen and document decoding still use the real host.
		await application.evaluate(({ dialog }, path) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, filePath);
	} else {
		await page.evaluate(async () => {
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(`ash-outline-${crypto.randomUUID()}`, { create: true });
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		});
	}
	await clickCanvasMenu(canvas, 'Save a copy', application);
	if (!application || !('windows' in application)) {
		const dialog = page.getByRole('dialog', { name: 'Save a copy', exact: true });
		await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill(name);
		await dialog.getByRole('button', { name: 'OK', exact: true }).click();
	}
	await expect(canvas.locator('.ash-sessions-design-message')).toHaveText(`Saved ${name}`);
	await canvas.press('Escape');
	await clickCanvasMenu(canvas, 'Open design', application);
	if (!application || !('windows' in application)) await page.locator('.ash-quick-pick-row-label').getByText(name, { exact: true }).click();
	await expect(canvas.locator('.ash-sessions-design-message')).toHaveText(`Opened ${name}`);
}

test('Sessions Design keeps rich outline colors, truncation and font failures atomic across save and reopen', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }),
		properties = page.locator('[data-part="auxiliarybar"]');
	await page.evaluate(() =>
		Object.defineProperty(window, 'queryLocalFonts', {
			configurable: true,
			value: async () => {
				throw new DOMException('Denied', 'NotAllowedError');
			},
		}),
	);
	await canvas.press('t');
	await canvas.locator('.ash-canvas-viewport').click({ position: { x: 160, y: 160 } });
	await page.keyboard.press('Escape');
	const content = properties.getByRole('textbox', { name: 'Text content', exact: true });
	await content.fill('AB');
	await content.press('Tab');
	await properties.getByRole('button', { name: 'Flatten selection', exact: true }).click();
	await expect(properties.getByRole('status').filter({ hasText: 'Allow local font access' })).toBeVisible();
	await expect(content).toHaveValue('AB');
	const family = properties.getByRole('combobox', { name: 'Font family', exact: true });
	await family.fill('Noto Sans');
	await family.press('Tab');
	await properties.getByLabel('Font file for outlines', { exact: true }).setInputFiles('test/smoke/fixtures/design-fonts/NotoSans.ttf');
	await expect(properties.getByRole('status').filter({ hasText: 'Font loaded.' })).toBeVisible();
	const weight = properties.getByRole('spinbutton', { name: 'Font weight', exact: true });
	await weight.fill('650');
	await weight.press('Tab');
	await canvas.press('Enter');
	await expect(canvas.getByRole('textbox', { name: 'Edit text', exact: true })).toBeFocused();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('Shift+ArrowRight');
	await expect(properties.getByText('1 characters selected', { exact: true })).toBeVisible();
	const color = properties.getByRole('textbox', { name: 'Text color', exact: true });
	await color.fill('#cc2200');
	await color.press('Tab');
	await canvas.press('Escape');
	await canvas.press('Tab');
	await properties.getByRole('button', { name: 'Flatten selection', exact: true }).click();
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path[fill="#cc2200"]')).toHaveCount(1);
	await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path[fill="#808080"]')).toHaveCount(1);
	if (target.kind === 'browser') {
		await reopenOutlinedDesign(page, 'outlined-text.ash-design');
		await expect(canvas.locator('.ash-sessions-design-shapes > g[data-shape-id] > path[fill="#cc2200"]')).toHaveCount(1);
	}
	await canvas.press('Escape');
	await canvas.press('t');
	await canvas.locator('.ash-canvas-viewport').click({ position: { x: 160, y: 260 } });
	await page.keyboard.press('Escape');
	await content.fill('office office office office');
	await content.press('Tab');
	await family.fill('Noto Sans');
	await family.press('Tab');
	await properties.getByRole('combobox', { name: 'Text resizing', exact: true }).selectOption('none');
	for (const [label, value] of [
		['Width', '120'],
		['Height', '50'],
	]) {
		const field = properties.getByRole('spinbutton', { name: label, exact: true });
		await field.fill(value);
		await field.press('Tab');
	}
	await properties
		.locator('summary')
		.filter({ hasText: /^Type details$/u })
		.click();
	await properties.getByRole('checkbox', { name: 'Truncate text', exact: true }).check();
	await properties.getByRole('button', { name: 'Outline stroke', exact: true }).click();
	await expect(page.getByRole('treeitem', { name: '…', exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('design-rich-text-outlines.png') });
});

test(
	'Sessions Design stacks shadow and blur effects with cutouts, spread, undo and persistence',
	{ tag: ['@browser-ui', '@browser-app-server', '@electron-app-server'] },
	async ({ application, target, workbench, testWorkspace }, testInfo) => {
		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
		await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
		const canvas = page.getByRole('region', { name: 'Design canvas', exact: true }),
			properties = page.locator('[data-part="auxiliarybar"]');
		const field = async (name: string, value: string): Promise<void> => {
			const input = properties.getByRole('spinbutton', { name, exact: true });
			await input.fill(value);
			await input.press('Tab');
		};
		const action = (name: string) => properties.getByRole('button', { name, exact: true }).click();
		const color = async (value: string): Promise<void> => {
			const input = properties.getByRole('textbox', { name: 'Shadow color', exact: true });
			await input.fill(value);
			await input.press('Tab');
		};
		await canvas.press('r');
		await field('X', '160');
		await field('Y', '160');
		await field('Width', '200');
		await field('Height', '140');
		await paintColor(page, '#ffffff00');
		await action('Add effect');
		await field('Effect blur', '0');
		await field('Shadow X', '0');
		await field('Shadow Y', '0');
		await field('Shadow spread', '20');
		await color('#ff0000ff');
		const layer = canvas.locator('.ash-sessions-design-shapes > [data-shape-id]').last();
		const box = await layer.locator(':scope > rect').boundingBox();
		expect(box).toBeTruthy();
		const pixel = (x: number, y: number) => paintPixel(page, box!.x + x, box!.y + y);
		await expect.poll(async () => (await pixel(100, 70)).slice(0, 3).every(value => value >= 245)).toBe(true);
		await expect.poll(async () => (await pixel(-10, 70)).slice(0, 3)).toEqual([255, 0, 0]);
		await properties.getByRole('checkbox', { name: 'Show shadow behind transparent areas', exact: true }).check();
		await expect.poll(async () => (await pixel(100, 70)).slice(0, 3)).toEqual([255, 0, 0]);
		await action('Duplicate effect');
		await color('#0000ffff');
		await expect.poll(async () => (await pixel(-10, 70)).slice(0, 3)).toEqual([0, 0, 255]);
		await action('Move effect down');
		await expect.poll(async () => (await pixel(-10, 70)).slice(0, 3)).toEqual([255, 0, 0]);
		await action('Remove effect');
		await paintColor(page, '#ffffffff');
		await properties.getByRole('combobox', { name: 'Effect type', exact: true }).selectOption('inner-shadow');
		await field('Shadow spread', '12');
		await expect.poll(async () => (await pixel(8, 70)).slice(0, 3)).toEqual([255, 0, 0]);
		await expect.poll(async () => (await pixel(100, 70)).slice(0, 3)).toEqual([255, 255, 255]);
		await properties.getByRole('checkbox', { name: 'Effect visible', exact: true }).uncheck();
		await expect.poll(async () => (await pixel(8, 70)).slice(0, 3)).toEqual([255, 255, 255]);
		await canvas.press('ControlOrMeta+z');
		await expect(properties.getByRole('checkbox', { name: 'Effect visible', exact: true })).toBeChecked();
		await action('Add effect');
		await properties.getByRole('combobox', { name: 'Effect type', exact: true }).selectOption('layer-blur');
		await field('Effect blur', '16');
		await expect
			.poll(async () => {
				const value = await pixel(8, 70);
				return value[1] > 20 && value[1] < 180;
			})
			.toBe(true);
		await expect(properties.getByRole('button', { name: 'Duplicate effect', exact: true })).toBeDisabled();
		await action('Add effect');
		await properties.getByRole('combobox', { name: 'Effect type', exact: true }).selectOption('background-blur');
		await action('Add effect');
		await expect(properties.getByRole('combobox', { name: 'Effect', exact: true }).locator('option')).toHaveCount(4);
		await reopenOutlinedDesign(page, 'Effects stack.ash-design', application, join(await realpath(testWorkspace.directory), 'Effects stack.ash-design'));
		await canvas.press('ControlOrMeta+a');
		await expect(properties.getByRole('combobox', { name: 'Effect', exact: true }).locator('option')).toHaveCount(4);
		await page.screenshot({ path: testInfo.outputPath('design-effects-stack.png') });
	},
);

for (const type of ['layer-blur', 'background-blur'] as const) {
	test(
		`Sessions Design progressive ${type} interpolates pixels and preserves editing, persistence and export`,
		{ tag: ['@browser-ui', '@browser-app-server', '@electron-app-server'] },
		async ({ application, target, workbench, testWorkspace }, testInfo) => {
			const page = await workbench.openAgentsWindow(target.kind);
			await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
			await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
			const canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
			const properties = page.locator('[data-part="auxiliarybar"]');
			const field = async (name: string, value: string): Promise<void> => {
				const input = properties.getByRole('spinbutton', { name, exact: true });
				await input.fill(value);
				await input.press('Tab');
			};
			const add = async (width: number, color: string): Promise<void> => {
				await canvas.press('r');
				await field('X', '100');
				await field('Y', '100');
				await field('Width', String(width));
				await field('Height', '240');
				await paintColor(page, color);
			};
			await add(360, '#ffffff');
			await field('X', '40');
			await field('Y', '40');
			await field('Height', '360');
			await add(120, '#000000');
			if (type === 'background-blur') {
				await add(240, '#ffffff00');
			}
			const name = properties.getByRole('textbox', { name: 'Layer name', exact: true });
			await name.fill('Progressive blur');
			await name.press('Tab');
			await properties.getByRole('button', { name: 'Add effect', exact: true }).click();
			await properties.getByRole('combobox', { name: 'Effect type', exact: true }).selectOption(type);
			await properties.getByRole('combobox', { name: 'Blur mode', exact: true }).selectOption('progressive');
			await field('End blur', '24');
			await field('Blur start Y (%)', '25');
			await field('Blur end Y (%)', '75');
			const layer = canvas.locator('.ash-sessions-design-shapes > [data-shape-id]').last();
			const box = await layer.locator('rect').last().boundingBox();
			expect(box).toBeTruthy();
			const pixel = (x: number, y: number) => paintPixel(page, box!.x + x, box!.y + y);
			await expect.poll(async () => (await pixel(112, 40))[0]).toBeLessThan(3);
			await expect.poll(async () => (await pixel(112, 200))[0]).toBeGreaterThan(50);
			const values: number[] = [];
			for (const y of [80, 100, 120, 140, 160]) {
				values.push((await pixel(112, y))[0]);
			}
			for (let index = 1; index < values.length; index++) {
				expect(values[index]).toBeGreaterThan(values[index - 1]);
			}
			const blurred = (await pixel(112, 200))[0];
			if (type === 'layer-blur') {
				await paintColor(page, '#00000080');
				for (const y of [80, 100, 120, 140, 160]) {
					const alpha = (await pixel(40, y))[0];
					expect(alpha).toBeGreaterThanOrEqual(126);
					expect(alpha).toBeLessThanOrEqual(130);
				}
				await paintColor(page, '#000000ff');
				await field('Rotation', '90');
				await expect.poll(async () => (await pixel(140, 172))[0]).toBeLessThan(3);
				await expect.poll(async () => Math.abs((await pixel(-20, 172))[0] - blurred)).toBeLessThanOrEqual(3);
				await field('Rotation', '0');
			}
			// Reversing both radii and endpoints leaves the field unchanged.
			await field('Start blur', '24');
			await field('End blur', '0');
			await field('Blur start Y (%)', '75');
			await field('Blur end Y (%)', '25');
			await expect.poll(async () => Math.abs((await pixel(112, 200))[0] - blurred)).toBeLessThanOrEqual(2);
			// A constant field must match uniform blur exactly.
			await field('End blur', '24');
			const equal = (await pixel(112, 120))[0];
			await properties.getByRole('combobox', { name: 'Blur mode', exact: true }).selectOption('uniform');
			await expect.poll(async () => Math.abs((await pixel(112, 120))[0] - equal)).toBeLessThanOrEqual(1);
			await canvas.press('ControlOrMeta+z');
			await field('Start blur', '0');
			await field('Blur start Y (%)', '25');
			await field('Blur end Y (%)', '75');
			await properties.getByRole('button', { name: 'Edit blur on canvas', exact: true }).click();
			const end = canvas.locator('[data-blur-handle="end"]');
			const endpoint = await end.boundingBox();
			expect(endpoint).toBeTruthy();
			await page.mouse.move(endpoint!.x + endpoint!.width / 2, endpoint!.y + endpoint!.height / 2);
			await page.mouse.down();
			await page.mouse.move(endpoint!.x + endpoint!.width / 2 + 24, endpoint!.y + endpoint!.height / 2 + 24);
			await page.mouse.up();
			await expect(properties.getByRole('spinbutton', { name: 'Blur end Y (%)', exact: true })).toHaveValue('85');
			await canvas.press('ControlOrMeta+z');
			await expect(properties.getByRole('spinbutton', { name: 'Blur end Y (%)', exact: true })).toHaveValue('75');
			await canvas.press('ArrowDown');
			await canvas.press('ControlOrMeta+z');
			await canvas.press('Escape');
			await expect(end).toHaveCount(0);
			await field('Blur start X (%)', '-50');
			await field('Blur end X (%)', '-50');
			await reopenOutlinedDesign(page, `Progressive ${type}.ash-design`, application, join(await realpath(testWorkspace.directory), `Progressive ${type}.ash-design`));
			await page.getByRole('tree', { name: 'Layers', exact: true }).getByRole('treeitem', { name: 'Progressive blur', exact: true }).click();
			await expect(properties.getByRole('combobox', { name: 'Blur mode', exact: true })).toHaveValue('progressive');
			await expect(properties.getByRole('spinbutton', { name: 'Blur start X (%)', exact: true })).toHaveValue('-50');
			await expect.poll(async () => Math.abs((await pixel(112, 200))[0] - blurred)).toBeLessThanOrEqual(2);
			await page.screenshot({ path: testInfo.outputPath(`progressive-${type}.png`) });
			if (type === 'background-blur') {
				await canvas.press('ControlOrMeta+d');
				await field('X', '100');
				await field('Y', '100');
				await expect.poll(async () => Math.abs((await pixel(112, 200))[0] - blurred)).toBeLessThanOrEqual(2);
			}
			const exportPath = join(await realpath(testWorkspace.directory), 'progressive.svg');
			if ('windows' in application)
				await application.evaluate(({ dialog }, path) => {
					dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
				}, exportPath);
			await clickCanvasMenu(canvas, 'Export SVG', application);
			if (!('windows' in application)) {
				const exportDialog = page.getByRole('dialog', { name: 'Export SVG', exact: true });
				await exportDialog.getByRole('textbox', { name: 'File name, field 1' }).fill('progressive.svg');
				await exportDialog.getByRole('button', { name: 'OK', exact: true }).click();
			}
			await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Exported progressive.svg');
			const svg =
				target.appServerMode === 'required'
					? await readFile(exportPath, 'utf8')
					: await page.evaluate(async () => {
							const folder = await (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
							return (await (await folder.getFileHandle('progressive.svg')).getFile()).text();
						});

			await canvas.getByRole('button', { name: 'Code', exact: true }).click();
			const code = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
			let preview: Page;
			if ('windows' in application) {
				const opened = application.waitForEvent('window');
				await application.evaluate(async ({ BrowserWindow }) => {
					const window = new BrowserWindow({
						show: false,
						width: 800,
						height: 600,
						webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
					});
					await window.loadURL('about:blank');
				});
				preview = await opened;
			} else {
				preview = await page.context().newPage();
			}
			try {
				await preview.setContent(code);
				const exported = await preview.locator('[data-design-kind="rectangle"]').last().boundingBox();
				expect(exported).toBeTruthy();
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
				const imageBox = await preview.locator('img').boundingBox();
				expect(imageBox).toBeTruthy();
				await expect.poll(async () => Math.abs((await paintPixel(preview, imageBox!.x + 212 - svgBounds[0], imageBox!.y + 300 - svgBounds[1]))[0] - blurred)).toBeLessThanOrEqual(2);
				await preview.screenshot({ path: testInfo.outputPath(`progressive-${type}-svg.png`) });
			} finally {
				await preview.close();
			}
		},
	);
}

test('Sessions Design automatically retains an untitled draft across window reopen without save confirmation', async ({ target, workbench, application }, testInfo) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	let canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await expect(page.locator('.ash-creator-header')).toBeHidden();
	await expect(page.locator('[data-creator-mode="design"] .ash-creator-workspace-actions')).toHaveCount(0);
	// Removed tabs, controls and the footer reserve no space around the canvas.
	await expect
		.poll(async () => {
			const editor = await page.locator('[data-part="editor"]').boundingBox();
			const canvasBounds = await canvas.locator('.ash-canvas-viewport').boundingBox();
			return Math.max(Math.abs(canvasBounds!.y - editor!.y), Math.abs(canvasBounds!.y + canvasBounds!.height - editor!.y - editor!.height));
		})
		.toBeLessThanOrEqual(2);
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
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	const design = page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true });
	if (await design.isVisible()) {
		await design.click();
	}
	canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await expect(canvas.locator('.ash-sessions-design-shapes > rect[data-shape-id]')).toHaveAttribute('data-shape-id', id!);
	await expect(canvas).not.toHaveClass(/\bdirty\b/u);
	await canvas.press('Tab');
	await canvas.press('ArrowRight');
	const movedX = await canvas.locator('.ash-sessions-design-shapes > rect[data-shape-id]').getAttribute('x');
	if (target.kind === 'browser') {
		await expect(canvas).not.toHaveClass(/\bdirty\b/u);
	}
	page = await workbench.reopenAgentsWindow(application, page);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	const reopenDesign = page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true });
	if (await reopenDesign.isVisible()) {
		await reopenDesign.click();
	}
	canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await expect(canvas.locator('.ash-sessions-design-shapes > rect[data-shape-id]')).toHaveAttribute('x', movedX!);
	await expect(page.getByRole('dialog')).toHaveCount(0);
	if ('windows' in application) {
		const profile = await application.evaluate(() => process.env.ASH_HOME!);
		const drafts = join(profile, 'creator');
		const manifests = (await readdir(drafts, { recursive: true })).filter(path => path.endsWith('manifest.json'));
		expect(manifests).toHaveLength(1);
		const saved = JSON.parse(await readFile(join(drafts, manifests[0]), 'utf8')) as {
			artifacts: Record<string, { objects: Record<string, { x: number }> }>;
		};
		expect(Object.values(saved.artifacts).map(artifact => artifact.objects[id!])).toContainEqual(expect.objectContaining({ x: Number(movedX) }));
	}
	await page.screenshot({ path: testInfo.outputPath('design-restored-after-close.png') });
});

test('Sessions Design color widgets edit page backgrounds and fills and restore them after closing', async ({ application, target, workbench }, testInfo) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	let properties = page.locator('[data-part="auxiliarybar"]');
	let canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await expect(properties.locator('.ash-design-page-name, .ash-design-page-summary')).toHaveCount(0);
	const background = properties.getByRole('textbox', { name: 'Page background color', exact: true });
	await background.fill('E8EEF6');
	await background.press('Enter');
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
	await color.fill('invalid');
	await color.press('Enter');
	await expect(color).toHaveAttribute('aria-invalid', 'true');
	await color.fill('2F6FED');
	await color.press('Enter');
	const opacity = properties.getByRole('spinbutton', { name: 'Fill opacity (%)', exact: true });
	await opacity.fill('40');
	await opacity.press('Enter');
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('fill', '#2f6fed66');
	const widget = color.locator('..');
	await widget.scrollIntoViewIfNeeded();
	await expect.poll(() => widget.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
	await page.screenshot({ path: testInfo.outputPath('fill-color-widget.png') });
	if (target.kind === 'browser') {
		await expect(canvas).not.toHaveClass(/\bdirty\b/u);
	}
	page = await workbench.reopenAgentsWindow(application, page);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	const design = page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true });
	if (await design.isVisible()) {
		await design.click();
	}
	canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	properties = page.locator('[data-part="auxiliarybar"]');
	await expect(properties.getByRole('textbox', { name: 'Page background color', exact: true })).toHaveValue('E8EEF6');
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('fill', '#2f6fed66');
	await expect(canvas.locator('.ash-canvas-viewport')).toHaveCSS('background-color', 'rgb(232, 238, 246)');
});
