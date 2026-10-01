import { expect, test } from "../../../automation/test.js";
import type { Locator, Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { Editor } from '../../../automation/editor.js';

async function replaceChatInput(editor: Editor, text: string): Promise<void> {
	await editor.waitForEditorFocus();
	await editor.input.page().keyboard.press('ControlOrMeta+A');
	await editor.input.page().keyboard.press('Backspace');
	await editor.input.page().keyboard.insertText(text);
}

async function expectComposerFocusWithoutOutline(card: Locator, input: Locator, blurTarget: Locator): Promise<void> {
	await blurTarget.hover();
	await blurTarget.focus();
	await expect(card).not.toHaveClass(/focused/u);
	const colors = await card.evaluate(element => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--ash-chat-input-border)';
		element.append(probe);
		const resting = getComputedStyle(probe).color;
		probe.style.color = 'var(--ash-widget-border)';
		const focused = getComputedStyle(probe).color;
		probe.remove();
		return { resting, focused };
	});
	await expect(card).toHaveCSS('border-top-color', colors.resting);
	await input.focus();
	await expect(input).toBeFocused();
	await expect(card).toHaveClass(/focused/u);
	await expect(card).toHaveCSS('border-top-color', colors.focused);
	await expect(card).toHaveCSS('outline-style', 'none');
}

async function expectFloatingComposerHover(card: Locator, input: Locator, blurTarget: Locator): Promise<void> {
	await blurTarget.hover();
	await blurTarget.focus();
	const colors = await card.evaluate(element => {
		const probe = document.createElement('span');
		element.append(probe);
		probe.style.color = 'var(--ash-border)';
		const resting = getComputedStyle(probe).color;
		probe.style.color = 'var(--ash-widget-border)';
		const hovered = getComputedStyle(probe).color;
		probe.remove();
		return { resting, hovered };
	});
	await expect(card).toHaveCSS('border-top-color', colors.resting);
	await expect(card).not.toHaveCSS('box-shadow', 'none');
	await expect(card).toHaveCSS('transition-property', 'border-color, box-shadow');
	await expect(card).toHaveCSS('transition-duration', '0.2s, 0.2s');
	await expect.poll(() => card.evaluate(element => element.getAnimations().length)).toBe(0);
	const restingShadow = await card.evaluate(element => getComputedStyle(element).boxShadow);
	const bounds = await card.boundingBox();
	await card.hover();
	await expect(card).toHaveCSS('border-top-color', colors.hovered);
	await expect.poll(() => card.evaluate(element => element.getAnimations().length)).toBe(0);
	await expect(card).not.toHaveCSS('box-shadow', restingShadow);
	const raisedShadow = await card.evaluate(element => getComputedStyle(element).boxShadow);
	expect(colors.hovered).not.toBe(colors.resting);
	await input.focus();
	await expect(input).toBeFocused();
	await expect(card).toHaveCSS('border-top-color', colors.hovered);
	await expect(card).toHaveCSS('outline-style', 'none');
	expect(await card.boundingBox()).toEqual(bounds);
	await card.page().mouse.move(0, 0);
	await input.press('ArrowLeft');
	await input.press('ArrowRight');
	await expect(input).toBeFocused();
	await expect(card).toHaveCSS('border-top-color', colors.hovered);
	await expect(card).toHaveCSS('box-shadow', raisedShadow);
	await blurTarget.focus();
	await expect(card).not.toHaveClass(/focused/u);
	await expect(card).toHaveCSS('border-top-color', colors.resting);
	await expect(card).toHaveCSS('box-shadow', restingShadow);
	await input.focus();
	await expect(card).toHaveCSS('border-top-color', colors.hovered);
	await expect(card).toHaveCSS('box-shadow', raisedShadow);
}

test('Sessions Design canvas keeps grid and cursor readable across themes', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	for (const [theme, scheme] of [
		['Ash Light', 'light'],
		['Ash Dark', 'dark'],
		['Ash High Contrast Dark', 'high-contrast-dark'],
		['Ash High Contrast Light', 'high-contrast-light'],
	]) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = workbench.page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill(theme);
		await picker.getByRole('combobox').press('Enter');
		await expect(picker).toHaveCount(0);
		let page = workbench.page;
		if (target.kind === 'browser') {
			await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
		} else {
			if (!('windows' in application)) {
				throw new Error('Expected Electron windows');
			}
			const opened = application.waitForEvent('window');
			await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
			page = await opened;
		}
		await expect(page.locator('#app')).toHaveAttribute('data-color-scheme', scheme);
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Design', exact: true }).click();
		const canvas = page.getByRole('region', { name: 'Design canvas' });
		const viewport = canvas.locator('.ash-sessions-design-viewport');
		await expect(viewport).toHaveCSS('background-image', /linear-gradient[\s\S]*linear-gradient/u);
		const colors = await viewport.evaluate(element => {
			const styles = getComputedStyle(element);
			const cursor = decodeURIComponent(styles.cursor);
			const probe = document.createElement('span');
			element.append(probe);
			probe.style.color = cursor.match(/stroke="([^"]+)"/u)![1];
			const cursorColor = getComputedStyle(probe).color;
			probe.style.color = 'var(--ash-foreground)';
			const foreground = getComputedStyle(probe).color;
			probe.remove();
			return { cursorColor, foreground, grid: styles.getPropertyValue('--ash-sessions-design-grid-line').trim(), contrast: styles.getPropertyValue('--ash-contrast-border').trim() };
		});
		expect(colors.cursorColor).toBe(colors.foreground);
		if (scheme.startsWith('high-contrast')) {
			expect(colors.grid).toBe(colors.contrast);
		}
		await canvas.focus();
		await page.keyboard.press('ArrowLeft');
		await expect(viewport).toHaveCSS('outline-style', 'solid');
		const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
		await returnFromSessions(page);
		await closed;
		await workbench.waitForReady();
	}
});

test('Sessions Design contribution keeps its viewport and applies canvas cursor settings', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) {
			throw new Error('Expected Electron windows');
		}
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	const navigation = page.locator('.ash-sessions-activity-content');
	const design = navigation.getByRole('button', { name: 'Design', exact: true });
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	const world = canvas.locator('.ash-sessions-design-world');
	const transform = () => world.evaluate(element => (element as HTMLElement).style.transform);
	await design.click();
	await expect(canvas).toBeVisible();
	await expect(canvas).toHaveCSS('display', 'flex');
	const viewport = canvas.locator('.ash-sessions-design-viewport');
	await expect(viewport).toHaveCSS('background-image', /linear-gradient[\s\S]*linear-gradient/u);
	await expect(viewport).toHaveCSS('background-size', '12px 12px, 12px 12px');
	await expect(viewport).toHaveCSS('cursor', /url\("data:image\/svg\+xml,/u);
	await canvas.focus();
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('+');
	await expect.poll(transform).toMatch(/scale\(1\.2\)$/u);
	await expect(viewport).toHaveCSS('background-size', '14.4px 14.4px, 14.4px 14.4px');
	const retainedTransform = await transform();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Design canvas[\s\S]*Press 0 to reset the view/u);
	await page.keyboard.press('Escape');
	await expect(canvas).toBeFocused();
	await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
	await expect(canvas).toBeHidden();
	await design.click();
	await expect(canvas).toBeVisible();
	await expect(canvas).toHaveCount(1);
	await expect.poll(transform).toBe(retainedTransform);
	await canvas.focus();
	await page.keyboard.press('0');
	await expect.poll(transform).toBe('translate(0px, 0px) scale(1)');
	const bounds = await canvas.boundingBox();
	expect(bounds).not.toBeNull();
	expect(bounds!.width).toBeGreaterThan(400);
	expect(bounds!.height).toBeGreaterThan(200);
	await viewport.hover();
	await page.mouse.down();
	await expect(viewport).toHaveCSS('cursor', 'grabbing');
	await page.mouse.up();
	await expect(viewport).toHaveCSS('cursor', /url\("data:image\/svg\+xml,/u);

	const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
	const openDesignSettings = async (): Promise<void> => {
		if (target.kind === 'electron' && process.platform === 'darwin') {
			if (!('windows' in application)) { throw new Error('Expected Electron application'); }
			// Select the real system-menu item through Main; it is outside the page's DOM.
			await application.evaluate(({ Menu }) => {
				const popup = Menu.prototype.popup;
				Menu.prototype.popup = function (options) {
					Menu.prototype.popup = popup;
					const item = this.items.find(item => item.label === 'Settings')!;
					item.click(item, options?.window, { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, triggeredByAccelerator: false });
					options?.callback?.();
				};
			});
		}
		await navigation.getByRole('button', { name: 'Accounts', exact: true }).click();
		if (target.kind === 'browser' || process.platform !== 'darwin') {
			await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
		}
		await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Design', exact: true }).click();
	};
	await openDesignSettings();
	const pointerSwitch = settings.getByRole('switch', { name: 'Use pointer cursor on the canvas', exact: true });
	await expect(pointerSwitch).toBeChecked();
	await pointerSwitch.focus();
	await page.keyboard.press('Space');
	await expect(pointerSwitch).not.toBeChecked();
	await expect(canvas).not.toHaveClass(/pointer-cursor/u);
	await expect(settings.locator('[data-configuration-key="accessibility.verbosity.designCanvas"]')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(viewport).toHaveCSS('cursor', 'grab');
	await page.reload();
	await design.click();
	await expect(canvas).toBeVisible();
	await expect(viewport).toHaveCSS('cursor', 'grab');
	await openDesignSettings();
	await expect(pointerSwitch).not.toBeChecked();
	await settings.locator('[data-settings-item-id="sessions.design.usePointerCursor"] .ash-switch-track').click();
	await expect(canvas).toHaveClass(/pointer-cursor/u);
	await page.keyboard.press('Escape');
	await expect(viewport).toHaveCSS('cursor', /url\("data:image\/svg\+xml,/u);
});

test('Sessions Design edits vector geometry and preserves a complete undo gesture', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) { throw new Error('Expected Electron windows'); }
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	const viewport = canvas.locator('.ash-sessions-design-viewport');
	await canvas.getByRole('button', { name: 'Rectangle', exact: true }).click();
	const rectangle = canvas.locator('rect[data-shape-id]');
	await expect(rectangle).toHaveAttribute('width', '120');
	const width = canvas.getByRole('spinbutton', { name: 'Width', exact: true });
	await width.fill('120.5');
	await width.press('Tab');
	await expect(rectangle).toHaveAttribute('width', '120.5');
	const rotation = canvas.getByRole('spinbutton', { name: 'Rotation', exact: true });
	await rotation.fill('30');
	await rotation.press('Tab');
	await expect(rectangle).toHaveAttribute('transform', /^rotate\(30 /u);
	await canvas.focus();
	await page.keyboard.press('+');
	await page.keyboard.press('+');
	const before = Number(await rectangle.getAttribute('x'));
	const rect = await rectangle.boundingBox();
	expect(rect).not.toBeNull();
	await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
	await page.mouse.down();
	await page.mouse.move(rect!.x + rect!.width / 2 + 72, rect!.y + rect!.height / 2 + 36, { steps: 4 });
	await page.mouse.up();
	await expect.poll(async () => Number(await rectangle.getAttribute('x'))).toBeCloseTo(before + 50, 5);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(async () => Number(await rectangle.getAttribute('x'))).toBe(before);
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect.poll(async () => Number(await rectangle.getAttribute('x'))).toBeCloseTo(before + 50, 5);
	const moved = await rectangle.boundingBox();
	await page.mouse.move(moved!.x + moved!.width / 2, moved!.y + moved!.height / 2);
	await page.mouse.down();
	await page.mouse.move(moved!.x + moved!.width / 2 + 72, moved!.y + moved!.height / 2);
	await page.keyboard.press('Escape');
	await page.mouse.up();
	await expect.poll(async () => Number(await rectangle.getAttribute('x'))).toBeCloseTo(before + 50, 5);
	await canvas.getByRole('button', { name: 'Ellipse', exact: true }).click();
	await expect(canvas.locator('ellipse[data-shape-id]')).toHaveCount(1);
	await canvas.focus();
	await page.keyboard.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Rectangle[\s\S]*Ellipse/u);
	await page.keyboard.press('Escape');
	await expect(canvas).toBeFocused();
	await page.keyboard.press('Escape');
	await page.keyboard.press('Tab');
	await page.keyboard.press('Delete');
	await expect(rectangle).toHaveCount(0);
	await canvas.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(rectangle).toHaveCount(1);
	await expect(viewport).toHaveCSS('background-size', /17\.28px/u);
	await expect(canvas.locator('.ash-sessions-design-zoom')).toContainText('Unsaved changes');
});

test('Sessions Design saves and reopens an editable file through App Server', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires desktop file operations through App Server');
	if (!('windows' in application)) { throw new Error('Expected Electron application'); }
	const filePath = join(await realpath(testWorkspace.directory), 'design.ash-design.json');
	// Only replace the OS picker; the renderer, IPC and authorized file service stay in the workflow.
	await application.evaluate(({ dialog }, path) => {
		dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
	}, filePath);
	const opened = application.waitForEvent('window');
	await workbench.page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
	const page = await opened;
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	await canvas.getByRole('button', { name: 'Rectangle', exact: true }).click();
	const width = canvas.getByRole('spinbutton', { name: 'Width', exact: true });
	await width.fill('120.5');
	await width.press('Tab');
	await canvas.focus();
	await page.keyboard.press('ControlOrMeta+s');
	await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Saved design.ash-design.json');
	const saved = JSON.parse(await readFile(filePath, 'utf8'));
	expect(saved).toMatchObject({ version: 1, shapes: [{ kind: 'rectangle', width: 120.5 }] });
	await expect(canvas.locator('.ash-sessions-design-zoom')).not.toContainText('Unsaved changes');
	await canvas.getByRole('button', { name: 'Ellipse', exact: true }).click();
	await page.keyboard.press('ControlOrMeta+z');
	await canvas.getByRole('button', { name: 'Open design', exact: true }).click();
	await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Opened design.ash-design.json');
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('width', '120.5');
	await expect(canvas.locator('ellipse[data-shape-id]')).toHaveCount(0);
	await canvas.focus();
	await page.keyboard.press('Tab');
	await width.fill('240.5');
	await width.press('Tab');
	await canvas.getByRole('button', { name: 'Save design', exact: true }).click();
	await expect(canvas.locator('.ash-sessions-design-zoom')).not.toContainText('Unsaved changes');
	expect(JSON.parse(await readFile(filePath, 'utf8')).shapes[0].width).toBe(240.5);
	await writeFile(filePath, JSON.stringify(saved));
	await width.fill('360.5');
	await width.press('Tab');
	await canvas.getByRole('button', { name: 'Save design', exact: true }).click();
	const error = page.getByRole('dialog');
	await expect(error).toContainText('Could not save the design. Your changes are still in the canvas.');
	await error.getByRole('button', { name: 'OK', exact: true }).click();
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('width', '360.5');
	await expect(canvas.locator('.ash-sessions-design-zoom')).toContainText('Unsaved changes');
	expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(saved);
	const closeSessions = () => application.evaluate(({ BrowserWindow }) => {
		BrowserWindow.getAllWindows().find(window => window.getTitle().includes('Sessions'))!.close();
	});
	await closeSessions();
	const savePrompt = page.getByRole('dialog', { name: 'Save Changes', exact: true });
	await expect(savePrompt).toContainText('design.ash-design.json');
	await savePrompt.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(savePrompt).toHaveCount(0);
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('width', '360.5');
	await closeSessions();
	const closed = page.waitForEvent('close');
	await savePrompt.getByRole('button', { name: "Don't Save", exact: true }).click();
	await closed;
});

test('Sessions Design saves and opens a browser folder without replacing the workspace', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled' || target.workbenchMode !== 'code', 'Requires the standalone browser file picker');
	const page = workbench.page;
	await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Design', exact: true }).click();
	const folderName = await page.evaluate(async () => {
		const name = `ash-design-${crypto.randomUUID()}`;
		const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		return name;
	});
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	await canvas.getByRole('button', { name: 'Ellipse', exact: true }).click();
	await canvas.focus();
	await page.keyboard.press('ControlOrMeta+s');
	const dialog = page.getByRole('dialog', { name: 'Save design', exact: true });
	await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('design.ash-design.json');
	await dialog.getByRole('button', { name: 'OK', exact: true }).click();
	await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Saved design.ash-design.json');
	const saved = await page.evaluate(async name => {
		const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
		return JSON.parse(await (await (await folder.getFileHandle('design.ash-design.json')).getFile()).text());
	}, folderName);
	expect(saved).toMatchObject({ version: 1, shapes: [{ kind: 'ellipse', width: 120, height: 80 }] });
	await canvas.getByRole('button', { name: 'Rectangle', exact: true }).click();
	await page.keyboard.press('ControlOrMeta+z');
	await expect(canvas.locator('.ash-sessions-design-zoom')).not.toContainText('Unsaved changes');
	await canvas.getByRole('button', { name: 'Open design', exact: true }).click();
	const file = page.locator('.ash-quick-pick-row-label').filter({ hasText: /^design\.ash-design\.json$/u });
	await expect(file).toBeVisible();
	await file.click();
	await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Opened design.ash-design.json');
	await expect(canvas.locator('ellipse[data-shape-id]')).toHaveCount(1);
	await expect(canvas.locator('rect[data-shape-id]')).toHaveCount(0);
	await expect(canvas.locator('.ash-sessions-design-zoom')).not.toContainText('Unsaved changes');
});

