import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { waitForElectronWindowState } from '../../../automation/electronDriver.js';
import { Menus } from '../../../automation/menus.js';
import { expect, test } from '../../../automation/test.js';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import type { Locator, Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { Editor } from '../../../automation/editor.js';
import { Workbench } from '../../../automation/workbench.js';
import {
	clickCanvasMenu,
	inspectCanvasMenu,
	drawBezierPath,
	rightClickCanvasShape,
} from '../../../automation/design.js';
import { parseDesignDocument } from '../../../../src/ash/sessions/contrib/creator/common/model/document.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { captureElectronMenu } from '../../../automation/menus.js';
import type { IKeyboardLayoutDefinition } from '../../../../src/ash/platform/keyboardLayout/common/keyboardLayout.js';
import { USER_KEYBOARD_LAYOUT_DEFAULT_CONTENT } from '../../../../src/ash/platform/keyboardLayout/common/userKeyboardLayout.js';

// macOS application menus and fullscreen transitions require a shown, focused window.
const focusTest = test.extend({ electronWindowMode: process.platform === 'darwin' ? 'active' : undefined });
const emptyWorkspaceTest = test.extend({ openWorkspace: false });

test(
	'Sessions sidebar groups switch between Chat and Code and retain expansion',
	{ tag: ['@electron-ui'] },
	async ({ target, workbench }, testInfo) => {
		const page = await workbench.openAgentsWindow(target.kind);
		const list = page.locator('.ash-sessions-list:visible');
		const headings = list.locator(':scope > .ash-sessions-list-items > section > h3 button');
		const recent = list.locator('[data-section=recent] > h3 button');
		const modes = page.locator('.ash-window-mode-control');
		await expect(list.getByRole('searchbox')).toHaveCount(0);
		await expect(headings).toHaveText(['Projects', 'Chats']);
		await expect(list.locator('[data-section=pinned]')).toHaveCount(0);
		// The disconnected Desktop fixture keeps the project-load failure available for retry.
		await expect(
			list
				.locator('[data-section=projects]')
				.getByRole('button', { name: 'Could not load projects. Retry', exact: true }),
		).toBeVisible();
		await recent.focus();
		await recent.press('ArrowLeft');
		await expect(recent).toHaveAttribute('aria-expanded', 'false');
		await expect(recent.locator('[data-ash-icon-id=chevron-right]')).toBeVisible();
		await modes.getByRole('button', { name: 'Code', exact: true }).click();
		await expect(headings).toHaveText(['Projects', 'Recents']);
		await expect(recent).toHaveAttribute('aria-expanded', 'true');
		await expect(list.locator('.ash-sessions-list-item > [data-ash-icon-id=chat-4]').first()).toBeVisible();
		await recent.focus();
		await recent.press('ArrowLeft');
		await expect(recent).toHaveAttribute('aria-expanded', 'false');
		await modes.getByRole('button', { name: 'Chat / Agents', exact: true }).click();
		await expect(recent).toHaveAttribute('aria-expanded', 'false');
		await recent.press('ArrowRight');
		await expect(list.locator('.ash-sessions-list-item').first()).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath('sidebar-chat-groups-desktop.png') });
		await modes.getByRole('button', { name: 'Code', exact: true }).click();
		await expect(recent).toHaveAttribute('aria-expanded', 'false');
		await recent.press('ArrowRight');
		await page.screenshot({ path: testInfo.outputPath('sidebar-code-groups-desktop.png') });
	},
);

test('Sessions Search opens categorized results and creates a new session', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const search = page.locator('[data-action-id="sessions.search"] button');
	await search.click();
	const picker = page.locator('.ash-sessions-search-dialog');
	const input = picker.getByRole('combobox');
	await expect(input).toBeFocused();
	await expect(
		picker.getByRole('toolbar', { name: 'Search categories', exact: true }).getByRole('button'),
	).toHaveText(['All', 'Sessions', 'Projects', 'Scheduled']);
	await expect(page.locator('.ash-quick-input-host:not([hidden])')).toHaveCount(0);
	await input.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Search finds saved sessions/);
	await help.press('Escape');
	await expect(help).toHaveCount(0);
	await expect(input).toBeFocused();
	await input.fill('missing_search_result');
	await expect(picker.getByRole('option')).toHaveCount(0);
	await input.press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(search).toBeFocused();
	const active = page.locator('.ash-sessions-chat-slot.active [data-untitled-session-id]');
	const previous = await active.getAttribute('data-untitled-session-id');
	await search.press('Enter');
	await input.fill('New Session');
	await picker
		.getByRole('option', { name: /New Session/ })
		.last()
		.click();
	await expect(picker).toHaveCount(0);
	await expect(active).not.toHaveAttribute('data-untitled-session-id', previous!);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await search.click();
	await expect(input).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('sessions-search.png') });
	await input.press('Escape');
	await expect(search).toBeFocused();
});

test('Sessions keyboard layout commands inspect the active mapping and offer layout selection', async ({
	target,
	workbench,
}) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const quickAccess = new QuickAccess(page);
	await quickAccess.runCommand('workbench.action.inspectKeyMappingsJSON');
	const group = page
		.locator('.ash-editor-group')
		.filter({ has: page.getByRole('tab', { name: /^Keyboard Layout \(JSON\)(?:,|$)/ }) });
	await new Editor(group.locator('.ash-editor-group-content')).waitForEditorContents(
		contents => contents.includes('"layout"') && contents.includes('"rawMapping"'),
	);
	await quickAccess.runCommand('workbench.action.changeKeyboardLayout');
	await expect(quickAccess.input).toHaveAttribute('aria-label', 'Select keyboard layout');
	await expect(page.getByRole('option', { name: /Auto Detect/ })).toBeVisible();
	await quickAccess.close();
});

test(
	'Sessions desktop reads the system keyboard layout and opens the profile layout file',
	{ tag: ['@electron-ui', '@electron-app-server'] },
	async ({ application, target, workbench }) => {
		if (!('windows' in application)) {
			throw new Error('Expected Electron windows');
		}
		const page = await workbench.openAgentsWindow(target.kind);
		const layout = await page.evaluate(() =>
			globalThis.ashTestMainProcess.call<IKeyboardLayoutDefinition>('keyboardLayout', 'readKeyboardLayout'),
		);
		expect(layout).toBeDefined();
		const quickAccess = new QuickAccess(page);
		await quickAccess.runCommand('workbench.action.inspectKeyMappings');
		const group = page
			.locator('.ash-editor-group')
			.filter({ has: page.getByRole('tab', { name: /^Keyboard Layout(?:,|$)/ }) });
		await new Editor(group.locator('.ash-editor-group-content')).waitForEditorContents(
			contents => contents.includes(`"id": "${layout.layout.id}"`) && contents.includes('"source": "native"'),
		);
		await quickAccess.runCommand('workbench.action.changeKeyboardLayout');
		await expect(page.getByRole('option', { name: /Auto Detect.*Current:/ })).toContainText(layout.layout.label);
		const originalOpenPath = await application.evaluateHandle(({ shell }) => shell.openPath);
		try {
			await application.evaluate(({ shell }) => {
				(globalThis as unknown as { openedKeyboardLayout?: string }).openedKeyboardLayout = undefined;
				shell.openPath = async path => {
					(globalThis as unknown as { openedKeyboardLayout?: string }).openedKeyboardLayout = path;
					return '';
				};
			});
			await page.getByRole('option', { name: /Configure Keyboard Layout File/ }).click();
			const readOpenedPath = () =>
				application.evaluate(
					() => (globalThis as unknown as { openedKeyboardLayout?: string }).openedKeyboardLayout,
				);
			await expect.poll(readOpenedPath).toMatch(/keyboard-layout\.json$/);
			const layoutPath = (await readOpenedPath())!;
			expect(await readFile(layoutPath, 'utf8')).toBe(USER_KEYBOARD_LAYOUT_DEFAULT_CONTENT);
			const readUserLayoutId = () =>
				page.evaluate(
					async () =>
						(
							await globalThis.ashTestMainProcess.call<IKeyboardLayoutDefinition | undefined>(
								'userKeyboardLayout',
								'readKeyboardLayout',
							)
						)?.layout.id,
				);
			const userLayout = (id: string) =>
				JSON.stringify({
					layout: { id, label: 'Synthetic profile layout', operatingSystem: 'linux' },
					rawMapping: { KeyT: { value: 't', withShift: 'T', withAltGr: '', withShiftAltGr: '' } },
				});
			await writeFile(layoutPath, userLayout('profile.watch'));
			await expect.poll(readUserLayoutId).toBe('profile.watch');
			const replacement = layoutPath + '.tmp';
			await writeFile(replacement, userLayout('profile.atomic'));
			await rename(replacement, layoutPath);
			await expect.poll(readUserLayoutId).toBe('profile.atomic');
			await rm(layoutPath);
			await expect.poll(readUserLayoutId).toBeUndefined();
		} finally {
			await application.evaluate(({ shell }, original) => {
				shell.openPath = original;
			}, originalOpenPath);
			await originalOpenPath.dispose();
		}
	},
);

test(
	'Sessions desktop follows system screen-reader detection and live changes in its editor',
	{ tag: ['@electron-ui', '@electron-app-server'] },
	async ({ application, target, workbench }) => {
		if (!('windows' in application)) {
			throw new Error('Expected Electron windows');
		}
		const initialSupport = await application.evaluate(({ app }) => app.isAccessibilitySupportEnabled());
		try {
			await application.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true));
			const page = await workbench.openAgentsWindow(target.kind);
			const chat = page.locator('.ash-sessions-chat-slot :is(.ash-chat,.ash-cowork):visible').first();
			const editor = new Editor(chat);
			await replaceChatInput(editor, 'System screen-reader detection');
			const mirror = editor.input.locator('.stanza-native-screen-reader-content');
			await expect(mirror).toHaveAttribute('aria-hidden', 'false');
			await expect(mirror).toHaveText('System screen-reader detection');
			await application.evaluate(({ app }) => app.setAccessibilitySupportEnabled(false));
			await expect(mirror).toHaveAttribute('aria-hidden', 'true');
			await expect(mirror).toHaveText('');
			await application.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true));
			await expect(mirror).toHaveAttribute('aria-hidden', 'false');
			await expect(mirror).toHaveText('System screen-reader detection');
		} finally {
			await application.evaluate(
				({ app }, enabled) => app.setAccessibilitySupportEnabled(enabled),
				initialSupport,
			);
		}
	},
);

async function replaceChatInput(editor: Editor, text: string): Promise<void> {
	await editor.waitForEditorFocus();
	await editor.input.page().keyboard.press('ControlOrMeta+A');
	await editor.input.page().keyboard.press('Backspace');
	await editor.input.page().keyboard.insertText(text);
	await editor.waitForEditorContents(contents =>
		text.includes('\n') ? contents.endsWith(text.split('\n').at(-1)!) : contents === text,
	);
}

test(
	'Sessions dictation introduction preserves the draft and restores focus after accessible help',
	{ tag: ['@electron-ui', '@electron-app-server'] },
	async ({ application, target, workbench }) => {
		if (!('windows' in application)) {
			throw new Error('Expected Electron windows');
		}
		const page = await workbench.openAgentsWindow(target.kind);
		const chat = page.locator('.ash-sessions-chat-slot :is(.ash-chat,.ash-cowork):visible').first();
		const editor = new Editor(chat);
		await replaceChatInput(editor, 'Keep the Sessions draft');
		await new QuickAccess(page).runCommand('workbench.action.chat.showSpeechToTextIntroduction');
		const introduction = page.getByRole('region', { name: 'Dictation introduction', exact: true });
		await expect(introduction).toBeVisible();
		const done = introduction.getByRole('button', { name: 'Done', exact: true });
		await done.focus();
		await page.keyboard.press('Alt+F1');
		const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
		await expect(help).toBeVisible();
		await expect(help.getByRole('textbox')).toHaveValue(/Test text is never inserted/);
		await page.keyboard.press('Escape');
		await expect(help).toHaveCount(0);
		await expect(done).toBeFocused();
		await page.keyboard.press('Alt+F2');
		const accessibleView = page.getByRole('dialog', { name: 'Accessible View', exact: true });
		await expect(accessibleView).toBeVisible();
		await expect(accessibleView.getByRole('textbox')).toHaveAttribute('readonly', '');
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect(introduction).toHaveCount(0);
		await editor.waitForEditorContents(text => text === 'Keep the Sessions draft');
		await expect(editor.input).toBeFocused();
	},
);

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

async function readComposerShadow(
	card: Locator,
): Promise<{ shadow: string; themeOpacity: number; layerOpacities: number[] }> {
	return card.evaluate(element => {
		const style = getComputedStyle(element);
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const context = canvas.getContext('2d')!;
		const opacity = (color: string): number => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			return context.getImageData(0, 0, 1, 1).data[3] / 255;
		};
		return {
			shadow: style.boxShadow,
			themeOpacity: opacity(style.getPropertyValue('--ash-sessions-inputShadow')),
			layerOpacities: [...style.boxShadow.matchAll(/(?:rgba?|color)\([^)]*\)/gu)].map(match => opacity(match[0])),
		};
	});
}

async function openSessionsComposer(page: Page, presentation: 'Cowork' | 'Code'): Promise<Locator> {
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	if (presentation === 'Cowork') {
		// Desktop's Chat mode opens ChatGPT; Collab hosts the shared Cowork composer.
		await page.locator('[data-action-id="sessions.open.collaboration"] button').click();
	}
	const chat = page
		.locator(`.ash-sessions-chat-slot .${presentation === 'Cowork' ? 'ash-cowork' : 'ash-chat'}:visible`)
		.first();
	await expect(chat).toBeVisible();
	return chat;
}

async function expectFloatingComposerHover(
	card: Locator,
	input: Locator,
	blurTarget: Locator,
	presentation: 'Cowork' | 'Code',
): Promise<void> {
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
	if (presentation === 'Code') {
		await expect(card).toHaveCSS('box-shadow', 'none');
	} else {
		await expect(card).not.toHaveCSS('box-shadow', 'none');
	}
	await expect(card).toHaveCSS('transition-property', 'border-color, box-shadow');
	await expect(card).toHaveCSS('transition-duration', '0.2s, 0.2s');
	await expect.poll(() => card.evaluate(element => element.getAnimations().length)).toBe(0);
	const resting = await readComposerShadow(card);
	const restingShadow = resting.shadow;
	// Cowork retains its two-layer elevation; Code only raises during interaction.
	expect(resting.themeOpacity).toBeGreaterThan(0.05);
	expect(resting.layerOpacities).toHaveLength(presentation === 'Code' ? 0 : 2);
	for (const [index, opacity] of resting.layerOpacities.entries()) {
		expect(opacity).toBeGreaterThan(0);
		expect(opacity).toBeCloseTo(resting.themeOpacity * [0.2, 0.12][index], 2);
	}
	const bounds = await card.boundingBox();
	await card.hover();
	await expect(card).toHaveCSS('border-top-color', colors.hovered);
	await expect.poll(() => card.evaluate(element => element.getAnimations().length)).toBe(0);
	await expect(card).not.toHaveCSS('box-shadow', restingShadow);
	const raised = await readComposerShadow(card);
	const raisedShadow = raised.shadow;
	const raisedMix = presentation === 'Code' ? [0.3] : [0.28, 0.18];
	expect(raised.layerOpacities).toHaveLength(raisedMix.length);
	for (const [index, opacity] of raised.layerOpacities.entries()) {
		expect(opacity).toBeGreaterThan(resting.layerOpacities[index] ?? 0);
		expect(opacity).toBeCloseTo(raised.themeOpacity * raisedMix[index], 2);
	}
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
	await card.getByRole('button').first().focus();
	await expect(card).toHaveClass(/focused/u);
	await expect(card).toHaveCSS('box-shadow', raisedShadow);
	await blurTarget.focus();
	await expect(card).not.toHaveClass(/focused/u);
	await expect(card).toHaveCSS('border-top-color', colors.resting);
	await expect(card).toHaveCSS('box-shadow', restingShadow);
	await input.focus();
	await expect(card).toHaveCSS('border-top-color', colors.hovered);
	await expect(card).toHaveCSS('box-shadow', raisedShadow);
}

