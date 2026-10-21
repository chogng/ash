import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { ElectronApplication, Page } from '@playwright/test';

const screenshotShortcut = process.platform === 'darwin' ? 'Control+Meta+a' : 'Control+Alt+s';

test('Agents screenshot shortcut survives initial navigation, reload and reopening', { tag: ['@electron-ui'] }, async ({ application, workbench, target }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const synchronize = async (): Promise<void> => {
		const result = await page.evaluate(() => (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:screenshot:shortcut', { accelerator: '', label: '', global: false }));
		expect(result).toEqual({ available: false, activeLabel: '' });
	};
	await synchronize();
	await workbench.reloadWindow(page);
	await synchronize();
	page = await workbench.reopenAgentsWindow(application, page);
	await synchronize();
});

async function screenOverlay(application: ElectronApplication, chinese = false): Promise<Page> {
	await expect.poll(() => application.windows().filter(page => page.url().includes('/screenshot/screenshot.html')).length).toBeGreaterThan(0);
	const page = application.windows().find(page => page.url().includes('/screenshot/screenshot.html'))!;
	await expect(page.getByRole('dialog', { name: chinese ? '屏幕截图' : 'Screen Capture', exact: true })).toBeVisible();
	return page;
}

/** Cover the desktop with test-owned pixels so screen capture evidence contains only synthetic content. */
async function coverDisplays(application: ElectronApplication): Promise<number[]> {
	return application.evaluate(async ({ BrowserWindow, screen }) => {
		const windows = screen.getAllDisplays().map(display => new BrowserWindow({ ...display.bounds, frame: false, show: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }));
		await Promise.all(windows.map(async window => {
			await window.loadURL('data:text/html,' + encodeURIComponent('<html><body style="margin:0;background:linear-gradient(90deg,rgb(37,99,235) 0 50%,rgb(34,197,94) 50% 100%);height:100vh;color:white;font:20px sans-serif"><p style="margin:20px">Ash synthetic screen capture fixture</p></body></html>'));
			window.showInactive();
			await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
		}));
		return windows.map(window => window.id);
	});
}

async function uncoverDisplays(application: ElectronApplication, ids: number[]): Promise<void> {
	await application.evaluate(({ BrowserWindow }, ids) => { for (const id of ids) BrowserWindow.fromId(id)?.destroy(); }, ids);
}

test('AI window capture keeps its trusted sender, CSS rectangle and no-overlay behavior', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, workbench }) => {
	if (!('browserWindow' in application)) throw new Error('Expected an Electron window');
	const page = workbench.page;
	const owner = await application.browserWindow(page);
	await owner.evaluate(window => window.webContents.setZoomFactor(1.25));
	try {
		const count = application.windows().length;
		const capture = await page.evaluate(async () => {
			const host = (globalThis as unknown as { ash: ISandboxGlobals; }).ash;
			const bytes = await host.ipcRenderer.invoke('ash:host:screenshot', { x: 20, y: 30, width: 160, height: 96 }) as Uint8Array;
			const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
			try { return { signature: [...bytes.slice(0, 8)], width: bitmap.width, height: bitmap.height, scale: devicePixelRatio }; }
			finally { bitmap.close(); }
		});
		expect(capture.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		expect(capture.width).toBe(Math.round(160 * capture.scale));
		expect(capture.height).toBe(Math.round(96 * capture.scale));
		expect(application.windows()).toHaveLength(count);
		await expect(page.getByRole('dialog', { name: 'Screen Capture', exact: true })).toHaveCount(0);
	} finally { await owner.evaluate(window => window.webContents.setZoomFactor(1)); }
});

for (const locale of ['en', 'zh-CN']) {
	test(`manual screenshot selects another window's desktop pixels and cancels safely in ${locale}`, { tag: ['@electron-ui'] }, async ({ application, workbench, restartWorkbench }, testInfo) => {
		if (!('browserWindow' in application)) throw new Error('Expected an Electron window');
		const chinese = locale === 'zh-CN';
		if (chinese) {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
			await picker.getByRole('combobox').fill('简体中文');
			await picker.getByRole('combobox').press('Enter');
			({ application, workbench } = await restartWorkbench());
			if (!('browserWindow' in application)) throw new Error('Expected an Electron window');
		}
		const desktop = application;
		const page = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.chat.open');
		const input = page.locator('.ash-chat-input-editor').getByRole('textbox').last();
		await input.focus();
		await page.keyboard.insertText('Screenshot draft');
		const covers = await coverDisplays(desktop);
		try {
			await input.press(screenshotShortcut);
			let overlay = await screenOverlay(desktop, chinese);
			await overlay.keyboard.press('Escape').catch(error => { if (!overlay.isClosed()) throw error; });
			await expect.poll(() => desktop.windows().filter(page => page.url().includes('/screenshot/screenshot.html')).length).toBe(0);
			await expect(page.locator('.ash-chat-input-editor').last()).toContainText('Screenshot draft');
			await input.press(screenshotShortcut);
			overlay = await screenOverlay(desktop, chinese);
			const image = (await overlay.locator('canvas').boundingBox())!;
			await overlay.mouse.move(image.x + 100, image.y + 150);
			await overlay.mouse.down();
			await overlay.mouse.move(image.x + 500, image.y + 350, { steps: 4 });
			await overlay.mouse.up();
			// The independent window-capture endpoint remains usable while manual selection is open.
			const overlayCount = desktop.windows().filter(page => page.url().includes('/screenshot/screenshot.html')).length;
			const raw = await page.evaluate(async () => [...(await (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:host:screenshot', { x: 0, y: 0, width: 80, height: 60 }) as Uint8Array).slice(0, 8)]);
			expect(raw).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			expect(desktop.windows().filter(page => page.url().includes('/screenshot/screenshot.html'))).toHaveLength(overlayCount);
			const pixels = await overlay.locator('canvas').evaluate(canvas => {
				const image = canvas as HTMLCanvasElement;
				const context = image.getContext('2d')!;
				return [0.25, 0.75].map(x => [...context.getImageData(Math.floor(image.width * x), Math.floor(image.height / 2), 1, 1).data]);
			});
			// Display profiles transform exact channels; both halves must retain the fixture's distinct colors.
			const [blue, green] = pixels;
			expect(blue[2]).toBeGreaterThan(blue[0] + 80);
			expect(blue[2]).toBeGreaterThan(blue[1] + 40);
			expect(green[1]).toBeGreaterThan(green[0] + 60);
			expect(green[1]).toBeGreaterThan(green[2] + 40);
			expect([blue[3], green[3]]).toEqual([255, 255]);
			const path = testInfo.outputPath(`manual-capture-${locale}.png`);
			await overlay.screenshot({ path });
			await testInfo.attach('synthetic desktop selection', { path, contentType: 'image/png' });
			await overlay.getByRole('button', { name: chinese ? '加入聊天' : 'Add to Chat', exact: true }).click().catch(error => { if (!overlay.isClosed()) throw error; });
			await expect.poll(() => desktop.windows().filter(page => page.url().includes('/screenshot/screenshot.html')).length).toBe(0);
			await expect(input).toBeFocused();
			await expect(page.getByRole('button', { name: chinese ? '预览 截图' : 'Preview Screenshot', exact: true })).toBeVisible();
			if (!chinese) {
				const originals = await desktop.evaluateHandle(async ({ dialog, clipboard, ClipboardItem }) => ({
					save: dialog.showSaveDialog,
					clipboard: await Promise.all((await clipboard.read()).filter(item => item.types.length > 0).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))),
				}));
				try {
					await expect.poll(() => desktop.windows().filter(page => page.url().includes('/screenshot/screenshot.html')).length).toBe(0);
					await input.press(screenshotShortcut);
					overlay = await screenOverlay(desktop);
					await overlay.getByRole('button', { name: 'Entire screen', exact: true }).click();
					await desktop.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
					await overlay.getByRole('button', { name: 'Save', exact: true }).click();
					await expect(overlay.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
					await expect(overlay.getByRole('dialog', { name: 'Screen Capture', exact: true })).toBeVisible();
					const destination = testInfo.outputPath('saved-screenshot.png');
					await desktop.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, destination);
					await overlay.getByRole('button', { name: 'Save', exact: true }).click().catch(error => { if (!overlay.isClosed()) throw error; });
					await expect.poll(() => readFile(destination).then(bytes => [...bytes.subarray(0, 8)]).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
					await expect.poll(() => desktop.windows().filter(page => page.url().includes('/screenshot/screenshot.html')).length).toBe(0);
					await input.press(screenshotShortcut);
					overlay = await screenOverlay(desktop);
					await overlay.getByRole('button', { name: 'Entire screen', exact: true }).click();
					const previous = overlay;
					await overlay.getByRole('button', { name: 'Retake', exact: true }).click().catch(error => { if (!overlay.isClosed()) throw error; });
					await expect.poll(() => previous.isClosed()).toBe(true);
					overlay = await screenOverlay(desktop);
					await overlay.getByRole('button', { name: 'Entire screen', exact: true }).click();
					await overlay.getByRole('button', { name: 'Copy', exact: true }).click().catch(error => { if (!overlay.isClosed()) throw error; });
					await expect.poll(() => desktop.windows().filter(page => page.url().includes('/screenshot/screenshot.html')).length).toBe(0);
					const copied = await desktop.evaluate(async ({ clipboard }) => {
						for (const item of await clipboard.read()) {
							if (!item.types.includes('image/png')) continue;
							// Only the bookmark MIME type returns a ClipboardBookmark.
							const image = await item.getType('image/png') as Blob;
							return [...new Uint8Array(await image.arrayBuffer()).subarray(0, 8)];
						}
						return [];
					});
					expect(copied).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
					await expect(page.getByRole('button', { name: 'Preview Screenshot', exact: true })).toHaveCount(1);
				} finally {
					await desktop.evaluate(async ({ dialog, clipboard }, saved) => { dialog.showSaveDialog = saved.save; if (saved.clipboard.length) await clipboard.write(saved.clipboard); else clipboard.clear(); }, originals);
					await originals.dispose();
				}
			}

		} finally { await uncoverDisplays(desktop, covers); }
	});

	test(`screen permission guidance identifies the running app and offers recovery in ${locale}`, { tag: ['@electron-ui'] }, async ({ application, workbench, restartWorkbench }) => {
		test.skip(process.platform !== 'darwin', 'macOS screen recording permission');
		if (!('browserWindow' in application)) throw new Error('Expected an Electron window');
		const chinese = locale === 'zh-CN';
		if (chinese) {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
			await picker.getByRole('combobox').fill('简体中文');
			await picker.getByRole('combobox').press('Enter');
			({ application, workbench } = await restartWorkbench());
			if (!('browserWindow' in application)) throw new Error('Expected an Electron window');
		}
		const desktop = application;
		const page = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.chat.open');
		const input = page.locator('.ash-chat-input-editor').getByRole('textbox').last();
		await input.focus();
		await page.keyboard.insertText('Permission draft');
		const saved = await desktop.evaluateHandle(({ app, systemPreferences, desktopCapturer, dialog, shell }) => {
			const originals = { access: systemPreferences.getMediaAccessStatus, capture: desktopCapturer.getSources, message: dialog.showMessageBox, open: shell.openExternal, reveal: shell.showItemInFolder };
			const state = {
				permission: 'denied' as 'denied' | 'not-determined' | 'granted', response: 0, captures: 0,
				dialogs: [] as { message: string; detail: string; buttons: string[]; cancelId?: number; }[],
				opened: [] as string[], revealed: [] as string[], executable: app.getPath('exe'),
				originals,
			};
			systemPreferences.getMediaAccessStatus = media => media === 'screen' ? state.permission : originals.access.call(systemPreferences, media);
			desktopCapturer.getSources = async () => { state.captures++; throw new Error('Deliberate permission capture failure'); };
			dialog.showMessageBox = (async (_window: unknown, options: { message: string; detail: string; buttons: string[]; cancelId?: number; }) => {
				state.dialogs.push({ message: options.message, detail: options.detail, buttons: options.buttons, cancelId: options.cancelId });
				return { response: state.response, checkboxChecked: false };
			}) as typeof dialog.showMessageBox;
			shell.openExternal = async target => { state.opened.push(target); };
			shell.showItemInFolder = target => { state.revealed.push(target); };
			return state;
		});
		try {
			await workbench.settingsEditor.openUserSettingsUI();
			await workbench.settingsEditor.selectGroup('workbench');
			await workbench.settingsEditor.selectCategory('screenshot');
			const settings = page.getByRole('dialog', { name: chinese ? 'Ash 设置' : 'Ash Settings', exact: true });
			const background = settings.getByRole('switch', { name: chinese ? '全局截图' : 'Global screenshot shortcut', exact: true });
			await expect(background).not.toBeChecked();
			await expect(settings.locator('[data-settings-item-id]')).toHaveCount(1);
			await expect(settings.getByRole('button', { name: chinese ? '打开系统设置' : 'Open System Settings', exact: true })).toHaveCount(0);
			await background.focus();
			await background.press('Space');
			await expect(background).toBeChecked();
			await background.press('Space');
			await expect(background).not.toBeChecked();
			expect(await saved.evaluate(state => state.captures)).toBe(0);
			expect(await saved.evaluate(state => state.dialogs)).toHaveLength(0);
			expect(await saved.evaluate(state => state.opened)).toHaveLength(0);
			await settings.locator('.ash-modal-editor-close').click();
			await workbench.quickaccess.runCommand('workbench.action.chat.open');
			await input.focus();

			await input.press(screenshotShortcut);
			await expect.poll(() => saved.evaluate(state => state.opened)).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
			const state = await saved.evaluate(state => ({ captures: state.captures, dialogs: state.dialogs, executable: state.executable }));
			expect(state.captures).toBe(0);
			expect(state.dialogs).toHaveLength(1);
			expect(state.dialogs[0]).toMatchObject({ message: chinese ? '允许屏幕截图' : 'Allow screen capture', buttons: chinese ? ['打开系统设置', '在 Finder 中显示应用程序', '取消'] : ['Open System Settings', 'Show Application in Finder', 'Cancel'], cancelId: 2 });
			const bundle = state.executable.slice(0, state.executable.lastIndexOf('/Contents/MacOS/'));
			expect(state.dialogs[0].detail).toContain(bundle);
			expect(state.dialogs[0].detail.split('\n')[0]).toContain(basename(bundle));
			await expect(input).toBeFocused();
			await expect(page.locator('.ash-chat-input-editor').last()).toContainText('Permission draft');
			await expect(page.getByRole('button', { name: chinese ? '预览 截图' : 'Preview Screenshot', exact: true })).toHaveCount(0);
			expect(desktop.windows().filter(page => page.url().includes('/screenshot/screenshot.html'))).toHaveLength(0);
			await expect(page.getByText(/Could not add context|无法添加上下文/)).toHaveCount(0);

			await saved.evaluate(state => { state.response = 1; });
			await input.press(screenshotShortcut);
			await expect.poll(() => saved.evaluate(state => state.revealed)).toEqual([bundle]);
			await expect(input).toBeFocused();

			// The first OS request must still run when consent has never been determined.
			await saved.evaluate(state => { state.permission = 'not-determined'; state.response = 2; });
			await input.press(screenshotShortcut);
			await expect.poll(() => saved.evaluate(state => state.dialogs.length)).toBe(3);
			expect(await saved.evaluate(state => state.captures)).toBe(1);
			await expect(input).toBeFocused();

			// An actual acquisition failure with permission granted must retain its error instead of blaming permissions.
			await saved.evaluate(state => { state.permission = 'granted'; });
			await input.press(screenshotShortcut);
			await expect(page.getByLabel(chinese ? '通知' : 'Notifications', { exact: true }).getByText(/Could not add context:.*Screen capture is unavailable|无法添加上下文：.*屏幕/)).toBeVisible();
			expect(await saved.evaluate(state => state.dialogs.length)).toBe(3);
		} finally {
			await desktop.evaluate(({ systemPreferences, desktopCapturer, dialog, shell }, state) => {
				systemPreferences.getMediaAccessStatus = state.originals.access;
				desktopCapturer.getSources = state.originals.capture;
				dialog.showMessageBox = state.originals.message;
				shell.openExternal = state.originals.open;
				shell.showItemInFolder = state.originals.reveal;
			}, saved);
			await saved.dispose();
		}
	});

}

test('screenshot shortcut reports occupancy, retains a working global binding and triggers from the background', { tag: ['@electron-ui'] }, async ({ application, workbench }) => {
	test.skip(process.platform !== 'darwin', 'macOS global screenshot shortcut');
	if (!('browserWindow' in application)) throw new Error('Expected Electron');
	const desktop = application;
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.chat.open');
	const input = page.locator('.ash-chat-input-editor').getByRole('textbox').last();
	await input.focus(); await page.keyboard.insertText('Global capture draft');
	const saved = await desktop.evaluateHandle(({ globalShortcut }) => {
		const originals = { register: globalShortcut.register, unregister: globalShortcut.unregister, isRegistered: globalShortcut.isRegistered };
		const state = { originals, blocked: new Set(['Command+Control+A']), callbacks: new Map<string, () => void>(), operations: [] as string[] };
		globalShortcut.register = (accelerator, callback) => {
			state.operations.push(`register:${accelerator}`);
			if (state.blocked.has(accelerator) || state.callbacks.has(accelerator)) return false;
			state.callbacks.set(accelerator, callback); return true;
		};
		globalShortcut.isRegistered = accelerator => state.callbacks.has(accelerator) || originals.isRegistered.call(globalShortcut, accelerator);
		globalShortcut.unregister = accelerator => {
			state.operations.push(`unregister:${accelerator}`);
			if (!state.callbacks.delete(accelerator)) originals.unregister.call(globalShortcut, accelerator);
		};
		return state;
	});
	let covers: number[] = [];
	try {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('screenshot');
		let settings = page.getByRole('dialog', { name: 'Ash Settings', exact: true });
		const background = settings.getByRole('switch', { name: 'Global screenshot shortcut', exact: true });
		await expect(background).not.toBeChecked();
		await background.focus();
		await background.press('Space');
		await expect(background).toBeChecked();
		const notifications = page.getByLabel('Notifications', { exact: true });
		await expect(notifications).toContainText('The global screenshot shortcut could not be registered.');
		expect(await saved.evaluate(state => state.callbacks.size)).toBe(0);
		await notifications.getByRole('button', { name: 'Change Shortcut', exact: true }).click();
		await expect(settings).toHaveCount(0);
		const shortcuts = page.locator('.ash-keybindings-editor');
		await expect(shortcuts.locator('.ash-keybindings-search input')).toHaveValue('@command:workbench.action.chat.attachScreenshot');
		await expect(shortcuts.locator('.ash-keybindings-search input')).toBeFocused();
		await expect(shortcuts.locator('.ash-keybindings-row')).toHaveCount(1);
		await expect(shortcuts.locator('.ash-keybindings-command-id')).toHaveText('workbench.action.chat.attachScreenshot');

		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('screenshot');
		await saved.evaluate(state => state.blocked.clear());
		await background.focus(); await background.press('Space');
		await expect(background).not.toBeChecked();
		await background.press('Space');
		await expect.poll(() => saved.evaluate(state => state.callbacks.has('Command+Control+A'))).toBe(true);

		const profile = await desktop.evaluate(() => process.env.ASH_HOME);
		if (!profile) throw new Error('Test profile missing');
		await writeFile(join(profile, 'keybindings.json'), '[{"key":"ctrl+cmd+b ctrl+cmd+c","command":"workbench.action.chat.attachScreenshot"}]');
		await expect(notifications).toContainText('This screenshot shortcut cannot be used globally.');
		await expect(notifications).toContainText('The previous shortcut still works:');
		expect(await saved.evaluate(state => [...state.callbacks.keys()])).toEqual(['Command+Control+A']);

		await saved.evaluate(state => state.blocked.add('Command+Control+B'));
		await writeFile(join(profile, 'keybindings.json'), '[{"key":"ctrl+cmd+b","command":"workbench.action.chat.attachScreenshot"}]');
		await expect(notifications).toContainText('The global screenshot shortcut could not be registered.');
		await expect(notifications).toContainText('The previous shortcut still works:');
		expect(await saved.evaluate(state => [...state.callbacks.keys()])).toEqual(['Command+Control+A']);

		await saved.evaluate(state => state.blocked.clear());
		await background.focus(); await background.press('Space');
		await expect(background).not.toBeChecked();
		await background.press('Space');
		await expect.poll(() => saved.evaluate(state => [...state.callbacks.keys()])).toEqual(['Command+Control+B']);
		await expect(notifications.getByRole('button', { name: 'Change Shortcut', exact: true })).toHaveCount(0);
		await settings.locator('.ash-modal-editor-close').click();
		covers = await coverDisplays(desktop);
		await desktop.evaluate(({ BrowserWindow }, ids) => BrowserWindow.fromId(ids[0])!.focus(), covers);
		await saved.evaluate(state => state.callbacks.get('Command+Control+B')!());
		const overlay = await screenOverlay(desktop);
		await overlay.keyboard.press('Escape').catch(error => { if (!overlay.isClosed()) throw error; });
		await expect.poll(() => desktop.windows().filter(page => page.url().includes('/screenshot/screenshot.html')).length).toBe(0);
		await expect(page.locator('.ash-chat-input-editor').last()).toContainText('Global capture draft');
		await uncoverDisplays(desktop, covers); covers = [];

		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('screenshot');
		settings = page.getByRole('dialog', { name: 'Ash Settings', exact: true });
		const disableBackground = settings.getByRole('switch', { name: 'Global screenshot shortcut', exact: true });
		await disableBackground.focus(); await disableBackground.press('Space');
		await expect.poll(() => saved.evaluate(state => state.callbacks.size)).toBe(0);
	} finally {
		if (covers.length) await uncoverDisplays(desktop, covers);
		// Release this contribution's registration before restoring the registry mock.
		await page.evaluate(async () => { await (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:screenshot:shortcut', { accelerator: '', label: '', global: false }); });
		await desktop.evaluate(({ globalShortcut }, state) => {
			globalShortcut.register = state.originals.register; globalShortcut.unregister = state.originals.unregister; globalShortcut.isRegistered = state.originals.isRegistered;
		}, saved);
		await saved.dispose();
	}
});