test('Sessions composer attaches files, chooses permissions, and restores the unsent draft', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	const composer = page.locator('.ash-sessions-chat-input').first();
	const editor = new Editor(composer);
	await expect(composer.locator('[data-action-id="ash.chat.input.attach"] button')).toHaveAccessibleName('Attach files');
	await composer.locator('input[type="file"]').setInputFiles({ name: 'context.ts', mimeType: 'text/plain', buffer: Buffer.from('export const value = 42;') });
	await expect(composer.getByRole('button', { name: 'Remove context.ts', exact: true })).toBeVisible();
	await expect(composer.locator('[data-action-id="ash.chat.input.send"] button')).toBeEnabled();
	const permissions = composer.getByRole('button', { name: 'Permissions: Ask permissions', exact: true });
	await permissions.press('ArrowDown');
	await page.getByRole('menuitemradio', { name: 'Automatic review', exact: true }).click();
	await expect(composer.getByRole('button', { name: 'Permissions: Automatic review', exact: true })).toBeFocused();
	await replaceChatInput(editor, 'Keep the attached draft');
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Attachments can be sent without text/u);
	await page.keyboard.press('Escape');
	await expect(editor.input).toBeFocused();
	await composer.locator('.ash-chat-input-container').evaluate(element => {
		const clipboard = new DataTransfer();
		const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ZkAAAAASUVORK5CYII='), character => character.charCodeAt(0));
		clipboard.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
	});
	await expect(composer.getByRole('button', { name: 'Remove clipboard.png', exact: true })).toBeVisible();
	await editor.waitForEditorContents(contents => contents === 'Keep the attached draft');
	await composer.locator('.ash-chat-input-container').evaluate(element => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['# Context'], 'dropped.md', { type: 'text/plain' }));
		element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
	});
	await expect(composer.locator('.ash-chat-drop-overlay')).toBeVisible();
	await composer.locator('.ash-chat-input-container').evaluate(element => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['# Context'], 'dropped.md', { type: 'text/plain' }));
		element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
	});
	await expect(composer.getByRole('button', { name: 'Remove dropped.md', exact: true })).toBeVisible();
	await expect(composer.locator('.ash-chat-drop-overlay')).toBeHidden();
	await composer.getByRole('button', { name: 'Remove dropped.md', exact: true }).click();
	await expect(composer.getByRole('button', { name: 'Remove dropped.md', exact: true })).toHaveCount(0);
	await composer.getByRole('button', { name: 'Dismiss tip', exact: true }).click();
	await expect(composer.locator('.ash-chat-input-tip')).toHaveCount(0);
	await editor.waitForEditorFocus();
	await page.reload({ waitUntil: 'domcontentloaded' });
	await new Editor(composer).waitForEditorContents(contents => contents === 'Keep the attached draft');
	await expect(composer.getByRole('button', { name: 'Remove context.ts', exact: true })).toBeVisible();
	await expect(composer.getByRole('button', { name: 'Remove clipboard.png', exact: true })).toBeVisible();
	await expect(composer.locator('.ash-chat-input-tip')).toHaveCount(0);
	await returnFromSessions(page);
});

test('Sessions composer configuration leaves Workbench input defaults unchanged', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	const parent = workbench.page;
	if (!await parent.locator('.ash-chat-view-pane').isVisible()) {
		await parent.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const defaultInput = parent.locator('.ash-chat-view-pane .ash-chat-input-part').first();
	const defaultCard = defaultInput.locator('.ash-chat-input-container');
	const workbenchBlurTarget = parent.getByRole('tab', { name: 'Explorer', exact: true });
	await expect(defaultInput.locator('.ash-chat-input-container')).toHaveCSS('border-radius', '8px');
	await expect(defaultInput.locator('.ash-chat-input-editor')).toHaveCSS('height', '100px');
	await workbenchBlurTarget.focus();
	await expect(defaultCard).not.toHaveClass(/focused/u);
	const restingBorder = await defaultCard.evaluate(element => getComputedStyle(element).borderTopColor);
	await defaultCard.hover();
	await expect(defaultCard).toHaveCSS('border-top-color', restingBorder);
	await expect(defaultCard).toHaveCSS('box-shadow', 'none');
	await expect(defaultCard).toHaveCSS('transition-duration', '0s');
	await defaultInput.getByRole('textbox', { name: 'Chat message' }).focus();
	const focusBorder = await defaultInput.evaluate(element => {
		const probe = document.createElement('span');
		probe.style.color = 'var(--ash-focus-border)';
		element.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	await expect(defaultInput.locator('.ash-chat-input-container')).toHaveCSS('border-top-color', focusBorder);
	await expect(defaultInput.locator('.ash-chat-input-container')).toHaveCSS('outline-style', 'none');
	await expect(defaultInput.locator('.ash-chat-input-container')).toHaveCSS('box-shadow', 'none');
	await parent.mouse.move(0, 0);
	await expect(defaultCard).toHaveCSS('border-top-color', focusBorder);
	let page = parent;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await parent.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	const sessionsInput = page.locator('.ash-sessions-chat-input').first();
	await expect(sessionsInput.locator('.ash-chat-input-container')).toHaveCSS('border-radius', '12px');
	await expect(sessionsInput.locator('.ash-chat-input-editor')).toHaveCSS('height', '48px');
	const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
	await returnFromSessions(page);
	await closed;
	await workbench.waitForReady();
	if (!await parent.locator('.ash-chat-view-pane').isVisible()) {
		await parent.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await expect(defaultInput.locator('.ash-chat-input-container')).toHaveCSS('border-radius', '8px');
	await expect(defaultInput.locator('.ash-chat-input-editor')).toHaveCSS('height', '100px');
	await defaultInput.getByRole('textbox', { name: 'Chat message' }).focus();
	await defaultCard.hover();
	await expect(defaultCard).toHaveCSS('border-top-color', focusBorder);
	await expect(defaultCard).toHaveCSS('box-shadow', 'none');
	await expect(defaultCard).toHaveCSS('transition-duration', '0s');
	await workbenchBlurTarget.focus();
	await expect(defaultCard).toHaveCSS('border-top-color', restingBorder);
	await expect(parent.locator('.ash-sessions-chat-input')).toHaveCount(0);
});

test('Sessions chat fills its content area without a duplicate session title', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	const sessionsContent = page.locator('[data-part="sessions"] > .ash-workbench-part-content');
	const navigation = page.locator('.ash-sessions-activity-content');
	for (const width of [1_200, 760]) {
		await page.setViewportSize({ width, height: 760 });
		await navigation.getByRole('button', { name: 'Code', exact: true }).click();
		await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
		await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
		await expect(sessionsContent.getByRole('heading', { name: 'What can we work on?' })).toBeVisible();
		await expect.poll(() => sessionsContent.evaluate(content => {
			const contentBounds = content.getBoundingClientRect();
			const viewBounds = content.querySelector('.ash-sessions-chat-view')!.getBoundingClientRect();
			return [Math.round(viewBounds.y - contentBounds.y), Math.round(viewBounds.height - contentBounds.height)];
		})).toEqual([0, 0]);
	}
});

test('Sessions empty chat centers a growing input card and keeps the draft across themes and navigation', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	// Electron observes the main-process appearance service; media emulation drives the Web host.
	const setColorScheme = 'windows' in application
		? (colorScheme: 'light' | 'dark') => application.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source; }, colorScheme)
		: (colorScheme: 'light' | 'dark') => page.emulateMedia({ colorScheme });
	const chat = page.locator('.ash-sessions-chat-slot .ash-chat:visible').first();
	const card = chat.locator('.ash-chat-input-container:visible');
	const editor = new Editor(chat);
	const input = editor.input;
	await expect(chat.getByRole('heading', { name: 'What can we work on?' })).toBeVisible();
	await expect(page.locator('.ash-sessions-chat-slot-header')).toBeHidden();
	await expect(card).toHaveCSS('border-radius', '12px');
	await expect(card).toHaveCSS('border-width', '1px');
	await expect(chat.locator('.ash-chat-textarea-input')).toHaveCount(0);
	await expect(chat.locator('.ash-chat-input-editor:visible')).toHaveCSS('height', '48px');
	const bounds = await chat.boundingBox();
	const cardBounds = await card.boundingBox();
	expect(Math.abs(cardBounds!.x + cardBounds!.width / 2 - bounds!.x - bounds!.width / 2)).toBeLessThanOrEqual(1);
	expect(Math.abs(cardBounds!.y + cardBounds!.height / 2 - bounds!.y - bounds!.height / 2)).toBeLessThan(80);
	expect(cardBounds!.width).toBeLessThanOrEqual(680);
	expect(cardBounds!.height).toBeLessThan(150);
	await replaceChatInput(editor, 'Keep this draft');
	await expect(input).toBeFocused();
	await expect(card).toHaveClass(/focused/u);
	const shortHeight = (await card.boundingBox())!.height;
	await replaceChatInput(editor, Array.from({ length: 10 }, (_, index) => `Draft line ${index + 1}`).join('\n'));
	await expect.poll(async () => (await card.boundingBox())!.height).toBeGreaterThan(shortHeight);
	await replaceChatInput(editor, Array.from({ length: 50 }, (_, index) => `Draft line ${index + 1}`).join('\n'));
	await expect(chat.locator('.ash-chat-input-editor:visible')).toHaveCSS('height', '240px');
	await editor.waitForEditorContents(contents => contents.includes('Draft line 50'));
	await page.keyboard.press('ControlOrMeta+Home');
	await editor.waitForEditorContents(contents => contents.startsWith('Draft line 1\n'));
	await replaceChatInput(editor, 'Keep this draft');
	for (const colorScheme of ['light', 'dark'] as const) {
		await setColorScheme(colorScheme);
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', `ash-${colorScheme}`);
		await expectComposerFocusWithoutOutline(card, input, page.getByRole('button', { name: 'Hide sidebar', exact: true }));
		await expectFloatingComposerHover(card, input, page.getByRole('button', { name: 'Hide sidebar', exact: true }));
		await editor.waitForEditorContents(contents => contents === 'Keep this draft');
		await expect(card).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	}
	const navigation = page.locator('.ash-sessions-activity-content');
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(chat.locator('.code-composer')).toBeVisible();
	await editor.waitForEditorContents(contents => contents === '');
	await replaceChatInput(editor, Array.from({ length: 50 }, (_, index) => `Code line ${index + 1}`).join('\n'));
	await expect(chat.locator('.ash-chat-input-editor:visible')).toHaveCSS('height', '240px');
	await replaceChatInput(editor, 'Keep this draft');
	for (const colorScheme of ['light', 'dark'] as const) {
		await setColorScheme(colorScheme);
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', `ash-${colorScheme}`);
		await expectComposerFocusWithoutOutline(card, input, page.getByRole('button', { name: 'Hide sidebar', exact: true }));
		await expectFloatingComposerHover(card, input, page.getByRole('button', { name: 'Hide sidebar', exact: true }));
	}
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(card).toHaveCSS('transition-duration', '0s');
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await editor.waitForEditorContents(contents => contents === 'Keep this draft');
	await page.setViewportSize({ width: 760, height: 600 });
	await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
	await expect(card).toBeVisible();
	const narrowBounds = await card.boundingBox();
	expect(narrowBounds!.x).toBeGreaterThanOrEqual(0);
	expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(760);
	await input.focus();
	await page.keyboard.press('Shift+Enter');
	await editor.waitForEditorContents(contents => contents === 'Keep this draft\n');
	await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
	await expect(chat.locator('.chat-composer')).toBeVisible();
	await editor.waitForEditorContents(contents => contents === 'Keep this draft');
});