test('Sessions Design contribution keeps its viewport and applies canvas cursor settings', async ({
	application,
	target,
	workbench,
}) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	const openDesign = async (): Promise<void> => {
		await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
		await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	};
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	const world = canvas.locator('.ash-canvas-world');
	const transform = () => world.evaluate(element => (element as HTMLElement).style.transform);
	await openDesign();
	await expect(canvas).toBeVisible();
	await expect(canvas).toHaveCSS('display', 'flex');
	await expect(page.locator('[data-part="editor"]').getByRole('region', { name: 'Design canvas' })).toBeVisible();
	await expect(page.locator('[data-part="sessions"]')).toBeHidden();
	await expect(page.locator('[data-part="sidebar"]').getByRole('tree', { name: 'Layers' })).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeVisible();
	const properties = page.locator('[data-part="auxiliarybar"]');
	await expect(properties.locator('.ash-composite-bar')).toBeHidden();
	await expect(properties.locator('.ash-pane-composite-title')).toBeHidden();
	await expect(properties.getByRole('tab')).toHaveCount(0);
	await expect(properties).toContainText('Select one object to edit its properties.');
	await expect(canvas.locator('.ash-sessions-design-properties')).toHaveCount(0);
	const viewport = canvas.locator('.ash-canvas-viewport');
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
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(
		/Design canvas[\s\S]*Press 0 to reset the view/u,
	);
	await page.keyboard.press('Escape');
	await expect(canvas).toBeFocused();
	await navigation.getByRole('button', { name: /^New(?:\.|$)/u }).click();
	await expect(canvas).toBeHidden();
	await openDesign();
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
		await new Workbench(page).menus.select(
			application,
			() => navigation.getByRole('button', { name: 'Accounts', exact: true }).click(),
			['Settings'],
		);
		await settings
			.getByRole('navigation', { name: 'Settings categories' })
			.getByRole('button', { name: 'Design', exact: true })
			.click();
	};
	await openDesignSettings();
	const pointerSwitch = settings.getByRole('switch', { name: 'Use pointer cursor on the canvas', exact: true });
	await expect(pointerSwitch).toBeChecked();
	await pointerSwitch.focus();
	await page.keyboard.press('Space');
	await expect(pointerSwitch).not.toBeChecked();
	await expect(viewport).not.toHaveClass(/pointer-cursor/u);
	await expect(settings.locator('[data-configuration-key="accessibility.verbosity.designCanvas"]')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(viewport).toHaveCSS('cursor', 'grab');
	await page.reload();
	await openDesign();
	await expect(canvas).toBeVisible();
	await expect(viewport).toHaveCSS('cursor', 'grab');
	await openDesignSettings();
	await expect(pointerSwitch).not.toBeChecked();
	await settings.locator('[data-settings-item-id="sessions.design.usePointerCursor"] .ash-switch-track').click();
	await expect(viewport).toHaveClass(/pointer-cursor/u);
	await page.keyboard.press('Escape');
	await expect(viewport).toHaveCSS('cursor', /url\("data:image\/svg\+xml,/u);
	await canvas.focus();
	await page.keyboard.press('r');
	await page.keyboard.press('e');
	const layers = page.locator('[data-part="sidebar"]').getByRole('tree', { name: 'Layers' });
	await expect(layers.getByRole('treeitem')).toHaveCount(2);
	await layers.getByRole('treeitem', { name: 'Rectangle', exact: true }).click();
	await layers.getByRole('treeitem', { name: 'Ellipse', exact: true }).click({ modifiers: ['Shift'] });
	await expect(layers.getByRole('treeitem', { selected: true })).toHaveCount(2);
	await layers.getByRole('treeitem', { name: 'Rectangle', exact: true }).click();
	const x = page.locator('[data-part="auxiliarybar"]').getByRole('spinbutton', { name: 'X', exact: true });
	await x.fill('42');
	await x.press('Tab');
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('x', '42');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(page.locator('[data-part="sessions"]')).toBeVisible();
	await expect(canvas).toBeHidden();
	await expect(properties.getByRole('spinbutton', { name: 'X', exact: true })).toBeHidden();
	await expect(properties.getByRole('tab')).toHaveCount(0);
	await openDesign();
	await expect(canvas).toBeVisible();
	await expect(properties.locator('.ash-pane-composite-title')).toBeHidden();
	await expect(properties.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('42');
	await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('x', '42');
	await expect(layers.getByRole('treeitem', { name: 'Rectangle', exact: true })).toHaveAttribute(
		'aria-selected',
		'true',
	);
});

test(
	'Sessions Design macOS canvas menu dispatches editing through Main',
	{ tag: ['@electron-ui', '@electron-app-server', '@darwin'] },
	async ({ application, target, workbench }) => {
		if (!('windows' in application)) {
			throw new Error('Expected Electron windows');
		}
		const page = await workbench.openAgentsWindow(target.kind);
		await page
			.locator('.ash-sessions-activity-content')
			.getByRole('button', { name: 'Artifacts', exact: true })
			.click();
		await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
		const canvas = page.getByRole('region', { name: 'Design canvas' });
		const tools = canvas.locator('.ash-design-tools-widget');
		await tools.getByRole('button', { name: 'Select (V)', exact: true }).focus();
		await page.keyboard.press('ArrowRight');
		const selectionTools = tools.getByRole('button', { name: 'Selection tools', exact: true });
		await expect(selectionTools).toBeFocused();
		await captureElectronMenu(application, () => page.keyboard.press('Enter'), { label: 'Move canvas (H)' });
		await expect(tools.getByRole('button', { name: 'Move canvas (H)', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		await expect(canvas.locator('.ash-canvas-viewport')).toHaveCSS('cursor', 'grab');
		await selectionTools.focus();
		await captureElectronMenu(application, () => page.keyboard.press('ArrowDown'), {
			label: 'Move canvas (H)',
			checked: true,
		});
		await expect(selectionTools).toBeFocused();
		const shapeTools = tools.getByRole('button', { name: 'Shape tools', exact: true });
		await captureElectronMenu(application, () => shapeTools.click(), { label: 'Ellipse' });
		await expect(tools.getByRole('button', { name: 'Ellipse', exact: true })).toBeVisible();
		await tools.getByRole('button', { name: 'Pen (P)', exact: true }).click();
		await tools.getByRole('button', { name: 'Ellipse', exact: true }).click();
		await expect(tools.getByRole('button', { name: 'Ellipse', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		await captureElectronMenu(application, () => shapeTools.click(), { label: 'Rectangle' });
		await canvas.focus();
		await canvas.press('v');
		expect(await inspectCanvasMenu(canvas, application, true)).toEqual([
			{ label: 'Undo', enabled: false },
			{ label: 'Redo', enabled: false },
			{ label: 'Delete', enabled: false },
			{ label: 'Select all', enabled: false },
			{ label: 'Duplicate', enabled: false },
			{ label: expect.stringMatching(/^Bring to front \[⇧⌘.+\]$/u), enabled: false },
			{ label: expect.stringMatching(/^Send to back \[⇧⌘.+\]$/u), enabled: false },
			{ label: 'Add auto layout', enabled: false },
			{ label: 'Group', enabled: false },
			{ label: 'Create component', enabled: false },
			{ label: 'Detach instance', enabled: false },
			{ label: 'Ungroup', enabled: false },
			{ label: 'Add frame (F)', enabled: true },
			{ label: 'Import image', enabled: true },
			{ label: 'Export SVG', enabled: false },
			{ label: 'Open design', enabled: true },
			{ label: 'Save a copy', enabled: true },
		]);
		await expect(canvas).toBeFocused();
		await canvas.press('r');
		await canvas.press('e');
		for (let index = 0; index < 15; index++) {
			await canvas.press('Shift+ArrowRight');
		}
		const rectangle = canvas.locator('rect[data-shape-id]');
		await captureElectronMenu(application, () => rightClickCanvasShape(rectangle), { label: 'Delete' });
		await expect(rectangle).toHaveCount(0);
		await expect(canvas.locator('ellipse[data-shape-id]')).toHaveCount(1);
		await expect(canvas).toBeFocused();
		await clickCanvasMenu(canvas, 'Undo', application);
		await expect(rectangle).toHaveCount(1);
		await clickCanvasMenu(canvas, 'Select all', application);
		await captureElectronMenu(application, () => rightClickCanvasShape(rectangle), { label: 'Group' });
		const group = canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id]');
		await expect(group).toHaveCount(1);
		await clickCanvasMenu(canvas, 'Ungroup', application);
		await expect(group).toHaveCount(0);
		await expect(canvas.locator('.ash-sessions-design-shapes > [data-shape-id]')).toHaveCount(2);
	},
);

test(
	'Sessions Design imports backend asset versions, crops independently and reopens a portable media package',
	{ tag: ['@browser-app-server', '@electron-app-server'] },
	async ({ application, target, testWorkspace, workbench }) => {
		let page = workbench.page;
		const directory = await realpath(testWorkspace.directory);
		if (target.kind === 'browser') {
			await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
		} else {
			if (!('windows' in application)) {
				throw new Error('Expected Electron application');
			}
			const opened = application.waitForEvent('window');
			await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
			page = await opened;
		}
		const encoded = await page.evaluate(() => {
			const image = document.createElement('canvas');
			image.width = 100;
			image.height = 80;
			const context = image.getContext('2d')!;
			context.fillStyle = '#007acc';
			context.fillRect(0, 0, 50, 80);
			context.fillStyle = '#ffffff';
			context.fillRect(50, 0, 50, 80);
			return image.toDataURL('image/png').split(',')[1];
		});
		await writeFile(join(directory, 'product.png'), Buffer.from(encoded, 'base64'));
		if (target.kind === 'electron') {
			if (!('windows' in application)) {
				throw new Error('Expected Electron application');
			}
			await application.evaluate(({ dialog }, folder) => {
				dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [`${folder}/product.png`] });
				dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${folder}/design.ash-design` });
			}, directory);
		}
		await page
			.locator('.ash-sessions-activity-content')
			.getByRole('button', { name: 'Artifacts', exact: true })
			.click();
		await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
		const canvas = page.getByRole('region', { name: 'Design canvas' });
		await canvas.focus();
		await page.keyboard.press('f');
		await canvas
			.locator('.ash-design-tools-widget')
			.getByRole('button', { name: 'Import image', exact: true })
			.click();
		if (target.kind === 'browser') {
			await page
				.locator('.ash-quick-pick-row-label')
				.filter({ hasText: /^product\.png$/u })
				.click();
		}
		const frame = canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id]');
		const images = frame.locator('svg[data-shape-id]');
		await expect(images).toHaveCount(1);
		const originalId = await images.first().getAttribute('data-shape-id');
		await expect(images.first().locator('image')).toHaveAttribute('href', /^blob:/u);
		await clickCanvasMenu(canvas, 'Duplicate', application);
		await expect(images).toHaveCount(2);
		const crop = page
			.locator('[data-part="auxiliarybar"]')
			.getByRole('spinbutton', { name: 'Crop width (%)', exact: true });
		await crop.fill('50');
		await crop.press('Tab');
		await expect(images.last()).toHaveAttribute('viewBox', '0 0 50 80');
		await expect(frame.locator(`svg[data-shape-id="${originalId}"]`)).toHaveAttribute('viewBox', '0 0 100 80');
		await canvas.focus();
		await page.keyboard.press('ControlOrMeta+z');
		await expect(images.last()).toHaveAttribute('viewBox', '0 0 100 80');
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect(images.last()).toHaveAttribute('viewBox', '0 0 50 80');
		await canvas.focus();
		await page.keyboard.press('ControlOrMeta+s');
		if (target.kind === 'browser') {
			const dialog = page.getByRole('dialog', { name: 'Save design', exact: true });
			await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('design.ash-design');
			await dialog.getByRole('button', { name: 'OK', exact: true }).click();
		}
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Saved design.ash-design');
		await expect(canvas).not.toHaveClass(/\bdirty\b/u);
		const saved = await readFile(join(directory, 'design.ash-design/manifest.json'), 'utf8');
		const designDocument = parseDesignDocument(saved);
		expect(designDocument.assets).toHaveLength(1);
		const asset = designDocument.assets[0];
		expect(asset.versions).toHaveLength(1);
		const originalBytes = await readFile(join(directory, 'design.ash-design', asset.versions[0].path));
		expect(originalBytes).toEqual(Buffer.from(encoded, 'base64'));
		if (target.kind === 'browser') {
			const committed = await page.evaluate(
				async ({ assetId, versionId }) => {
					const service = globalThis.ashWebWorkbenchHost!.api.assets;
					const version = await service.getVersion(assetId, versionId);
					return {
						width: version.width,
						height: version.height,
						sha256: version.sha256,
						bytes: Array.from(await service.readVersion(version)),
					};
				},
				{ assetId: asset.id, versionId: asset.versions[0].id },
			);
			expect(committed).toEqual({
				width: 100,
				height: 80,
				sha256: asset.versions[0].sha256,
				bytes: Array.from(originalBytes),
			});
		}
		await canvas.locator('.ash-design-tools-widget').getByRole('button', { name: 'Code', exact: true }).click();
		await expect(canvas.getByRole('textbox', { name: 'Generated code', exact: true })).toHaveValue(
			/href="data:image\/png;base64,/u,
		);
		await canvas.locator('.ash-design-tools-widget').getByRole('button', { name: 'Design', exact: true }).click();
		await rename(join(directory, 'design.ash-design'), join(directory, 'moved.ash-design'));
		if (target.kind === 'electron') {
			if (!('windows' in application)) {
				throw new Error('Expected Electron application');
			}
			await application.evaluate(({ dialog }, folder) => {
				dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [`${folder}/moved.ash-design`] });
			}, directory);
		}
		await clickCanvasMenu(canvas, 'Open design', application);
		if (target.kind === 'browser') {
			await page
				.locator('.ash-quick-pick-row-label')
				.filter({ hasText: /^moved\.ash-design$/u })
				.click();
		}
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Opened moved.ash-design');
		await expect(images).toHaveCount(2);
		await expect(images.last()).toHaveAttribute('viewBox', '0 0 50 80');
		await expect(canvas).not.toHaveClass(/\bdirty\b/u);
	},
);

test(
	'Sessions Design saves and reopens an editable file through App Server',
	{ tag: ['@electron-app-server'] },
	async ({ application, target, testWorkspace, workbench }) => {
		if (!('windows' in application)) {
			throw new Error('Expected Electron application');
		}
		const packagePath = join(await realpath(testWorkspace.directory), 'design.ash-design');
		const filePath = join(packagePath, 'manifest.json');
		// Only replace the OS picker; the renderer, IPC and authorized file service stay in the workflow.
		await application.evaluate(({ dialog }, path) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, packagePath);
		const page = await workbench.openAgentsWindow(target.kind);
		await page
			.locator('.ash-sessions-activity-content')
			.getByRole('button', { name: 'Artifacts', exact: true })
			.click();
		await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
		const canvas = page.getByRole('region', { name: 'Design canvas' });
		await canvas.focus();
		await page.keyboard.press('r');
		const width = page
			.locator('[data-part="auxiliarybar"]')
			.getByRole('spinbutton', { name: 'Width', exact: true });
		await width.fill('120.5');
		await width.press('Tab');
		await page.locator('[data-part="auxiliarybar"]').getByRole('button', { name: 'Fill', exact: true }).click();
		const colors = page.getByRole('dialog', { name: /^Color picker/u });
		await colors.getByRole('textbox', { name: 'Color value' }).fill('2670ee80');
		await colors.getByRole('textbox', { name: 'Color value' }).press('Enter');
		await colors.getByRole('button', { name: 'Close', exact: true }).click();
		await canvas.focus();
		await page.keyboard.press('ControlOrMeta+s');
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Saved design.ash-design');
		const saved = JSON.parse(await readFile(filePath, 'utf8'));
		expect(saved.schemaVersion).toBe(2);
		expect(parseDesignDocument(JSON.stringify(saved)).shapes).toMatchObject([
			{ kind: 'rectangle', width: 120.5, fill: '#2670ee80' },
		]);
		await expect(canvas).not.toHaveClass(/\bdirty\b/u);
		await canvas.focus();
		await page.keyboard.press('e');
		await page.keyboard.press('ControlOrMeta+z');
		await clickCanvasMenu(canvas, 'Open design', application);
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Opened design.ash-design');
		await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('width', '120.5');
		await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('fill', '#2670ee80');
		await expect(canvas.locator('ellipse[data-shape-id]')).toHaveCount(0);
		await canvas.focus();
		await page.keyboard.press('Tab');
		await width.fill('240.5');
		await width.press('Tab');
		await canvas.focus();
		await page.keyboard.press('ControlOrMeta+s');
		await expect(canvas).not.toHaveClass(/\bdirty\b/u);
		expect(parseDesignDocument(await readFile(filePath, 'utf8')).shapes[0].width).toBe(240.5);
		await writeFile(filePath, JSON.stringify(saved));
		await width.fill('360.5');
		await width.press('Tab');
		await canvas.focus();
		await page.keyboard.press('ControlOrMeta+s');
		const error = page.getByRole('dialog');
		await expect(error).toContainText('Could not save the design. Your changes are still in the canvas.');
		await error.getByRole('button', { name: 'OK', exact: true }).click();
		await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('width', '360.5');
		await expect(canvas).toHaveClass(/\bdirty\b/u);
		expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(saved);
		const closeSessions = () =>
			application.evaluate(({ BrowserWindow }) => {
				BrowserWindow.getAllWindows()
					.find(window => window.getTitle().includes('Sessions'))!
					.close();
			});
		await closeSessions();
		const savePrompt = page.getByRole('dialog', { name: 'Save Changes', exact: true });
		await expect(savePrompt).toContainText('design.ash-design');
		await savePrompt.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(savePrompt).toHaveCount(0);
		await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('width', '360.5');
		await closeSessions();
		const closed = page.waitForEvent('close');
		await savePrompt.getByRole('button', { name: "Don't Save", exact: true }).click();
		await closed;
	},
);

test(
	'Sessions Design saves and opens a browser folder without replacing the workspace',
	{ tag: ['@browser-ui'] },
	async ({ application, target, workbench }) => {
		const page = workbench.page;
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
		await page
			.locator('.ash-sessions-activity-content')
			.getByRole('button', { name: 'Artifacts', exact: true })
			.click();
		await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
		const folderName = await page.evaluate(async () => {
			const name = `ash-design-${crypto.randomUUID()}`;
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
			return name;
		});
		const canvas = page.getByRole('region', { name: 'Design canvas' });
		await canvas.focus();
		await page.keyboard.press('e');
		await canvas.focus();
		await page.keyboard.press('ControlOrMeta+s');
		const dialog = page.getByRole('dialog', { name: 'Save design', exact: true });
		await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('design.ash-design');
		await dialog.getByRole('button', { name: 'OK', exact: true }).click();
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Saved design.ash-design');
		const saved = await page.evaluate(async name => {
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
			const design = await folder.getDirectoryHandle('design.ash-design');
			return JSON.parse(await (await (await design.getFileHandle('manifest.json')).getFile()).text());
		}, folderName);
		expect(saved.schemaVersion).toBe(2);
		expect(parseDesignDocument(JSON.stringify(saved)).shapes).toMatchObject([
			{ kind: 'ellipse', width: 120, height: 80 },
		]);
		await canvas.focus();
		await page.keyboard.press('r');
		await page.keyboard.press('ControlOrMeta+z');
		await expect(canvas).not.toHaveClass(/\bdirty\b/u);
		await clickCanvasMenu(canvas, 'Open design', application);
		const file = page.locator('.ash-quick-pick-row-label').filter({ hasText: /^design\.ash-design$/u });
		await expect(file).toBeVisible();
		await file.click();
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Opened design.ash-design');
		await expect(canvas.locator('ellipse[data-shape-id]')).toHaveCount(1);
		await expect(canvas.locator('rect[data-shape-id]')).toHaveCount(0);
		await expect(canvas).not.toHaveClass(/\bdirty\b/u);
		const legacy = await page.evaluate(async name => {
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
			const content = JSON.stringify({
				version: 1,
				shapes: [
					{
						id: crypto.randomUUID(),
						kind: 'rectangle',
						x: 10,
						y: 20,
						width: 239.5,
						height: 80,
						rotation: 0,
						fill: '#808080',
					},
				],
			});
			const file = await folder.getFileHandle('legacy.ash-design.json', { create: true });
			const writer = await file.createWritable();
			await writer.write(content);
			await writer.close();
			return content;
		}, folderName);
		await clickCanvasMenu(canvas, 'Open design', application);
		await page
			.locator('.ash-quick-pick-row-label')
			.filter({ hasText: /^legacy\.ash-design\.json$/u })
			.click();
		await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute('width', '239.5');
		await expect(canvas.locator('rect[data-shape-id]')).toHaveAttribute(
			'data-shape-id',
			JSON.parse(legacy).shapes[0].id,
		);
		await expect(canvas.locator('ellipse[data-shape-id]')).toHaveCount(0);
		await canvas.focus();
		await page.keyboard.press('ControlOrMeta+s');
		await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('migrated.ash-design');
		await dialog.getByRole('button', { name: 'OK', exact: true }).click();
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Saved migrated.ash-design');
		const migrated = await page.evaluate(async name => {
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
			const design = await folder.getDirectoryHandle('migrated.ash-design');
			return {
				manifest: await (await (await design.getFileHandle('manifest.json')).getFile()).text(),
				legacy: await (await (await folder.getFileHandle('legacy.ash-design.json')).getFile()).text(),
			};
		}, folderName);
		expect(migrated.legacy).toBe(legacy);
		expect(parseDesignDocument(migrated.manifest).shapes).toEqual(JSON.parse(legacy).shapes);
	},
);

test(
	'Sessions Design exports SVG and HTML and reopens grouped text and paths through the file service',
	{ tag: ['@browser-ui', '@electron-app-server'] },
	async ({ application, target, testWorkspace, workbench }) => {
		let page = workbench.page;
		let folderName = '';
		const directory = await realpath(testWorkspace.directory);
		if (target.kind === 'browser') {
			await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
			folderName = await page.evaluate(async () => {
				const name = `ash-design-${crypto.randomUUID()}`;
				const folder = await (
					await navigator.storage.getDirectory()
				).getDirectoryHandle(name, { create: true });
				Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
				return name;
			});
		} else {
			if (!('windows' in application)) {
				throw new Error('Expected Electron application');
			}
			await application.evaluate(({ dialog }, folder) => {
				dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${folder}/design.ash-design` });
				dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [`${folder}/design.ash-design`] });
			}, directory);
			const opened = application.waitForEvent('window');
			await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
			page = await opened;
		}
		await page
			.locator('.ash-sessions-activity-content')
			.getByRole('button', { name: 'Artifacts', exact: true })
			.click();
		await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
		const canvas = page.getByRole('region', { name: 'Design canvas' });
		await canvas.focus();
		await page.keyboard.press('t');
		await canvas.locator('.ash-canvas-viewport').click({ position: { x: 120, y: 80 } });
		await page.keyboard.press('Escape');
		const text = page
			.locator('[data-part="auxiliarybar"]')
			.getByRole('textbox', { name: 'Text content', exact: true });
		await text.fill('中文 <script>');
		await text.press('Tab');
		await canvas.focus();
		await drawBezierPath(canvas);
		await canvas.press('Escape');
		await clickCanvasMenu(canvas, 'Select all', application);
		await clickCanvasMenu(canvas, 'Group', application);
		await canvas.focus();
		await page.keyboard.press('ControlOrMeta+s');
		if (target.kind === 'browser') {
			const dialog = page.getByRole('dialog', { name: 'Save design', exact: true });
			await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('design.ash-design');
			await dialog.getByRole('button', { name: 'OK', exact: true }).click();
		}
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Saved design.ash-design');
		await canvas.focus();
		await page.keyboard.press('ArrowRight');
		if (target.kind === 'electron' && 'windows' in application) {
			await application.evaluate(({ dialog }, folder) => {
				dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${folder}/design.svg` });
			}, directory);
		}
		await clickCanvasMenu(canvas, 'Export SVG', application);
		if (target.kind === 'browser') {
			const dialog = page.getByRole('dialog', { name: 'Export SVG', exact: true });
			await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('design.svg');
			await dialog.getByRole('button', { name: 'OK', exact: true }).click();
		}
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Exported design.svg');
		await expect(canvas).toHaveClass(/\bdirty\b/u);
		const read = async (filename: string): Promise<string> =>
			target.kind === 'electron'
				? readFile(join(directory, filename), 'utf8')
				: page.evaluate(
						async ({ folderName, filename }) => {
							let folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(folderName);
							const parts = filename.split('/');
							for (const part of parts.slice(0, -1)) {
								folder = await folder.getDirectoryHandle(part);
							}
							return (await (await folder.getFileHandle(parts.at(-1)!)).getFile()).text();
						},
						{ folderName, filename },
					);
		const svg = await read('design.svg');
		const saved = parseDesignDocument(await read('design.ash-design/manifest.json'));
		expect(saved.shapes[0]).toMatchObject({
			kind: 'group',
			children: [{ kind: 'text', text: '中文 <script>' }, { kind: 'path' }],
		});
		const parsed = await page.evaluate(content => {
			const svg = new DOMParser().parseFromString(content, 'image/svg+xml');
			return {
				text: svg.querySelector('[data-design-text]')?.textContent,
				path: svg.querySelector('path')?.getAttribute('d'),
				selection: svg.querySelector('.ash-sessions-design-selection') !== null,
				script: svg.querySelector('script') !== null,
				error: svg.querySelector('parsererror') !== null,
			};
		}, svg);
		expect(parsed).toMatchObject({ text: '中文 <script>', selection: false, script: false, error: false });
		expect(parsed.path).toContain(' C ');
		await canvas.locator('.ash-design-tools-widget').getByRole('button', { name: 'Code', exact: true }).click();
		const source = await canvas.getByRole('textbox', { name: 'Generated code', exact: true }).inputValue();
		if (target.kind === 'electron' && 'windows' in application) {
			await application.evaluate(({ dialog }, folder) => {
				dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${folder}/design.html` });
			}, directory);
		}
		await canvas.getByRole('button', { name: 'Export code', exact: true }).click();
		if (target.kind === 'browser') {
			const dialog = page.getByRole('dialog', { name: 'Export code', exact: true });
			await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('design.html');
			await dialog.getByRole('button', { name: 'OK', exact: true }).click();
		}
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Exported design.html');
		expect(await read('design.html')).toBe(source);
		await expect(canvas).toHaveClass(/\bdirty\b/u);
		await canvas.locator('.ash-design-tools-widget').getByRole('button', { name: 'Design', exact: true }).click();
		await canvas.focus();
		await page.keyboard.press('ControlOrMeta+z');
		await clickCanvasMenu(canvas, 'Open design', application);
		if (target.kind === 'browser') {
			await page
				.locator('.ash-quick-pick-row-label')
				.filter({ hasText: /^design\.ash-design$/u })
				.click();
		}
		await expect(canvas.locator('.ash-sessions-design-message')).toHaveText('Opened design.ash-design');
		await expect(canvas.locator('.ash-sessions-design-shapes > svg[data-shape-id]')).toHaveCount(1);
		await expect(canvas.locator('[data-design-text]')).toContainText('中文 <script>');
		await expect(canvas.locator('path[data-shape-id]')).toHaveCount(1);
	},
);

