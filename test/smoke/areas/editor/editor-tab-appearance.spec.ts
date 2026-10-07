import type { Locator } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

async function expectTabActionCentered(item: Locator): Promise<void> {
	const geometry = await item.evaluate(element => {
		const tab = element.getBoundingClientRect();
		const button = element.querySelector('.ash-tab-primary-action button')!.getBoundingClientRect();
		const icon = element.querySelector('.ash-tab-primary-action button svg')!.getBoundingClientRect();
		return {
			buttonOffsetY: button.top + button.height / 2 - tab.top - tab.height / 2,
			iconOffsetX: icon.left + icon.width / 2 - button.left - button.width / 2,
			iconOffsetY: icon.top + icon.height / 2 - button.top - button.height / 2,
		};
	});
	expect(geometry.buttonOffsetY).toBeCloseTo(0, 2);
	expect(geometry.iconOffsetX).toBeCloseTo(0, 2);
	expect(geometry.iconOffsetY).toBeCloseTo(0, 2);
}

test('editor tab width settings resize existing tabs and persist after reload', async ({ workbench, reloadWorkbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await page.keyboard.press('ControlOrMeta+N');
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	await expect(group.tabs).toHaveCount(2);
	const first = group.tabs.filter({ hasText: 'Untitled-1' });
	const id = await first.getAttribute('id');
	const widths = async () => group.title.locator('.ash-tab').evaluateAll(tabs => tabs.map(tab => Math.round(tab.getBoundingClientRect().width * 100) / 100));
	const fitWidths = await widths();
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectEditorCategory('editor-opening');
	const settings = page.locator('.ash-settings-editor');
	await settings.getByRole('searchbox', { name: 'Search settings' }).fill('workbench.editor.tabSizing');
	const select = settings.locator('[data-configuration-key="workbench.editor.tabSizing"]').getByRole('combobox');
	const min = settings.locator('[data-configuration-key="workbench.editor.tabSizingFixedMinWidth"]');
	const max = settings.locator('[data-configuration-key="workbench.editor.tabSizingFixedMaxWidth"]');
	await expect(select).toContainText('Fit');
	await expect(min).toHaveValue('50');
	await expect(max).toHaveValue('160');
	await select.click();
	await page.getByRole('option', { name: 'Fixed', exact: true }).click();
	await expect.poll(widths).toEqual([160, 160]);
	await min.fill('90');
	await min.press('Tab');
	await max.fill('220');
	await max.press('Tab');
	await expect.poll(widths).toEqual([220, 220]);
	await max.fill('120');
	await max.press('Tab');
	await expect.poll(widths).toEqual([120, 120]);
	await max.fill('120.5');
	await max.press('Tab');
	await expect.poll(widths).toEqual([120.5, 120.5]);
	await max.fill('120');
	await max.press('Tab');
	await min.fill('150');
	await min.press('Tab');
	await expect.poll(widths).toEqual([150, 150]);
	await min.fill('90');
	await min.press('Tab');
	await expect.poll(widths).toEqual([120, 120]);
	for (const mode of ['Shrink', 'Fit']) {
		await select.click();
		await page.getByRole('option', { name: mode, exact: true }).click();
		await expect(first).toHaveAttribute('id', id!);
	}
	await expect.poll(widths).toEqual(fitWidths);
	await select.click();
	await page.getByRole('option', { name: 'Fixed', exact: true }).click();
	await page.locator('.ash-modal-editor-close').click();
	await first.focus();
	await first.press('Tab');
	const item = group.title.locator('.ash-tab').filter({ has: page.getByRole('tab', { name: 'Untitled-1', exact: true }) });
	const close = item.locator('.ash-tab-primary-action button');
	await expect(close).toBeFocused();
	await close.hover();
	await expectTabActionCentered(item);
	await expect.poll(widths).toEqual([120, 120]);
	const restored = await reloadWorkbench();
	await restored.workbench.settingsEditor.openUserSettingsUI();
	await restored.workbench.settingsEditor.selectEditorCategory('editor-opening');
	const restoredSettings = restored.workbench.page.locator('.ash-settings-editor');
	await restoredSettings.getByRole('searchbox', { name: 'Search settings' }).fill('workbench.editor.tabSizing');
	await expect(restoredSettings.locator('[data-configuration-key="workbench.editor.tabSizing"]').getByRole('combobox')).toContainText('Fixed');
	await expect(restoredSettings.locator('[data-configuration-key="workbench.editor.tabSizingFixedMinWidth"]')).toHaveValue('90');
	await expect(restoredSettings.locator('[data-configuration-key="workbench.editor.tabSizingFixedMaxWidth"]')).toHaveValue('120');
	await restored.workbench.page.locator('.ash-modal-editor-close').click();
	await restored.workbench.page.keyboard.press('ControlOrMeta+N');
	await expect.poll(() => restored.workbench.editors.groupAt(0).title.locator('.ash-tab').last().evaluate(tab => Math.round(tab.getBoundingClientRect().width * 100) / 100)).toBe(120);
});

test('editor pill style includes the action in tab width and survives reload', async ({ workbench, reloadWorkbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	const tab = group.tabs.filter({ hasText: 'Untitled-1' });
	const item = group.title.locator('.ash-tab').filter({ has: page.getByRole('tab', { name: 'Untitled-1', exact: true }) });
	const close = item.locator('.ash-tab-primary-action button');
	const id = await tab.getAttribute('id');
	const geometry = async () => item.evaluate(element => {
		const bounds = element.getBoundingClientRect();
		const label = element.querySelector<HTMLElement>('.ash-tab-label')!;
		const action = element.querySelector<HTMLElement>('.ash-tab-primary-action button')!.getBoundingClientRect();
		const style = getComputedStyle(element);
		return {
			width: bounds.width, labelRight: label.getBoundingClientRect().right, actionLeft: action.left,
			actionWidth: action.width, rightInset: bounds.right - action.right,
			topRadius: style.borderTopLeftRadius, bottomRadius: style.borderBottomLeftRadius,
			labelOverlay: getComputedStyle(label, '::after').content,
			textOverflow: getComputedStyle(label.querySelector('.ash-icon-label-text')!).textOverflow,
		};
	});
	await expect(tab).toBeVisible();
	const initialWidth = (await geometry()).width;
	for (const option of ['Pill', 'Connected', 'Pill']) {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectEditorCategory('editor-opening');
		const settings = page.locator('.ash-settings-editor');
		await settings.getByRole('searchbox', { name: 'Search settings' }).fill('workbench.experimental.modernUIEditorTabStyle');
		const select = settings.locator('[data-configuration-key="workbench.experimental.modernUIEditorTabStyle"]').getByRole('combobox');
		await select.click();
		await page.getByRole('option', { name: option, exact: true }).click();
		await expect(select).toContainText(option);
		await page.locator('.ash-modal-editor-close').click();
		await expect(group.title.locator('.ash-ordinary-editor-tabs-row')).toHaveClass(option === 'Connected' ? /ash-connected-editor-tabs/u : /^(?!.*ash-connected-editor-tabs)/u);
		await expect(tab).toHaveAttribute('id', id!);
		const bounds = await geometry();
		await expectTabActionCentered(item);
		expect(bounds).toMatchObject({ width: initialWidth, actionWidth: 22, labelOverlay: 'none', textOverflow: 'ellipsis' });
		expect(bounds.rightInset).toBeCloseTo(2, 2);
		expect(bounds.labelRight).toBeLessThanOrEqual(bounds.actionLeft);
		expect(bounds.bottomRadius).toBe(option === 'Connected' ? '0px' : bounds.topRadius);
	}
	for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Light', 'Ash High Contrast Dark']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = page.locator('.ash-quick-pick').getByRole('combobox');
		await picker.fill(theme);
		await picker.press('Enter');
		await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
		await close.hover();
		expect((await geometry()).width).toBe(initialWidth);
		await expectTabActionCentered(item);
		await tab.focus();
		await tab.press('Tab');
		await expect(close).toBeFocused();
		expect((await geometry()).width).toBe(initialWidth);
		await expectTabActionCentered(item);
	}
	await page.keyboard.press('ControlOrMeta+N');
	await group.editor.input.focus();
	await page.mouse.move(0, 0);
	await expect(close).toBeHidden();
	const hiddenWidth = (await geometry()).width;
	await tab.hover();
	await expect(close).toBeVisible();
	expect((await geometry()).width).toBe(hiddenWidth);
	await expectTabActionCentered(item);
	const restored = await reloadWorkbench();
	await restored.workbench.settingsEditor.openUserSettingsUI();
	await restored.workbench.settingsEditor.selectEditorCategory('editor-opening');
	const settings = restored.workbench.page.locator('.ash-settings-editor');
	await settings.getByRole('searchbox', { name: 'Search settings' }).fill('workbench.experimental.modernUIEditorTabStyle');
	await expect(settings.locator('[data-configuration-key="workbench.experimental.modernUIEditorTabStyle"]').getByRole('combobox')).toContainText('Pill');
	await restored.workbench.page.locator('.ash-modal-editor-close').click();
	await restored.workbench.page.keyboard.press('ControlOrMeta+N');
	await expect(restored.workbench.editors.groupAt(0).title.locator('.ash-ordinary-editor-tabs-row')).not.toHaveClass(/ash-connected-editor-tabs/u);
});

test('unsaved tab indicators stay round and centered until the close button is hovered or focused', async ({ application, workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	const tab = group.tabs.filter({ hasText: 'Untitled-1' });
	const item = group.title.locator('.ash-tab').filter({ has: page.getByRole('tab', { name: /^Untitled-1(?:,|$)/u }) });
	const close = item.locator('.ash-tab-primary-action button');
	const icon = close.locator('svg');
	await group.editor.waitForEditorFocus();
	await expect(close).toBeVisible();
	const indicator = async () => close.evaluate(button => {
		const style = getComputedStyle(button, '::after');
		const bounds = button.getBoundingClientRect();
		const tabBounds = button.closest('.ash-tab')!.getBoundingClientRect();
		return {
			content: style.content,
			width: parseFloat(style.width),
			height: parseFloat(style.height),
			centerX: parseFloat(style.left) + parseFloat(style.marginLeft) + parseFloat(style.width) / 2,
			centerY: parseFloat(style.top) + parseFloat(style.marginTop) + parseFloat(style.height) / 2,
			buttonCenterX: bounds.width / 2,
			buttonCenterY: bounds.height / 2,
			buttonOffsetY: bounds.top + bounds.height / 2 - tabBounds.top - tabBounds.height / 2,
			radius: style.borderRadius,
			color: style.backgroundColor,
			foreground: getComputedStyle(button).color,
		};
	});
	expect((await indicator()).content).toBe('none');
	await page.keyboard.insertText('unsaved text');
	await expect(tab).toHaveAttribute('aria-label', /unsaved changes/u);
	for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Light', 'Ash High Contrast Dark']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = page.locator('.ash-quick-pick').getByRole('combobox');
		await picker.fill(theme);
		await picker.press('Enter');
		await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
		await group.editor.input.focus();
		await page.mouse.move(0, 0);
		await expect(icon).toBeHidden();
		const geometry = await indicator();
		expect(geometry).toMatchObject({ content: '""', width: 8, height: 8, radius: '50%' });
		expect(geometry.centerX).toBeCloseTo(geometry.buttonCenterX, 1);
		expect(geometry.centerY).toBeCloseTo(geometry.buttonCenterY, 1);
		expect(geometry.buttonOffsetY).toBeCloseTo(0, 2);
		expect(geometry.color).toBe(geometry.foreground);
		await tab.hover();
		await tab.focus();
		await expect(icon).toBeHidden();
		expect((await indicator()).content).toBe('""');
		await close.hover();
		await expect(icon).toBeVisible();
		await expect.poll(async () => (await indicator()).content).toBe('none');
		await expectTabActionCentered(item);
		await page.mouse.move(0, 0);
		await tab.focus();
		await tab.press('Tab');
		await expect(close).toBeFocused();
		await expect(icon).toBeVisible();
		expect((await indicator()).content).toBe('none');
		await expectTabActionCentered(item);
	}
	await page.keyboard.press('ControlOrMeta+N');
	await expect(tab).toHaveAttribute('aria-selected', 'false');
	await group.editor.input.focus();
	await page.mouse.move(0, 0);
	await expect(close).toBeVisible();
	await expect(icon).toBeHidden();
	expect((await indicator()).content).toBe('""');
	expect((await indicator()).buttonOffsetY).toBeCloseTo(0, 2);
	await tab.click();
	await group.editor.waitForEditorFocus();
	await close.hover();
	await expect(icon).toBeVisible();
	await workbench.dialogs.confirm(application, 'Save Changes', "Don't Save", () => close.click());
	await expect(tab).toHaveCount(0);
});

test('editor label format setting persists and keeps untitled tabs free of directory labels', async ({ workbench, reloadWorkbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const tab = workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled-1' });
	const tabId = await tab.getAttribute('id');
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectEditorCategory('editor-opening');
	const settings = page.locator('.ash-settings-editor');
	await settings.getByRole('searchbox', { name: 'Search settings' }).fill('workbench.editor.labelFormat');
	const setting = settings.locator('[data-configuration-key="workbench.editor.labelFormat"]');
	await expect(setting.getByRole('combobox')).toContainText('Default');
	for (const option of ['Parent Directory', 'Relative Path', 'Absolute Path']) {
		await setting.getByRole('combobox').click();
		await page.getByRole('option', { name: option, exact: true }).click();
		await expect(setting.getByRole('combobox')).toContainText(option);
		await expect(tab).toHaveAttribute('aria-label', 'Untitled-1');
		await expect(tab.locator('.ash-icon-label-description')).toBeHidden();
		await expect(tab).toHaveAttribute('id', tabId!);
	}
	await page.locator('.ash-modal-editor-close').click();
	const restored = await reloadWorkbench();
	await restored.workbench.settingsEditor.openUserSettingsUI();
	await restored.workbench.settingsEditor.selectEditorCategory('editor-opening');
	await restored.workbench.page.locator('.ash-settings-editor').getByRole('searchbox', { name: 'Search settings' }).fill('workbench.editor.labelFormat');
	await expect(restored.workbench.page.locator('[data-configuration-key="workbench.editor.labelFormat"]').getByRole('combobox')).toContainText('Absolute Path');
});

test.describe('File tab label format', () => {
	test.use({ openWorkspace: true });

	test('editor tabs keep complete filenames and scroll instead of shrinking', async ({ target, testWorkspace, workbench }) => {
		test.skip(target.kind === 'electron' && target.appServerMode === 'disabled', 'Desktop file access requires App Server');
		const page = workbench.page;
		const names = ['browser-foundation.md', '浏览器基础与依赖方向说明.md', ...Array.from({ length: 5 }, (_, index) => `browser-foundation-layout-and-editor-tab-width-regression-${index}.md`)];
		if (target.kind === 'browser' && target.appServerMode === 'disabled') {
			await page.evaluate(async filenames => {
				const root = await navigator.storage.getDirectory();
				const folder = await root.getDirectoryHandle('tab-width-files', { create: true });
				for (const name of filenames) {
					const file = await folder.getFileHandle(name, { create: true });
					const writer = await file.createWritable();
					await writer.write(`# ${name}`);
					await writer.close();
				}
				Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
			}, names);
			await workbench.quickaccess.runCommand('workbench.action.files.openFolderViaWorkspace');
		} else {
			await Promise.all(names.map(name => writeFile(join(testWorkspace.directory, name), `# ${name}`)));
		}
		await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
		await workbench.openExplorer();
		const group = workbench.editors.groupAt(0);
		const tab = group.element.getByRole('tab', { name: names[0]!, exact: true });
		const item = group.title.locator('.ash-tab').filter({ has: page.getByRole('tab', { name: names[0]!, exact: true }) });
		const geometry = async () => item.evaluate(element => {
			const label = element.querySelector<HTMLElement>('.ash-tab-label')!;
			const text = label.querySelector<HTMLElement>('.ash-icon-label-text')!;
			const range = document.createRange();
			range.selectNodeContents(text);
			const textBounds = range.getBoundingClientRect();
			const action = element.querySelector<HTMLElement>('.ash-tab-primary-action button')!.getBoundingClientRect();
			return {
				width: element.getBoundingClientRect().width, clipped: text.scrollWidth > text.clientWidth,
				textRight: textBounds.right, labelRight: label.getBoundingClientRect().right, actionLeft: action.left
			};
		});
		await page.locator('.ash-explorer').getByRole('treeitem', { name: names[0]!, exact: true }).dblclick();
		await expect(tab).toBeVisible();
		await expect.poll(async () => (await geometry()).clipped).toBe(false);
		const initialWidth = (await geometry()).width;
		for (const option of ['Pill', 'Connected']) {
			await workbench.settingsEditor.openUserSettingsUI();
			await workbench.settingsEditor.selectEditorCategory('editor-opening');
			const settings = page.locator('.ash-settings-editor');
			await settings.getByRole('searchbox', { name: 'Search settings' }).fill('workbench.experimental.modernUIEditorTabStyle');
			await settings.locator('[data-configuration-key="workbench.experimental.modernUIEditorTabStyle"]').getByRole('combobox').click();
			await page.getByRole('option', { name: option, exact: true }).click();
			await page.locator('.ash-modal-editor-close').click();
			const bounds = await geometry();
			await expectTabActionCentered(item);
			expect(bounds).toMatchObject({ width: initialWidth, clipped: false });
			expect(bounds.textRight).toBeLessThanOrEqual(bounds.labelRight);
			// Fractional display scaling can round the shared edge differently.
			expect(bounds.labelRight - bounds.actionLeft).toBeLessThan(0.01);
		}
		for (const name of names.slice(1)) {
			await page.locator('.ash-explorer').getByRole('treeitem', { name, exact: true }).dblclick();
			const label = group.element.getByRole('tab', { name, exact: true }).locator('.ash-icon-label-text');
			await expect(label).toHaveText(name);
			await expect.poll(() => label.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
			if (name.startsWith('browser-foundation-layout')) {
				expect(await label.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(180);
			}
		}
		await expect(group.tabs).toHaveCount(names.length);
		const viewport = group.title.locator('.ash-ordinary-editor-tabs-row .ash-scrollbar-viewport');
		await expect.poll(() => viewport.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
		await tab.focus();
		await expect(tab).toBeInViewport();
		const inactiveWidth = (await geometry()).width;
		await item.locator('.ash-tab-primary-action button').hover();
		await expectTabActionCentered(item);
		expect((await geometry()).width).toBe(inactiveWidth);
		await tab.press('Alt+Enter');
		await expect(group.title.locator('.ash-sticky-editor-tabs-row').getByRole('tab', { name: names[0]!, exact: true })).toBeVisible();
		await expectTabActionCentered(item);
		expect((await geometry()).clipped).toBe(false);
		const ordinary = group.title.locator('.ash-ordinary-editor-tabs-row .ash-tab');
		const naturalWidths = await ordinary.evaluateAll(tabs => tabs.map(tab => tab.getBoundingClientRect().width));
		for (const mode of ['Shrink', 'Fixed', 'Fit']) {
			await workbench.settingsEditor.openUserSettingsUI();
			await workbench.settingsEditor.selectEditorCategory('editor-opening');
			const settings = page.locator('.ash-settings-editor');
			await settings.getByRole('searchbox', { name: 'Search settings' }).fill('workbench.editor.tabSizing');
			await settings.locator('[data-configuration-key="workbench.editor.tabSizing"]').getByRole('combobox').click();
			await page.getByRole('option', { name: mode, exact: true }).click();
			await page.locator('.ash-modal-editor-close').click();
			const resized = await ordinary.evaluateAll(tabs => tabs.map(tab => tab.getBoundingClientRect().width));
			if (mode === 'Fit') {
				resized.forEach((width, index) => expect(width).toBeCloseTo(naturalWidths[index]!, 2));
			} else if (mode === 'Shrink') {
				expect(resized.every((width, index) => width <= naturalWidths[index]!)).toBe(true);
				expect(resized.some((width, index) => width < naturalWidths[index]! - 1)).toBe(true);
				expect(await viewport.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
			} else {
				expect(Math.max(...resized) - Math.min(...resized)).toBeLessThan(0.02);
				expect(resized.every(width => width >= 50 && width <= 160.01)).toBe(true);
			}
			for (const button of await ordinary.locator('.ash-tab-primary-action button').all()) {
				expect(await button.evaluate(element => element.getBoundingClientRect().width)).toBe(22);
			}
		}
	});

	test('file tabs only add distinguishing paths and preserve them across pinned rows and settings changes', async ({ target, testWorkspace, workbench }) => {
		test.skip(target.kind === 'electron' && target.appServerMode === 'disabled', 'Desktop file access requires App Server');
		const page = workbench.page;
		if (target.kind === 'browser' && target.appServerMode === 'disabled') {
			await page.evaluate(async () => {
				const root = await navigator.storage.getDirectory();
				const folder = await root.getDirectoryHandle('tab-label-files', { create: true });
				for (const name of ['client', 'server']) {
					const child = await folder.getDirectoryHandle(name, { create: true });
					const file = await child.getFileHandle('index.ts', { create: true });
					const writer = await file.createWritable();
					await writer.write(`// ${name}`);
					await writer.close();
				}
				Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
			});
			await workbench.quickaccess.runCommand('workbench.action.files.openFolderViaWorkspace');
		} else {
			for (const name of ['client', 'server']) {
				await mkdir(join(testWorkspace.directory, name));
				await writeFile(join(testWorkspace.directory, name, 'index.ts'), `// ${name}`);
			}
		}
		await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
		const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
		if (await showSidebar.isVisible()) { await showSidebar.click(); }
		const explorer = page.locator('.ash-explorer');
		await explorer.getByRole('treeitem', { name: 'client', exact: true }).locator('.ash-tree-twistie').click();
		await explorer.getByRole('treeitem', { name: /client[\\/]index\.ts$/u }).dblclick();
		const group = workbench.editors.groupAt(0);
		await expect(group.tabs).toHaveAttribute('aria-label', 'index.ts');
		await explorer.getByRole('treeitem', { name: 'server', exact: true }).locator('.ash-tree-twistie').click();
		await explorer.getByRole('treeitem', { name: /server[\\/]index\.ts$/u }).dblclick();
		await expect(group.tabs.locator('.ash-icon-label-description')).toHaveText(['client', 'server']);
		const client = group.tabs.filter({ hasText: 'client' });
		await client.press('Alt+Enter');
		await expect(group.title.locator('.ash-sticky-editor-tabs-row').getByRole('tab')).toHaveAttribute('aria-label', 'index.ts, client');
		const server = group.tabs.filter({ hasText: 'server' });
		const id = await server.getAttribute('id');
		for (const [option, description] of [['Absolute Path', /server$/u], ['Relative Path', /^server$/u], ['Parent Directory', /^server$/u], ['Default', /^server$/u]] as const) {
			await workbench.settingsEditor.openUserSettingsUI();
			await workbench.settingsEditor.selectEditorCategory('editor-opening');
			const settings = page.locator('.ash-settings-editor');
			await settings.getByRole('searchbox', { name: 'Search settings' }).fill('workbench.editor.labelFormat');
			await settings.locator('[data-configuration-key="workbench.editor.labelFormat"]').getByRole('combobox').click();
			await page.getByRole('option', { name: option, exact: true }).click();
			await expect(server.locator('.ash-icon-label-description')).toHaveText(description);
			if (option === 'Absolute Path') {
				await expect(server.locator('.ash-icon-label-description')).not.toHaveText('server');
			}
			await expect(server).toHaveAttribute('id', id!);
			await page.locator('.ash-modal-editor-close').click();
		}
		await server.focus();
		await expect(server).toBeFocused();
		await server.press('ControlOrMeta+W');
		await expect(group.tabs).toHaveCount(1);
		await expect(group.tabs).toHaveAttribute('aria-label', 'index.ts');
	});
});

test('tab command groups close and split the clicked tabs from mouse and keyboard', async ({ application, workbench }) => {
	const page = workbench.page;
	const choose = async (tab: Locator, label: string, keyboard = false): Promise<void> => {
		await workbench.menus.select(application, async () => {
			if (keyboard) { await tab.focus(); await tab.press('Shift+F10'); }
			else { await tab.click({ button: 'right' }); }
		}, [label]);
	};
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	const source = workbench.editors.groupAt(0);
	const names: string[] = [];
	for (let index = 0; index < 3; index++) {
		await page.keyboard.press('ControlOrMeta+N');
		await expect(source.tabs).toHaveCount(index + 1);
		names.push((await source.tabs.last().getAttribute('aria-label'))!);
	}
	const first = source.element.getByRole('tab', { name: names[0], exact: true });
	const second = source.element.getByRole('tab', { name: names[1], exact: true });
	const third = source.element.getByRole('tab', { name: names[2], exact: true });
	await choose(first, 'Split Right');
	await expect(workbench.editors.groups).toHaveCount(2);
	const copied = workbench.editors.groupAt(1);
	await expect(copied.tabs).toHaveCount(1);
	await expect(copied.tabs).toHaveAttribute('aria-label', names[0]);
	await expect(third).toHaveAttribute('aria-selected', 'true');
	const originalBounds = (await source.element.boundingBox())!;
	const copiedBounds = (await copied.element.boundingBox())!;
	expect(copiedBounds.x).toBeGreaterThan(originalBounds.x);
	await choose(copied.tabs, 'Close All in Group', true);
	await expect(copied.tabs).toHaveCount(0);
	await expect(source.tabs).toHaveCount(3);
	await first.click();
	await second.click({ modifiers: ['ControlOrMeta'] });
	await choose(first, 'Split Down', true);
	await expect(workbench.editors.groups).toHaveCount(3);
	const down = workbench.editors.groups.filter({ has: page.getByRole('tab', { name: names[0], exact: true }) }).nth(1);
	const downTabs = down.getByRole('tab');
	await expect(downTabs).toHaveCount(2);
	expect(await downTabs.evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')))).toEqual(names.slice(0, 2));
	const downBounds = (await down.boundingBox())!;
	expect(downBounds.y).toBeGreaterThan((await source.element.boundingBox())!.y);
	await choose(downTabs.first(), 'Close All in Group');
	await expect(workbench.editors.groups.filter({ has: page.getByRole('tab', { name: names[0], exact: true }) })).toHaveCount(1);
	await third.click();
	await choose(second, 'Close to the Right', true);
	await expect(third).toHaveCount(0);
	await expect(source.tabs).toHaveCount(2);
	await choose(first, 'Pin Editor', true);
	await expect(first).toHaveAttribute('aria-description', /Pinned tab/u);
	const previousTabCount = await source.tabs.count();
	await page.keyboard.press('ControlOrMeta+N');
	await expect(source.tabs).toHaveCount(previousTabCount + 1);
	const dirty = source.tabs.last();
	const dirtyName = (await dirty.getAttribute('aria-label'))!;
	await source.content.getByRole('textbox', { name: dirtyName, exact: true }).focus();
	await page.keyboard.insertText('unsaved text');
	await expect(dirty).toHaveAttribute('aria-label', /unsaved changes/u);
	await choose(second, 'Close Saved');
	await expect(second).toHaveCount(0);
	await expect(first).toHaveCount(1);
	await expect(dirty).toHaveCount(1);
	await expect(source.tabs).toHaveCount(2);
});

test('editor tabs distinguish the active document from the tab strip across themes', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	const strip = group.title.locator('.ash-editor-tabs-and-actions');
	const active = strip.locator('.ash-tab.checked');
	const inactive = strip.locator('.ash-tab:not(.checked):not(.selected)').first();
	for (const [theme, documentColor, stripColor, inactiveColor] of [
		['Ash Dark', 'rgb(30, 30, 30)', 'rgb(37, 37, 38)', 'rgb(37, 37, 38)'],
		['Ash Light', 'rgb(255, 255, 255)', 'rgb(243, 243, 243)', 'rgb(238, 238, 238)'],
		['Ash High Contrast Dark', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)'],
		['Ash High Contrast Light', 'rgb(255, 255, 255)', 'rgb(255, 255, 255)', 'rgb(255, 255, 255)'],
	] as const) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = page.locator('.ash-quick-pick').getByRole('combobox');
		await picker.fill(theme);
		await picker.press('Enter');
		await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
		await expect(strip).toHaveCSS('background-color', stripColor);
		await expect(active).toHaveCSS('background-color', documentColor);
		await expect(inactive).toHaveCSS('background-color', inactiveColor);
		const tab = active.getByRole('tab');
		await tab.focus();
		await expect(tab).toHaveCSS('outline-style', 'solid');
		await tab.press('Alt+Enter');
		await expect(group.title.locator('.ash-sticky-editor-tabs-row .ash-tab.checked')).toHaveCSS('background-color', documentColor);
		await expect(strip).toHaveCSS('background-color', stripColor);
		await active.getByRole('button', { name: 'Unpin Editor', exact: true }).click();
	}
});

test('double-clicking Welcome keeps it in the ordinary row and preserves an explicit pin', async ({ workbench }) => {
	const page = workbench.page;
	const welcome = page.getByRole('tab', { name: 'Welcome', exact: true });
	const ordinary = page.locator('.ash-ordinary-editor-tabs-row .ash-tab').filter({ has: welcome });
	await expect(ordinary).toHaveCount(1);
	const tabId = await welcome.getAttribute('id');
	const originalLabel = await welcome.elementHandle();
	const originalText = await welcome.locator('.ash-icon-label-text').elementHandle();
	await welcome.dblclick();
	await expect(ordinary).toHaveCount(1);
	await expect(ordinary).not.toHaveClass(/preview/u);
	await expect(page.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await expect(welcome).toHaveAttribute('id', tabId!);
	expect(await welcome.evaluate((element, original) => element === original, originalLabel)).toBe(true);
	expect(await welcome.locator('.ash-icon-label-text').evaluate((element, original) => element === original, originalText)).toBe(true);
	await originalLabel?.dispose();
	await originalText?.dispose();
	await expect(workbench.editors.groupAt(0).content.getByRole('button').first()).toBeFocused();
	await welcome.dblclick();
	await expect(ordinary).toHaveCount(1);
	await welcome.press('Alt+Enter');
	const sticky = page.locator('.ash-sticky-editor-tabs-row .ash-tab').filter({ has: welcome });
	await expect(sticky).toHaveCount(1);
	await welcome.dblclick();
	await expect(sticky).toHaveCount(1);
	await expect(workbench.editors.groupAt(0).content.getByRole('button').first()).toBeFocused();
	await welcome.press('ControlOrMeta+k');
	await welcome.press('Shift+Enter');
	await expect(ordinary).toHaveCount(1);
});

test('pin commands follow the focused inactive tab and preserve editor selection', async ({ workbench }) => {
	const page = workbench.page;
	const group = workbench.editors.groupAt(0);
	await page.keyboard.press('ControlOrMeta+N');
	const untitled = group.tabs.filter({ hasText: /Untitled-/u });
	const firstName = await untitled.first().getAttribute('aria-label');
	await page.keyboard.press('ControlOrMeta+N');
	await expect(untitled).toHaveCount(2);
	const secondName = await untitled.last().getAttribute('aria-label');
	const first = group.element.getByRole('tab', { name: firstName!, exact: true });
	const second = group.element.getByRole('tab', { name: secondName!, exact: true });
	await first.focus();
	await first.press('Alt+Enter');
	await expect(group.title.locator('.ash-sticky-editor-tabs-row').getByRole('tab', { name: firstName!, exact: true })).toHaveCount(1);
	await expect(second).toHaveAttribute('aria-selected', 'true');
	await expect(first).toHaveAttribute('aria-selected', 'false');
	await expect(first).toBeFocused();
	await first.press('ControlOrMeta+k');
	await first.press('Shift+Enter');
	await expect(group.title.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await expect(second).toHaveAttribute('aria-selected', 'true');
	await expect(first).toBeFocused();
	await first.press('Alt+Enter');
	await group.title.locator('.ash-sticky-editor-tabs-row').getByRole('button', { name: 'Unpin Editor', exact: true }).click();
	await expect(group.title.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await expect(second).toHaveAttribute('aria-selected', 'true');
	await expect(first).toHaveAttribute('aria-selected', 'false');
	await expect(first).toBeFocused();
});

test('pinned editor action stays Unpin on hover and returns the editor to the ordinary row', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');

	const ordinary = page.locator('.ash-ordinary-editor-tabs-row .ash-tab.checked');
	await expect(ordinary).toHaveCount(1);
	await expect(ordinary.getByRole('tab')).toHaveAttribute('aria-label', /^Untitled-/u);
	const untitledName = await ordinary.getByRole('tab').getAttribute('aria-label');
	await expect(ordinary.locator('.ash-tab-close-action')).toHaveCount(1);
	await expect(ordinary.getByRole('tab')).toHaveAttribute('aria-description', /Pin Editor to pin/u);
	const colors = await ordinary.evaluate(element => {
		const reference = document.createElement('span');
		reference.style.background = 'var(--ash-editor-background)';
		element.append(reference);
		const editor = getComputedStyle(reference).backgroundColor;
		reference.remove();
		return { tab: getComputedStyle(element).backgroundColor, editor };
	});
	expect(colors.tab).toBe(colors.editor);
	await expect(ordinary).toHaveCSS('border-bottom-width', '0px');
	const closeGeometry = await ordinary.locator('.ash-tab-close-action button').evaluate(button => {
		const rect = button.getBoundingClientRect();
		const icon = button.querySelector('.ash-icon')!.getBoundingClientRect();
		return { width: rect.width, height: rect.height, iconWidth: icon.width, iconHeight: icon.height, left: icon.left - rect.left, right: rect.right - icon.right };
	});
	expect(closeGeometry).toEqual({ width: 22, height: 22, iconWidth: 16, iconHeight: 16, left: 3, right: 3 });
	await expectTabActionCentered(ordinary);

	await ordinary.getByRole('tab').press('Alt+Enter');
	const sticky = page.locator('.ash-sticky-editor-tabs-row .ash-tab.checked');
	await expect(sticky).toHaveCount(1);
	await expect(sticky).toHaveCSS('border-bottom-width', '0px');
	const unpin = sticky.getByRole('button', { name: 'Unpin Editor', exact: true });
	await expect(sticky.locator('.ash-tab-close-action')).toHaveCount(0);
	await expect(unpin.locator('svg')).toHaveAttribute('data-ash-icon-id', 'pinned');
	await expect(sticky.getByRole('tab')).toHaveAttribute('aria-description', /Unpin Editor to unpin/u);
	await page.mouse.move(0, 0);
	await sticky.getByRole('tab').blur();
	await expect(unpin).toBeVisible();
	await sticky.getByRole('tab').hover();
	await unpin.hover();
	await expectTabActionCentered(sticky);
	await expect(unpin.locator('svg')).toBeVisible();
	await expect(unpin.locator('svg')).toHaveAttribute('data-ash-icon-id', 'pinned');
	await expect(sticky.getByRole('button', { name: /^Close /u })).toHaveCount(0);
	await unpin.click();
	await expect(page.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await expect(ordinary.getByRole('tab')).toHaveAttribute('aria-label', untitledName!);
	await ordinary.getByRole('tab').press('Alt+Enter');
	await unpin.focus();
	await expectTabActionCentered(sticky);
	await unpin.press('Enter');
	await expect(page.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await expect(ordinary.getByRole('tab')).toBeFocused();
	await ordinary.locator('.ash-tab-close-action button').click();
	await expect(page.getByRole('tab', { name: untitledName! })).toHaveCount(0);
});

test('editor tab menu targets the clicked tab and opens from the keyboard', async ({ target, workbench }) => {
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS displays this menu through Electron');
	const page = workbench.page;
	const createUntitled = async (): Promise<void> => {
		await page.getByRole('button', { name: 'Application menu' }).click();
		await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).hover();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'New Untitled Text Editor' }).click();
	};
	await createUntitled();
	const group = workbench.editors.groupAt(0);
	const untitledTabs = group.tabs.filter({ hasText: /Untitled-/u });
	const firstName = await untitledTabs.last().getAttribute('aria-label');
	await createUntitled();
	await expect(untitledTabs).toHaveCount(2);
	const remainingName = await untitledTabs.last().getAttribute('aria-label');
	const first = group.element.getByRole('tab', { name: firstName! });
	const remaining = group.element.getByRole('tab', { name: remainingName! });
	await first.click({ button: 'right' });
	const menu = page.getByRole('menu').last();
	await expect(menu.getByRole('menuitem', { name: 'Close Editor' })).toBeVisible();
	await menu.getByRole('menuitem', { name: 'Close Editor' }).click();
	await expect(first).toHaveCount(0);
	await expect(remaining).toHaveCount(1);
	await remaining.focus();
	await remaining.press('Shift+F10');
	await expect(menu.getByRole('menuitem', { name: 'Pin Editor' })).toBeVisible();
	await menu.getByRole('menuitem', { name: 'Pin Editor' }).click();
	await expect(remaining).toHaveAttribute('aria-description', /Pinned tab/u);
	await createUntitled();
	await expect(untitledTabs).toHaveCount(2);
	await remaining.click({ button: 'right' });
	await menu.getByRole('menuitem', { name: 'Close Other Editors' }).click();
	await expect(group.tabs).toHaveCount(1);
	await expect(remaining).toHaveCount(1);
});

test('macOS Electron editor tab menu targets mouse and keyboard actions', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || process.platform !== 'darwin', 'This scenario requires the macOS Code desktop product');
	const page = workbench.page;
	const group = workbench.editors.groupAt(0);
	await page.keyboard.press('ControlOrMeta+N');
	const untitledTabs = group.tabs.filter({ hasText: /Untitled-/u });
	const firstName = await untitledTabs.last().getAttribute('aria-label');
	await page.keyboard.press('ControlOrMeta+N');
	await expect(untitledTabs).toHaveCount(2);
	const remainingName = await untitledTabs.last().getAttribute('aria-label');

	const first = group.element.getByRole('tab', { name: firstName!, exact: true });
	const remaining = group.element.getByRole('tab', { name: remainingName!, exact: true });
	await workbench.menus.select(application, () => first.click({ button: 'right' }), ['Close Editor']);
	await expect(first).toHaveCount(0);
	await expect(remaining).toHaveCount(1);
	await workbench.menus.select(application, async () => { await remaining.focus(); await remaining.press('Shift+F10'); }, ['Pin Editor']);
	await expect(remaining).toHaveAttribute('aria-description', /Pinned tab/u);
});


test('editor icon setting updates existing tabs and survives pinning', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	await expect(group.tabs.filter({ hasText: /Untitled-/u }).locator('.ash-icon-label-icon')).toBeHidden();
	await workbench.quickaccess.runCommand('workbench.action.openWelcome');
	const tab = group.tabs.filter({ hasText: 'Welcome' });
	const icon = tab.locator('.ash-icon-label-icon');
	await expect(icon).toHaveAttribute('aria-hidden', 'true');
	await expect(icon).toHaveClass(/is-reserved/u);
	await expect(icon.locator('svg')).toHaveAttribute('data-ash-icon-id', 'home');
	const tabId = await tab.getAttribute('id');
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	const settings = page.locator('.ash-settings-editor');
	await workbench.settingsEditor.selectEditorCategory('editor-opening');
	await settings.getByRole('searchbox', { name: 'Search settings' }).fill('workbench.editor.showIcons');
	const toggle = settings.locator('[data-configuration-key="workbench.editor.showIcons"]');
	await expect(toggle).toBeChecked();
	await toggle.focus();
	await toggle.press('Space');
	await expect(toggle).not.toBeChecked();
	await expect(icon).not.toHaveClass(/is-reserved/u);
	await expect(icon).toBeHidden();
	await expect(tab).toHaveAttribute('id', tabId!);
	await toggle.press('Space');
	await expect(toggle).toBeChecked();
	await expect(icon).toHaveClass(/is-reserved/u);
	await page.locator('.ash-modal-editor-close').click();
	await tab.press('Alt+Enter');
	await expect(group.title.locator('.ash-sticky-editor-tabs-row .ash-tab-label .ash-icon-label-icon')).toHaveClass(/is-reserved/u);
});