test('Sessions input card keeps a visible border without shadow or focus outline in high contrast', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	for (const theme of ['Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = workbench.page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill(theme);
		await picker.getByRole('combobox').press('Enter');
		await expect(picker).toHaveCount(0);
		let page = workbench.page;
		if (target.kind === 'browser') {
			await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
		} else {
			if (!('windows' in application)) throw new Error('Expected Electron windows');
			const opened = application.waitForEvent('window');
			await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
			page = await opened;
		}
		await expect(page.locator('#app')).toHaveAttribute('data-color-scheme', theme.endsWith('Dark') ? 'high-contrast-dark' : 'high-contrast-light');
		const frame = page.locator('.ash-sessions-content-card');
		expect(await frame.evaluate(element => Math.round(parseFloat(getComputedStyle(element).borderRightWidth)))).toBe(1);
		await expect(frame).toHaveCSS('box-shadow', 'none');
		for (const presentation of ['Chat', 'Code'] as const) {
			await page.locator('.ash-sessions-activity-content').getByRole('button', { name: new RegExp(`^${presentation}(?:\\.|$)`, 'u') }).click();
			const card = page.locator(`.${presentation.toLowerCase()}-composer .ash-chat-input-container`).first();
			expect(await card.evaluate(element => Math.round(parseFloat(getComputedStyle(element).borderRightWidth)))).toBe(1);
			await expect(card).toHaveCSS('border-style', 'solid');
			await expect(card).toHaveCSS('box-shadow', 'none');
			await expectComposerFocusWithoutOutline(card, card.getByRole('textbox', { name: 'Chat message' }), page.getByRole('button', { name: 'Hide sidebar', exact: true }));
			await card.hover();
			await expect(card).toHaveCSS('box-shadow', 'none');
		}
		const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
		await returnFromSessions(page);
		await closed;
		await workbench.waitForReady();
	}
});

test.describe('Notification Center', () => {
	test.use({ openWorkspace: false });
	test('Sessions window does not show an empty Notification Center button', async ({ application, target, workbench }) => {
		test.skip(target.workbenchMode !== 'code', 'Requires Code Sessions');
		let page = workbench.page;
		if (target.kind === 'browser') {
			await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
		} else {
			if (!('windows' in application)) throw new Error('Expected an Electron application');
			const opened = application.waitForEvent('window');
			await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
			page = await opened;
		}
		await expect(page.locator('.ash-sessions-window')).toBeVisible();
		const toggle = page.getByRole('button', { name: 'Show Notification Center' });
		await expect(toggle).toBeHidden();
		const center = page.getByRole('region', { name: 'Notification Center' });
		await expect(center).toBeHidden();
	});
});

async function returnFromSessions(page: Page): Promise<void> {
	const accountButton = page.getByRole('button', { name: 'Accounts' });
	await accountButton.click();
	await expect(accountButton).toHaveAttribute('aria-expanded', 'true');
	if (process.platform === 'darwin' && page.url().includes('/electron-browser/')) {
		// macOS renders this menu outside the web page, so Playwright cannot select its item by role.
		await page.evaluate(() => {
			const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
			void ipc.invoke('ash:sessions:return-to-workbench');
		});
		return;
	}
	await page.getByRole('menuitem', { name: 'Return to Workbench' }).click();
}

async function expectActivityIconSize(navigation: Locator, size: number): Promise<void> {
	await expect(navigation).toHaveCSS('display', 'flex');
	await expect(navigation).toHaveCSS('justify-content', 'space-between');
	const horizontal = await navigation.evaluate(element => element.classList.contains('horizontal'));
	await expect(navigation).toHaveCSS('flex-direction', horizontal ? 'row' : 'column');
	const icons = navigation.locator('button svg.ash-icon');
	await expect(icons).toHaveCount(7);
	for (const icon of await icons.all()) {
		await expect(icon).toHaveCSS('width', `${size}px`);
		await expect(icon).toHaveCSS('height', `${size}px`);
		const bounds = await icon.evaluate(element => {
			const icon = element.getBoundingClientRect();
			const button = element.closest('button')!.getBoundingClientRect();
			return {
				x: Math.abs(icon.x + icon.width / 2 - button.x - button.width / 2),
				y: Math.abs(icon.y + icon.height / 2 - button.y - button.height / 2),
			};
		});
		expect(bounds.x).toBeLessThanOrEqual(1);
		expect(bounds.y).toBeLessThanOrEqual(1);
	}
}

test('Code chat mode menu shows the available icons and selection', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || (target.kind !== 'browser' && target.kind !== 'electron'), 'Requires Code browser or Electron UI');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected an Electron application');
		const sessionPagePromise = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		page = await sessionPagePromise;
	}
	const modeButton = page.locator("[data-action-id='ash.chat.input.mode'] button").first();
	await expect(modeButton).toBeVisible();
	await expect(modeButton.locator('svg[data-ash-icon-id="unlimited"]')).toHaveCount(1);
	const chevron = modeButton.locator('.ash-chat-input-mode-indicator svg[data-ash-icon-id="chevron-down"]');
	await expect(chevron).toBeVisible();
	await expect(modeButton.locator('.ash-chat-input-mode-action-label')).toBeVisible();
	const labelBounds = await modeButton.locator('.ash-chat-input-mode-action-label').boundingBox();
	const chevronBounds = await chevron.boundingBox();
	expect(labelBounds).not.toBeNull();
	expect(chevronBounds).not.toBeNull();
	expect(chevronBounds!.x).toBeGreaterThan(labelBounds!.x + labelBounds!.width);
	const inputContainer = page.locator('.ash-chat-input-container').filter({ has: modeButton });
	await inputContainer.evaluate(element => element.style.width = '230px');
	await expect(modeButton.locator('.ash-chat-input-mode-action-label')).toBeHidden();
	await expect(modeButton).toHaveAttribute('aria-label', 'Agent');
	await inputContainer.evaluate(element => element.style.width = '');
	await expect(modeButton.locator('.ash-chat-input-mode-action-label')).toBeVisible();
	await modeButton.click();
	const menu = page.locator('.ash-chat-input-mode-menu');
	await expect(menu).toBeVisible();
	await menu.getByRole('menuitemradio', { name: 'Plan', exact: true }).hover();
	await page.waitForTimeout(650);
	await expect(page.locator('.ash-hover[role="tooltip"]')).toHaveCount(0);
	for (const [label, iconId] of [
		['Agent', 'unlimited'],
		['Plan', 'plan'],
		['Debug', 'debug'],
		['Multitask', 'multitask'],
		['Ask', 'chat-4'],
	] as const) {
		const item = menu.getByRole('menuitemradio', { name: label, exact: true });
		await expect(item).toBeVisible();
		await expect(item.locator('.ash-menu-leading-slot .ash-icon-label-icon svg.ash-icon')).toHaveCount(iconId ? 1 : 0);
		if (iconId) await expect(item.locator('.ash-menu-leading-slot .ash-icon-label-icon svg.ash-icon')).toHaveAttribute('data-ash-icon-id', iconId);
	}
	await expect(menu.getByRole('menuitemradio', { name: 'Agent' })).toHaveAttribute('aria-checked', 'true');
	await expect(menu.locator("[data-action-id='ash.chat.input.agent.error']")).toHaveCount(0);
	const selectedAgent = menu.getByRole('menuitemradio', { name: 'Agent' });
	const agentIcon = selectedAgent.locator('.ash-icon-label-icon svg.ash-icon');
	const selectionCheck = selectedAgent.locator('.ash-menu-leading-check > svg.ash-icon');
	await expect(agentIcon).toBeVisible();
	await expect(selectionCheck).toBeVisible();
	const agentIconBounds = await agentIcon.boundingBox();
	const selectionCheckBounds = await selectionCheck.boundingBox();
	expect(agentIconBounds).not.toBeNull();
	expect(selectionCheckBounds).not.toBeNull();
	expect(selectionCheckBounds!.x).toBeGreaterThan(agentIconBounds!.x);
	await menu.getByRole('menuitemradio', { name: 'Plan' }).click();
	await expect(modeButton).toHaveText('Plan');
	await expect(modeButton.locator('svg[data-ash-icon-id="plan"]')).toHaveCount(1);
	await expect(chevron).toBeVisible();
	await page.mouse.move(4, 4);
	await modeButton.focus();
	await page.keyboard.press('ArrowDown');
	await expect(modeButton).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('.ash-chat-input-mode-menu').getByRole('menuitemradio', { name: 'Agent', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(modeButton).toHaveAttribute('aria-expanded', 'false');
	await expect(modeButton).toBeFocused();
	for (const [label, mode, color] of [
		['Plan', 'plan', '--ash-charts-orange'],
		['Debug', 'debug', '--ash-charts-red'],
		['Multitask', 'multitask', '--ash-charts-purple'],
		['Ask', 'ask', '--ash-charts-green'],
	] as const) {
		if (mode !== 'plan') {
			await modeButton.click();
			await page.locator('.ash-chat-input-mode-menu').getByRole('menuitemradio', { name: label, exact: true }).click();
		}
		await expect(modeButton.locator('..')).toHaveClass(new RegExp(`\\bmode-${mode}\\b`));
		const foreground = await modeButton.evaluate((button, variable) => {
			const probe = document.createElement('span');
			probe.style.color = `var(${variable})`;
			button.append(probe);
			const expected = getComputedStyle(probe).color;
			probe.remove();
			return { actual: getComputedStyle(button).color, expected };
		}, color);
		expect(foreground.actual).toBe(foreground.expected);
	}
});