test('Sessions permission shortcuts use shared keycaps and keep numeric activation scoped', async ({
	target,
	workbench,
}) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const composer = page.locator(':is(.ash-sessions-chat-input,.ash-sessions-cowork-input)').first();
	const manual = composer.getByRole('button', { name: 'Permissions: Manual', exact: true });
	await manual.press('ArrowDown');
	const menu = page.getByRole('menu', { name: 'Permissions', exact: true });
	const keys = menu.locator('.ash-keybinding-label-keycap kbd');
	await expect(keys).toHaveText(['1', '2', '3']);
	await expect(menu.getByRole('menuitemradio').first()).toHaveAttribute('aria-keyshortcuts', '1');
	expect(
		await keys.evaluateAll(keys =>
			keys.map(key => ({ height: getComputedStyle(key).height, fontSize: getComputedStyle(key).fontSize })),
		),
	).toEqual([
		{ height: '20px', fontSize: '12px' },
		{ height: '20px', fontSize: '12px' },
		{ height: '20px', fontSize: '12px' },
	]);
	await page.keyboard.press('1');
	const automatic = composer.getByRole('button', { name: 'Permissions: Auto', exact: true });
	await expect(automatic).toBeFocused();
	await automatic.press('ArrowDown');
	await page.keyboard.press('2');
	await expect(manual).toBeFocused();
	await manual.press('ArrowDown');
	await page.keyboard.press('Escape');
	await expect(manual).toBeFocused();
	await expect(menu).toBeHidden();
	const editor = new Editor(composer);
	await replaceChatInput(editor, '123');
	await editor.waitForEditorContents(contents => contents === '123');
	await expect(manual).toBeVisible();
});

test('Sessions composer attaches files, chooses permissions, and restores the unsent draft', async ({
	application,
	target,
	workbench,
}) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	let composer = page.locator(':is(.ash-sessions-chat-input,.ash-sessions-cowork-input)').first();
	let editor = new Editor(composer);
	await expect(composer.locator('[data-action-id="ash.chat.input.attach"] button')).toHaveAccessibleName(
		'Add context',
	);
	await composer.getByRole('button', { name: 'Add context', exact: true }).click();
	const upload = page.waitForEvent('filechooser');
	await page
		.getByRole('dialog', { name: 'Search attachments', exact: true })
		.getByRole('combobox')
		.fill('Attach files');
	await page.keyboard.press('Enter');
	await (
		await upload
	).setFiles({ name: 'context.ts', mimeType: 'text/plain', buffer: Buffer.from('export const value = 42;') });
	await expect(editor.element.locator('.ash-chat-code-reference')).toHaveText(['context.ts']);
	const fileDraft = (await editor.lines.allTextContents()).join('\n').replace(/\u00a0/g, ' ');
	await expect(composer.locator('[data-action-id="ash.chat.input.send"] button')).toBeEnabled();
	const permissions = composer.getByRole('button', { name: 'Permissions: Manual', exact: true });
	await permissions.press('ArrowDown');
	const permissionMenu = page.getByRole('menu', { name: 'Permissions', exact: true });
	await expect(permissionMenu.getByRole('menuitemradio')).toHaveCount(3);
	await expect(permissionMenu.getByRole('menuitemradio', { name: 'Manual', exact: true })).toHaveAttribute(
		'aria-checked',
		'true',
	);
	await expect(permissionMenu.getByRole('menuitemradio', { name: 'Auto', exact: true })).toHaveAccessibleDescription(
		'Review operations automatically; ask you when uncertain',
	);
	await expect(permissionMenu.locator('.ash-sessions-permission-shortcut')).toHaveText(['1', '2', '3']);
	await expect(permissionMenu.getByRole('menuitem', { name: 'Review model…', exact: true })).toBeVisible();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/press 1, 2, or 3/u);
	await page.keyboard.press('Escape');
	await expect(permissionMenu.getByRole('menuitemradio', { name: 'Manual', exact: true })).toBeFocused();
	await page.keyboard.press('1');
	await expect(composer.getByRole('button', { name: 'Permissions: Auto', exact: true })).toBeFocused();
	const modeButton = composer.getByRole('button', { name: 'Mode: Agent', exact: true });
	await modeButton.click();
	const modes = page.locator('.ash-chat-input-mode-menu');
	await expect(modes.getByRole('menuitemradio', { name: 'Execute', exact: true })).toHaveCount(0);
	await modes.getByRole('menuitemradio', { name: 'Plan', exact: true }).click();
	await expect(composer.getByRole('button', { name: 'Permissions: Auto', exact: true })).toBeVisible();
	await composer.getByRole('button', { name: 'Permissions: Auto', exact: true }).press('ArrowDown');
	await page.keyboard.press('3');
	const warning = page.getByRole('dialog').filter({ hasText: 'Skip most permission approvals?' });
	await expect(warning).toContainText('File and network access limits still apply');
	await expect(warning.getByRole('button', { name: 'Bypass permissions', exact: true })).toBeVisible();
	await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(composer.getByRole('button', { name: 'Permissions: Auto', exact: true })).toBeVisible();
	await expect(composer.getByRole('button', { name: 'Mode: Plan', exact: true })).toBeVisible();
	await composer.getByRole('button', { name: 'Permissions: Auto', exact: true }).press('ArrowDown');
	await page.keyboard.press('3');
	await warning.getByRole('button', { name: 'Bypass permissions', exact: true }).click();
	await expect(composer.getByRole('button', { name: 'Permissions: Bypass permissions', exact: true })).toBeVisible();
	await expect(composer.getByRole('button', { name: 'Mode: Plan', exact: true })).toBeVisible();
	await composer.getByRole('button', { name: 'Permissions: Bypass permissions', exact: true }).press('ArrowDown');
	await page.keyboard.press('2');
	await expect(composer.getByRole('button', { name: 'Permissions: Manual', exact: true })).toBeFocused();
	await composer.getByRole('button', { name: 'Permissions: Manual', exact: true }).press('ArrowDown');
	await page.keyboard.press('Home');
	await expect(permissionMenu.getByRole('menuitemradio', { name: 'Auto', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(permissionMenu.getByRole('menuitemradio', { name: 'Manual', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(composer.getByRole('button', { name: 'Permissions: Manual', exact: true })).toBeFocused();
	await composer.getByRole('button', { name: 'Permissions: Manual', exact: true }).press('ArrowDown');
	await page.keyboard.press('Tab');
	await expect(permissionMenu).toBeHidden();
	await editor.input.focus();
	await editor.input.press('ControlOrMeta+End');
	await page.keyboard.type('123');
	await editor.waitForEditorContents(contents => contents === `${fileDraft}123`);
	await expect(composer.getByRole('button', { name: 'Permissions: Manual', exact: true })).toBeVisible();
	// Replace only the plain text so the inline file reference remains attached.
	for (let count = 0; count < 3; count++) await editor.input.press('Backspace');
	await page.keyboard.insertText('Keep the attached draft');
	await editor.waitForEditorContents(contents => contents === `${fileDraft}Keep the attached draft`);
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Attachments can be sent without text/u);
	await page.keyboard.press('Escape');
	await expect(editor.input).toBeFocused();
	await composer.locator(':is(.ash-chat-input-container,.ash-cowork-input-container)').evaluate(element => {
		const clipboard = new DataTransfer();
		const bytes = Uint8Array.from(
			atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='),
			character => character.charCodeAt(0),
		);
		clipboard.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
		element.dispatchEvent(
			new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }),
		);
	});
	await expect(composer.getByRole('button', { name: 'Remove clipboard.png', exact: true })).toBeVisible();
	await editor.waitForEditorContents(
		contents =>
			contents.includes('context.ts') &&
			contents.includes('Keep the attached draft') &&
			contents.includes('clipboard.png'),
	);
	const imageDraft = (await editor.lines.allTextContents()).join('\n').replace(/\u00a0/g, ' ');
	await composer.locator(':is(.ash-chat-input-container,.ash-cowork-input-container)').evaluate(element => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['# Context'], 'dropped.md', { type: 'text/plain' }));
		element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
	});
	await expect(composer.locator(':is(.ash-chat-drop-overlay,.ash-cowork-drop-overlay)')).toBeVisible();
	await composer.locator(':is(.ash-chat-input-container,.ash-cowork-input-container)').evaluate(element => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['# Context'], 'dropped.md', { type: 'text/plain' }));
		element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
	});
	await expect(editor.element.locator('.ash-chat-code-reference')).toHaveText(['context.ts', 'dropped.md']);
	await expect(composer.locator(':is(.ash-chat-drop-overlay,.ash-cowork-drop-overlay)')).toBeHidden();
	await editor.input.focus();
	await editor.input.press('End');
	await editor.input.press('Backspace');
	await editor.waitForEditorContents(contents => contents.endsWith('dropped.md'));
	await editor.input.press('Backspace');
	await expect(editor.element.locator('.ash-chat-code-reference')).toHaveText(['context.ts']);
	await editor.waitForEditorContents(contents => contents === imageDraft);
	await composer.getByRole('button', { name: 'Dismiss tip', exact: true }).click();
	await expect(composer.locator(':is(.ash-chat-input-tip,.ash-cowork-input-tip)')).toHaveCount(0);
	await editor.waitForEditorFocus();
	page = await workbench.reopenAgentsWindow(application, page);
	composer = page.locator(':is(.ash-sessions-chat-input,.ash-sessions-cowork-input)').first();
	editor = new Editor(composer);
	await editor.waitForEditorContents(contents => contents === imageDraft);
	await expect(editor.element.locator('.ash-chat-code-reference')).toHaveText(['context.ts']);
	await expect(composer.getByRole('button', { name: 'Remove clipboard.png', exact: true })).toBeVisible();
	await expect(composer.locator(':is(.ash-chat-input-tip,.ash-cowork-input-tip)')).toHaveCount(0);
	const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
	await returnFromSessions(page, application);
	await closed;
});

test('Sessions composer configuration leaves Workbench input defaults unchanged', async ({
	application,
	target,
	workbench,
}) => {
	const parent = workbench.page;
	if (!(await parent.locator('.ash-chat-view-pane').isVisible())) {
		await parent.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const defaultInput = parent.locator('.ash-chat-view-pane :is(.ash-chat-input-part,.ash-cowork-input-part)').first();
	const defaultCard = defaultInput.locator(':is(.ash-chat-input-container,.ash-cowork-input-container)');
	const workbenchBlurTarget = parent.getByRole('tab', { name: 'Explorer', exact: true });
	await expect(defaultInput.locator(':is(.ash-chat-input-container,.ash-cowork-input-container)')).toHaveCSS(
		'border-radius',
		'8px',
	);
	await expect(defaultInput.locator(':is(.ash-chat-input-editor,.ash-cowork-input-editor)')).toHaveCSS(
		'height',
		'40px',
	);
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
		probe.style.color = 'var(--ash-focusBorder)';
		element.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	await expect(defaultInput.locator(':is(.ash-chat-input-container,.ash-cowork-input-container)')).toHaveCSS(
		'border-top-color',
		focusBorder,
	);
	await expect(defaultInput.locator(':is(.ash-chat-input-container,.ash-cowork-input-container)')).toHaveCSS(
		'outline-style',
		'none',
	);
	await expect(defaultInput.locator(':is(.ash-chat-input-container,.ash-cowork-input-container)')).toHaveCSS(
		'box-shadow',
		'none',
	);
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
	const sessionsInput = page.locator(':is(.ash-sessions-chat-input,.ash-sessions-cowork-input)').first();
	await expect(sessionsInput.locator(':is(.ash-chat-input-container,.ash-cowork-input-container)')).toHaveCSS(
		'border-radius',
		'12px',
	);
	await expect(sessionsInput.locator(':is(.ash-chat-input-editor,.ash-cowork-input-editor)')).toHaveCSS(
		'height',
		'48px',
	);
	const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
	await returnFromSessions(page, application);
	await closed;
	await workbench.waitForReady();
	if (!(await parent.locator('.ash-chat-view-pane').isVisible())) {
		await parent.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await expect(defaultInput.locator(':is(.ash-chat-input-container,.ash-cowork-input-container)')).toHaveCSS(
		'border-radius',
		'8px',
	);
	await expect(defaultInput.locator(':is(.ash-chat-input-editor,.ash-cowork-input-editor)')).toHaveCSS(
		'height',
		'40px',
	);
	await defaultInput.getByRole('textbox', { name: 'Chat message' }).focus();
	await defaultCard.hover();
	await expect(defaultCard).toHaveCSS('border-top-color', focusBorder);
	await expect(defaultCard).toHaveCSS('box-shadow', 'none');
	await expect(defaultCard).toHaveCSS('transition-duration', '0s');
	await workbenchBlurTarget.focus();
	await expect(defaultCard).toHaveCSS('border-top-color', restingBorder);
	await expect(parent.locator(':is(.ash-sessions-chat-input,.ash-sessions-cowork-input)')).toHaveCount(0);
});

focusTest(
	'Sessions input shadow has its own theme color when general widget shadows are transparent',
	async ({ application, target, workbench }) => {
		const parent = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		const settings = parent.getByRole('dialog', { name: 'Ash Settings' });
		await settings.locator('[data-settings-group-id="workbench"]').click();
		await settings.locator('[data-settings-category-id="appearance"]').click();
		const colors = settings.locator('[data-configuration-key="workbench.colorCustomizations"]');
		for (const [id, color] of [
			['widget.shadow', '#00000000'],
			['sessions.inputShadow', '#12345666'],
		]) {
			await colors.getByRole('button', { name: 'Add Color', exact: true }).click();
			const row = colors.locator('.ash-string-map-row').last();
			await row.locator('[data-pattern-part="key"]').fill(id);
			await row.locator('[data-pattern-part="value"]').fill(color);
			await row.locator('[data-pattern-part="value"]').press('Tab');
		}
		await settings.locator('.ash-modal-editor-close').click();
		const page = await workbench.openAgentsWindow(target.kind);
		for (const presentation of ['Cowork', 'Code'] as const) {
			const chat = await openSessionsComposer(page, presentation);
			const card = chat.locator('.ash-chat-input-container');
			await expect
				.poll(() =>
					card.evaluate(element => {
						const style = getComputedStyle(element);
						return [
							style.getPropertyValue('--ash-widget-shadow').trim(),
							style.getPropertyValue('--ash-sessions-inputShadow').trim(),
						];
					}),
				)
				.toEqual(['rgba(0, 0, 0, 0)', 'rgba(18, 52, 86, 0.4)']);
			await expectFloatingComposerHover(
				card,
				card.getByRole('textbox', { name: 'Chat message' }),
				page.getByRole('button', { name: 'Hide sidebar', exact: true }),
				presentation,
			);
		}
		const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
		await returnFromSessions(page, application);
		await closed;
		await workbench.waitForReady();
		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		await settings.locator('[data-settings-group-id="workbench"]').click();
		await settings.locator('[data-settings-category-id="appearance"]').click();
		for (let count = 2; count > 0; count--) {
			await colors.locator('.ash-string-map-row').last().getByRole('button').click();
			await expect(colors.locator('.ash-string-map-row')).toHaveCount(count - 1);
		}
		await settings.locator('.ash-modal-editor-close').click();
	},
);

test('Sessions empty chat centers a growing input card and keeps the draft across themes and navigation', async ({
	application,
	target,
	workbench,
}) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const setColorScheme = (colorScheme: 'light' | 'dark') => workbench.setAppearance(application, colorScheme, page);
	await openSessionsComposer(page, 'Cowork');
	const chat = page.locator('.ash-sessions-chat-slot :is(.ash-chat,.ash-cowork):visible').first();
	const card = chat.locator(':is(.ash-chat-input-container,.ash-cowork-input-container):visible');
	const editor = new Editor(chat);
	const input = editor.input;
	await expect(chat.getByRole('heading', { name: 'What can we work on?' })).toBeVisible();
	await expect(page.locator('[data-part="sessions"] .ash-editor-title-control')).toBeHidden();
	await expect(card).toHaveCSS('border-radius', '12px');
	// Windows display scaling can serialize a one-pixel border as a fractional CSS width.
	expect(await card.evaluate(element => Math.round(parseFloat(getComputedStyle(element).borderTopWidth)))).toBe(1);
	await expect(chat.locator(':is(.ash-chat-textarea-input,.ash-cowork-textarea-input)')).toHaveCount(0);
	await expect(chat.locator(':is(.ash-chat-input-editor,.ash-cowork-input-editor):visible')).toHaveCSS(
		'height',
		'32px',
	);
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
	await expect(chat.locator(':is(.ash-chat-input-editor,.ash-cowork-input-editor):visible')).toHaveCSS(
		'height',
		'240px',
	);
	await editor.waitForEditorContents(contents => contents.includes('Draft line 50'));
	await page.keyboard.press('ControlOrMeta+Home');
	await editor.waitForEditorContents(contents => contents.startsWith('Draft line 1\n'));
	await replaceChatInput(editor, 'Keep this draft');
	for (const colorScheme of ['light', 'dark'] as const) {
		await setColorScheme(colorScheme);
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', `ash-${colorScheme}`);
		await expectComposerFocusWithoutOutline(
			card,
			input,
			page.getByRole('button', { name: 'Hide sidebar', exact: true }),
		);
		await expectFloatingComposerHover(
			card,
			input,
			page.getByRole('button', { name: 'Hide sidebar', exact: true }),
			'Cowork',
		);
		await editor.waitForEditorContents(contents => contents === 'Keep this draft');
		await expect(card).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	}
	await openSessionsComposer(page, 'Code');
	await expect(chat.locator(':is(.chat-composer,.cowork-composer)')).toBeVisible();
	await editor.waitForEditorContents(contents => contents === 'Keep this draft');
	await replaceChatInput(editor, Array.from({ length: 50 }, (_, index) => `Code line ${index + 1}`).join('\n'));
	await expect(chat.locator(':is(.ash-chat-input-editor,.ash-cowork-input-editor):visible')).toHaveCSS(
		'height',
		'240px',
	);
	await replaceChatInput(editor, 'Keep this draft');
	for (const colorScheme of ['light', 'dark'] as const) {
		await setColorScheme(colorScheme);
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', `ash-${colorScheme}`);
		await expectComposerFocusWithoutOutline(
			card,
			input,
			page.getByRole('button', { name: 'Hide sidebar', exact: true }),
		);
		await expectFloatingComposerHover(
			card,
			input,
			page.getByRole('button', { name: 'Hide sidebar', exact: true }),
			'Code',
		);
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
	await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
	await openSessionsComposer(page, 'Cowork');
	await expect(chat.locator(':is(.chat-composer,.cowork-composer)')).toBeVisible();
	await editor.waitForEditorContents(contents => contents === 'Keep this draft\n');
});

focusTest(
	'Sessions input card keeps a visible border without shadow or focus outline in high contrast',
	{ tag: ['@browser-app-server', '@electron-app-server'] },
	async ({ application, target, workbench }) => {
		for (const theme of ['Ash High Contrast Dark', 'Ash High Contrast Light']) {
			await workbench.quickaccess.runCommand('workbench.action.selectTheme');
			const picker = workbench.page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill(theme);
			await picker.getByRole('combobox').press('Enter');
			await expect(picker).toHaveCount(0);
			const page = await workbench.openAgentsWindow(target.kind);
			await expect(page.locator('#app')).toHaveAttribute(
				'data-color-scheme',
				theme.endsWith('Dark') ? 'hcDark' : 'hcLight',
			);
			const sidebar = page.locator('[data-part="sidebar"]');
			await expect(sidebar).toBeVisible();
			expect(
				await sidebar.evaluate(element => Math.round(parseFloat(getComputedStyle(element).borderRightWidth))),
			).toBe(1);
			await expect(sidebar).toHaveCSS('border-right-style', 'solid');
			await expect(sidebar).not.toHaveCSS('border-right-color', 'rgba(0, 0, 0, 0)');
			for (const presentation of ['Cowork', 'Code'] as const) {
				const chat = await openSessionsComposer(page, presentation);
				const card = chat.locator('.ash-chat-input-container');
				expect(
					await card.evaluate(element => Math.round(parseFloat(getComputedStyle(element).borderRightWidth))),
				).toBe(1);
				await expect(card).toHaveCSS('border-style', 'solid');
				await expect(card).toHaveCSS('box-shadow', 'none');
				await expectComposerFocusWithoutOutline(
					card,
					card.getByRole('textbox', { name: 'Chat message' }),
					page.getByRole('button', { name: 'Hide sidebar', exact: true }),
				);
				await card.hover();
				await expect(card).toHaveCSS('box-shadow', 'none');
			}
			const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
			await returnFromSessions(page, application);
			await closed;
			await workbench.waitForReady();
		}
	},
);

test.describe('Notification Center', () => {
	test.use({ openWorkspace: false });
	test('Sessions window does not show an empty Notification Center button', async ({
		application,
		target,
		workbench,
	}) => {
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

async function returnFromSessions(page: Page, application: PlaywrightApplication): Promise<void> {
	if ('windows' in application && process.platform === 'darwin') {
		await waitForElectronWindowState(application, page, { focused: true });
	}
	await new Menus(page).selectApplication(application, ['File', 'Return to Workbench']);
}

async function expectActivityIconSize(navigation: Locator, size: number): Promise<void> {
	await expect(navigation).toHaveCSS('display', 'flex');
	await expect(navigation).toHaveCSS('justify-content', 'space-between');
	await expect
		.poll(() =>
			navigation.evaluate(
				element =>
					getComputedStyle(element).flexDirection ===
					(element.classList.contains('horizontal') ? 'row' : 'column'),
			),
		)
		.toBe(true);
	const icons = navigation.locator('button .ash-icon');
	const horizontal = await navigation.evaluate(element => element.classList.contains('horizontal'));
	const labeled = await navigation.evaluate(element => element.classList.contains('labeled'));
	const itemSize = horizontal ? 24 : 36;
	const entries = navigation.locator('.ash-composite-bar-navigation-item > button');
	await expect(entries).not.toHaveCount(0);
	for (const item of await entries.all()) {
		await expect(item.locator('.ash-icon')).toHaveCount(1);
		if (labeled) {
			expect((await item.boundingBox())!.width).toBeGreaterThan(itemSize);
		} else {
			await expect(item).toHaveCSS('width', `${itemSize}px`);
		}
		await expect(item).toHaveCSS('height', `${itemSize}px`);
	}
	await expect(icons).toHaveCount((await entries.count()) + (horizontal || labeled ? 0 : 1));
	const accounts = navigation.page().getByRole('button', { name: 'Accounts', exact: true });
	await expect(accounts).toHaveCount(1);
	const titlebarAccounts = navigation
		.page()
		.locator('[data-part="titlebar"]')
		.getByRole('button', { name: 'Accounts', exact: true });
	await expect(titlebarAccounts).toHaveCount(horizontal ? 1 : 0);
	if (horizontal) {
		await expect(navigation.getByRole('button', { name: 'Accounts', exact: true })).toHaveCount(0);
		await expect(titlebarAccounts.locator('.ash-icon')).toHaveCSS('width', '16px');
		await expect(titlebarAccounts.locator('.ash-icon')).toHaveCSS('height', '16px');
		await expect(titlebarAccounts).toHaveAttribute('aria-haspopup', 'menu');
	}
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
		if (!labeled) {
			expect(bounds.x).toBeLessThanOrEqual(1);
		}
		expect(bounds.y).toBeLessThanOrEqual(1);
	}
}

test('Code Sessions mode selection updates its shared composer', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const mode = page.locator('[data-action-id="ash.chat.input.mode"] button').first();
	await mode.click();
	const menu = page.locator('.ash-chat-input-mode-menu');
	await expect(menu.getByRole('menuitemradio', { name: 'Default Agent', exact: true })).toHaveAttribute(
		'aria-checked',
		'true',
	);
	await menu.getByRole('menuitemradio', { name: 'Plan', exact: true }).click();
	await expect(mode).toHaveText('Plan');
	await expect(mode).toBeFocused();
});

test('Sessions navigation retains its own selection and hover skin across navigation positions', async ({
	application,
	target,
	workbench,
}) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.bringToFront();
	const navigation = page.locator('.ash-sessions-activity-content');
	const chat = navigation.getByRole('button', { name: 'New', exact: true });
	const originalChat = await chat.elementHandle();
	await chat.click();
	await expect(chat).toHaveAttribute('aria-current', 'page');
	await expectActivityIconSize(navigation, 16);
	await expect(chat).toHaveCSS('width', '36px');
	await expect(chat).toHaveCSS('height', '32px');
	// Shared toolbar theme overrides must not change Sessions navigation feedback.
	const hoverVariables = ['--ash-toolbar-hoverBackground', '--ash-sessions-selectionBackground'];
	const previousHoverStyles = await navigation.evaluate((element, variables) => {
		const style = (element as HTMLElement).style;
		const previous = variables.map(variable => ({
			variable,
			value: style.getPropertyValue(variable),
			priority: style.getPropertyPriority(variable),
		}));
		style.setProperty(variables[0], 'rgb(255, 0, 255)');
		style.setProperty(variables[1], 'rgb(12, 34, 56)');
		return previous;
	}, hoverVariables);
	try {
		await navigation.getByRole('button', { name: 'Projects', exact: true }).hover();
		await expect(navigation.getByRole('button', { name: 'Projects', exact: true })).toHaveCSS(
			'background-color',
			'rgb(12, 34, 56)',
		);
		await chat.hover();
		await expect(chat).toHaveCSS('background-color', 'rgb(12, 34, 56)');
	} finally {
		await navigation.evaluate((element, previous) => {
			const style = (element as HTMLElement).style;
			for (const { variable, value, priority } of previous) {
				if (value) style.setProperty(variable, value, priority);
				else style.removeProperty(variable);
			}
		}, previousHoverStyles);
	}
	for (const position of ['Top', 'Bottom', 'Default']) {
		if ('windows' in application && process.platform === 'darwin') {
			await captureElectronMenu(application, () => chat.click({ button: 'right' }), { label: position });
		} else {
			await chat.click({ button: 'right' });
			await page.getByRole('menuitem', { name: 'Activity Bar Position', exact: true }).click();
			await page.getByRole('menuitemcheckbox', { name: position, exact: true }).click();
		}
		await expectActivityIconSize(navigation, position === 'Default' ? 24 : 16);
		const selected = navigation.locator('.ash-composite-bar-navigation-item.checked > button.selected');
		await expect(selected).toHaveCount(1);
		await expect(selected).toHaveCSS('background-color', 'rgb(240, 240, 240)');
		await expect(selected.locator('.ash-icon')).toHaveCSS('color', 'rgb(0, 0, 0)');
		await expect(selected).toHaveCSS('border-radius', '8px');
		await page.bringToFront();
		await page.mouse.move(600, 400);
		await chat.hover();
		const tooltip = page.getByRole('tooltip');
		await expect(tooltip).toHaveText('Chat');
		const anchorBounds = await chat.boundingBox();
		const hoverBounds = await page.locator('.ash-context-view-hover', { has: tooltip }).boundingBox();
		if (position === 'Top') expect(hoverBounds!.y).toBeGreaterThanOrEqual(anchorBounds!.y + anchorBounds!.height);
		if (position === 'Bottom') expect(hoverBounds!.y + hoverBounds!.height).toBeLessThanOrEqual(anchorBounds!.y);
		if (position === 'Default')
			expect(hoverBounds!.x).toBeGreaterThanOrEqual(anchorBounds!.x + anchorBounds!.width);
		await page.keyboard.press('Escape');
		if (position !== 'Default') {
			await expect(chat).toHaveCSS('width', '24px');
			await expect(chat).toHaveCSS('height', '24px');
		}
		const projects = navigation.getByRole('button', { name: 'Projects', exact: true });
		await page.mouse.move(600, 400);
		await expect(projects.locator('.ash-icon')).toHaveCSS('color', 'rgb(128, 128, 128)');
		await projects.hover();
		await expect(projects).toHaveCSS('background-color', 'rgb(240, 240, 240)');
		await expect(projects.locator('.ash-icon')).toHaveCSS('color', 'rgb(0, 0, 0)');
		await page.mouse.move(600, 400);
		await expect(projects).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(projects.locator('.ash-icon')).toHaveCSS('color', 'rgb(128, 128, 128)');
		await chat.focus();
		await chat.press(position === 'Default' ? 'ArrowDown' : 'ArrowRight');
		// Switch workspaces before exercising Code's Collab entry.
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const collaboration = navigation.getByRole('button', { name: 'Collab', exact: true });
		await expect(collaboration).toBeFocused();
		await collaboration.press('Enter');
		await expect(collaboration).toHaveAttribute('aria-current', 'page');
		await expect(collaboration.locator('.ash-icon')).toHaveCSS('color', 'rgb(0, 0, 0)');
		await expect(collaboration).toHaveCSS('background-color', 'rgb(240, 240, 240)');
		await expect(collaboration.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'collab');
		await expect(navigation.locator('.ash-composite-bar-navigation-item.checked')).toHaveCount(1);
		await expect(chat).not.toHaveAttribute('aria-current');
		await chat.press('Enter');
		await expect(chat).toHaveAttribute('aria-current', 'page');
		expect(await chat.evaluate((element, original) => element === original, originalChat)).toBe(true);
	}
	await expectActivityIconSize(navigation, 16);
	await expect(chat).toHaveCSS('height', '32px');
	await expect(chat).toHaveCSS('border-radius', '8px');
	await workbench.setAppearance(application, 'dark', page);
	await expect(chat).toHaveCSS('background-color', 'rgb(48, 48, 48)');
	await expect(chat).toHaveCSS('border-radius', '8px');
	const projects = navigation.getByRole('button', { name: 'Projects', exact: true });
	await page.mouse.move(600, 400);
	await expect(chat.locator('.ash-icon')).toHaveCSS('color', 'rgb(255, 255, 255)');
	await expect(projects.locator('.ash-icon')).toHaveCSS('color', 'rgb(153, 153, 153)');
	await projects.hover();
	await expect(projects).toHaveCSS('background-color', 'rgb(48, 48, 48)');
	await expect(projects.locator('.ash-icon')).toHaveCSS('color', 'rgb(255, 255, 255)');
	await originalChat!.dispose();
});

test(
	'Browser Code opens Sessions and reloads the routed workbench',
	{ tag: ['@browser-ui', '@browser-app-server'] },
	async ({ workbench }) => {
		const page = workbench.page;
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
		const activityBar = page.locator('.ash-sessions-activity-content');
		await expect(activityBar).toBeVisible();
		await activityBar.getByRole('button', { name: 'Artifacts', exact: true }).click();
		await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
		await expect(page.getByRole('region', { name: 'Design canvas' })).toBeVisible();
		await activityBar.getByRole('button', { name: 'New', exact: true }).click();
		await expect(page.locator('.ash-sessions-list:visible')).toBeVisible();
		await workbench.reloadWindow(page);
		await expect(activityBar).toBeVisible();
		await expect(page.locator('.ash-sessions-list:visible')).toBeVisible();
	},
);

test(
	'Browser Sessions settings scroll each pane independently',
	{ tag: ['@browser-ui'] },
	async ({ target, workbench }) => {
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
			await expect
				.poll(() => navigationViewport.evaluate(viewport => viewport.scrollHeight > viewport.clientHeight))
				.toBe(true);
			await expect
				.poll(() => contentViewport.evaluate(viewport => viewport.scrollHeight > viewport.clientHeight))
				.toBe(true);
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
	},
);

test(
	'Browser Models Settings controls which models appear in the picker',
	{ tag: ['@browser-app-server'] },
	async ({ target, workbench }) => {
		const page = workbench.page;
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
		const modelButton = page.locator('[data-action-id="ash.chat.input.model"] button').first();
		await expect(modelButton).toBeVisible();
		const accounts = page.locator('.ash-sessions-activity-bottom button').last();
		await accounts.click();
		await page.getByRole('menuitem', { name: 'Settings' }).click();
		const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
		await settings
			.getByRole('navigation', { name: 'Settings categories' })
			.getByRole('button', { name: 'Models' })
			.click();
		await expect(settings.locator('.ash-local-transcription-model-controls')).toHaveCount(0);

		await expect(settings.getByRole('heading', { name: 'API key' })).toBeVisible();
		const apiConnection = settings.locator('.ash-models-settings-api-row').first();
		await expect(apiConnection).toBeVisible();
		await expect(apiConnection.locator('input[type="password"]')).toBeVisible();
		const apiName = (await apiConnection.locator('h5').textContent())!.trim();
		const modelRows = settings.locator('.ash-models-settings-model-row');
		await expect(modelRows.first()).toBeVisible();
		const firstModel = modelRows.first();
		const modelName = (await firstModel
			.locator('.ash-models-settings-model-copy > span')
			.first()
			.textContent())!.trim();
		const catalogSearch = settings.getByRole('searchbox', { name: 'Search models', exact: true });
		await catalogSearch.fill('openai/gpt-6-astra');
		await expect(modelRows).toHaveCount(1);
		await expect(modelRows).toContainText(['GPT-6 Astra']);
		await expect(catalogSearch).toBeFocused();
		await expect(apiConnection).toBeVisible();
		await catalogSearch.fill('');
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
		const auto = page
			.locator(':is(.ash-chat-model-picker,.ash-cowork-model-picker)')
			.getByRole('switch', { name: 'Auto' });
		if (await auto.isChecked()) {
			await auto.press('Space');
			await expect(auto).not.toHaveAttribute('aria-busy', 'true');
		}
		await expect(
			page.locator(':is(.ash-chat-model-picker,.ash-cowork-model-picker)').getByRole('combobox'),
		).toBeVisible();
		await expect(
			page.locator(':is(.ash-chat-model-picker,.ash-cowork-model-picker)').getByText(modelName, { exact: true }),
		).toHaveCount(0);
		await page.keyboard.press('Escape');
		await accounts.click();
		await page.getByRole('menuitem', { name: 'Settings' }).click();
		await settings
			.getByRole('navigation', { name: 'Settings categories' })
			.getByRole('button', { name: 'Models' })
			.click();
		const restoredVisibility = settings.getByRole('switch', { name: `Show ${modelName} in model picker` });
		await expect(restoredVisibility).toHaveAttribute('aria-checked', 'false');
		await restoredVisibility.locator('..').locator('.ash-switch-track').click();
		await expect(restoredVisibility).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape');
		await modelButton.click();
		await expect(
			page.locator(':is(.ash-chat-model-picker,.ash-cowork-model-picker)').getByText(modelName, { exact: true }),
		).toBeVisible();
	},
);

test(
	'Electron Code Sessions Activity Bar follows its position setting with fixed sizes',
	{ tag: ['@electron-ui', '@electron-app-server'] },
	async ({ application, target, workbench }) => {
		if (target.kind !== 'electron' || !('windows' in application)) return;
		const page = await workbench.openAgentsWindow(target.kind);
		const original = await (async () => {
			return (await readUserSettings(page)).content;
		})();
		const updateSettings = async (location: string): Promise<void> => {
			await (async values => {
				const snapshot = await readUserSettings(page);
				const settings = JSON.parse(snapshot.content) as Record<string, unknown>;
				settings['sessions.activityBar.location'] = values.location;
				await writeUserSettings(page, JSON.stringify(settings), snapshot.revision);
			})({ location });
		};
		try {
			await updateSettings('default');
			await expect(page.locator('[data-part="activitybar"]')).toHaveCount(0);
			await expect(page.locator('.ash-workbench-activitybar, .ash-activity-bar-content')).toHaveCount(0);
			const activityNavigation = page.locator('.ash-sessions-activity-content');
			await expectActivityIconSize(activityNavigation, 16);
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			const collaboration = page
				.locator('.ash-sessions-activity-content')
				.getByRole('button', { name: 'Collab' });
			const projects = page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Projects' });
			await collaboration.click();
			await expect(collaboration.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'collab');
			await expect(page.locator('.ash-sessions-list:visible')).toBeHidden();
			await page
				.locator('.ash-window-mode-control')
				.getByRole('button', { name: 'Chat / Agents', exact: true })
				.click();
			await expect(projects.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'projects');
			await projects.click();
			await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
			await expect(page.locator('[data-part="auxiliarybar"] h2')).toBeHidden();
			await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
			await page
				.locator('.ash-sessions-activity-content')
				.getByRole('button', { name: 'New', exact: true })
				.click();
			await expect(page.locator('.ash-sessions-list:visible')).toBeVisible();
			const chatButton = page.locator('.ash-sessions-activity-content button').first();
			await expect(chatButton).toBeVisible();
			await chatButton.click({ button: 'right' });
			await page.keyboard.press('Escape');
			await updateSettings('top');
			await expect(page.locator('[data-part="activitybar"]')).toHaveCount(0);
			await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
			await expectActivityIconSize(activityNavigation, 16);
			await page.reload();
			await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
			await expectActivityIconSize(activityNavigation, 16);
			const titlebarAccounts = page
				.locator('[data-part="titlebar"]')
				.getByRole('button', { name: 'Accounts', exact: true });
			const accountItems = await new Menus(page).inspect(application, () => titlebarAccounts.press('Enter'));
			expect(accountItems.map(item => item.label)).toEqual(
				expect.arrayContaining(['Settings', 'Return to Workbench']),
			);
			await expect(titlebarAccounts).toHaveAttribute('aria-expanded', 'false');
			await updateSettings('bottom');
			await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
			await expectActivityIconSize(activityNavigation, 16);
			await updateSettings('default');
			await expect(page.locator('.ash-sessions-activity-content')).toBeVisible();
			await expectActivityIconSize(activityNavigation, 16);
		} finally {
			await (async source => {
				const snapshot = await readUserSettings(page);
				await writeUserSettings(page, source, snapshot.revision);
			})(original);
		}
	},
);

test(
	'Electron Sessions account menu opens the Sessions settings page',
	{ tag: ['@electron-ui', '@electron-app-server'] },
	async ({ application, target, workbench }) => {
		if (target.kind !== 'electron' || !('windows' in application)) return;
		if (process.platform === 'darwin') {
			// The system menu is outside Playwright's page DOM; use the product's custom menu for this UI flow.
			await (async () => {
				const snapshot = await readUserSettings(workbench.page);
				const settings = JSON.parse(snapshot.content) as Record<string, unknown>;
				settings['window.menuStyle'] = 'custom';
				await writeUserSettings(workbench.page, JSON.stringify(settings), snapshot.revision);
			})();
		}
		const page = await workbench.openAgentsWindow(target.kind);
		const accountButton = page.locator('.ash-sessions-activity-bottom button').last();
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
		await expect(settings.locator('.ash-sessions-settings-page .ash-scrollbar-viewport')).toHaveCSS(
			'scrollbar-width',
			'none',
		);
		await expect(navigation.locator('.ash-scrollbar-track-vertical')).toHaveCount(1);
		await expect(settings.locator('.ash-sessions-settings-page .ash-scrollbar-track-vertical')).toHaveCount(1);
		const sidebarBounds = await settings.locator('.ash-sessions-settings-sidebar').boundingBox();
		const scrollTrackBounds = await navigation.locator('.ash-scrollbar-track-vertical').boundingBox();
		expect(sidebarBounds).not.toBeNull();
		expect(scrollTrackBounds).not.toBeNull();
		expect(
			Math.abs(sidebarBounds!.x + sidebarBounds!.width - scrollTrackBounds!.x - scrollTrackBounds!.width),
		).toBeLessThanOrEqual(2);
		await navigation.getByRole('button', { name: 'Appearance' }).click();
		await expect(settings.locator('[data-configuration-key="sessions.layoutStyle"]')).toBeVisible();
		await expect(settings.locator('[data-configuration-key="sessions.activityBar.location"]')).toBeVisible();
		await expect(settings.locator('[data-configuration-key="sessions.activityBar.compact"]')).toHaveCount(0);
		await navigation.getByRole('button', { name: 'General' }).click();
		await expect(settings.locator('[data-configuration-key="dictation.backend"]')).toBeVisible();
		await expect(settings.locator('[data-configuration-key="dictation.cloudProvider"]')).toHaveCount(0);
		await expect(settings.getByRole('grid', { name: 'Local dictation models' })).toBeVisible();
		await expect(settings.locator('.ash-local-transcription-model-controls')).toBeVisible();
		await navigation.getByRole('button', { name: 'General' }).click();
		await expect(
			settings.locator('[data-configuration-key="accessibility.verbosity.sessionsActivityBar"]'),
		).toBeVisible();
		await expect(
			settings.locator('[data-configuration-key="accessibility.verbosity.sessionsSettings"]'),
		).toBeVisible();
		await expect(settings.locator('[data-configuration-key="workbench.layoutStyle"]')).toHaveCount(0);
		await navigation.getByRole('button', { name: 'Models' }).click();
		await expect(settings.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
		await expect(settings.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
		await expect(settings.getByRole('searchbox', { name: 'Search models', exact: true })).toBeVisible();
		await expect(settings.locator('.ash-local-transcription-model-controls')).toHaveCount(0);
		await expect(settings.getByRole('heading', { name: 'API key' })).toBeVisible();
		if (target.appServerMode === 'required') {
			await expect(
				settings.locator('.ash-models-settings-api-row').first().locator('input[type="password"]'),
			).toBeVisible();
			await expect(
				settings.getByRole('switch', { name: 'Show GPT-6.1 Sol in model picker', exact: true }),
			).toBeChecked();
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
	},
);

test(
	'Sessions and IDE layout styles switch independently',
	{ tag: ['@electron-ui', '@electron-app-server'] },
	async ({ application, target, workbench }) => {
		if (target.kind !== 'electron' || !('windows' in application)) return;
		const sessionsPage = await workbench.openAgentsWindow(target.kind);
		const sessionsWindow = sessionsPage.locator('.ash-sessions-window');
		await expect(sessionsWindow).toBeVisible();
		const original = await (async () => {
			return (await readUserSettings(sessionsPage)).content;
		})();
		const updateSettings = async (values: Record<string, string>): Promise<void> => {
			await (async changes => {
				const snapshot = await readUserSettings(sessionsPage);
				const settings = JSON.parse(snapshot.content) as Record<string, unknown>;
				for (const [key, value] of Object.entries(changes)) settings[key] = value;
				await writeUserSettings(sessionsPage, JSON.stringify(settings), snapshot.revision);
			})(values);
		};
		const gap = () =>
			sessionsPage.evaluate(() => {
				const sidebar = document.querySelector<HTMLElement>('[data-part="sidebar"]');
				const sessions = document.querySelector<HTMLElement>('[data-part="sessions"]');
				if (!sidebar || !sessions) throw new Error('Sessions regions are missing');
				return Math.round(sessions.getBoundingClientRect().left - sidebar.getBoundingClientRect().right);
			});
		try {
			await updateSettings({ 'workbench.layoutStyle': 'modern', 'sessions.layoutStyle': 'modern' });
			await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'modern');
			await expect.poll(gap).toBe(0);
			await expect(sessionsPage.locator('[data-part="activitybar"]')).toHaveCount(0);
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
			await expect(sessionsPage.locator('[data-part="activitybar"]')).toHaveCount(0);
			await expect(sessionsPage.locator('.ash-sessions-content-card')).toHaveCSS('border-radius', '12px');
		} finally {
			await (async source => {
				const snapshot = await readUserSettings(sessionsPage);
				await writeUserSettings(sessionsPage, source, snapshot.revision);
			})(original);
		}
	},
);

test(
	'Sessions applies an installed extension color theme',
	{ tag: ['@electron-app-server'] },
	async ({ application, target, workbench }) => {
		if (target.kind !== 'electron' || !('windows' in application)) return;
		const openSessions = workbench.page.locator(
			"[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button",
		);
		const sessionPagePromise = application.waitForEvent('window');
		await openSessions.click();
		const sessionsPage = await sessionPagePromise;
		await expect(sessionsPage.locator('.ash-code-sessions-window')).toBeVisible();
		await (async () => {
			const snapshot = await readUserSettings(sessionsPage);
			const values = JSON.parse(snapshot.content);
			values['workbench.colorTheme'] = 'extension-vscode-theme-defaults-visual-studio-dark';
			await writeUserSettings(sessionsPage, JSON.stringify(values), snapshot.revision);
		})();
		await expect(sessionsPage.locator('#app')).toHaveAttribute(
			'data-color-theme',
			'extension-vscode-theme-defaults-visual-studio-dark',
		);
		await expect
			.poll(() =>
				sessionsPage
					.locator('#app')
					.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim()),
			)
			.toBe('#1e1e1e');
		await expect(workbench.element).toHaveAttribute(
			'data-color-theme',
			'extension-vscode-theme-defaults-visual-studio-dark',
		);
		await expect
			.poll(() =>
				workbench.element.evaluate(element =>
					getComputedStyle(element).getPropertyValue('--ash-editor-background').trim(),
				),
			)
			.toBe('#1e1e1e');
	},
);

test(
	'Open in Agents moves the IDE chat draft and preserves drafts when the target chat is occupied',
	{ tag: ['@electron-ui'] },
	async ({ application, driver, target, workbench }) => {
		if (target.kind !== 'electron' || !('windows' in application))
			throw new Error('Agents Window handoff requires Electron');

		const workbenchPage = workbench.page;
		if (!(await workbenchPage.locator('.ash-chat-view-pane').isVisible())) {
			await workbenchPage.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		}
		const sourceChat = workbenchPage.locator('.ash-chat-view-pane :is(.ash-chat,.ash-cowork)').first();
		const sourceDraft = sourceChat.getByRole('textbox', { name: 'Chat message' });
		const sourceLine = sourceChat
			.locator(':is(.ash-chat-input-editor,.ash-cowork-input-editor) .stanza-editor-line-text')
			.first();
		await sourceDraft.focus();
		await workbenchPage.keyboard.insertText('Continue reviewing this change in Agents Window');
		await workbenchPage
			.locator('[data-part="titlebar"]')
			.getByRole('button', { name: 'Hide Secondary Side Bar', exact: true })
			.click();
		const auxiliaryBar = workbenchPage.locator('[data-part="auxiliarybar"]');
		await expect(auxiliaryBar).toBeHidden();

		const sessionsPagePromise = application.waitForEvent('window');
		await workbenchPage
			.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button")
			.click();
		let sessionsPage = await sessionsPagePromise;
		let targetEditor = new Editor(sessionsPage.locator('.ash-sessions-chat-slot.active:visible'));
		await targetEditor.waitForEditorContents(
			contents => contents === 'Continue reviewing this change in Agents Window',
		);
		await expect(auxiliaryBar).toBeHidden();
		await expect(sourceLine).toHaveText('');
		let activityNavigation = sessionsPage.locator('.ash-sessions-activity-content');
		await sessionsPage
			.locator('.ash-window-mode-control')
			.getByRole('button', { name: 'Code', exact: true })
			.click();
		await replaceChatInput(targetEditor, 'Keep this Code draft during handoff');

		const closed = sessionsPage.waitForEvent('close');
		await returnFromSessions(sessionsPage, application);
		await closed;
		await workbenchPage.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		await sourceDraft.focus();
		await workbenchPage.keyboard.insertText('Keep this second draft in the IDE');
		await expect(sourceLine).toHaveText('Keep this second draft in the IDE');
		sessionsPage = await workbench.openAgentsWindow('electron');
		// The occupied target rejects the second handoff; assert and consume only that expected command error.
		const rejectedHandoff =
			"[runtime] Error: Error invoking remote method 'ash:native-host:open-agents-window': Error: Error: The Agents Window already has an unsent draft in this chat.";
		await expect.poll(() => driver.diagnostics.errors).toEqual([rejectedHandoff]);
		driver.diagnostics.consoleErrors.splice(driver.diagnostics.consoleErrors.indexOf(rejectedHandoff), 1);
		targetEditor = new Editor(sessionsPage.locator('.ash-sessions-chat-slot.active:visible'));
		activityNavigation = sessionsPage.locator('.ash-sessions-activity-content');
		// Chat and Code share this Session's draft, including the edit made before close.
		await targetEditor.waitForEditorContents(contents => contents === 'Keep this Code draft during handoff');
		await expect(sourceLine).toHaveText('Keep this second draft in the IDE');
		await sessionsPage
			.locator('.ash-window-mode-control')
			.getByRole('button', { name: 'Code', exact: true })
			.click();
		await targetEditor.waitForEditorContents(contents => contents === 'Keep this Code draft during handoff');
	},
);

test(
	'Open in Agents selects the same session thread in the Agents Window',
	{ tag: ['@electron-app-server'] },
	async ({ application, target, workbench }) => {
		if (target.kind !== 'electron' || !('windows' in application))
			throw new Error('Agents Window handoff requires Electron');

		const workbenchPage = workbench.page;
		if (!(await workbenchPage.locator('.ash-chat-view-pane').isVisible())) {
			await workbenchPage.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		}
		const sourceChat = workbenchPage.locator('.ash-chat-view-pane :is(.ash-chat,.ash-cowork):visible');
		await sourceChat.getByRole('textbox', { name: 'Chat message' }).focus();
		await workbenchPage.keyboard.insertText('Create a session for the window handoff test');
		await sourceChat.locator('[data-action-id="ash.chat.input.send"] button').click();
		await expect(sourceChat).toHaveAttribute('data-session-id', /.+/u);
		const sessionId = await sourceChat.getAttribute('data-session-id');
		const threadId = await sourceChat.getAttribute('data-thread-id');
		expect(sessionId).toBeTruthy();
		expect(threadId).toBeTruthy();

		const sessionsPagePromise = application.waitForEvent('window');
		await workbenchPage
			.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button")
			.click();
		const sessionsPage = await sessionsPagePromise;
		const targetChat = sessionsPage.locator('.ash-sessions-chat-slot.active:visible :is(.ash-chat,.ash-cowork)');
		await expect(targetChat).toHaveAttribute('data-session-id', sessionId!);
		await expect(targetChat).toHaveAttribute('data-thread-id', threadId!);
		const sessionTitle = (await targetChat.getAttribute('aria-label'))!;
		const navigation = sessionsPage.locator('.ash-sessions-activity-content');
		await sessionsPage
			.locator('.ash-window-mode-control')
			.getByRole('button', { name: 'Code', exact: true })
			.click();
		await sessionsPage.locator('.ash-sessions-list-item').filter({ hasText: sessionTitle }).click();
		const codeChat = sessionsPage.locator('.ash-sessions-chat-slot.active:visible :is(.ash-chat,.ash-cowork)');
		await expect(codeChat).toHaveAttribute('data-session-id', sessionId!);
		await expect(codeChat).toHaveAttribute('data-thread-id', threadId!);
		await replaceChatInput(new Editor(codeChat), 'Code draft for the same conversation');
		await navigation.getByRole('button', { name: /^New(?:\.|$)/u }).click();
		const chatEditor = new Editor(
			sessionsPage.locator('.ash-sessions-chat-slot.active:visible :is(.ash-chat,.ash-cowork)'),
		);
		await chatEditor.waitForEditorContents(contents => contents === 'Code draft for the same conversation');
		await sessionsPage
			.locator('.ash-window-mode-control')
			.getByRole('button', { name: 'Code', exact: true })
			.click();
		await sessionsPage.locator('[data-action-id="sessions.newSession"] button').click();
		await expect(codeChat).not.toHaveAttribute('data-session-id', sessionId!);
		await sessionsPage.locator('[data-part="titlebar"]').getByRole('button', { name: 'Back', exact: true }).click();
		await navigation.getByRole('button', { name: /^New(?:\.|$)/u }).click();
		await expect(targetChat).toHaveAttribute('data-session-id', sessionId!);
		await expect(targetChat).toHaveAttribute('data-thread-id', threadId!);
	},
);

focusTest(
	'Agents macOS fullscreen hides window controls and restores them on exit',
	{ tag: ['@electron-ui', '@electron-app-server', '@darwin'] },
	async ({ application, target, workbench }) => {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const sessionsPage = await workbench.openAgentsWindow(target.kind);
		const spacer = sessionsPage.locator('.ash-sessions-window-controls-spacer');
		await expect(spacer).toBeVisible();
		await application.evaluate(({ app, BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find(candidate =>
				candidate.webContents.getURL().includes('sessions/electron-browser/sessions.html'),
			);
			if (!window) throw new Error('Sessions window is missing');
			window.show();
			app.focus({ steal: true });
			window.focus();
		});
		await waitForElectronWindowState(application, sessionsPage, { focused: true });
		await application.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find(candidate =>
				candidate.webContents.getURL().includes('sessions/electron-browser/sessions.html'),
			)!;
			window.setFullScreen(true);
		});
		await waitForElectronWindowState(application, sessionsPage, { fullScreen: true });
		await expect(sessionsPage.locator('#app')).toHaveClass(/ash-sessions-fullscreen/u);
		await expect(spacer).toBeHidden();
		await application.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find(candidate =>
				candidate.webContents.getURL().includes('sessions/electron-browser/sessions.html'),
			);
			if (!window) throw new Error('Sessions window is missing');
			window.setFullScreen(false);
		});
		await waitForElectronWindowState(application, sessionsPage, { fullScreen: false });
		await expect(spacer).toBeVisible();
	},
);

emptyWorkspaceTest(
	'Code opens Sessions in a dedicated Electron window and returns to Workbench',
	{ tag: ['@electron-app-server'] },
	async ({ application, target, workbench }) => {
		if (target.kind !== 'electron') {
			return;
		}
		if (!('windows' in application)) {
			throw new Error('Dedicated Sessions window verification requires Electron');
		}

		const workbenchPage = workbench.page;
		const openSessions = workbenchPage.locator(
			"[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button",
		);
		await expect(openSessions).toBeVisible();
		const sessionPagePromise = application.waitForEvent('window');
		await openSessions.click();
		const sessionsPage = await sessionPagePromise;
		await sessionsPage.waitForLoadState('domcontentloaded');
		await expect(sessionsPage.locator('.ash-code-sessions-window')).toBeVisible();
		const keybindingsResource = await sessionsPage.evaluate(async () => {
			const home = (await globalThis.ashTestMainProcess.call('localFilesystem', 'userDataHome')) as string;
			return `${home.replace(/\/$/u, '')}/keybindings.json`;
		});
		// Shortcuts belong to the shared profile file, including after a window reload.
		await writeFile(new URL(keybindingsResource), '[]');
		const before = await readUserSettings(sessionsPage);
		expect(JSON.parse(before.content)).toEqual({});
		const resources = await sessionsPage.evaluate(async resource => {
			const ipc = (
				globalThis as unknown as {
					readonly ash: {
						readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> };
					};
				}
			).ash.ipcRenderer;
			const keybindings = (await globalThis.ashTestMainProcess.call('localFilesystem', 'readFile', {
				resource,
			})) as { readonly revision: string; readonly bytes: string };
			const connection = (await ipc.invoke('ash:remote:connection')) as { readonly kind: string };
			return {
				keybindingsRevision: keybindings.revision,
				bindings: JSON.parse(atob(keybindings.bytes)),
				connectionKind: connection.kind,
			};
		}, keybindingsResource);
		expect(resources).toEqual({ keybindingsRevision: expect.any(String), bindings: [], connectionKind: 'local' });
		const changed = sessionsPage.evaluate(
			({ resource }) =>
				new Promise<void>((resolve, reject) => {
					const subscription = globalThis.ashTestMainProcess.listen(
						'localFilesystem',
						'fileChange',
						value => {
							if (Array.isArray(value) && !value.includes(resource)) return;
							clearTimeout(timeout);
							subscription.dispose();
							resolve();
						},
					);
					const timeout = setTimeout(() => {
						subscription.dispose();
						reject(new Error('Sessions file change was not delivered'));
					}, 2_000);
				}),
			{ resource: before.resource },
		);
		await writeUserSettings(sessionsPage, before.content + '\n', before.revision);
		await changed;
		const updated = await readUserSettings(sessionsPage);
		expect(updated.revision).not.toBe(before.revision);
		await writeUserSettings(sessionsPage, before.content, updated.revision);
		await expect(sessionsPage.locator('.ash-code-sessions-window')).toHaveCSS('display', 'flex');

		await expect(sessionsPage.locator('#app')).toHaveAttribute('data-runtime', 'electron');
		await expect(sessionsPage.locator('#app')).toHaveAttribute('data-workbench-state', 'empty');
		const originalThemeSettings = await (async () => {
			const snapshot = await readUserSettings(sessionsPage);
			const values = JSON.parse(snapshot.content);
			values['workbench.colorTheme'] = 'ash-dark';
			await writeUserSettings(sessionsPage, JSON.stringify(values), snapshot.revision);
			return snapshot.content;
		})();
		await expect(sessionsPage.locator('#app')).toHaveAttribute('data-color-theme', 'ash-dark');
		await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
		await workbench.setAppearance(application, 'dark', sessionsPage);
		await (async document => {
			const snapshot = await readUserSettings(sessionsPage);
			await writeUserSettings(sessionsPage, document, snapshot.revision);
		})(originalThemeSettings);
		await expect(sessionsPage.locator('#app')).toHaveAttribute('data-color-theme', 'ash-dark');
		const titlebar = sessionsPage.locator("[data-part='titlebar']");
		await expect(titlebar).toBeVisible();
		await expect(titlebar).toHaveCSS('-webkit-app-region', 'drag');
		await expect(titlebar.getByRole('button').first()).toHaveCSS('-webkit-app-region', 'no-drag');
		await expect(titlebar.getByRole('button', { name: 'Return to Workbench' })).toHaveCount(0);
		await expect(titlebar.locator('.ash-sessions-titlebar-title, .ash-sessions-titlebar-avatar')).toHaveCount(0);
		if (process.platform === 'darwin') {
			const spacer = sessionsPage.locator('.ash-sessions-window-controls-spacer');
			const titlebarButtons = titlebar
				.getByRole('toolbar', { name: 'Title bar left actions', exact: true })
				.getByRole('button');
			expect(
				await titlebarButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))),
			).toEqual(['Hide sidebar', 'Back', 'Forward']);
			await expect(spacer).toBeVisible();
			const [spacerBounds, controlsBounds] = await Promise.all([
				spacer.boundingBox(),
				titlebarButtons.first().boundingBox(),
			]);
			expect(controlsBounds!.x).toBeGreaterThanOrEqual(spacerBounds!.x + spacerBounds!.width);
			await sessionsPage.evaluate(async () => {
				const ipc = (
					globalThis as unknown as {
						readonly ash: {
							readonly ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> };
						};
					}
				).ash.ipcRenderer;
				await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: -2 });
			});
			await expect
				.poll(() => spacer.evaluate(element => Number.parseFloat(getComputedStyle(element).width)))
				.toBeGreaterThan(90);
			await sessionsPage.evaluate(async () => {
				const ipc = (
					globalThis as unknown as {
						readonly ash: {
							readonly ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> };
						};
					}
				).ash.ipcRenderer;
				await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: 0 });
			});
		}
		if (target.appServerMode === 'required') {
			const accounts = sessionsPage.getByRole('button', { name: 'Accounts', exact: true });
			const accountItems = await new Menus(sessionsPage).inspect(application, () => accounts.click());
			expect(accountItems.map(item => item.label)).toContain('Settings');
			expect(accountItems.map(item => item.label)).toContain('Return to Workbench');
			expect(accountItems.map(item => item.label)).not.toContain('Sign in with ChatGPT');
			await expect(accounts).toHaveAttribute('aria-expanded', 'false');
		}
		await expect(sessionsPage.locator("[data-part='sidebar']")).toBeVisible();
		await expect(sessionsPage.locator("[data-part='sessions']")).toBeVisible();
		await expect(sessionsPage.locator("[data-part='auxiliarybar']")).toBeHidden();
		const sidebarToggle = titlebar.getByRole('button', { name: 'Hide sidebar' });
		await expect(sidebarToggle.locator('[data-ash-icon-id="layout-sidebar-left-2"]')).toBeVisible();
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
		await expect(showSidebar.locator('[data-ash-icon-id="layout-sidebar-left-off-2"]')).toBeVisible();
		await showSidebar.click();
		await expect(sessionsPage.locator("[data-part='sidebar']")).toBeVisible();
		if (process.platform === 'darwin') {
			expect(
				await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map(item => item.label)),
			).toContain('File');
		} else {
			const applicationItems = await new Menus(sessionsPage).inspect(application, () =>
				titlebar.getByRole('button', { name: 'Application menu' }).click(),
			);
			expect(applicationItems.map(item => item.label)).toContain('File');
		}
		await expect(sessionsPage.locator('.ash-sessions-list')).toHaveCSS('display', 'flex');
		await expect(sessionsPage.locator('.ash-sessions-chat-slot').first()).toHaveCSS('display', 'flex');
		await expect(sessionsPage.locator(':is(.ash-chat-input-part,.ash-cowork-input-part)')).toBeVisible();
		await expect(sessionsPage.getByRole('searchbox', { name: 'Search sessions' })).toHaveCount(0);
		const chatsGroup = sessionsPage.locator('.ash-sessions-list:visible [data-section="recent"] > h3 button');
		await chatsGroup.click();
		await expect(chatsGroup).toHaveAttribute('aria-expanded', 'false');
		await chatsGroup.press('ArrowRight');
		await expect(chatsGroup).toHaveAttribute('aria-expanded', 'true');
		await sessionsPage.locator('[data-action-id="sessions.newSession"] button').click();
		await expect(sessionsPage.locator('.ash-sessions-chat-slot')).toHaveCount(1);
		await expect(sessionsPage.locator('.ash-sessions-chat-slot.active')).toHaveCount(1);
		await expect.poll(() => application.windows().length).toBe(2);

		const sessionWindowState = await application.evaluate(({ BrowserWindow }) => {
			const windows = BrowserWindow.getAllWindows();
			return windows.map(
				(window: { readonly id: number; getTitle(): string; readonly webContents: { getURL(): string } }) => ({
					id: window.id,
					title: window.getTitle(),
					url: window.webContents.getURL(),
				}),
			);
		});
		expect(sessionWindowState).toHaveLength(2);
		expect(
			sessionWindowState.some((window: { readonly url: string }) =>
				window.url.includes('sessions/electron-browser/sessions.html'),
			),
		).toBe(true);
		const windowIds = sessionWindowState
			.map((window: { readonly id: number }) => window.id)
			.sort((left: number, right: number) => left - right);
		await openSessions.click();
		await expect
			.poll(() =>
				application.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()
						.map(window => window.id)
						.sort((left, right) => left - right),
				),
			)
			.toEqual(windowIds);
		await workbench.reloadWindow(sessionsPage);
		await expect(sessionsPage.locator('.ash-code-sessions-window')).toBeVisible();
		await expect.poll(() => application.windows().length).toBe(2);
		const reloadedIpc = await sessionsPage.evaluate(async resource => {
			const ipc = (
				globalThis as unknown as {
					readonly ash: {
						readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> };
					};
				}
			).ash.ipcRenderer;
			const home = await globalThis.ashTestMainProcess.call<string>('localFilesystem', 'userDataHome');
			const configuration = await globalThis.ashTestMainProcess.call<{ revision: string }>(
				'localFilesystem',
				'readFile',
				{ resource: home.replace(/\/$/u, '') + '/settings.json' },
			);
			const keybindings = (await globalThis.ashTestMainProcess.call('localFilesystem', 'readFile', {
				resource,
			})) as { readonly revision: string; readonly bytes: string };
			const connection = (await ipc.invoke('ash:remote:connection')) as { readonly kind: string };
			await ipc.invoke('ash:native-host:open-agents-window');
			const windows = (await (ipc as { invoke(channel: string, params: unknown): Promise<unknown> }).invoke(
				'ash:window:operation',
				{ kind: 'list' },
			)) as readonly unknown[];
			return {
				configurationRevision: configuration.revision,
				keybindingsRevision: keybindings.revision,
				bindings: JSON.parse(atob(keybindings.bytes)),
				connectionKind: connection.kind,
				windowCount: windows.length,
			};
		}, keybindingsResource);
		expect(reloadedIpc).toEqual({
			configurationRevision: expect.any(String),
			keybindingsRevision: resources.keybindingsRevision,
			bindings: [],
			connectionKind: 'local',
			windowCount: 2,
		});
		await expect(
			workbenchPage.evaluate(async () => {
				const ipc = (
					globalThis as unknown as {
						readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } };
					}
				).ash.ipcRenderer;
				return ipc.invoke('ash:sessions:return-to-workbench');
			}),
		).rejects.toThrow(/Untrusted renderer IPC sender/);
		const expectedBounds = await application.evaluate(({ BrowserWindow }) => {
			const child = BrowserWindow.getAllWindows().find(window =>
				window.webContents.getURL().includes('sessions/electron-browser/sessions.html'),
			);
			if (!child) throw new Error('Sessions window is missing');
			child.setBounds({ ...child.getBounds(), width: 1000, height: 700 });
			return child.getBounds();
		});

		const closed = sessionsPage.waitForEvent('close');
		await returnFromSessions(sessionsPage, application);
		await closed;
		await expect.poll(() => application.windows().length).toBe(1);
		await expect(workbenchPage.locator('.ash-workbench')).toBeVisible();
		// Repeated restoration must not accumulate fractional-DPI frame rounding.
		for (let reopen = 0; reopen < 3; reopen++) {
			await openSessions.click();
			await expect.poll(() => application.windows().length).toBe(2);
			const reopenedPage = application.windows().find(page => page !== workbenchPage);
			if (!reopenedPage) {
				throw new Error('Reopened Sessions window is missing');
			}
			await expect(reopenedPage.locator('.ash-code-sessions-window')).toBeVisible();
			await expect
				.poll(() =>
					application.evaluate(({ BrowserWindow }) => {
						const child = BrowserWindow.getAllWindows().find(window =>
							window.webContents.getURL().includes('sessions/electron-browser/sessions.html'),
						);
						return child?.getBounds();
					}),
				)
				.toEqual(expectedBounds);
			const reopenedClosed = reopenedPage.waitForEvent('close');
			await returnFromSessions(reopenedPage, application);
			await reopenedClosed;
			await expect.poll(() => application.windows().length).toBe(1);
		}
		const parentClosed = workbenchPage.waitForEvent('close');
		await application.evaluate(({ BrowserWindow }) => {
			const parent = BrowserWindow.getAllWindows().find(
				window =>
					!window.isDestroyed() &&
					!window.webContents.isDestroyed() &&
					window.webContents.getURL().includes('workbench.html'),
			);
			if (!parent) throw new Error('Workbench window is missing');
			parent.close();
		});
		await parentClosed;
	},
);