test('Browser Code Sessions Activity Bar centers icons and changes size and position through its menu', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code', 'Requires the browser Code Sessions page');
	const page = workbench.page;
	await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	const activityBar = page.locator('[data-part="activitybar"]');
	await expect(activityBar).toBeVisible();
	await expect(activityBar).toHaveClass(/ash-sessions-activitybar/u);
	await expect(page.locator('.ash-workbench-activitybar, .ash-activity-bar-content')).toHaveCount(0);
	const activityNavigation = page.locator('.ash-sessions-activity-content');
	await expectActivityIconSize(activityNavigation, 24);
	await expect(activityNavigation.getByRole('button', { name: 'Chat' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'chat-2-filled');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
	await expect(activityNavigation.getByRole('button', { name: 'Code' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'code');
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).not.toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-sidebar-tabs')).toHaveCount(0);
	await page.mouse.move(400, 180);
	await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(activityBar.locator('.ash-sessions-activity-top button svg').first()).toHaveAttribute('data-ash-icon-id', 'chat-2-filled');
	const collaboration = activityBar.getByRole('button', { name: 'Collaboration' });
	const library = activityBar.getByRole('button', { name: 'Library' });
	const chat = activityBar.getByRole('button', { name: 'Chat' });
	await collaboration.click();
	await expect(collaboration.locator('svg')).toHaveAttribute('data-ash-icon-id', 'colab-filled');
	await expect(collaboration).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-list-controls')).toBeHidden();
	await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
	await expect(page.locator('[data-part="auxiliarybar"] h2')).toBeHidden();
	await library.click();
	await expect(library.locator('svg')).toHaveAttribute('data-ash-icon-id', 'library-filled');
	await expect(library).toHaveAttribute('aria-current', 'page');
	await expect(collaboration.locator('svg')).toHaveAttribute('data-ash-icon-id', 'colab');
	await chat.click();
	await expect(chat).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-list-controls')).toBeVisible();
	await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
	await expect(chat).toHaveCSS('background-color', 'rgb(240, 240, 240)');
	await expect(page.locator('.ash-sessions-list-item.selected').first()).toHaveCSS('background-color', 'rgb(240, 240, 240)');
	const design = activityBar.getByRole('button', { name: 'Design' });
	await design.click();
	await expect(design.locator('svg')).toHaveAttribute('data-ash-icon-id', 'symbol-color-filled');
	await expect(design).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-list-controls')).toBeHidden();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	await expect(canvas).toBeVisible();
	const world = canvas.locator('.ash-sessions-design-world');
	const worldTransform = () => world.evaluate(element => (element as HTMLElement).style.transform);
	await expect.poll(worldTransform).toBe('translate(0px, 0px) scale(1)');
	await page.mouse.move(700, 400);
	await page.mouse.wheel(0, 120);
	await expect.poll(worldTransform).toBe('translate(0px, -120px) scale(1)');
	await page.mouse.down();
	await page.mouse.move(760, 440, { steps: 2 });
	await page.mouse.up();
	await expect.poll(worldTransform).toBe('translate(60px, -80px) scale(1)');
	await canvas.click();
	await page.keyboard.press('0');
	await page.keyboard.press('ArrowLeft');
	await expect.poll(worldTransform).toBe('translate(60px, 0px) scale(1)');
	await chat.click();
	await expect(chat).toHaveAttribute('aria-current', 'page');
	await expect(canvas).toBeHidden();
	await expect(activityBar.locator('.ash-sessions-activity-bottom button svg').first()).toHaveAttribute('data-ash-icon-id', 'device-mobile');
	const accounts = activityBar.locator('.ash-sessions-activity-bottom button').last();
	await accounts.click();
	await expect(accounts).toHaveAttribute('aria-expanded', 'true');
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
	await expect(settings).toBeVisible();
	await expect(settings.locator('.ash-dialog-title')).toBeHidden();
	await expect(settings).toHaveCSS('border-top-width', '1px');
	await expect(settings.locator('.ash-sessions-settings')).toHaveCSS('border-top-width', '0px');
	await expect(settings.locator('.ash-sessions-settings-list').first()).toHaveCSS('border-top-width', '0px');
	const settingsCard = settings.locator('.ash-sessions-settings-list.ash-settings-card');
	for (const card of await settingsCard.all()) { await expect(card).toHaveCSS('border-radius', '8px'); }
	for (const card of await settingsCard.all()) { await expect(card).toHaveCSS('background-color', /rgb\(/); }
	await expect(settingsCard.locator('.ash-configuration-setting').first()).toHaveCSS('border-top-left-radius', '8px');
	await expect(settingsCard.locator('.ash-configuration-setting').last()).toHaveCSS('border-bottom-right-radius', '8px');
	const sidebar = settings.locator('.ash-sessions-settings-sidebar');
	const settingsPage = settings.locator('.ash-sessions-settings-page');
	const sidebarBounds = await sidebar.boundingBox();
	const pageBounds = await settingsPage.boundingBox();
	expect(sidebarBounds).not.toBeNull();
	expect(pageBounds).not.toBeNull();
	expect(sidebarBounds!.x + sidebarBounds!.width).toBeLessThanOrEqual(pageBounds!.x + 1);
	expect(sidebarBounds!.y + sidebarBounds!.height).toBeGreaterThanOrEqual(pageBounds!.y + pageBounds!.height - 1);
	await expect(settings.locator('.ash-dialog-actions')).toHaveCount(0);
	const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
	for (const [section, categories] of [
		['Basics', ['General', 'Account', 'Appearance', 'Personalization']],
		['Development', ['Agents', 'Design', 'Models', 'Git & PRs', 'Worktree', 'Browser', 'Tab', 'Code Intelligence', 'Environment']],
		['Management', ['Plugins', 'Keyboard Shortcuts', 'Archived Chats']],
	] as const) {
		const group = navigation.getByRole('group', { name: section });
		for (const category of categories) {
			await expect(group.getByRole('button', { name: category, exact: true }).locator('svg.ash-icon')).toHaveCount(1);
		}
	}
	await expect(navigation.getByRole('button', { name: 'Tab', exact: true }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'keyboard-tab');
	await expect(navigation.getByRole('button', { name: 'Personalization' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'briefcase');
	await expect(navigation.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
	await expect(navigation.getByRole('button', { name: 'General' })).toHaveCSS('background-color', 'rgb(240, 240, 240)');
	await expect(settings.getByRole('heading', { name: 'General' })).toBeVisible();
	await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsActivityBar"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsSettings"]')).toBeVisible();
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible();
	await expect(settings.locator('[data-configuration-key="sessions.layoutStyle"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="sessions.activityBar.location"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="sessions.activityBar.compact"]')).toBeVisible();
	await navigation.getByRole('button', { name: 'General' }).click();
	await expect(settings.getByRole('heading', { name: 'General' })).toBeVisible();
	await expect(settings.locator('[data-configuration-key="dictation.backend"]')).toBeVisible();
	await expect(settings.getByRole('grid', { name: 'Local dictation models' })).toBeVisible();
	await expect(settings.locator('[data-configuration-key="dictation.cloudProvider"]')).toHaveCount(0);
	const dictationBackend = settings.locator('[data-configuration-key="dictation.backend"]').getByRole('combobox');
	const originalDictationBackend = (await dictationBackend.textContent())!.trim();
	const changedDictationBackend = originalDictationBackend === 'Local' ? 'Cloud' : 'Local';
	await dictationBackend.click();
	await page.getByRole('option', { name: changedDictationBackend }).click();
	await expect(dictationBackend).toHaveText(changedDictationBackend);
	await expect(settings.locator('[data-configuration-key="dictation.cloudProvider"]')).toBeVisible();
	await expect(settings.getByRole('grid', { name: 'Local dictation models' })).toHaveCount(0);
	await settings.getByRole('button', { name: 'Manage API connections' }).click();
	await expect(settings.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
	await navigation.getByRole('button', { name: 'General' }).click();
	await dictationBackend.click();
	await page.getByRole('option', { name: originalDictationBackend }).click();
	await navigation.getByRole('button', { name: 'Archived Chats' }).click();
	await expect(settingsPage.getByRole('heading')).toHaveCount(0);
	await expect(settingsPage.locator('.ash-configuration-setting')).toHaveCount(0);
	await expect(settings.getByText('No settings found.')).toBeHidden();
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	await expect(settings.locator('[data-configuration-key="workbench.layoutStyle"]')).toHaveCount(0);
	const searchSettings = settings.getByRole('searchbox', { name: 'Search settings' });
	await expect(settings.locator('.ash-sessions-settings-search svg[data-ash-icon-id="search"]')).toBeVisible();
	await searchSettings.fill('layout');
	await expect(settings.getByRole('heading', { name: 'Search results' })).toBeVisible();
	await expect(settings.locator('.ash-configuration-setting')).toHaveCount(1);
	await searchSettings.fill('unmatched-setting');
	await expect(settings.getByText('No settings found.')).toBeVisible();
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	const originalViewport = page.viewportSize();
	if (!originalViewport) throw new Error('Browser test requires a viewport');
	await page.setViewportSize({ width: 540, height: 500 });
	const narrowSidebarBounds = await sidebar.boundingBox();
	const narrowPageBounds = await settingsPage.boundingBox();
	expect(narrowSidebarBounds).not.toBeNull();
	expect(narrowPageBounds).not.toBeNull();
	expect(narrowSidebarBounds!.y + narrowSidebarBounds!.height).toBeLessThanOrEqual(narrowPageBounds!.y + 1);
	await expect(settings.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
	await page.setViewportSize(originalViewport);
	const layoutStyle = settings.locator('[data-configuration-key="sessions.layoutStyle"]').getByRole('combobox');
	const originalLayoutStyle = (await layoutStyle.textContent())!.trim();
	const changedLayoutStyle = originalLayoutStyle === 'Flat' ? 'Modern' : 'Flat';
	await layoutStyle.click();
	await page.getByRole('option', { name: changedLayoutStyle }).click();
	await expect(layoutStyle).toHaveText(changedLayoutStyle);
	await expectActivityIconSize(activityNavigation, 24);
	await layoutStyle.click();
	await page.getByRole('option', { name: originalLayoutStyle }).click();
	await page.keyboard.press('Escape');
	await expect(settings).toHaveCount(0);
	await expect(accounts).toBeFocused();
	const chatButton = activityBar.locator('button').first();
	const buttonBounds = await chatButton.boundingBox();
	const iconBounds = await chatButton.locator('svg').boundingBox();
	expect(buttonBounds).not.toBeNull();
	expect(iconBounds).not.toBeNull();
	expect(buttonBounds!.width).toBe(36);
	expect(buttonBounds!.height).toBe(36);
	expect(iconBounds!.width).toBe(24);
	expect(iconBounds!.height).toBe(24);
	const collaborationIcon = activityBar.locator('button svg[data-ash-icon-id="colab"]');
	await expect(collaborationIcon).toHaveCSS('width', '24px');
	expect(Math.abs(iconBounds!.x + iconBounds!.width / 2 - (buttonBounds!.x + buttonBounds!.width / 2))).toBeLessThanOrEqual(1);
	expect(Math.abs(iconBounds!.y + iconBounds!.height / 2 - (buttonBounds!.y + buttonBounds!.height / 2))).toBeLessThanOrEqual(1);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Size' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Compact' }).click();
	await expect.poll(() => chatButton.evaluate(button => button.getBoundingClientRect().width)).toBe(28);
	await expect(collaborationIcon).toHaveCSS('width', '16px');
	await expectActivityIconSize(activityNavigation, 16);
	await expect.poll(() => activityBar.evaluate(bar => bar.getBoundingClientRect().width)).toBe(36);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Top' }).click();
	await expect(activityBar).toBeHidden();
	const topHost = page.locator('.ash-sessions-activity-host.top');
	await expect(topHost).toBeVisible();
	await expectActivityIconSize(activityNavigation, 16);
	await expect(topHost.locator('button').first()).toHaveAttribute('aria-label', /Chat/);
	await topHost.locator('button').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Bottom' }).click();
	await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
	await expect(topHost).toBeHidden();
	await expectActivityIconSize(activityNavigation, 16);
	await page.locator('.ash-sessions-activity-host.bottom button').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Default' }).click();
	await expect(activityBar).toBeVisible();
	await expect.poll(() => activityBar.evaluate(bar => bar.getBoundingClientRect().width)).toBe(36);
	await expectActivityIconSize(activityNavigation, 16);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Size' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Default' }).click();
	await expectActivityIconSize(activityNavigation, 24);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Top' }).click();
	await expect(topHost).toBeVisible();
	await expectActivityIconSize(activityNavigation, 16);
	await topHost.locator('button').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Default' }).click();
	await expectActivityIconSize(activityNavigation, 24);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Hidden' }).click();
	await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeHidden();
	await expect(activityBar).toBeHidden();
});

test('Browser Sessions settings scroll each pane independently', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Requires the browser Code Sessions page');
	const page = workbench.page;
	await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	await page.locator('.ash-sessions-activity-bottom button').last().click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
	const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	const originalViewport = page.viewportSize();
	if (!originalViewport) throw new Error('Browser test requires a viewport');
	try {
		await page.setViewportSize({ width: 1080, height: 420 });
		const navigationViewport = navigation.locator('.ash-scrollbar-viewport');
		const contentViewport = settings.locator('.ash-sessions-settings-page .ash-scrollbar-viewport');
		await expect(navigationViewport).toHaveCSS('scrollbar-width', 'none');
		await expect(contentViewport).toHaveCSS('scrollbar-width', 'none');
		await expect(navigation.locator('.ash-scrollbar-track-vertical')).toHaveCount(1);
		await expect(settings.locator('.ash-sessions-settings-page .ash-scrollbar-track-vertical')).toHaveCount(1);
		await expect.poll(() => navigationViewport.evaluate(viewport => viewport.scrollHeight > viewport.clientHeight)).toBe(true);
		await expect.poll(() => contentViewport.evaluate(viewport => viewport.scrollHeight > viewport.clientHeight)).toBe(true);
		await contentViewport.hover({ position: { x: 10, y: 10 } });
		await page.mouse.wheel(0, 300);
		await expect.poll(() => contentViewport.evaluate(viewport => viewport.scrollTop)).toBeGreaterThan(0);
		await expect(navigationViewport).toHaveJSProperty('scrollTop', 0);
		const contentScrollTop = await contentViewport.evaluate(viewport => viewport.scrollTop);
		await navigationViewport.hover({ position: { x: 10, y: 10 } });
		await page.mouse.wheel(0, 300);
		await expect.poll(() => navigationViewport.evaluate(viewport => viewport.scrollTop)).toBeGreaterThan(0);
		await expect(contentViewport).toHaveJSProperty('scrollTop', contentScrollTop);
		await navigation.getByRole('button', { name: 'General' }).click();
		await expect(contentViewport).toHaveJSProperty('scrollTop', 0);
	} finally {
		await page.setViewportSize(originalViewport);
	}
});

test('Browser Models Settings controls which models appear in the picker', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires browser Code Sessions with App Server');
	const page = workbench.page;
	await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	const modelButton = page.locator('[data-action-id="ash.chat.input.model"] button').first();
	await expect(modelButton).toBeVisible();
	const accounts = page.locator('.ash-sessions-activity-bottom button').last();
	await accounts.click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
	await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Models' }).click();
	await expect(settings.locator('.ash-local-transcription-model-controls')).toHaveCount(0);

	await expect(settings.getByRole('heading', { name: 'API connections' })).toBeVisible();
	const apiConnection = settings.locator('.ash-models-settings-api-row').first();
	await expect(apiConnection).toBeVisible();
	await expect(apiConnection.locator('input[type="password"]')).toBeVisible();
	const apiName = (await apiConnection.locator('h5').textContent())!.trim();
	const modelRows = settings.locator('.ash-models-settings-model-row');
	await expect(modelRows.first()).toBeVisible();
	const firstModel = modelRows.first();
	const modelName = (await firstModel.locator('.ash-models-settings-model-copy > span').first().textContent())!.trim();
	const modelSearch = settings.getByRole('searchbox', { name: 'Search settings' });
	await modelSearch.fill('no-such-model');
	await expect(settings.getByText('No settings found.', { exact: true })).toBeVisible();
	await expect(modelRows.first()).toBeHidden();
	await modelSearch.fill(apiName);
	await expect(apiConnection).toBeVisible();
	await modelSearch.fill(modelName);
	await expect(firstModel).toBeVisible();
	const visibility = firstModel.getByRole('switch', { name: `Show ${modelName} in model picker` });
	await expect(visibility).toHaveAttribute('aria-checked', 'true');
	await firstModel.locator('.ash-switch-track').click();
	await expect(visibility).toHaveAttribute('aria-checked', 'false');
	await page.keyboard.press('Escape');
	await modelButton.click();
	await expect(page.locator('.ash-chat-model-picker').getByText(modelName, { exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await accounts.click();
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Models' }).click();
	const restoredVisibility = settings.getByRole('switch', { name: `Show ${modelName} in model picker` });
	await expect(restoredVisibility).toHaveAttribute('aria-checked', 'false');
	await restoredVisibility.locator('..').locator('.ash-switch-track').click();
	await expect(restoredVisibility).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	await modelButton.click();
	await expect(page.locator('.ash-chat-model-picker').getByText(modelName, { exact: true })).toBeVisible();
});

test('Electron Code Sessions Activity Bar follows its position and size settings', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'Requires the Code Sessions window');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const sessionPagePromise = application.waitForEvent('window');
	await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const page = await sessionPagePromise;
	const original = await page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return (await ipc.invoke('ash:configuration:read') as { document: { source: string } }).document.source;
	});
	const updateSettings = async (location: string, compact: boolean): Promise<void> => {
		await page.evaluate(async values => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { version: 1; source: string } };
			const settings = JSON.parse(snapshot.document.source) as Record<string, unknown>;
			settings['sessions.activityBar.location'] = values.location;
			settings['sessions.activityBar.compact'] = values.compact;
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
		}, { location, compact });
	};
	try {
		await updateSettings('default', false);
		await expect(page.locator('[data-part="activitybar"]')).toHaveClass(/ash-sessions-activitybar/u);
		await expect(page.locator('.ash-workbench-activitybar, .ash-activity-bar-content')).toHaveCount(0);
		const activityNavigation = page.locator('.ash-sessions-activity-content');
		await expectActivityIconSize(activityNavigation, 24);
		const collaboration = page.locator('[data-part="activitybar"]').getByRole('button', { name: 'Collaboration' });
		const library = page.locator('[data-part="activitybar"]').getByRole('button', { name: 'Library' });
		await collaboration.click();
		await expect(collaboration.locator('svg')).toHaveAttribute('data-ash-icon-id', 'colab-filled');
		await expect(page.locator('.ash-sessions-list-controls')).toBeHidden();
		await library.click();
		await expect(library.locator('svg')).toHaveAttribute('data-ash-icon-id', 'library-filled');
		await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
		await expect(page.locator('[data-part="auxiliarybar"] h2')).toBeHidden();
		await page.locator('[data-part="activitybar"]').getByRole('button', { name: 'Chat' }).click();
		await expect(page.locator('.ash-sessions-list-controls')).toBeVisible();
		const chatButton = page.locator('[data-part="activitybar"] button').first();
		await expect(chatButton).toBeVisible();
		await chatButton.click({ button: 'right' });
		await page.keyboard.press('Escape');
		await updateSettings('default', true);
		await expect.poll(() => chatButton.evaluate(button => button.getBoundingClientRect().width)).toBe(28);
		await expectActivityIconSize(activityNavigation, 16);
		await updateSettings('top', true);
		await expect(page.locator('[data-part="activitybar"]')).toBeHidden();
		await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
		await expectActivityIconSize(activityNavigation, 16);
		await page.reload();
		await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
		await expectActivityIconSize(activityNavigation, 16);
		await updateSettings('bottom', true);
		await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
		await expectActivityIconSize(activityNavigation, 16);
		await updateSettings('top', false);
		await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
		await expectActivityIconSize(activityNavigation, 16);
		await updateSettings('default', false);
		await expect(page.locator('[data-part="activitybar"]')).toBeVisible();
		await expectActivityIconSize(activityNavigation, 24);
	} finally {
		await page.evaluate(async source => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number };
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source } });
		}, original);
	}
});