focusTest(
	'Sessions menus and history actions stay independent from Workbench',
	async ({ application, target, workbench }) => {
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
			if (!('windows' in application)) {
				throw new Error('Expected Electron windows');
			}
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
		const conversation = page.locator('.ash-sessions-chat-slot.active :is(.ash-chat,.ash-cowork)');
		const originalId = await conversation.getAttribute('data-untitled-session-id');
		expect(originalId).toBeTruthy();
		await expect(sessions).toHaveAttribute('aria-current', 'page');
		await page.locator('[data-action-id="sessions.newSession"] button').click();
		await expect(sessions).toHaveCount(1);
		await expect(conversation).not.toHaveAttribute('data-untitled-session-id', originalId!);
		const newId = await conversation.getAttribute('data-untitled-session-id');
		expect(newId).toBeTruthy();
		await expect(sessions).toHaveAttribute('aria-current', 'page');
		await expect(back).toBeEnabled();
		await back.click();
		await expect(conversation).toHaveAttribute('data-untitled-session-id', originalId!);
		await expect(sessions).toHaveAttribute('aria-current', 'page');
		await expect(back).toBeDisabled();
		await expect(forward).toBeEnabled();
		await forward.click();
		await expect(conversation).toHaveAttribute('data-untitled-session-id', newId!);
		await expect(sessions).toHaveAttribute('aria-current', 'page');
		await expect(back).toBeEnabled();
		await expect(forward).toBeDisabled();
		const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
		await new Menus(page).selectApplication(application, ['File', 'Return to Workbench']);
		await closed;
		await workbench.waitForReady();
	},
);

test(
	'Sessions titlebar aligns its platform actions and sidebar toggle',
	{ tag: ['@electron-ui', '@electron-app-server'] },
	async ({ application, target, workbench }) => {
		if (target.kind !== 'electron' || !('windows' in application)) return;
		const sessionsPage = await workbench.openAgentsWindow(target.kind);
		// History actions move into Go at narrow widths; expand the sidebar to check their full layout.
		const sidebar = (await sessionsPage.locator('[data-part="sidebar"]').boundingBox())!;
		for (const sash of await sessionsPage.getByRole('separator').all()) {
			const bounds = await sash.boundingBox();
			if (!bounds || bounds.height < 200 || Math.abs(bounds.x - sidebar.x - sidebar.width) > 8) continue;
			await sash.focus();
			for (let step = 0; step < 20; step++) await sash.press('ArrowRight');
			break;
		}
		const toolbar = sessionsPage
			.locator('[data-part="titlebar"]')
			.getByRole('toolbar', { name: 'Title bar left actions', exact: true });
		const buttons = toolbar.getByRole('button');
		const hasWindowMenu = process.platform !== 'darwin';
		await expect(buttons).toHaveCount(hasWindowMenu ? 4 : 3);
		await expect(toolbar.getByRole('button', { name: 'Application menu', exact: true })).toHaveCount(
			hasWindowMenu ? 1 : 0,
		);
		await expect(toolbar).toHaveCSS('-webkit-app-region', 'no-drag');
		await expect(toolbar.getByRole('button', { name: 'Hide sidebar', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		const activityNavigation = sessionsPage.locator('.ash-sessions-activity-content');
		await expect(activityNavigation.getByRole('button', { name: 'New', exact: true })).toHaveAttribute(
			'aria-current',
			'page',
		);
		await expect(
			sessionsPage.locator('.ash-window-mode-control').getByRole('button', { name: 'Code' }),
		).not.toHaveAttribute('aria-pressed', 'true');
		await sessionsPage.locator('.ash-window-mode-control').getByRole('button', { name: 'Code' }).click();
		await expect(
			sessionsPage.locator('.ash-window-mode-control').getByRole('button', { name: 'Code' }),
		).toHaveAttribute('aria-pressed', 'true');
		await expect(sessionsPage.locator('[data-part="sessions"]')).toBeVisible();
		await expect(sessionsPage.locator('.ash-sessions-surface-header')).toHaveCount(0);
		await activityNavigation.getByRole('button', { name: 'New', exact: true }).click();
		await expect(sessionsPage.locator('.ash-sessions-surface-header')).toHaveCount(0);
		expect(
			await buttons.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))),
		).toEqual([...(hasWindowMenu ? ['Application menu'] : []), 'Hide sidebar', 'Back', 'Forward']);
		if (hasWindowMenu) {
			const leadingInset = await sessionsPage.evaluate(() => {
				const menu = document.querySelector<HTMLElement>('[data-action-id="ash.applicationMenu"] button')!;
				const content = document.querySelector<HTMLElement>(
					'.ash-sessions-titlebar > .ash-workbench-part-content',
				)!;
				return menu.getBoundingClientRect().left - content.getBoundingClientRect().left;
			});
			expect(Math.round(leadingInset)).toBe(8);
		}
		const iconOffsets = await buttons.evaluateAll(buttons =>
			buttons.map(button => {
				const buttonBounds = button.getBoundingClientRect();
				const iconBounds = button.querySelector('.ash-icon')!.getBoundingClientRect();
				return {
					x: iconBounds.x + iconBounds.width / 2 - (buttonBounds.x + buttonBounds.width / 2),
					y: iconBounds.y + iconBounds.height / 2 - (buttonBounds.y + buttonBounds.height / 2),
				};
			}),
		);
		expect(Math.max(...iconOffsets.map(({ x, y }) => Math.max(Math.abs(x), Math.abs(y))))).toBeLessThanOrEqual(1);
		await toolbar.getByRole('button', { name: 'Hide sidebar' }).click();
		await expect(sessionsPage.locator('[data-part="sidebar"]')).toBeHidden();
		await toolbar.getByRole('button', { name: 'Show sidebar' }).click();
		await expect(sessionsPage.locator('[data-part="sidebar"]')).toBeVisible();
		const closed = sessionsPage.waitForEvent('close');
		if (process.platform === 'darwin') {
			await returnFromSessions(sessionsPage, application);
		} else {
			await toolbar.getByRole('button', { name: 'Application menu' }).click();
			await expect(toolbar.getByRole('button', { name: 'Application menu' })).toHaveAttribute(
				'aria-expanded',
				'true',
			);
			await sessionsPage.getByRole('menuitem', { name: 'File' }).hover();
			await expect(sessionsPage.getByRole('menuitem', { name: 'New Session' })).toHaveCount(0);
			await sessionsPage.getByRole('menuitem', { name: 'Return to Workbench' }).click();
		}
		await closed;
	},
);