test('Electron Sessions account menu opens the Sessions settings page', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'Requires the Code Sessions window');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	if (process.platform === 'darwin') {
		// The system menu is outside Playwright's page DOM; use the product's custom menu for this UI flow.
		await workbench.page.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { version: 1; source: string } };
			const settings = JSON.parse(snapshot.document.source) as Record<string, unknown>;
			settings['window.menuStyle'] = 'custom';
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
		});
	}
	const sessionPagePromise = application.waitForEvent('window');
	await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const page = await sessionPagePromise;
	const accountButton = page.locator('[data-part="activitybar"] .ash-sessions-activity-bottom button').last();
	await accountButton.click();
	await expect(accountButton).toHaveAttribute('aria-expanded', 'true');
	await page.getByRole('menuitem', { name: 'Settings' }).click();
	const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
	await expect(settings).toBeVisible();
	for (const card of await settings.locator('.ash-sessions-settings-list.ash-settings-card').all()) {
		await expect(card).toHaveCSS('border-radius', '8px');
	}
	const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
	await expect(navigation.locator('.ash-scrollbar-viewport')).toHaveCSS('scrollbar-width', 'none');
	await expect(settings.locator('.ash-sessions-settings-page .ash-scrollbar-viewport')).toHaveCSS('scrollbar-width', 'none');
	await expect(navigation.locator('.ash-scrollbar-track-vertical')).toHaveCount(1);
	await expect(settings.locator('.ash-sessions-settings-page .ash-scrollbar-track-vertical')).toHaveCount(1);
	const sidebarBounds = await settings.locator('.ash-sessions-settings-sidebar').boundingBox();
	const scrollTrackBounds = await navigation.locator('.ash-scrollbar-track-vertical').boundingBox();
	expect(sidebarBounds).not.toBeNull();
	expect(scrollTrackBounds).not.toBeNull();
	expect(Math.abs(sidebarBounds!.x + sidebarBounds!.width - scrollTrackBounds!.x - scrollTrackBounds!.width)).toBeLessThanOrEqual(2);
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	await expect(settings.locator('[data-configuration-key="sessions.layoutStyle"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="sessions.activityBar.location"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="sessions.activityBar.compact"]')).toBeVisible();
	await navigation.getByRole('button', { name: 'General' }).click();
	await expect(settings.locator('[data-configuration-key="dictation.backend"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="dictation.cloudProvider"]')).toHaveCount(0);
	await expect(settings.getByRole('grid', { name: 'Local dictation models' })).toBeVisible();
	await expect(settings.locator('.ash-local-transcription-model-controls')).toBeVisible();
	await navigation.getByRole('button', { name: 'General' }).click();
	await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsActivityBar"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsSettings"]')).toBeVisible();
	await expect(settings.locator('[data-configuration-key="workbench.layoutStyle"]')).toHaveCount(0);
	await navigation.getByRole('button', { name: 'Models' }).click();
	await expect(settings.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
	await expect(settings.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
	await expect(settings.locator('.ash-local-transcription-model-controls')).toHaveCount(0);
	await expect(settings.getByRole('heading', { name: 'API connections' })).toBeVisible();
	if (target.appServerMode === 'required') {
		await expect(settings.locator('.ash-models-settings-api-row').first().locator('input[type="password"]')).toBeVisible();
		const firstModel = settings.locator('.ash-models-settings-model-row').first();
		await expect(firstModel).toBeVisible();
		const visibility = firstModel.getByRole('switch');
		await expect(visibility).toHaveAttribute('aria-checked', 'true');
		await firstModel.locator('.ash-switch-track').click();
		await expect(visibility).toHaveAttribute('aria-checked', 'false');
		await firstModel.locator('.ash-switch-track').click();
		await expect(visibility).toHaveAttribute('aria-checked', 'true');
	}
	await navigation.getByRole('button', { name: 'Appearance' }).click();
	const layoutStyle = settings.locator('[data-configuration-key="sessions.layoutStyle"]').getByRole('combobox');
	const originalLayoutStyle = (await layoutStyle.textContent())!.trim();
	const changedLayoutStyle = originalLayoutStyle === 'Flat' ? 'Modern' : 'Flat';
	await layoutStyle.click();
	await page.getByRole('option', { name: changedLayoutStyle }).click();
	await expect(layoutStyle).toHaveText(changedLayoutStyle);
	await layoutStyle.click();
	await page.getByRole('option', { name: originalLayoutStyle }).click();
	await expect(settings.locator('.ash-dialog-actions')).toHaveCount(0);
	const dialogBounds = await settings.boundingBox();
	expect(dialogBounds).not.toBeNull();
	await page.mouse.click(dialogBounds!.x - 8, dialogBounds!.y - 8);
	await expect(settings).toHaveCount(0);
	await expect(accountButton).toBeFocused();
});

test('Sessions and IDE layout styles switch independently', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'Requires the Code Sessions window');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const sessionsPagePromise = application.waitForEvent('window');
	await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionsPagePromise;
	const sessionsWindow = sessionsPage.locator('.ash-sessions-window');
	await expect(sessionsWindow).toBeVisible();
	const original = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return (await ipc.invoke('ash:configuration:read') as { document: { source: string } }).document.source;
	});
	const updateSettings = async (values: Record<string, string>): Promise<void> => {
		await sessionsPage.evaluate(async changes => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { version: 1; source: string } };
			const settings = JSON.parse(snapshot.document.source) as Record<string, unknown>;
			for (const [key, value] of Object.entries(changes)) settings[key] = value;
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
		}, values);
	};
	const gap = () => sessionsPage.evaluate(() => {
		const sidebar = document.querySelector<HTMLElement>('[data-part="sidebar"]');
		const sessions = document.querySelector<HTMLElement>('[data-part="sessions"]');
		if (!sidebar || !sessions) throw new Error('Sessions regions are missing');
		return Math.round(sessions.getBoundingClientRect().left - sidebar.getBoundingClientRect().right);
	});
	try {
		await updateSettings({ 'workbench.layoutStyle': 'modern', 'sessions.layoutStyle': 'modern' });
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'modern');
		await expect.poll(gap).toBe(0);
		await expect(sessionsPage.locator('[data-part="activitybar"]')).toHaveCSS('border-top-left-radius', '0px');
		await expect(sessionsPage.locator('.ash-sessions-content-card')).toHaveCSS('border-radius', '12px');
		await updateSettings({ 'workbench.layoutStyle': 'flat' });
		await expect(workbench.element).toHaveAttribute('data-layout-style', 'flat');
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'modern');
		await updateSettings({ 'sessions.layoutStyle': 'flat' });
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'flat');
		await expect.poll(gap).toBe(0);
		await expect(sessionsPage.locator('[data-part="sessions"]')).toHaveCSS('border-top-left-radius', '0px');
		await sessionsPage.reload();
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'flat');
		await expect.poll(gap).toBe(0);
		await updateSettings({ 'sessions.layoutStyle': 'modern' });
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'modern');
		await expect.poll(gap).toBe(0);
		await expect(sessionsPage.locator('[data-part="sessions"]')).toHaveCSS('border-top-left-radius', '0px');
		await expect(sessionsPage.locator('[data-part="activitybar"]')).toHaveCSS('border-top-left-radius', '0px');
		await expect(sessionsPage.locator('.ash-sessions-content-card')).toHaveCSS('border-radius', '12px');
	} finally {
		await sessionsPage.evaluate(async source => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number };
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source } });
		}, original);
	}
});

test('Sessions applies an installed extension color theme', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires Code Sessions and App Server extension resources');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const openSessions = workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button");
	const sessionPagePromise = application.waitForEvent('window');
	await openSessions.click();
	const sessionsPage = await sessionPagePromise;
	await expect(sessionsPage.locator('.ash-code-sessions-window')).toBeVisible();
	await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { source: string } };
		const values = JSON.parse(snapshot.document.source);
		values['workbench.colorTheme'] = 'extension-vscode-theme-defaults-visual-studio-dark';
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(values) } });
	});
	await expect(sessionsPage.locator('#app')).toHaveAttribute('data-color-theme', 'extension-vscode-theme-defaults-visual-studio-dark');
	await expect.poll(() => sessionsPage.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim())).toBe('#1e1e1e');
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'extension-vscode-theme-defaults-visual-studio-dark');
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim())).toBe('#1e1e1e');
});

test('Open in Agents moves the IDE chat draft into the Agents Window', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the Code Electron chat shell');
	if (target.kind !== 'electron' || !('windows' in application)) throw new Error('Agents Window handoff requires Electron');

	const workbenchPage = workbench.page;
	if (!await workbenchPage.locator('.ash-chat-view-pane').isVisible()) {
		await workbenchPage.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const sourceChat = workbenchPage.locator('.ash-chat-view-pane .ash-chat').first();
	const sourceDraft = sourceChat.getByRole('textbox', { name: 'Chat message' });
	const sourceLine = sourceChat.locator('.ash-chat-input-editor .stanza-editor-line-text').first();
	await sourceDraft.focus();
	await workbenchPage.keyboard.insertText('Continue reviewing this change in Agents Window');
	await workbenchPage.getByRole('button', { name: 'Hide Secondary Side Bar', exact: true }).click();
	const auxiliaryBar = workbenchPage.locator('[data-part="auxiliarybar"]');
	await expect(auxiliaryBar).toBeHidden();

	const sessionsPagePromise = application.waitForEvent('window');
	await workbenchPage.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionsPagePromise;
	const targetEditor = new Editor(sessionsPage.locator('.ash-sessions-chat-slot.active:visible'));
	await targetEditor.waitForEditorContents(contents => contents === 'Continue reviewing this change in Agents Window');
	await expect(auxiliaryBar).toBeHidden();
	await expect(sourceLine).toHaveText('');
	const activityNavigation = sessionsPage.locator('.ash-sessions-activity-content');
	await activityNavigation.getByRole('button', { name: 'Code', exact: true }).click();
	await replaceChatInput(targetEditor, 'Keep this Code draft during handoff');

	await sessionsPage.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+W' : 'Control+Alt+W');
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('/workbench/workbench.html'))).toBe(true);
	await workbenchPage.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	await sourceDraft.focus();
	await workbenchPage.keyboard.insertText('Keep this second draft in the IDE');
	await expect(sourceLine).toHaveText('Keep this second draft in the IDE');
	await workbenchPage.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	await targetEditor.waitForEditorContents(contents => contents === 'Continue reviewing this change in Agents Window');
	await expect(sourceLine).toHaveText('Keep this second draft in the IDE');
	await activityNavigation.getByRole('button', { name: 'Code', exact: true }).click();
	await targetEditor.waitForEditorContents(contents => contents === 'Keep this Code draft during handoff');
});