test(
	'Workbench and Sessions tooltips keep separate colors across themes',
	{ tag: ['@browser-app-server', '@electron-app-server'] },
	async ({ application, target, workbench }) => {
		for (const [theme, scheme, background, foreground] of [
			['Ash Light', 'light', 'rgb(243, 243, 243)', 'rgb(97, 97, 97)'],
			['Ash Dark', 'dark', 'rgb(37, 37, 38)', 'rgb(204, 204, 204)'],
			['Ash High Contrast Dark', 'hcDark', 'rgb(12, 20, 31)', 'rgb(255, 255, 255)'],
			['Ash High Contrast Light', 'hcLight', 'rgb(255, 255, 255)', 'rgb(41, 41, 41)'],
		]) {
			await workbench.quickaccess.runCommand('workbench.action.selectTheme');
			const picker = workbench.page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill(theme);
			await picker.getByRole('combobox').press('Enter');
			await expect(picker).toHaveCount(0);
			await expect(workbench.page.locator('#app')).toHaveAttribute('data-color-scheme', scheme);
			await workbench.page.bringToFront();
			await workbench.page.mouse.move(400, 180);
			const workbenchControl = workbench.page
				.getByRole('toolbar', { name: 'Activity Bar global actions', exact: true })
				.getByRole('button', { name: 'Manage', exact: true });
			await workbenchControl.hover();
			const workbenchTooltip = workbench.page.getByRole('tooltip');
			const workbenchHover = workbench.page.locator('.ash-context-view-hover');
			await expect(workbenchTooltip).toBeVisible();
			await expect(workbenchTooltip).toHaveCSS('background-color', background);
			await expect(workbenchTooltip).toHaveCSS('color', foreground);
			await expect(workbenchHover).toHaveCSS('background-color', background);
			await expect
				.poll(() => workbenchHover.evaluate(element => getComputedStyle(element, '::before').backgroundColor))
				.toBe(background);
			await workbench.page.mouse.move(400, 180);
			await expect(workbenchTooltip).toHaveCount(0);

			const page = await workbench.openAgentsWindow(target.kind);
			await expect(page.locator('#app')).toHaveAttribute('data-color-scheme', scheme);
			await page.bringToFront();
			await page.mouse.move(400, 180);
			await page
				.locator('.ash-sessions-activity-content')
				.getByRole('button', { name: 'New', exact: true })
				.hover();
			const tooltip = page.getByRole('tooltip');
			const hover = page.locator('.ash-context-view-hover');
			await expect(tooltip).toHaveText('Chat');
			await expect(tooltip).toHaveCSS('background-color', 'rgb(0, 0, 0)');
			await expect(tooltip).toHaveCSS('color', 'rgb(255, 255, 255)');
			await expect(hover).toHaveCSS('background-color', 'rgb(0, 0, 0)');
			await expect(hover).toHaveCSS('border-radius', '12px');
			await expect
				.poll(() => hover.evaluate(element => getComputedStyle(element, '::before').content))
				.toBe('none');
			if (scheme.startsWith('high-contrast')) {
				await expect(hover).toHaveCSS('border-top-color', 'rgb(255, 255, 255)');
			}
			await page.keyboard.press('Escape');
			await expect(tooltip).toHaveCount(0);
			const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
			await returnFromSessions(page, application);
			await closed;
			await expect(workbench.page.locator('.ash-workbench')).toBeVisible();
			await workbench.page.bringToFront();
			await workbench.page.mouse.move(400, 180);
			await workbenchControl.hover();
			await expect(workbenchTooltip).toHaveCSS('background-color', background);
			await expect(workbenchTooltip).toHaveCSS('color', foreground);
			await workbench.page.mouse.move(400, 180);
			await expect(workbenchTooltip).toHaveCount(0);
		}
	},
);

test('Sessions titlebar sidebar toggle stays transparent at rest and responds to pointer and keyboard', async ({
	application,
	target,
	workbench,
}) => {
	const workbenchToggle = workbench.page.locator(
		'.ash-titlebar-left-actions [data-action-id="workbench.action.toggleSideBar"] button',
	);
	await expect(workbenchToggle).toHaveCSS('border-radius', '4px');
	await workbenchToggle.hover();
	await expect(workbench.page.getByRole('tooltip')).toBeVisible();
	await expect(workbench.page.locator('.ash-context-view-hover')).toHaveCSS('border-radius', '6px');
	await expect
		.poll(() =>
			workbench.page
				.locator('.ash-context-view-hover')
				.evaluate(element => getComputedStyle(element, '::before').content),
		)
		.toBe('""');
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
	const chat = navigation.getByRole('button', { name: 'New', exact: true });
	const projects = navigation.getByRole('button', { name: 'Projects' });
	const menu = page.getByRole('button', { name: 'Application menu', exact: true });
	const hasWindowMenu = target.kind === 'browser' || process.platform !== 'darwin';
	if (!hasWindowMenu) {
		await expect(menu).toHaveCount(0);
	}
	for (const colorScheme of ['light', 'dark'] as const) {
		await workbench.setAppearance(application, colorScheme, page);
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', `ash-${colorScheme}`);
		await page.mouse.move(400, 180);
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		const selectedBackground = await chat.evaluate(button => getComputedStyle(button).backgroundColor);
		expect(selectedBackground).not.toBe('rgba(0, 0, 0, 0)');
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect
			.poll(() =>
				page
					.locator('.ash-sessions-titlebar-actions button')
					.evaluateAll(buttons => buttons.map(button => getComputedStyle(button).borderRadius)),
			)
			.toEqual(Array(hasWindowMenu ? 4 : 3).fill('8px'));
		await projects.hover();
		await expect(projects).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(projects).not.toHaveCSS('background-color', selectedBackground);
		if (hasWindowMenu) {
			await menu.hover();
			await expect(menu).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		}
		await toggle.hover();
		await expect(toggle).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		const hoverBackground = await toggle.evaluate(button => getComputedStyle(button).backgroundColor);
		await expect(page.getByRole('tooltip')).toHaveText('Hide sidebar');
		await expect(page.locator('.ash-context-view-hover')).toHaveCSS('border-radius', '12px');
		await expect
			.poll(() =>
				page
					.locator('.ash-context-view-hover')
					.evaluate(element => getComputedStyle(element, '::before').content),
			)
			.toBe('none');
		await toggle.click();
		await expect(sidebar).toBeHidden();
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await expect(toggle).toHaveAccessibleName('Show sidebar');
		await page.mouse.move(400, 180);
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await toggle.hover();
		await expect(toggle).toHaveCSS('background-color', hoverBackground);
		await toggle.click();
		await expect(sidebar).toBeVisible();
		await page.mouse.move(400, 180);
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await page.keyboard.press('Tab');
		await toggle.focus();
		await expect(toggle).toHaveCSS('outline-style', 'solid');
		// Chromium rounds a 1px outline to device pixels (for example, 0.8px at 125% scaling).
		expect(await toggle.evaluate(button => parseFloat(getComputedStyle(button).outlineWidth))).toBeGreaterThan(0);
		await page.keyboard.press('Enter');
		await expect(sidebar).toBeHidden();
		await page.keyboard.press('Space');
		await expect(sidebar).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(toggle).toHaveAccessibleName('Hide sidebar');
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(toggle).toHaveCSS('border-radius', '8px');
		await expect(toggle.locator('[data-ash-icon-id="layout-sidebar-left-2"]')).toBeVisible();
		if (hasWindowMenu) {
			await page.keyboard.press('ArrowLeft');
			await expect(menu).toBeFocused();
			await page.keyboard.press('ArrowDown');
			await expect(menu).toHaveAttribute('aria-expanded', 'true');
			await expect(menu).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await page.keyboard.press('Escape');
			await expect(menu).toHaveAttribute('aria-expanded', 'false');
			await expect(menu).toBeFocused();
			await page.mouse.move(400, 180);
			await expect(menu).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await page.keyboard.press('ArrowRight');
			await expect(toggle).toBeFocused();
		}
	}
	if (target.kind === 'electron') {
		await expect(workbenchToggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(workbenchToggle).toHaveCSS('border-radius', '4px');
	}
});

test(
	'Sessions titlebar sidebar toggle stays transparent at rest with hover and keyboard outlines in high contrast',
	{ tag: ['@browser-app-server', '@electron-app-server'] },
	async ({ application, target, workbench }) => {
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
				if (!('windows' in application)) {
					throw new Error('Expected Electron windows');
				}
				const opened = application.waitForEvent('window');
				await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
				page = await opened;
			}
			await expect(page.locator('#app')).toHaveAttribute(
				'data-color-scheme',
				theme.endsWith('Dark') ? 'hcDark' : 'hcLight',
			);
			const navigation = page.locator('.ash-sessions-activity-content');
			const chat = navigation.getByRole('button', { name: 'New', exact: true });
			const projects = navigation.getByRole('button', { name: 'Projects' });
			const toggle = page.locator('[data-action-id="ash.sessions.toggleSidebar"] button');
			await page.mouse.move(400, 180);
			const iconColor = theme.endsWith('Dark') ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)';
			await expect(chat.locator('.ash-icon')).toHaveCSS('color', iconColor);
			await expect(projects.locator('.ash-icon')).toHaveCSS('color', iconColor);
			const selectedBackground = await chat.evaluate(button => getComputedStyle(button).backgroundColor);
			await expect(toggle).toHaveAttribute('aria-pressed', 'true');
			await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(toggle).toHaveCSS('outline-style', 'none');
			await expect(chat).toHaveCSS('outline-style', 'solid');
			await projects.hover();
			await expect(projects).toHaveCSS('background-color', selectedBackground);
			await expect(projects).toHaveCSS('outline-style', 'solid');
			await expect(projects.locator('.ash-icon')).toHaveCSS('color', iconColor);
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
			expect(await toggle.evaluate(button => parseFloat(getComputedStyle(button).outlineWidth))).toBeGreaterThan(
				0,
			);
			const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
			await returnFromSessions(page, application);
			await closed;
			await expect(workbench.page.locator('.ash-workbench')).toBeVisible();
		}
	},
);

// Only macOS chooses the application menu from the OS-focused window.
focusTest(
	'Sessions application menu follows its host and uses Sessions actions',
	async ({ application, target, workbench }) => {
		const page = await workbench.openAgentsWindow(target.kind);
		const menu = page.getByRole('button', { name: 'Application menu', exact: true });
		if (target.kind === 'electron' && process.platform === 'darwin') {
			if (!('windows' in application)) {
				throw new Error('Expected Electron windows');
			}
			await expect(menu).toHaveCount(0);
			const fileItems = (): Promise<string[]> =>
				application.evaluate(({ Menu }) =>
					Menu.getApplicationMenu()!
						.items.find(item => item.label === 'File')!
						.submenu!.items.map(item => item.label),
				);
			await expect.poll(fileItems).toContain('Return to Workbench');
			expect(await fileItems()).not.toContain('New Session');
			const mainWindow = await application.browserWindow(workbench.page);
			const sessionsWindow = await application.browserWindow(page);
			await mainWindow.evaluate(window => window.focus());
			await expect.poll(fileItems).not.toContain('Return to Workbench');
			await sessionsWindow.evaluate(window => window.focus());
			await expect.poll(fileItems).toContain('Return to Workbench');
			const closed = page.waitForEvent('close');
			await application.evaluate(({ Menu, BrowserWindow }) => {
				const item = Menu.getApplicationMenu()!
					.items.find(item => item.label === 'File')!
					.submenu!.items.find(item => item.label === 'Return to Workbench')!;
				item.click(item, BrowserWindow.getFocusedWindow()!, {
					shiftKey: false,
					ctrlKey: false,
					altKey: false,
					metaKey: false,
					triggeredByAccelerator: false,
				});
			});
			await closed;
			await expect.poll(fileItems).not.toContain('Return to Workbench');
			await mainWindow.dispose();
			await sessionsWindow.dispose();
		} else {
			await menu.focus();
			await menu.press('ArrowDown');
			await expect(menu).toHaveAttribute('aria-expanded', 'true');
			await page.keyboard.press('Escape');
			await expect(menu).toBeFocused();
			const fileItems = await new Menus(page).inspect(application, () => menu.click(), ['File']);
			expect(fileItems.map(item => item.label)).toContain('Return to Workbench');
			expect(fileItems.map(item => item.label)).not.toContain('New Session');
			await new Menus(page).select(application, () => menu.click(), ['File', 'Return to Workbench']);
			if (target.kind === 'browser') {
				await expect(page).toHaveURL(/\/workbench\/workbench\.html$/u);
			}
		}
		await expect(workbench.page.locator('.ash-workbench')).toBeVisible();
	},
);

test('Sessions Activity Bar tooltips follow side, top and bottom placement without replacing buttons', async ({
	application,
	target,
	workbench,
}) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	const chat = navigation.getByRole('button', { name: /^New(?:\.|$)/u });
	const accounts = page.getByRole('button', { name: 'Accounts', exact: true });
	const originalChat = await chat.elementHandle();
	const checkTooltip = async (
		trigger: Locator,
		label: string,
		direction: 'right' | 'below' | 'above',
		keyboard = false,
	): Promise<void> => {
		await page.mouse.move(600, 400);
		if (keyboard) {
			await page
				.locator('[data-part="titlebar"]')
				.getByRole('button', { name: /^(?:Hide|Show) sidebar$/u })
				.focus();
			await trigger.focus();
		} else {
			await trigger.hover();
		}
		const tooltip = page.getByRole('tooltip');
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toHaveText(label);
		const [anchor, hover] = await Promise.all([
			trigger.boundingBox(),
			page.locator('.ash-context-view-hover', { has: tooltip }).boundingBox(),
		]);
		expect(anchor).not.toBeNull();
		expect(hover).not.toBeNull();
		if (direction === 'right') expect(hover!.x).toBeGreaterThanOrEqual(anchor!.x + anchor!.width);
		if (direction === 'below') expect(hover!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height);
		if (direction === 'above') expect(hover!.y + hover!.height).toBeLessThanOrEqual(anchor!.y);
		await expect(trigger).toHaveAttribute('aria-describedby', (await tooltip.getAttribute('id')) ?? '');
		await expect(page.locator('.ash-context-view-hover')).toHaveCSS('border-radius', '12px');
		await page.keyboard.press('Escape');
		await expect(tooltip).toHaveCount(0);
		await expect(trigger).not.toHaveAttribute('aria-describedby');
		if (keyboard) await expect(trigger).toBeFocused();
	};
	const setPosition = async (position: string): Promise<void> => {
		if ('windows' in application && process.platform === 'darwin') {
			await captureElectronMenu(application, () => accounts.click({ button: 'right' }), { label: position });
		} else {
			await accounts.click({ button: 'right' });
			await page
				.getByRole('menu')
				.last()
				.getByRole('menuitem', { name: 'Activity Bar Position' })
				.press('ArrowRight');
			await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: position, exact: true }).click();
		}
	};
	await checkTooltip(chat, 'Chat', 'right');
	for (const label of ['Collab', 'Projects', 'Code', 'Accounts']) {
		await checkTooltip(navigation.getByRole('button', { name: label, exact: true }), label, 'right');
	}
	await checkTooltip(accounts, 'Accounts', 'right', true);
	await setPosition('Top');
	await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
	await checkTooltip(chat, 'Chat', 'below', true);
	await checkTooltip(accounts, 'Accounts', 'below');
	await workbench.setAppearance(application, 'dark', page);
	await setPosition('Bottom');
	await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
	await checkTooltip(chat, 'Chat', 'above');
	// Horizontal layouts place Accounts in the title bar, whose tooltip opens below.
	await checkTooltip(accounts, 'Accounts', 'below', true);
	await setPosition('Default');
	await expect(page.locator('.ash-sessions-activity-content')).toBeVisible();
	const originalAccounts = await accounts.elementHandle();
	await page.setViewportSize({ width: 900, height: 600 });
	await checkTooltip(chat, 'Chat', 'right');
	expect(await chat.evaluate((element, original) => element === original, originalChat)).toBe(true);
	expect(await accounts.evaluate((element, original) => element === original, originalAccounts)).toBe(true);
	await originalChat!.dispose();
	await originalAccounts!.dispose();
	const closed = target.kind === 'electron' ? page.waitForEvent('close') : undefined;
	await returnFromSessions(page, application);
	await closed;
});

test('Sessions replace a conversation in their own grid and restore its draft through history', async ({
	target,
	workbench,
}) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const host = page.locator('[data-part="sessions"]');
	const editor = new Editor(host.locator('.ash-sessions-chat-slot.active:visible'));
	await replaceChatInput(editor, 'Keep the replaced conversation draft');
	const grid = await host.locator('.ash-sessions-chat-grid').elementHandle();
	const chat = host.locator('.ash-sessions-chat-slot.active :is(.ash-chat,.ash-cowork)');
	const identity = await chat.getAttribute('data-untitled-session-id');
	expect(identity).toBeTruthy();
	await page.locator('[data-action-id="sessions.newSession"] button').click();
	await editor.waitForEditorContents(text => text === '');
	await expect(host.locator('.ash-sessions-chat-slot')).toHaveCount(1);
	await expect(host.locator('.ash-editor-group, .ash-editor-title-control')).toHaveCount(0);
	expect(
		await host.locator('.ash-sessions-chat-grid').evaluate((element, previous) => element === previous, grid),
	).toBe(true);
	await expect(chat).not.toHaveAttribute('data-untitled-session-id', identity!);
	await page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Back', exact: true }).click();
	await editor.waitForEditorContents(text => text === 'Keep the replaced conversation draft');
	await expect(chat).toHaveAttribute('data-untitled-session-id', identity!);
	await expect(host.locator('.ash-sessions-chat-slot')).toHaveCount(1);
	await grid!.dispose();
});

test('Sessions Activity Bar changes layout while retaining the same session, draft, attachments and history', async ({
	application,
	target,
	workbench,
}) => {
	let page = await workbench.openAgentsWindow(target.kind);
	let navigation = page.locator('.ash-sessions-activity-content');
	let composer = page.locator(':is(.ash-sessions-chat-input,.ash-sessions-cowork-input):visible').first();
	let editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await replaceChatInput(editor, 'Keep this draft');
	await composer
		.locator('input[type="file"]')
		.setInputFiles({
			name: 'context.ts',
			mimeType: 'text/plain',
			buffer: Buffer.from('export const code = true;'),
		});
	await expect(composer.locator('.ash-chat-code-reference')).toHaveText('context.ts');
	const originalInput = await editor.input.elementHandle();
	const identity = await page
		.locator('.ash-sessions-chat-slot.active :is(.ash-chat,.ash-cowork)')
		.getAttribute('data-untitled-session-id');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(
		page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }),
	).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(
		page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }),
	).toHaveAttribute('aria-pressed', 'true');
	await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeVisible();
	await editor.waitForEditorContents(text => text === 'Keep this draft context.ts ');
	expect(await editor.input.evaluate((element, original) => element === original, originalInput)).toBe(false);
	await editor.input.focus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('ArrowLeft');
	for (const _ of 'Keep this draft') await page.keyboard.press('Shift+ArrowRight');
	await page.keyboard.insertText('Edited from Code');
	await navigation.getByRole('button', { name: 'New', exact: true }).focus();
	await page.keyboard.press('Space');
	await expect(navigation.getByRole('button', { name: 'New', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	await editor.waitForEditorContents(text => text === 'Edited from Code context.ts ');
	await expect(composer.locator('.ash-chat-code-reference')).toBeVisible();
	await expect(page.locator('.ash-sessions-chat-slot.active :is(.ash-chat,.ash-cowork)')).toHaveAttribute(
		'data-untitled-session-id',
		identity!,
	);
	expect(await editor.input.evaluate((element, original) => element === original, originalInput)).toBe(true);
	await navigation.getByRole('button', { name: 'Agent Teams', exact: true }).click();
	await expect(page.locator('.ash-teams-panel')).toBeVisible();
	await navigation.getByRole('button', { name: 'New', exact: true }).click();
	const back = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Back', exact: true });
	const forward = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Forward', exact: true });
	await expect(back).toBeDisabled();
	await page.locator('[data-action-id="sessions.newSession"] button').click();
	await editor.waitForEditorContents(text => text === '');
	await back.click();
	await editor.waitForEditorContents(text => text === 'Edited from Code context.ts ');
	await expect(forward).toBeEnabled();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(forward).toBeEnabled();
	await forward.click();
	await editor.waitForEditorContents(text => text === '');
	await back.click();
	await editor.waitForEditorContents(text => text === 'Edited from Code context.ts ');
	await expect(composer.locator('.ash-chat-code-reference')).toBeVisible();
	const restoredInput = await editor.input.elementHandle();
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(page.locator('[data-part="editor"] .ash-projects')).toBeVisible();
	await expect(page.locator('[data-part="sessions"]')).toBeHidden();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	const sidebarToggle = page.locator('[data-action-id="ash.sessions.toggleSidebar"] button');
	await sidebarToggle.click();
	await expect(page.locator('[data-part="sidebar"]')).toBeHidden();
	await sidebarToggle.click();
	await expect(page.locator('[data-part="editor"] .ash-projects')).toBeVisible();
	await expect(navigation.getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute(
		'aria-current',
		'page',
	);
	await navigation.getByRole('button', { name: 'New', exact: true }).click();
	expect(await editor.input.evaluate((element, original) => element === original, restoredInput)).toBe(false);
	await restoredInput?.dispose();
	await originalInput?.dispose();
	page = await workbench.reopenAgentsWindow(application, page);
	navigation = page.locator('.ash-sessions-activity-content');
	composer = page.locator(':is(.ash-sessions-chat-input,.ash-sessions-cowork-input):visible').first();
	editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await editor.waitForEditorContents(text => text === 'Edited from Code context.ts ');
	await expect(composer.locator('.ash-chat-code-reference')).toBeVisible();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await editor.waitForEditorContents(text => text === 'Edited from Code context.ts ');
});

focusTest(
	'Open IDE focuses or creates an IDE while keeping the Agents window and draft',
	{ tag: ['@electron-ui', '@electron-app-server'] },
	async ({ application, target, workbench }, testInfo) => {
		if (target.kind !== 'electron' || !('windows' in application)) throw new Error('Open IDE requires Electron');
		const ide = workbench.page;
		const agents = await workbench.openAgentsWindow(target.kind);
		await agents.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const editor = new Editor(agents.locator('.ash-sessions-chat-slot.active:visible'));
		const draft = 'Keep this unsent Agent draft while opening the IDE';
		await replaceChatInput(editor, draft);
		const input = await editor.input.elementHandle();
		const accounts = agents.getByRole('button', { name: 'Accounts', exact: true });
		const openIde = async (): Promise<void> => {
			await agents.bringToFront();
			await accounts.press('Enter');
			const action = agents.getByRole('menuitem', { name: 'Open IDE', exact: true });
			await expect(action).toBeVisible();
			await action.press('Enter');
			await expect(accounts).toHaveAttribute('aria-expanded', 'false');
		};
		// Embedded browser pages also appear in Playwright; only native windows determine coexistence.
		const windowIds = () =>
			application.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()
					.map(window => window.id)
					.sort((a, b) => a - b),
			);
		const originalIds = await windowIds();
		const ideWindow = await application.browserWindow(ide);
		const ideId = await ideWindow.evaluate(window => window.id);
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				if (attempt === 0) {
					await openIde();
				} else {
					await agents.bringToFront();
					await new QuickAccess(agents).runCommand('agents.openAshWindow');
				}
				await expect
					.poll(() =>
						application.evaluate(({ BrowserWindow }, id) => BrowserWindow.getFocusedWindow()?.id, ideId),
					)
					.toBe(ideId);
				expect(await windowIds()).toEqual(originalIds);
				await editor.waitForEditorContents(text => text === draft);
			}

			const closed = ide.waitForEvent('close');
			await ideWindow.evaluate(window => window.close());
			await closed;
			await expect.poll(async () => (await windowIds()).length).toBe(1);
			const opened = application.waitForEvent('window');
			await openIde();
			const reopened = await opened;
			await new Workbench(reopened).waitForReady();
			await expect.poll(async () => (await windowIds()).length).toBe(2);
			const reopenedWindow = await application.browserWindow(reopened);
			try {
				const reopenedId = await reopenedWindow.evaluate(window => window.id);
				expect(reopenedId).not.toBe(ideId);
				await expect
					.poll(() =>
						application.evaluate(
							({ BrowserWindow }, id) => BrowserWindow.getFocusedWindow()?.id,
							reopenedId,
						),
					)
					.toBe(reopenedId);
				const reopenedIds = await windowIds();
				await openIde();
				await expect
					.poll(() =>
						application.evaluate(
							({ BrowserWindow }, id) => BrowserWindow.getFocusedWindow()?.id,
							reopenedId,
						),
					)
					.toBe(reopenedId);
				expect(await windowIds()).toEqual(reopenedIds);
				await expect(agents.locator('.ash-code-sessions-window')).toBeVisible();
				await editor.waitForEditorContents(text => text === draft);
				expect(await editor.input.evaluate((element, original) => element === original, input)).toBe(true);
				await agents.screenshot({ path: testInfo.outputPath('agents-draft-after-open-ide.png') });
			} finally {
				await reopenedWindow.dispose();
			}
		} finally {
			await input?.dispose();
			await ideWindow.dispose();
		}
	},
);

test(
	'closing the Workbench keeps Sessions usable and Return to Workbench reopens the workspace',
	{ tag: ['@electron-ui', '@electron-app-server'] },
	async ({ target }) => {
		const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-dedicated-close-'));
		try {
			const { application, driver, close } = await launchElectron({
				appServerMode: target.appServerMode,
				userDataDirectory,
				windowMode: process.platform === 'darwin' ? 'active' : undefined,
			});
			try {
				const parent = driver.workbench.page;
				const childPromise = application.waitForEvent('window');
				await parent
					.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button")
					.click();
				const child = await childPromise;
				await expect(child.locator('.ash-code-sessions-window')).toBeVisible();
				await parent.close();
				await expect(child.locator('.ash-code-sessions-window')).toBeVisible();
				expect(JSON.parse((await readUserSettings(child)).content)).toEqual({});
				const windows = await child.evaluate(async () => {
					const ipc = (
						globalThis as unknown as {
							readonly ash: {
								readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> };
							};
						}
					).ash.ipcRenderer;
					const list = (await ipc.invoke('ash:window:operation', { kind: 'list' })) as readonly {
						readonly title: string;
					}[];
					const connection = (await ipc.invoke('ash:remote:connection')) as { readonly kind: string };
					return { titles: list.map(window => window.title), connectionKind: connection.kind };
				});
				expect(windows).toEqual({ titles: [expect.stringContaining('Sessions')], connectionKind: 'local' });
				const workbenchPromise = application.waitForEvent('window');
				await new Menus(child).selectApplication(application, ['File', 'Return to Workbench']);
				const reopened = await workbenchPromise;
				await expect(reopened.locator('.ash-workbench')).toBeVisible();
				await expect.poll(() => application.windows().length).toBe(1);
			} finally {
				await close();
			}
		} finally {
			if (!resolve(userDataDirectory).startsWith(`${resolve(tmpdir())}${sep}`))
				throw new Error('Test profile escaped the temporary directory');
			await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	},
);

test(
	'Code registers and releases a user system-wide Open Agents Window shortcut',
	{ tag: ['@electron-ui', '@electron-app-server'] },
	async ({ target }) => {
		const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-shortcut-'));
		const profileDirectory = join(userDataDirectory, 'profile');
		const resourcePath = join(profileDirectory, 'keybindings.json');
		await mkdir(profileDirectory);
		await writeFile(
			resourcePath,
			JSON.stringify([
				{ key: 'ctrl+alt+shift+f24', command: 'workbench.action.openAgentsWindow', systemWide: true },
			]),
		);
		try {
			const { application, close } = await launchElectron({
				appServerMode: 'disabled',
				userDataDirectory,
				profileDirectory,
			});
			try {
				await expect
					.poll(() =>
						application.evaluate(({ globalShortcut }) =>
							globalShortcut.isRegistered('Control+Alt+Shift+F24'),
						),
					)
					.toBe(true);
				await writeFile(resourcePath, '[]\n');
				await expect
					.poll(() =>
						application.evaluate(({ globalShortcut }) =>
							globalShortcut.isRegistered('Control+Alt+Shift+F24'),
						),
					)
					.toBe(false);
			} finally {
				await close();
			}
		} finally {
			if (!resolve(userDataDirectory).startsWith(`${resolve(tmpdir())}${sep}`))
				throw new Error('Test profile escaped the temporary directory');
			await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	},
);

test(
	'Agents retains the system-wide shortcut after the Workbench closes and forwards command arguments',
	{ tag: ['@electron-ui', '@electron-app-server'] },
	async ({ target }) => {
		const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-agents-shortcut-'));
		const profileDirectory = join(userDataDirectory, 'profile');
		const resourcePath = join(profileDirectory, 'keybindings.json');
		await mkdir(profileDirectory);
		await writeFile(resourcePath, '[]\n');
		try {
			const { application, driver, close } = await launchElectron({
				appServerMode: 'disabled',
				userDataDirectory,
				profileDirectory,
			});
			try {
				await application.evaluate(({ globalShortcut }) => {
					const register = globalShortcut.register;
					// Substitute only the OS trigger; registration, Main routing and renderer handoff remain real.
					globalShortcut.register = (accelerator, callback) => {
						const registered = register.call(globalShortcut, accelerator, callback);
						if (accelerator === 'Control+Alt+Shift+F24') {
							(
								globalThis as typeof globalThis & { ashOpenAgentsShortcut?: () => void }
							).ashOpenAgentsShortcut = callback;
							globalShortcut.register = register;
						}
						return registered;
					};
				});
				await writeFile(
					resourcePath,
					JSON.stringify([
						{
							key: 'ctrl+alt+shift+f24',
							command: 'workbench.action.openAgentsWindow',
							systemWide: true,
							args: { draft: { mode: 'agent', text: 'From the system shortcut', contexts: [] } },
						},
						{
							key: 'ctrl+shift+y',
							command: 'workbench.action.openAgentsWindow',
							args: { draft: { mode: 'agent', text: 'From the Agents command', contexts: [] } },
						},
					]),
				);
				await expect
					.poll(() =>
						application.evaluate(({ globalShortcut }) =>
							globalShortcut.isRegistered('Control+Alt+Shift+F24'),
						),
					)
					.toBe(true);
				const childPromise = application.waitForEvent('window');
				await driver.workbench.page.keyboard.press('Control+Shift+Y');
				const child = await childPromise;
				const editor = new Editor(child.locator('.ash-sessions-chat-slot.active:visible'));
				await editor.waitForEditorContents(contents => contents === 'From the Agents command');
				// Draft handoff preserves unsent text; clear the previous draft before accepting another.
				await replaceChatInput(editor, '');
				await application.evaluate(() =>
					(globalThis as typeof globalThis & { ashOpenAgentsShortcut: () => void }).ashOpenAgentsShortcut(),
				);
				await editor.waitForEditorContents(contents => contents === 'From the system shortcut');
				await driver.workbench.page.close();
				await expect.poll(() => application.windows().length).toBe(1);
				await expect
					.poll(() =>
						application.evaluate(({ globalShortcut }) =>
							globalShortcut.isRegistered('Control+Alt+Shift+F24'),
						),
					)
					.toBe(true);
				await replaceChatInput(editor, '');
				await child.keyboard.press('Control+Shift+Y');
				await editor.waitForEditorContents(contents => contents === 'From the Agents command');
				await replaceChatInput(editor, '');
				await application.evaluate(() =>
					(globalThis as typeof globalThis & { ashOpenAgentsShortcut: () => void }).ashOpenAgentsShortcut(),
				);
				await editor.waitForEditorContents(contents => contents === 'From the system shortcut');
				await new Workbench(child).reloadWindow(child);
				await expect
					.poll(() =>
						application.evaluate(({ globalShortcut }) =>
							globalShortcut.isRegistered('Control+Alt+Shift+F24'),
						),
					)
					.toBe(true);
				await replaceChatInput(editor, '');
				await application.evaluate(() =>
					(globalThis as typeof globalThis & { ashOpenAgentsShortcut: () => void }).ashOpenAgentsShortcut(),
				);
				await editor.waitForEditorContents(contents => contents === 'From the system shortcut');
				await writeFile(resourcePath, '[]\n');
				await expect
					.poll(() =>
						application.evaluate(({ globalShortcut }) =>
							globalShortcut.isRegistered('Control+Alt+Shift+F24'),
						),
					)
					.toBe(false);
			} finally {
				await close();
			}
		} finally {
			if (!resolve(userDataDirectory).startsWith(`${resolve(tmpdir())}${sep}`))
				throw new Error('Test profile escaped the temporary directory');
			await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	},
);

focusTest(
	'Agents invitation IPC follows real window focus, close, reload and persistent cooldown',
	{ tag: ['@electron-ui'] },
	async ({ application, target, workbench, reloadWorkbench }) => {
		if (!('windows' in application)) throw new Error('Expected an Electron application');
		const page = workbench.page;
		const invoke = (source: import('@playwright/test').Page, channel: string, params?: unknown): Promise<unknown> =>
			source.evaluate(
				({ channel, params }) => {
					const bridge = (
						globalThis as unknown as {
							ash: { ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } };
						}
					).ash.ipcRenderer;
					return bridge.invoke(channel, params);
				},
				{ channel, params },
			);
		const resource = (threadId: string) => ({
			scheme: 'agent-host-session',
			authority: 'local',
			path: '/open',
			query: new URLSearchParams({ sessionId: 'invitation-smoke', threadId }).toString(),
		});
		const read = async (source = page) =>
			(await invoke(
				source,
				'ash:native-host:editor-state',
			)) as import('../../../../src/ash/platform/chat/common/agentsWindowInvitation.js').IAgentHostEditorState;
		const submit = async (source: import('@playwright/test').Page, threadId: string) => {
			await invoke(source, 'ash:native-host:editor-update', {
				kind: 'request',
				resource: resource(threadId),
				isNewSession: true,
				requestSequence: 1,
			});
			await invoke(source, 'ash:native-host:editor-update', {
				kind: 'sessions',
				sessions: [{ resource: resource(threadId), inProgress: true, needsInput: false }],
			});
		};
		await application.evaluate(({ app, BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0]!;
			window.show();
			app.focus({ steal: true });
			window.focus();
		});
		await waitForElectronWindowState(application, page, { focused: true });
		const owner = await application.browserWindow(page);
		let ownerId: number;
		try {
			ownerId = await owner.evaluate(window => window.id);
		} finally {
			await owner.dispose();
		}
		await submit(page, 'first');
		expect((await read()).sessions.map(session => session.windowId)).toEqual([ownerId]);
		const forged = await invoke(page, 'ash:native-host:editor-update', {
			kind: 'request',
			resource: resource('forged'),
			isNewSession: true,
			windowId: ownerId + 1,
		}).then(
			() => '',
			error => String(error),
		);
		expect(forged).toContain('Invalid editor activity update');
		const claim = (await invoke(page, 'ash:native-host:invitation-claim', resource('first'))) as {
			id: string;
			windowId: number;
		};
		expect(claim.windowId).toBe(ownerId);
		expect((await read()).invitation?.id).toBe(claim.id);
		expect((await read()).lastShown).toBeUndefined();
		await waitForElectronWindowState(application, page, { focused: true });
		await invoke(page, 'ash:native-host:invitation-shown', claim.id);
		const impression = (await read()).lastShown!;
		expect(impression.editorSessionCount).toBe(1);
		expect(impression.timestamp).toBeGreaterThan(0);
		const agents = await workbench.openAgentsWindow(target.kind);
		await waitForElectronWindowState(application, agents, { focused: true });
		expect(await invoke(page, 'ash:native-host:invitation-claim', resource('first'))).toBeUndefined();
		expect(await invoke(agents, 'ash:native-host:invitation-claim', resource('first'))).toBeUndefined();
		await invoke(agents, 'ash:native-host:invitation-release', claim.id);
		expect((await read()).invitation?.id).toBe(claim.id);
		await invoke(agents, 'ash:native-host:editor-update', {
			kind: 'request',
			resource: resource('first'),
			isNewSession: false,
			requestSequence: 2,
		});
		await invoke(page, 'ash:native-host:editor-update', {
			kind: 'sessions',
			sessions: [{ resource: resource('first'), inProgress: true, needsInput: false }],
		});
		expect((await read()).sessions).toEqual([]);
		expect((await read()).invitation).toBeUndefined();
		const secondaryOpened = application.waitForEvent('window');
		await invoke(page, 'ash:window:open', { forceReuseWindow: false });
		const secondary = await secondaryOpened;
		await expect(secondary.locator('.ash-workbench')).toBeVisible();
		await submit(secondary, 'secondary');
		expect((await read()).sessions).toHaveLength(1);
		const secondaryClosed = secondary.waitForEvent('close');
		await invoke(secondary, 'ash:window:operation', { kind: 'close' });
		await secondaryClosed;
		await expect.poll(async () => (await read()).sessions).toEqual([]);
		await submit(page, 'reload');
		await page.reload();
		await expect(page.locator('.ash-workbench')).toBeVisible();
		expect((await read()).sessions).toEqual([]);
		expect((await read()).editorSessionCount).toBe(3);
		expect((await read()).lastShown).toEqual(impression);
		const agentsClosed = agents.waitForEvent('close');
		await invoke(agents, 'ash:window:operation', { kind: 'close' });
		await agentsClosed;
		const restarted = await reloadWorkbench();
		const durable = await read(restarted.workbench.page);
		expect({
			count: durable.editorSessionCount,
			lastShown: durable.lastShown,
			sessions: durable.sessions,
			invitation: durable.invitation,
		}).toEqual({ count: 3, lastShown: impression, sessions: [], invitation: undefined });
	},
);