test('Open in Agents selects the same session thread in the Agents Window', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Requires Code Electron with App Server');
	if (target.kind !== 'electron' || !('windows' in application)) throw new Error('Agents Window handoff requires Electron');

	const workbenchPage = workbench.page;
	if (!await workbenchPage.locator('.ash-chat-view-pane').isVisible()) {
		await workbenchPage.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const sourceChat = workbenchPage.locator('.ash-chat-view-pane .ash-chat:visible');
	await sourceChat.getByRole('textbox', { name: 'Chat message' }).focus();
	await workbenchPage.keyboard.insertText('Create a session for the window handoff test');
	await sourceChat.locator('[data-action-id="ash.chat.input.send"] button').click();
	await expect(sourceChat).toHaveAttribute('data-session-id', /.+/u);
	const sessionId = await sourceChat.getAttribute('data-session-id');
	const threadId = await sourceChat.getAttribute('data-thread-id');
	expect(sessionId).toBeTruthy();
	expect(threadId).toBeTruthy();

	const sessionsPagePromise = application.waitForEvent('window');
	await workbenchPage.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionsPagePromise;
	const targetChat = sessionsPage.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
	await expect(targetChat).toHaveAttribute('data-session-id', sessionId!);
	await expect(targetChat).toHaveAttribute('data-thread-id', threadId!);
	const sessionTitle = (await sessionsPage.locator('.ash-sessions-chat-slot.active:visible .ash-sessions-chat-slot-title').textContent())!;
	const navigation = sessionsPage.locator('.ash-sessions-activity-content');
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await sessionsPage.locator('.ash-sessions-list-item').filter({ hasText: sessionTitle }).click();
	const codeChat = sessionsPage.locator('.ash-sessions-chat-slot.active:visible .ash-chat');
	await expect(codeChat).toHaveAttribute('data-session-id', sessionId!);
	await expect(codeChat).toHaveAttribute('data-thread-id', threadId!);
	await replaceChatInput(new Editor(codeChat), 'Code draft for the same conversation');
	await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
	const chatEditor = new Editor(sessionsPage.locator('.ash-sessions-chat-slot.active:visible .ash-chat'));
	await chatEditor.waitForEditorContents(contents => contents === '');
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await sessionsPage.locator('.ash-sessions-chat-slot.active:visible .ash-sessions-chat-slot-close').click();
	await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
	await expect(targetChat).toHaveAttribute('data-session-id', sessionId!);
	await expect(targetChat).toHaveAttribute('data-thread-id', threadId!);
});

test("Code opens Sessions in a dedicated Electron window and returns to Workbench", async ({ application, target, workbench }) => {
	test.skip(
		target.kind !== "electron" || target.workbenchMode !== "code",
		"This scenario verifies the Code Electron Sessions window.",
	);
	if (target.kind !== "electron") {
		return;
	}
	if (!("windows" in application)) {
		throw new Error("Dedicated Sessions window verification requires Electron");
	}

	const workbenchPage = workbench.page;
	const openSessions = workbenchPage.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button");
	await expect(openSessions).toBeVisible();
	const sessionPagePromise = application.waitForEvent("window");
	await openSessions.click();
	const sessionsPage = await sessionPagePromise;
	await sessionsPage.waitForLoadState("domcontentloaded");
	await expect(sessionsPage.locator(".ash-code-sessions-window")).toBeVisible();
	const resources = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		const configuration = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
		const keybindings = await ipc.invoke('ash:keybindings-resource:read') as { readonly revision: number; readonly bindings: readonly unknown[] };
		const connection = await ipc.invoke('ash:remote:connection') as { readonly kind: string };
		return { configurationRevision: configuration.revision, keybindingsRevision: keybindings.revision, bindings: keybindings.bindings.length, connectionKind: connection.kind };
	});
	expect(resources).toEqual({ configurationRevision: expect.any(Number), keybindingsRevision: expect.any(Number), bindings: expect.any(Number), connectionKind: 'local' });
	const childWindowOperations = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: {
			invoke(channel: string, params?: unknown): Promise<unknown>;
			on(channel: string, listener: (value: unknown) => void): { dispose(): void };
		} } }).ash.ipcRenderer;
		const windows = await ipc.invoke('ash:window:operation', { kind: 'list' }) as readonly { readonly id: number; readonly title: string }[];
		const sessions = windows.find(window => window.title.includes('Sessions'));
		if (!sessions) throw new Error('Sessions window is missing from window list');
		const zoomChange = new Promise<number>((resolve, reject) => {
			const subscription = ipc.on('ash:window:zoom-changed', value => {
				clearTimeout(timeout);
				subscription.dispose();
				resolve(value as number);
			});
			const timeout = setTimeout(() => {
				subscription.dispose();
				reject(new Error('Dedicated window zoom change was not delivered'));
			}, 2_000);
		});
		await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: 1 });
		const changedZoom = await zoomChange;
		const zoom = await ipc.invoke('ash:window:operation', { kind: 'getZoom' });
		await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: 0 });
		return { count: windows.length, changedZoom, zoom };
	});
	expect(childWindowOperations).toEqual({ count: 2, changedZoom: 1, zoom: 1 });
	await sessionsPage.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+W' : 'Control+Alt+W');
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('/workbench/workbench.html'))).toBe(true);
	await openSessions.click();
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('/sessions/sessions-code.html'))).toBe(true);
	const configurationChange = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: {
			invoke(channel: string, params?: unknown): Promise<unknown>;
			on(channel: string, listener: (value: unknown) => void): { dispose(): void };
		} } }).ash.ipcRenderer;
		const before = await ipc.invoke('ash:configuration:read') as { readonly revision: number; readonly document: { readonly version: 1; readonly source: string } };
		const changed = new Promise<number>((resolve, reject) => {
			const subscription = ipc.on('ash:configuration:changed', value => {
				clearTimeout(timeout);
				subscription.dispose();
				resolve((value as { readonly revision: number }).revision);
			});
			const timeout = setTimeout(() => {
				subscription.dispose();
				reject(new Error('Sessions configuration change was not delivered'));
			}, 2_000);
		});
		const updated = await ipc.invoke('ash:configuration:update', {
			expectedRevision: before.revision,
			document: { ...before.document, source: `${before.document.source}\n` },
		}) as { readonly revision: number };
		const notifiedRevision = await changed;
		await ipc.invoke('ash:configuration:update', { expectedRevision: updated.revision, document: before.document });
		return { updatedRevision: updated.revision, notifiedRevision };
	});
	expect(configurationChange.updatedRevision).toBe(configurationChange.notifiedRevision);
	await expect(sessionsPage.locator(".ash-code-sessions-window")).toHaveCSS("display", "flex");
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-workbench-mode", "code");
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-runtime", "electron");
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-workbench-state", "empty");
	await sessionsPage.emulateMedia({ colorScheme: "dark" });
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-color-theme", "ash-dark");
	await expect.poll(() => sessionsPage.locator("#app").evaluate(element => getComputedStyle(element).getPropertyValue("--ash-title-bar-background").trim())).toBe("#1e1e1e");
	await sessionsPage.emulateMedia({ colorScheme: "light" });
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-color-theme", "ash-light");
	await expect.poll(() => sessionsPage.locator("#app").evaluate(element => getComputedStyle(element).getPropertyValue("--ash-title-bar-background").trim())).toBe("#ffffff");
	const originalThemeSettings = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { readonly revision: number; readonly document: { readonly version: 1; readonly source: string } };
		const values = JSON.parse(snapshot.document.source);
		values['workbench.colorTheme'] = 'ash-dark';
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(values) } });
		return snapshot.document;
	});
	await expect(sessionsPage.locator('#app')).toHaveAttribute('data-color-theme', 'ash-dark');
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
	await sessionsPage.emulateMedia({ colorScheme: 'dark' });
	await sessionsPage.evaluate(async document => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document });
	}, originalThemeSettings);
	await expect(sessionsPage.locator('#app')).toHaveAttribute('data-color-theme', 'ash-dark');
	const titlebar = sessionsPage.locator("[data-part='titlebar']");
	await expect(titlebar).toBeVisible();
	await expect(titlebar).toHaveCSS('-webkit-app-region', 'drag');
	await expect(titlebar.getByRole('button').first()).toHaveCSS('-webkit-app-region', 'no-drag');
	await expect(titlebar.getByRole('button', { name: 'Return to Workbench' })).toHaveCount(0);
	await expect(titlebar.locator('.ash-sessions-titlebar-title, .ash-sessions-titlebar-avatar')).toHaveCount(0);
	const titlebarButtons = titlebar.locator('.ash-action-bar[role="toolbar"] button');
	await expect(titlebar.locator('.ash-action-bar[role="toolbar"]')).toHaveAttribute('aria-label', 'Title bar left actions');
	await expect(titlebarButtons).toHaveCount(4);
	const activityNavigation = sessionsPage.locator('.ash-sessions-activity-content');
	await expect(titlebar.getByRole('navigation', { name: 'Chat and Code' })).toHaveCount(0);
	await expect(activityNavigation.getByRole('button', { name: 'Chat' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'chat-2-filled');
	await expect(activityNavigation.getByRole('button', { name: 'Code' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'code');
	await expect(sessionsPage.locator('.ash-sessions-sidebar-tabs')).toHaveCount(0);
	const titlebarActionNames = await titlebarButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
	expect(titlebarActionNames).toEqual(['Application menu', 'Hide sidebar', 'Back', 'Forward']);
	await expect(titlebar).toHaveCSS('height', '35px');
	await expect(titlebar).toHaveCSS('border-bottom-width', '0px');
	const titlebarBounds = await titlebar.boundingBox();
	const buttonBounds = await titlebarButtons.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
	expect(buttonBounds.every((button, index) => button.right < titlebarBounds!.x + titlebarBounds!.width / 2 && (index === 0 || button.left > buttonBounds[index - 1].left))).toBe(true);
	if (process.platform === 'darwin') {
		const spacer = sessionsPage.locator('.ash-sessions-window-controls-spacer');
		await expect(spacer).toBeVisible();
		const [spacerBounds, controlsBounds] = await Promise.all([
			spacer.boundingBox(),
			titlebarButtons.first().boundingBox(),
		]);
		expect(controlsBounds!.x).toBeGreaterThanOrEqual(spacerBounds!.x + spacerBounds!.width);
		await sessionsPage.evaluate(async () => {
			const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: -2 });
		});
		await expect.poll(() => spacer.evaluate(element => Number.parseFloat(getComputedStyle(element).width))).toBeGreaterThan(90);
		await sessionsPage.evaluate(async () => {
			const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: 0 });
		});
		await application.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('sessions-code.html'));
			if (!window) throw new Error('Sessions window is missing');
			window.setFullScreen(true);
		});
		await expect(sessionsPage.locator('#app')).toHaveClass(/ash-sessions-fullscreen/u);
		await expect(spacer).toBeHidden();
		await application.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('sessions-code.html'));
			if (!window) throw new Error('Sessions window is missing');
			window.setFullScreen(false);
		});
		await expect(spacer).toBeVisible();
	}
	await expect(sessionsPage.locator("[data-part='activitybar']")).toBeVisible();
	const activityButtons = sessionsPage.locator("[data-part='activitybar'] button");
	expect(await activityButtons.locator('svg').evaluateAll(icons => icons.map(icon => icon.getAttribute('data-ash-icon-id')))).toEqual(['chat-2-filled', 'colab', 'library', 'device-mobile', 'account']);
	await expect(sessionsPage.locator('.ash-sessions-activity-bottom button')).toHaveCount(2);
	const chatButton = activityButtons.first();
	const chatButtonBounds = await chatButton.boundingBox();
	const chatIconBounds = await chatButton.locator('svg').boundingBox();
	expect(chatButtonBounds).not.toBeNull();
	expect(chatIconBounds).not.toBeNull();
	expect(chatButtonBounds!.width).toBe(36);
	expect(chatButtonBounds!.height).toBe(36);
	expect(Math.abs(chatIconBounds!.x + chatIconBounds!.width / 2 - (chatButtonBounds!.x + chatButtonBounds!.width / 2))).toBeLessThanOrEqual(1);
	expect(Math.abs(chatIconBounds!.y + chatIconBounds!.height / 2 - (chatButtonBounds!.y + chatButtonBounds!.height / 2))).toBeLessThanOrEqual(1);
	await expect(activityButtons.nth(1)).toBeEnabled();
	await expect(activityButtons.nth(2)).toBeEnabled();
	await expect(activityButtons.nth(3)).toBeDisabled();
	if (target.appServerMode === 'required') {
		await activityButtons.nth(4).click();
		await expect(activityButtons.nth(4)).toHaveAttribute('aria-expanded', 'true');
		if (process.platform !== 'darwin') {
			await expect(sessionsPage.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
			await expect(sessionsPage.getByRole('menuitem', { name: 'Return to Workbench' })).toBeVisible();
			await expect(sessionsPage.getByRole('menuitem', { name: 'Sign in with ChatGPT' })).toHaveCount(0);
		}
		await sessionsPage.keyboard.press('Escape');
	}
	await expect(sessionsPage.locator("[data-part='sidebar']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='sessions']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='auxiliarybar']")).toBeHidden();
	const sidebarToggle = titlebar.getByRole('button', { name: 'Hide sidebar' });
	await expect(sidebarToggle.locator('svg[data-ash-icon-id="layout-sidebar-left-2"]')).toBeVisible();
	const divider = await sessionsPage.evaluate(() => {
		const sidebar = document.querySelector<HTMLElement>('[data-part="sidebar"]')!;
		const sessions = document.querySelector<HTMLElement>('[data-part="sessions"]')!;
		return {
			gap: sessions.getBoundingClientRect().left - sidebar.getBoundingClientRect().right,
			sidebarRadius: getComputedStyle(sidebar).borderTopRightRadius,
			sessionsRadius: getComputedStyle(sessions).borderTopLeftRadius,
		};
	});
	expect(divider).toEqual({ gap: 0, sidebarRadius: '0px', sessionsRadius: '0px' });
	await sidebarToggle.click();
	await expect(sessionsPage.locator("[data-part='sidebar']")).toBeHidden();
	const showSidebar = titlebar.getByRole('button', { name: 'Show sidebar' });
	await expect(showSidebar.locator('svg[data-ash-icon-id="layout-sidebar-left-off-2"]')).toBeVisible();
	await showSidebar.click();
	await expect(sessionsPage.locator("[data-part='sidebar']")).toBeVisible();
	await titlebar.getByRole('button', { name: 'Application menu' }).click();
	await expect(titlebar.getByRole('button', { name: 'Application menu' })).toHaveAttribute('aria-expanded', 'true');
	await expect(sessionsPage.getByRole('menuitem', { name: 'File' })).toBeVisible();
	await sessionsPage.keyboard.press('Escape');
	await expect(sessionsPage.locator(".ash-sessions-list")).toHaveCSS("display", "flex");
	await expect(sessionsPage.locator(".ash-sessions-chat-slot").first()).toHaveCSS("display", "flex");
	await expect(sessionsPage.locator(".ash-chat-input-part")).toBeVisible();
	const search = sessionsPage.getByRole('searchbox', { name: 'Search sessions' });
	await search.fill('no matching session title');
	await expect(sessionsPage.locator('.ash-sessions-empty')).toHaveText('No matching sessions');
	await search.clear();
	await sessionsPage.locator('.ash-sessions-list-add').click();
	await expect(sessionsPage.locator(".ash-sessions-chat-slot")).toHaveCount(2);
	await expect(sessionsPage.locator(".ash-sessions-chat-slot.active")).toHaveCount(1);
	await sessionsPage.locator(".ash-sessions-chat-slot-close").last().click();
	await expect(sessionsPage.locator(".ash-sessions-chat-slot")).toHaveCount(1);
	await expect.poll(() => application.windows().length).toBe(2);

	const sessionWindowState = await application.evaluate(({ BrowserWindow }) => {
		const windows = BrowserWindow.getAllWindows();
		return windows.map((window: { readonly id: number; getTitle(): string; readonly webContents: { getURL(): string } }) => ({
			id: window.id,
			title: window.getTitle(),
			url: window.webContents.getURL(),
		}));
	});
	expect(sessionWindowState).toHaveLength(2);
	expect(sessionWindowState.some((window: { readonly url: string }) => window.url.includes("sessions-code.html"))).toBe(true);
	const windowIds = sessionWindowState.map((window: { readonly id: number }) => window.id).sort((left: number, right: number) => left - right);
	await openSessions.click();
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.id).sort((left, right) => left - right))).toEqual(windowIds);
	await sessionsPage.reload();
	await expect(sessionsPage.locator('.ash-code-sessions-window')).toBeVisible();
	await expect.poll(() => application.windows().length).toBe(2);
	const reloadedIpc = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		const configuration = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
		const keybindings = await ipc.invoke('ash:keybindings-resource:read') as { readonly bindings: readonly unknown[] };
		const connection = await ipc.invoke('ash:remote:connection') as { readonly kind: string };
		let childCannotOpen = false;
		try { await ipc.invoke('ash:native-host:open-agents-window'); } catch { childCannotOpen = true; }
		return { configurationRevision: configuration.revision, bindings: keybindings.bindings.length, connectionKind: connection.kind, childCannotOpen };
	});
	expect(reloadedIpc).toEqual({ configurationRevision: expect.any(Number), bindings: expect.any(Number), connectionKind: 'local', childCannotOpen: true });
	await expect(workbenchPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return ipc.invoke('ash:sessions:return-to-workbench');
	})).rejects.toThrow(/Untrusted renderer IPC sender/);
	const expectedBounds = await application.evaluate(({ BrowserWindow }) => {
		const child = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('sessions-code.html'));
		if (!child) throw new Error('Sessions window is missing');
		child.setBounds({ ...child.getBounds(), width: 1000, height: 700 });
		return child.getBounds();
	});

	const closed = sessionsPage.waitForEvent("close");
	await returnFromSessions(sessionsPage);
	await closed;
	await expect.poll(() => application.windows().length).toBe(1);
	await expect(workbenchPage.locator(".ash-workbench")).toBeVisible();
	await openSessions.click();
	await expect.poll(() => application.windows().length).toBe(2);
	const reopenedPage = application.windows().find(page => page !== workbenchPage);
	if (!reopenedPage) throw new Error('Reopened Sessions window is missing');
	await expect(reopenedPage.locator('.ash-code-sessions-window')).toBeVisible();
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
		const child = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('sessions-code.html'));
		return child?.getBounds();
	})).toEqual(expectedBounds);
	const reopenedClosed = reopenedPage.waitForEvent('close');
	await returnFromSessions(reopenedPage);
	await reopenedClosed;
	const parentClosed = workbenchPage.waitForEvent('close');
	await application.evaluate(({ BrowserWindow }) => {
		const parent = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.getURL().includes('workbench.html'));
		if (!parent) throw new Error('Workbench window is missing');
		parent.close();
	});
	await parentClosed;
});

test('Sessions menus and history actions stay independent from Workbench', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser' || process.platform !== 'darwin') {
		const workbenchMenu = page.getByRole('button', { name: 'Application menu', exact: true });
		await workbenchMenu.click();
		await page.getByRole('menuitem', { name: 'File', exact: true }).hover();
		await expect(page.getByRole('menuitem', { name: 'Return to Workbench', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
	}
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) { throw new Error('Expected Electron windows'); }
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	const toolbar = page.locator('.ash-sessions-titlebar-actions');
	const back = toolbar.getByRole('button', { name: 'Back', exact: true });
	const forward = toolbar.getByRole('button', { name: 'Forward', exact: true });
	await expect(back).toBeDisabled();
	await expect(forward).toBeDisabled();
	const sessions = page.locator('.ash-sessions-list-item');
	await expect(sessions).toHaveCount(1);
	const originalSession = sessions.filter({ hasText: 'New code session' });
	await expect(originalSession).toHaveAttribute('aria-current', 'page');
	await page.locator('.ash-sessions-list-add').click();
	await expect(sessions).toHaveCount(2);
	const newSession = sessions.filter({ hasText: /^New session$/u });
	await expect(newSession).toHaveAttribute('aria-current', 'page');
	await expect(back).toBeEnabled();
	await back.click();
	await expect(originalSession).toHaveAttribute('aria-current', 'page');
	await expect(back).toBeDisabled();
	await expect(forward).toBeEnabled();
	await forward.click();
	await expect(newSession).toHaveAttribute('aria-current', 'page');
	await expect(back).toBeEnabled();
	await expect(forward).toBeDisabled();
	await toolbar.getByRole('button', { name: 'Application menu', exact: true }).click();
	await page.getByRole('menuitem', { name: 'File', exact: true }).hover();
	await expect(page.getByRole('menuitem', { name: 'Return to Workbench', exact: true })).toBeVisible();
	const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
	await page.getByRole('menuitem', { name: 'Return to Workbench', exact: true }).click();
	await closed;
	await workbench.waitForReady();
});

test('Sessions titlebar aligns its application menu and actions', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const sessionsPagePromise = application.waitForEvent('window');
	await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionsPagePromise;
	const toolbar = sessionsPage.locator('[data-part="titlebar"] .ash-toolbar');
	const buttons = toolbar.getByRole('button');
	await expect(buttons).toHaveCount(4);
	await expect(toolbar).toHaveCSS('-webkit-app-region', 'no-drag');
	await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
	const activityNavigation = sessionsPage.locator('.ash-sessions-activity-content');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).not.toHaveAttribute('aria-current', 'page');
	await activityNavigation.getByRole('button', { name: 'Code' }).click();
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).toHaveAttribute('aria-current', 'page');
	await expect(sessionsPage.getByRole('region', { name: 'Code' })).toBeVisible();
	await expect(sessionsPage.locator('.ash-sessions-surface-header')).toHaveCount(0);
	await activityNavigation.getByRole('button', { name: 'Chat' }).click();
	await expect(sessionsPage.locator('.ash-sessions-surface-header')).toHaveCount(0);
	expect(await buttons.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(['Application menu', 'Hide sidebar', 'Back', 'Forward']);
	const columnOffset = await sessionsPage.evaluate(() => {
		const menu = document.querySelector<HTMLElement>('[data-action-id="ash.applicationMenu"] button')!;
		const chat = document.querySelector<HTMLElement>('[data-part="activitybar"] button')!;
		const menuBounds = menu.getBoundingClientRect();
		const chatBounds = chat.getBoundingClientRect();
		return menuBounds.x + menuBounds.width / 2 - (chatBounds.x + chatBounds.width / 2);
	});
	if (process.platform !== 'darwin') expect(Math.abs(columnOffset)).toBeLessThanOrEqual(1);
	const iconOffsets = await buttons.evaluateAll(buttons => buttons.map(button => {
		const buttonBounds = button.getBoundingClientRect();
		const iconBounds = button.querySelector('svg')!.getBoundingClientRect();
		return {
			x: iconBounds.x + iconBounds.width / 2 - (buttonBounds.x + buttonBounds.width / 2),
			y: iconBounds.y + iconBounds.height / 2 - (buttonBounds.y + buttonBounds.height / 2),
		};
	}));
	expect(Math.max(...iconOffsets.map(({ x, y }) => Math.max(Math.abs(x), Math.abs(y))))).toBeLessThanOrEqual(1);
	await toolbar.getByRole('button', { name: 'Hide sidebar' }).click();
	await expect(sessionsPage.locator('[data-part="sidebar"]')).toBeHidden();
	await toolbar.getByRole('button', { name: 'Show sidebar' }).click();
	await expect(sessionsPage.locator('[data-part="sidebar"]')).toBeVisible();
	await toolbar.getByRole('button', { name: 'Application menu' }).click();
	await expect(toolbar.getByRole('button', { name: 'Application menu' })).toHaveAttribute('aria-expanded', 'true');
	const closed = sessionsPage.waitForEvent('close');
	if (process.platform === 'darwin') {
		await sessionsPage.keyboard.press('Escape');
		await returnFromSessions(sessionsPage);
	} else {
		await sessionsPage.getByRole('menuitem', { name: 'File' }).hover();
		await expect(sessionsPage.getByRole('menuitem', { name: 'New Session' })).toHaveCount(0);
		await sessionsPage.getByRole('menuitem', { name: 'Return to Workbench' }).click();
	}
	await closed;
});

test('Sessions titlebar sidebar toggle stays transparent at rest and responds to pointer and keyboard', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	const workbenchToggle = workbench.page.locator('.ash-titlebar-left-actions [data-action-id="workbench.action.toggleSideBar"] button');
	await expect(workbenchToggle).toHaveCSS('border-radius', '4px');
	await workbenchToggle.hover();
	await expect(workbench.page.getByRole('tooltip')).toBeVisible();
	await expect(workbench.page.locator('.ash-context-view-hover')).toHaveCSS('border-radius', '6px');
	await expect.poll(() => workbench.page.locator('.ash-context-view-hover').evaluate(element => getComputedStyle(element, '::before').content)).toBe('""');
	await workbench.page.mouse.move(400, 180);
	await expect(workbenchToggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		page = await opened;
	}
	const sidebar = page.locator('[data-part="sidebar"]');
	const toggle = page.locator('[data-action-id="ash.sessions.toggleSidebar"] button');
	const navigation = page.locator('.ash-sessions-activity-content');
	const chat = navigation.getByRole('button', { name: 'Chat' });
	const library = navigation.getByRole('button', { name: 'Library' });
	const menu = page.getByRole('button', { name: 'Application menu', exact: true });
	for (const colorScheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme });
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', `ash-${colorScheme}`);
		await page.mouse.move(400, 180);
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		const selectedBackground = await chat.evaluate(button => getComputedStyle(button).backgroundColor);
		expect(selectedBackground).not.toBe('rgba(0, 0, 0, 0)');
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect.poll(() => page.locator('.ash-sessions-titlebar-actions button').evaluateAll(buttons => buttons.map(button => getComputedStyle(button).borderRadius))).toEqual(['8px', '8px', '8px', '8px']);
		await library.hover();
		await expect(library).toHaveCSS('background-color', selectedBackground);
		await menu.hover();
		await expect(menu).toHaveCSS('background-color', selectedBackground);
		await toggle.hover();
		await expect(toggle).toHaveCSS('background-color', selectedBackground);
		await expect(page.getByRole('tooltip')).toHaveText('Hide sidebar');
		await expect(page.locator('.ash-context-view-hover')).toHaveCSS('border-radius', '12px');
		await expect.poll(() => page.locator('.ash-context-view-hover').evaluate(element => getComputedStyle(element, '::before').content)).toBe('none');
		await toggle.click();
		await expect(sidebar).toBeHidden();
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await expect(toggle).toHaveAccessibleName('Show sidebar');
		await page.mouse.move(400, 180);
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await toggle.hover();
		await expect(toggle).toHaveCSS('background-color', selectedBackground);
		await toggle.click();
		await expect(sidebar).toBeVisible();
		await page.mouse.move(400, 180);
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await page.keyboard.press('Tab');
		await toggle.focus();
		await expect(toggle).toHaveCSS('outline-style', 'solid');
		await expect(toggle).toHaveCSS('outline-width', '1px');
		await page.keyboard.press('Enter');
		await expect(sidebar).toBeHidden();
		await page.keyboard.press('Space');
		await expect(sidebar).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(toggle).toHaveAccessibleName('Hide sidebar');
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(toggle).toHaveCSS('border-radius', '8px');
		await expect(toggle.locator('svg[data-ash-icon-id="layout-sidebar-left-2"]')).toBeVisible();
		await page.keyboard.press('ArrowLeft');
		await expect(menu).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(menu).toHaveAttribute('aria-expanded', 'true');
		await expect(menu).toHaveCSS('background-color', selectedBackground);
		await page.keyboard.press('Escape');
		await expect(menu).toHaveAttribute('aria-expanded', 'false');
		await expect(menu).toBeFocused();
		await page.mouse.move(400, 180);
		await expect(menu).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await page.keyboard.press('ArrowRight');
		await expect(toggle).toBeFocused();
	}
	if (target.kind === 'electron') {
		await expect(workbenchToggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(workbenchToggle).toHaveCSS('border-radius', '4px');
	}
});

test('Sessions titlebar sidebar toggle stays transparent at rest with hover and keyboard outlines in high contrast', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	for (const theme of ['Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const search = workbench.page.locator('.ash-quick-pick').getByRole('combobox');
		await search.fill(theme);
		await search.press('Enter');
		await expect(workbench.page.locator('.ash-quick-pick')).toHaveCount(0);
		let page = workbench.page;
		if (target.kind === 'browser') {
			await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
		} else {
			if (!('windows' in application)) { throw new Error('Expected Electron windows'); }
			const opened = application.waitForEvent('window');
			await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
			page = await opened;
		}
		await expect(page.locator('#app')).toHaveAttribute('data-color-scheme', theme.endsWith('Dark') ? 'high-contrast-dark' : 'high-contrast-light');
		const navigation = page.locator('.ash-sessions-activity-content');
		const chat = navigation.getByRole('button', { name: 'Chat' });
		const library = navigation.getByRole('button', { name: 'Library' });
		const toggle = page.locator('[data-action-id="ash.sessions.toggleSidebar"] button');
		await page.mouse.move(400, 180);
		const selectedBackground = await chat.evaluate(button => getComputedStyle(button).backgroundColor);
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(toggle).toHaveCSS('outline-style', 'none');
		await expect(chat).toHaveCSS('outline-style', 'solid');
		await library.hover();
		await expect(library).toHaveCSS('background-color', selectedBackground);
		await expect(library).toHaveCSS('outline-style', 'solid');
		await toggle.hover();
		await expect(toggle).toHaveCSS('background-color', selectedBackground);
		await expect(toggle).toHaveCSS('outline-style', 'solid');
		await toggle.click();
		await page.mouse.move(400, 180);
		await expect(page.locator('[data-part="sidebar"]')).toBeHidden();
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(toggle).toHaveCSS('outline-style', 'none');
		await toggle.click();
		await page.mouse.move(400, 180);
		await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(toggle).toHaveCSS('outline-style', 'none');
		await page.keyboard.press('Tab');
		await toggle.focus();
		await expect(toggle).toHaveCSS('outline-style', 'solid');
		await expect(toggle).toHaveCSS('outline-width', '1px');
		const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
		await returnFromSessions(page);
		await closed;
		await expect(workbench.page.locator('.ash-workbench')).toBeVisible();
	}
});

test('Browser Sessions application menu uses Sessions actions', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code');
	await workbench.page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	const menu = workbench.page.getByRole('button', { name: 'Application menu' });
	await menu.click();
	await workbench.page.getByRole('menuitem', { name: 'File' }).hover();
	await expect(workbench.page.getByRole('menuitem', { name: 'Return to Workbench' })).toBeVisible();
	await expect(workbench.page.getByRole('menuitem', { name: 'New Session' })).toHaveCount(0);
	await workbench.page.getByRole('menuitem', { name: 'Return to Workbench' }).click();
	await expect(workbench.page).toHaveURL(/\/workbench\/workbench\.html$/u);
});

test('Sessions Activity Bar tooltips follow side, top and bottom placement without replacing buttons', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	const navigation = page.locator('.ash-sessions-activity-content');
	const chat = navigation.getByRole('button', { name: /^Chat(?:\.|$)/u });
	const accounts = navigation.getByRole('button', { name: 'Accounts', exact: true });
	const originalChat = await chat.elementHandle();
	const originalAccounts = await accounts.elementHandle();
	const checkTooltip = async (trigger: Locator, label: string, direction: 'right' | 'below' | 'above', keyboard = false): Promise<void> => {
		await page.mouse.move(600, 400);
		if (keyboard) {
			await page.getByRole('button', { name: 'Application menu', exact: true }).focus();
			await trigger.focus();
		} else {
			await trigger.hover();
		}
		const tooltip = page.getByRole('tooltip');
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toHaveText(label);
		const [anchor, hover] = await Promise.all([trigger.boundingBox(), page.locator('.ash-context-view-hover', { has: tooltip }).boundingBox()]);
		expect(anchor).not.toBeNull();
		expect(hover).not.toBeNull();
		if (direction === 'right') expect(hover!.x).toBeGreaterThanOrEqual(anchor!.x + anchor!.width);
		if (direction === 'below') expect(hover!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height);
		if (direction === 'above') expect(hover!.y + hover!.height).toBeLessThanOrEqual(anchor!.y);
		await expect(trigger).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') ?? '');
		await expect(page.locator('.ash-context-view-hover')).toHaveCSS('border-radius', '12px');
		await page.keyboard.press('Escape');
		await expect(tooltip).toHaveCount(0);
		await expect(trigger).not.toHaveAttribute('aria-describedby');
		if (keyboard) await expect(trigger).toBeFocused();
	};
	const setPosition = async (position: string): Promise<void> => {
		await accounts.click({ button: 'right' });
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'Activity Bar Position' }).press('ArrowRight');
		await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: position, exact: true }).click();
	};
	await checkTooltip(chat, 'Chat', 'right');
	for (const label of ['Collaboration', 'Library', 'Code', 'Mobile devices (coming soon)', 'Accounts']) {
		await checkTooltip(navigation.getByRole('button', { name: label, exact: true }), label, 'right');
	}
	await checkTooltip(accounts, 'Accounts', 'right', true);
	await setPosition('Top');
	await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
	await checkTooltip(chat, 'Chat', 'below', true);
	await checkTooltip(accounts, 'Accounts', 'below');
	await page.emulateMedia({ colorScheme: 'dark' });
	await setPosition('Bottom');
	await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
	await checkTooltip(chat, 'Chat', 'above');
	await checkTooltip(accounts, 'Accounts', 'above', true);
	await setPosition('Default');
	await expect(page.locator('[data-part="activitybar"]')).toBeVisible();
	await accounts.click({ button: 'right' });
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Activity Bar Size' }).press('ArrowRight');
	await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: 'Compact', exact: true }).click();
	await expect(navigation).toHaveClass(/compact/u);
	await page.setViewportSize({ width: 900, height: 600 });
	await checkTooltip(chat, 'Chat', 'right');
	expect(await chat.evaluate((element, original) => element === original, originalChat)).toBe(true);
	expect(await accounts.evaluate((element, original) => element === original, originalAccounts)).toBe(true);
	await originalChat!.dispose();
	await originalAccounts!.dispose();
	const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
	await returnFromSessions(page);
	await closed;
});

test('Sessions Activity Bar switches Chat and Code with the keyboard with independent drafts and attachments', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		page = await opened;
	}
	const activityNavigation = page.locator('.ash-sessions-activity-content');
	await expect(page.locator('[data-part="titlebar"] .ash-sessions-chat-code-switch')).toHaveCount(0);
	await expect(page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Code', exact: true })).toHaveCount(0);
	const editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await replaceChatInput(editor, 'Keep this draft');
	const originalInput = await editor.input.elementHandle();
	const composer = page.locator('.ash-sessions-chat-input:visible').first();
	const card = composer.locator('.ash-chat-input-container');
	await expect(composer).toHaveClass(/chat-composer/u);
	// Exercise the public presentation boundary with a Chat-only style change.
	const chatStyle = await page.addStyleTag({ content: '.ash-chat > .ash-chat-input-part.ash-sessions-chat-input.chat-composer { --ash-chat-input-radius: 4px; --ash-chat-input-min-height: 180px; }' });
	await expect(card).toHaveCSS('border-radius', '4px');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
	await activityNavigation.getByRole('button', { name: 'Library' }).focus();
	await page.keyboard.press('Tab');
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).toBeFocused();
	await page.keyboard.press('Enter');
	if (target.kind === 'browser') await expect(page).toHaveURL(/sessions-code\.html$/u);
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).toHaveAttribute('aria-current', 'page');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' })).not.toHaveAttribute('aria-current', 'page');
	await expect(activityNavigation.locator('[aria-current="page"]')).toHaveCount(1);
	await expect(page.getByRole('region', { name: 'Code' })).toBeVisible();
	await expect(composer).toHaveClass(/code-composer/u);
	await expect(composer).not.toHaveClass(/chat-composer/u);
	await expect(card).toHaveCSS('border-radius', '12px');
	await expect(card).toHaveCSS('min-height', '112px');
	await editor.waitForEditorContents(contents => contents === '');
	expect(await editor.input.evaluate((element, original) => element === original, originalInput)).toBe(false);
	const codeBounds = await page.getByRole('region', { name: 'Code' }).boundingBox();
	const inputBounds = await card.boundingBox();
	expect(Math.abs(inputBounds!.x + inputBounds!.width / 2 - codeBounds!.x - codeBounds!.width / 2)).toBeLessThanOrEqual(1);
	expect(Math.abs(inputBounds!.y + inputBounds!.height / 2 - codeBounds!.y - codeBounds!.height / 2)).toBeLessThan(80);
	await composer.locator('input[type="file"]').setInputFiles({ name: 'code-context.ts', mimeType: 'text/plain', buffer: Buffer.from('export const code = true;') });
	await expect(composer.getByRole('button', { name: 'Remove code-context.ts', exact: true })).toBeVisible();
	await replaceChatInput(editor, 'Edited from Code');
	await expect(composer.locator('[data-action-id="ash.chat.input.send"] button')).toBeEnabled();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Attachments can be sent without text/u);
	await page.keyboard.press('Escape');
	await expect(editor.input).toBeFocused();
	await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
	await expect(page.locator('.ash-sessions-list')).toBeVisible();
	await activityNavigation.getByRole('button', { name: 'Chat' }).focus();
	await page.keyboard.press('Space');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
	await expect(composer).toHaveClass(/chat-composer/u);
	await expect(composer).not.toHaveClass(/code-composer/u);
	await expect(card).toHaveCSS('border-radius', '4px');
	await expect(composer.getByRole('button', { name: 'Remove code-context.ts', exact: true })).toHaveCount(0);
	await editor.waitForEditorContents(contents => contents === 'Keep this draft');
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).not.toHaveAttribute('aria-current', 'page');
	await activityNavigation.getByRole('button', { name: 'Collaboration' }).click();
	await activityNavigation.getByRole('button', { name: 'Code' }).click();
	await expect(page.getByRole('region', { name: 'Code' })).toBeVisible();
	await expect(page.locator('.ash-sessions-list')).toBeVisible();
	await expect(activityNavigation.getByRole('button', { name: 'Collaboration' })).not.toHaveAttribute('aria-current', 'page');
	await editor.waitForEditorContents(contents => contents === 'Edited from Code');
	await expect(composer.getByRole('button', { name: 'Remove code-context.ts', exact: true })).toBeVisible();
	const back = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Back', exact: true });
	const forward = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Forward', exact: true });
	await expect(back).toBeDisabled();
	await page.locator('.ash-sessions-list-add').click();
	await expect(page.locator('.ash-sessions-chat-slot:visible')).toHaveCount(2);
	await editor.waitForEditorContents(contents => contents === '');
	await expect(back).toBeEnabled();
	await back.click();
	await editor.waitForEditorContents(contents => contents === 'Edited from Code');
	await expect(forward).toBeEnabled();
	await activityNavigation.getByRole('button', { name: 'Chat' }).click();
	await expect(page.locator('.ash-sessions-chat-slot:visible')).toHaveCount(1);
	await expect(page.locator('.ash-sessions-list-item')).toHaveCount(1);
	await editor.waitForEditorContents(contents => contents === 'Keep this draft');
	await expect(back).toBeDisabled();
	await expect(forward).toBeDisabled();
	await activityNavigation.getByRole('button', { name: 'Code' }).click();
	await forward.click();
	await page.locator('.ash-sessions-chat-slot.active:visible .ash-sessions-chat-slot-close').click();
	await expect(page.locator('.ash-sessions-chat-slot:visible')).toHaveCount(1);
	await editor.waitForEditorContents(contents => contents === 'Edited from Code');
	await activityNavigation.getByRole('button', { name: 'Chat' }).click();
	await editor.waitForEditorContents(contents => contents === 'Keep this draft');
	await chatStyle.evaluate(element => (element as HTMLStyleElement).remove());
	await originalInput?.dispose();
	await page.reload();
	await editor.waitForEditorContents(contents => contents === 'Keep this draft');
	await expect(composer.getByRole('button', { name: 'Remove code-context.ts', exact: true })).toHaveCount(0);
	await activityNavigation.getByRole('button', { name: 'Code' }).click();
	await editor.waitForEditorContents(contents => contents === 'Edited from Code');
	await expect(composer.getByRole('button', { name: 'Remove code-context.ts', exact: true })).toBeVisible();
});

test('closing the Workbench keeps Sessions usable and Return to Workbench reopens the workspace', async ({ target }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires Code Electron');
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-dedicated-close-'));
	try {
		const { application, driver, close } = await launchElectron({ appServerMode: target.appServerMode, workbenchMode: 'code', userDataDirectory });
		try {
			const parent = driver.workbench.page;
			const childPromise = application.waitForEvent('window');
			await parent.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
			const child = await childPromise;
			await expect(child.locator('.ash-code-sessions-window')).toBeVisible();
			await parent.close();
			await expect(child.locator('.ash-code-sessions-window')).toBeVisible();
			const windows = await child.evaluate(async () => {
				const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
				const list = await ipc.invoke('ash:window:operation', { kind: 'list' }) as readonly { readonly title: string }[];
				const configuration = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
				const connection = await ipc.invoke('ash:remote:connection') as { readonly kind: string };
				return { titles: list.map(window => window.title), configurationRevision: configuration.revision, connectionKind: connection.kind };
			});
			expect(windows).toEqual({ titles: [expect.stringContaining('Sessions')], configurationRevision: expect.any(Number), connectionKind: 'local' });
			const workbenchPromise = application.waitForEvent('window');
			await returnFromSessions(child);
			const reopened = await workbenchPromise;
			await expect(reopened.locator('.ash-workbench')).toBeVisible();
			await expect.poll(() => application.windows().length).toBe(1);
		} finally {
			await close();
		}
	} finally {
		if (!resolve(userDataDirectory).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('Test profile escaped the temporary directory');
		await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test('Code registers and releases a user system-wide Open Agents Window shortcut', async ({ target }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires Code Electron');
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-shortcut-'));
	const profileDirectory = join(userDataDirectory, 'profile');
	const resourcePath = join(profileDirectory, 'keybindings.json');
	await mkdir(profileDirectory);
	await writeFile(resourcePath, JSON.stringify([{
		key: 'ctrl+alt+shift+f24',
		command: 'workbench.action.openAgentsWindow',
		systemWide: true,
	}]));
	try {
		const { application, close } = await launchElectron({ appServerMode: 'disabled', workbenchMode: 'code', userDataDirectory, profileDirectory });
		try {
			await expect.poll(() => application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F24'))).toBe(true);
			await writeFile(resourcePath, '[]\n');
			await expect.poll(() => application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F24'))).toBe(false);
		} finally {
			await close();
		}
	} finally {
		if (!resolve(userDataDirectory).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('Test profile escaped the temporary directory');
		await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
