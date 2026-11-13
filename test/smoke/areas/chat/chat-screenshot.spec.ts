import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { ElectronApplication, Page } from '@playwright/test';
import type { BaseWindow, SaveDialogOptions } from 'electron';

const screenshotShortcut = process.platform === 'darwin' ? 'Control+Meta+a' : 'Control+Alt+s';

// These cases exercise OS capture and focus; synthetic cover windows must actually be visible.
test.use({ electronWindowMode: 'active' });

test('Agents screenshot shortcut survives initial navigation, reload and reopening', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, workbench, target }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const synchronize = async (): Promise<void> => {
		const result = await page.evaluate(() => (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:global-keybinding:update', { id: 'chat.screenshot', commandId: 'workbench.action.chat.attachScreenshot', accelerator: '', label: '', global: false }));
		expect(result).toEqual({ available: false, activeLabel: '' });
	};
	await synchronize();
	await workbench.reloadWindow(page);
	await synchronize();
	page = await workbench.reopenAgentsWindow(application, page);
	await synchronize();
});

async function screenOverlay(application: ElectronApplication, chinese = false): Promise<Page> {
	await expect.poll(() => application.windows().filter(page => page.url().includes('/imageView/imageView.html')).length).toBeGreaterThan(0);
	const page = application.windows().find(page => page.url().includes('/imageView/imageView.html'))!;
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
			if (!window.isVisible()) throw new Error('Synthetic screen cover did not become visible');
			await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
		}));
		return windows.map(window => window.id);
	});
}

async function uncoverDisplays(application: ElectronApplication, ids: number[]): Promise<void> {
	await application.evaluate(({ BrowserWindow }, ids) => { for (const id of ids) BrowserWindow.fromId(id)?.destroy(); }, ids);
}

test('desktop screenshot setup replaces a cancelled pending permission request', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, workbench }) => {
	test.skip(process.platform !== 'darwin', 'macOS screen recording permission');
	if (!('browserWindow' in application)) throw new Error('Expected Electron');
	const desktop = application;
	const state = await desktop.evaluateHandle(({ systemPreferences }) => {
		const original = systemPreferences.getMediaAccessStatus;
		const state = { calls: 0, release: undefined as (() => void) | undefined, restore() { systemPreferences.getMediaAccessStatus = original; } };
		systemPreferences.getMediaAccessStatus = type => {
			if (type !== 'screen') return original.call(systemPreferences, type);
			if (++state.calls === 2) {
				return new Promise<'denied'>(resolve => { state.release = () => resolve('denied'); }) as unknown as ReturnType<typeof original>;
			}
			return 'denied';
		};
		return state;
	});
	const owner = await desktop.browserWindow(workbench.page);
	try {
		await workbench.quickaccess.runCommand('workbench.action.chat.attachScreenshot');
		await expect.poll(() => state.evaluate(state => state.calls)).toBe(2);
		await owner.evaluate(window => window.webContents.send('ash:global-keybinding:trigger', { id: 'chat.screenshot' }));
		const setup = workbench.page.getByRole('dialog', { name: 'Set Up Desktop Screenshots', exact: true });
		await expect(setup).toBeVisible();
		await expect.poll(() => state.evaluate(state => state.calls)).toBe(4);
		await state.evaluate(state => state.release?.());
		await expect(setup).toHaveCount(1);
		await expect(setup).toBeVisible();
		await setup.press('Escape');
		await expect(setup).toHaveCount(0);
		expect(desktop.windows().filter(page => page.url().includes('/imageView/imageView.html'))).toHaveLength(0);
	} finally {
		await state.evaluate(state => { state.release?.(); state.restore(); });
		await state.dispose();
		await owner.dispose();
	}
});

test('standalone capture copies on Enter while Chat stays closed', { tag: ['@electron-app-server'] }, async ({ application, workbench }) => {
	if (!('browserWindow' in application)) throw new Error('Expected an Electron window');
	const permission = await application.evaluate(({ systemPreferences }) => process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted');
	test.skip(permission !== 'granted', 'Screen Recording permission is required for actual desktop pixels.');
	await workbench.quickaccess.runCommand('workbench.action.closeAuxiliaryBar');
	const chat = workbench.page.locator('[data-view-id="ash.chat.view"] .ash-chat-input-editor');
	await expect(chat).toBeHidden();
	const covers = await coverDisplays(application);
	try {
		await workbench.page.keyboard.press(screenshotShortcut);
		const overlay = await screenOverlay(application);
		await overlay.getByRole('button', { name: 'Entire screen', exact: true }).click();
		await expect(overlay.getByRole('button', { name: 'Copy', exact: true })).toHaveClass(/primary/);
		const surface = overlay.getByRole('group', { name: 'Frozen screen and region selection' });
		await surface.press('Enter').catch(error => { if (!overlay.isClosed()) throw error; });
		await expect.poll(() => application.windows().filter(page => page.url().includes('/imageView/imageView.html')).length).toBe(0);
		expect(await application.evaluate(async ({ clipboard }) => {
			const image = (await clipboard.read()).find(item => item.types.includes('image/png'));
			const data = image && await image.getType('image/png');
			return data instanceof Blob ? [...new Uint8Array(await data.arrayBuffer()).subarray(0, 8)] : [];
		})).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		await expect(chat).toBeHidden();
	} finally { await uncoverDisplays(application, covers); }
});

test('Agent window screenshots retain their target with another window open and never start desktop selection', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, workbench }) => {
	if (!('browserWindow' in application)) throw new Error('Expected an Electron window');
	const page = workbench.page;
	const owner = await application.browserWindow(page);
	await owner.evaluate(window => window.webContents.setZoomFactor(1.25));
	const otherWindow = await application.evaluate(async ({ BrowserWindow }) => {
		const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
		await window.loadURL('data:text/html,' + encodeURIComponent('<title>Screenshot decoy</title><body style="background:rgb(255,0,255)">Other window</body>'));
		return window.id;
	});
	try {
		await page.evaluate(async () => {
			const marker = document.createElement('div');
			marker.id = 'target-screenshot-marker';
			marker.style.cssText = 'position:fixed;inset:0;width:240px;height:180px;background:rgb(37,99,235);z-index:2147483647;pointer-events:none';
			document.body.append(marker);
			await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		});
		const count = application.windows().length;
		const externalPixel = await page.evaluate(async bytes => {
			const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
			try {
				const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
				const context = canvas.getContext('2d')!;
				context.drawImage(bitmap, 0, 0);
				return [...context.getImageData(8, 8, 1, 1).data];
			} finally { bitmap.close(); }
		}, [...await page.screenshot({ clip: { x: 20, y: 30, width: 160, height: 96 } })]);
		// Native color management can round an RGB channel by one level.
		for (const [index, expected] of [37, 99, 235, 255].entries()) expect(Math.abs(externalPixel[index] - expected)).toBeLessThanOrEqual(2);
		const capture = await page.evaluate(async () => {
			const host = (globalThis as unknown as { ash: ISandboxGlobals; }).ash;
			const bytes = await host.ipcRenderer.invoke('ash:host:screenshot', { x: 20, y: 30, width: 160, height: 96 }) as Uint8Array;
			const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
			try {
				const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
				const context = canvas.getContext('2d')!;
				context.drawImage(bitmap, 0, 0);
				return { signature: [...bytes.slice(0, 8)], width: bitmap.width, height: bitmap.height, scale: devicePixelRatio, pixel: [...context.getImageData(8, 8, 1, 1).data] };
			}
			finally { bitmap.close(); }
		});
		expect(capture.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		expect(capture.width).toBe(Math.round(160 * capture.scale));
		expect(capture.height).toBe(Math.round(96 * capture.scale));
		for (const [index, expected] of [37, 99, 235, 255].entries()) expect(Math.abs(capture.pixel[index] - expected)).toBeLessThanOrEqual(2);
		expect(application.windows()).toHaveLength(count);
		expect(application.windows().filter(window => window.url().includes('/imageView/imageView.html'))).toHaveLength(0);
		await expect(page.getByRole('dialog', { name: 'Screen Capture', exact: true })).toHaveCount(0);
	} finally {
		await page.evaluate(() => document.getElementById('target-screenshot-marker')?.remove());
		await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), otherWindow);
		await owner.evaluate(window => window.webContents.setZoomFactor(1));
		await owner.dispose();
	}
});

for (const locale of ['en', 'zh-CN']) {
	test(`manual screenshot selects another window's desktop pixels and cancels safely in ${locale}`, { tag: ['@electron-app-server'] }, async ({ application, workbench, restartWorkbench }, testInfo) => {
		if (!('browserWindow' in application)) throw new Error('Expected an Electron window');
		const permission = await application.evaluate(({ systemPreferences }) => process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted');
		test.skip(permission !== 'granted', 'Screen Recording permission is required for actual desktop pixels.');
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
			await expect.poll(() => desktop.windows().filter(page => page.url().includes('/imageView/imageView.html')).length).toBe(0);
			await expect(page.locator('.ash-chat-input-editor').last()).toContainText('Screenshot draft');
			await input.press(screenshotShortcut);
			overlay = await screenOverlay(desktop, chinese);
			const image = (await overlay.locator('canvas').boundingBox())!;
			await overlay.mouse.move(image.x + 100, image.y + 150);
			await overlay.mouse.down();
			await overlay.mouse.move(image.x + 500, image.y + 350, { steps: 4 });
			await overlay.mouse.up();
			const toolbar = overlay.getByRole('group', { name: chinese ? '截图工具' : 'Screenshot tools' });
			await expect(toolbar).toBeVisible();
			expect(await toolbar.getByRole('button').allTextContents()).toEqual(Array(14).fill(''));
			// Native image views inherit their host CSP; a browser fixture alone cannot catch blocked inline fonts.
			await expect.poll(() => toolbar.evaluate(element => {
				return [...element.ownerDocument.fonts].some(font => font.family.includes('Ash Snapshot Icons') && font.status === 'loaded');
			})).toBe(true);
			// The independent window-capture endpoint remains usable while manual selection is open.
			const overlayCount = desktop.windows().filter(page => page.url().includes('/imageView/imageView.html')).length;
			const raw = await page.evaluate(async () => [...(await (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:host:screenshot', { x: 0, y: 0, width: 80, height: 60 }) as Uint8Array).slice(0, 8)]);
			expect(raw).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			expect(desktop.windows().filter(page => page.url().includes('/imageView/imageView.html'))).toHaveLength(overlayCount);
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
			await expect.poll(() => desktop.windows().filter(page => page.url().includes('/imageView/imageView.html')).length).toBe(0);
			await expect(input).toBeFocused();
			await expect(page.getByRole('button', { name: chinese ? '预览 截图' : 'Preview Screenshot', exact: true })).toBeVisible();
			const originals = await desktop.evaluateHandle(async ({ dialog, clipboard, ClipboardItem }) => ({
				save: dialog.showSaveDialog,
				clipboard: await Promise.all((await clipboard.read()).filter(item => item.types.length > 0).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))),
			}));
			try {
				await expect.poll(() => desktop.windows().filter(page => page.url().includes('/imageView/imageView.html')).length).toBe(0);
				await input.press(screenshotShortcut);
				overlay = await screenOverlay(desktop, chinese);
				await overlay.getByRole('button', { name: chinese ? '整个屏幕' : 'Entire screen', exact: true }).click();
				await desktop.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
				await overlay.getByRole('button', { name: chinese ? '保存' : 'Save', exact: true }).click();
				await expect(overlay.getByRole('button', { name: chinese ? '保存' : 'Save', exact: true })).toBeEnabled();
				await expect(overlay.getByRole('dialog', { name: chinese ? '屏幕截图' : 'Screen Capture', exact: true })).toBeVisible();
				const destination = testInfo.outputPath('saved-screenshot.png');
				const savedDialogs = await desktop.evaluateHandle(({ dialog }, path) => {
					const calls: { title?: string; defaultPath?: string; }[] = [];
					dialog.showSaveDialog = async (ownerOrOptions: BaseWindow | SaveDialogOptions, options?: SaveDialogOptions) => {
						const value = options ?? ownerOrOptions as SaveDialogOptions;
						calls.push({ title: value.title, defaultPath: value.defaultPath });
						return { canceled: false, filePath: path };
					};
					return calls;
				}, destination);
				await overlay.getByRole('button', { name: chinese ? '保存' : 'Save', exact: true }).click().catch(error => { if (!overlay.isClosed()) throw error; });
				await expect.poll(() => readFile(destination).then(bytes => [...bytes.subarray(0, 8)]).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
				expect(await savedDialogs.jsonValue()).toEqual([{ title: chinese ? '保存图像' : 'Save image', defaultPath: 'Image.png' }]);
				await savedDialogs.dispose();
				await expect.poll(() => desktop.windows().filter(page => page.url().includes('/imageView/imageView.html')).length).toBe(0);
				await input.press(screenshotShortcut);
				overlay = await screenOverlay(desktop, chinese);
				await overlay.getByRole('button', { name: chinese ? '整个屏幕' : 'Entire screen', exact: true }).click();
				const previous = overlay;
				await overlay.getByRole('button', { name: chinese ? '重新截图' : 'Retake', exact: true }).click().catch(error => { if (!overlay.isClosed()) throw error; });
				await expect.poll(() => previous.isClosed()).toBe(true);
				overlay = await screenOverlay(desktop, chinese);
				await overlay.getByRole('button', { name: chinese ? '整个屏幕' : 'Entire screen', exact: true }).click();
				await overlay.getByRole('button', { name: chinese ? '复制' : 'Copy', exact: true }).click().catch(error => { if (!overlay.isClosed()) throw error; });
				await expect.poll(() => desktop.windows().filter(page => page.url().includes('/imageView/imageView.html')).length).toBe(0);
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
				await expect(page.getByRole('button', { name: chinese ? '预览 截图' : 'Preview Screenshot', exact: true })).toHaveCount(1);
			} finally {
				await desktop.evaluate(async ({ dialog, clipboard }, saved) => { dialog.showSaveDialog = saved.save; if (saved.clipboard.length) await clipboard.write(saved.clipboard); else clipboard.clear(); }, originals);
				await originals.dispose();
			}

		} finally { await uncoverDisplays(desktop, covers); }
	});

	test(`desktop screenshot setup handles permissions before annotation in ${locale}`, { tag: ['@electron-app-server'] }, async ({ application, workbench, restartWorkbench }, testInfo) => {
		test.skip(process.platform !== 'darwin', 'macOS screen recording permission');
		if (!('browserWindow' in application)) throw new Error('Expected Electron');
		const chinese = locale === 'zh-CN';
		if (chinese) {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
			await picker.getByRole('combobox').fill('简体中文');
			await picker.getByRole('combobox').press('Enter');
			({ application, workbench } = await restartWorkbench());
			if (!('browserWindow' in application)) throw new Error('Expected Electron');
		}
		const desktop = application;
		const page = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.chat.open');
		const input = page.locator('.ash-chat-input-editor').getByRole('textbox').last();
		await input.focus(); await page.keyboard.insertText('Permission draft');
		const composer = await input.evaluateHandle(element => element.closest('.ash-chat-input-editor')!);
		const state = await desktop.evaluateHandle(({ systemPreferences, desktopCapturer, shell }) => {
			const original = { access: systemPreferences.getMediaAccessStatus, capture: desktopCapturer.getSources, open: shell.openExternal };
			const state = { original, captures: 0, consentRequests: 0, opened: [] as string[], permission: 'denied' as 'denied' | 'granted' | 'restricted' };
			systemPreferences.getMediaAccessStatus = type => type === 'screen' ? state.permission : original.access.call(systemPreferences, type);
			desktopCapturer.getSources = async options => {
				if (options.thumbnailSize?.width === 0 && options.thumbnailSize.height === 0) state.consentRequests++;
				else state.captures++;
				throw new Error('The fixture permits consent requests but no desktop pixels');
			};
			shell.openExternal = async url => { state.opened.push(url); };
			return state;
		});
		try {
			const denied = await page.evaluate(async () => {
				try {
					await (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:image-view:open', {
						id: crypto.randomUUID(), title: 'Permission boundary probe', source: 'screen', html: '', input: {},
					});
					return '';
				} catch (error) { return String(error); }
			});
			expect(denied).toContain('ScreenCapturePermissionRequired');
			expect(desktop.windows().filter(page => page.url().includes('/imageView/imageView.html'))).toHaveLength(0);
			await workbench.quickaccess.runCommand('workbench.action.openSettings');
			const settings = workbench.settingsEditor.element;
			await expect(settings).toBeVisible();
			await workbench.settingsEditor.selectGroup('workbench');
			await workbench.settingsEditor.selectCategory('screenshot');
			await expect(settings.locator('[data-settings-tree-group-id="screenshot.group.screen"]')).toContainText(chinese ? '屏幕截图' : 'Screen capture');
			await expect(settings.locator('[data-configuration-key="snapshot.code.padding"]')).toBeVisible();
			await page.screenshot({ path: testInfo.outputPath(`screenshot-settings-${locale}.png`) });
			await settings.locator('.ash-modal-editor-close').click();
			await input.focus(); await input.press(screenshotShortcut);
			const setup = page.getByRole('dialog', { name: chinese ? '设置桌面截图' : 'Set Up Desktop Screenshots', exact: true });
			await expect(setup).toBeVisible();
			expect(desktop.windows().filter(page => page.url().includes('/imageView/imageView.html'))).toHaveLength(0);
			expect(await state.evaluate(state => state.opened)).toEqual([]);
			expect(await state.evaluate(state => state.captures)).toBe(0);
			const recheck = setup.getByRole('button', { name: chinese ? '重新检查' : 'Check Again', exact: true });
			await recheck.focus();
			await page.keyboard.press('Alt+F1');
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(chinese ? /授权后重新发起截图/ : /start a new screenshot/);
			await page.keyboard.press('Escape');
			await expect(recheck).toBeFocused();
			await setup.getByRole('button', { name: chinese ? '在设置中允许' : 'Allow in Settings', exact: true }).click();
			await expect.poll(() => state.evaluate(state => state.opened)).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
			expect(await state.evaluate(state => state.consentRequests)).toBe(1);
			await state.evaluate(state => { state.permission = 'granted'; });
			await recheck.click();
			await expect(setup).toBeHidden();
			expect(await state.evaluate(state => state.captures)).toBe(0);
			expect(desktop.windows().filter(page => page.url().includes('/imageView/imageView.html'))).toHaveLength(0);
			await state.evaluate(state => { state.permission = 'restricted'; });
			await input.focus(); await input.press(screenshotShortcut);
			await expect(setup).toBeVisible();
			await expect(setup.getByRole('button', { name: chinese ? '在设置中允许' : 'Allow in Settings', exact: true })).toBeHidden();
			await page.screenshot({ path: testInfo.outputPath(`screenshot-permission-${locale}.png`) });
			await setup.press('Escape');
			await expect(setup).toBeHidden();
			await expect(input).toBeFocused();
			await expect.poll(() => composer.evaluate(element => element.isConnected ? element.textContent : '')).toContain('Permission draft');
		} finally {
			await desktop.evaluate(({ systemPreferences, desktopCapturer, shell }, state) => {
				systemPreferences.getMediaAccessStatus = state.original.access;
				desktopCapturer.getSources = state.original.capture;
				shell.openExternal = state.original.open;
			}, state);
			await state.dispose();
			await composer.dispose();
		}
	});

}

test('screenshot shortcut reports occupancy, retains a working global binding and triggers from the background', { tag: ['@electron-app-server'] }, async ({ application, workbench }) => {
	test.skip(process.platform !== 'darwin', 'macOS global screenshot shortcut');
	if (!('browserWindow' in application)) throw new Error('Expected Electron');
	const desktop = application;
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.chat.open');
	const input = page.locator('.ash-chat-input-editor').getByRole('textbox').last();
	await input.focus(); await page.keyboard.insertText('Global capture draft');
	const saved = await desktop.evaluateHandle(({ globalShortcut, shell }) => {
		const originals = { register: globalShortcut.register, unregister: globalShortcut.unregister, isRegistered: globalShortcut.isRegistered, open: shell.openExternal };
		shell.openExternal = async () => { };
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
		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		await expect(workbench.settingsEditor.element).toBeVisible();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('screenshot');
		let settings = page.getByRole('dialog', { name: 'Ash Settings', exact: true });
		const background = settings.getByRole('switch', { name: 'Capture while Ash is in the background', exact: true });
		await expect(background).not.toBeChecked();
		await background.focus();
		await background.press('Space');
		await expect(background).toBeChecked();
		const notifications = page.getByRole('region', { name: 'Notifications', exact: true });
		await expect(notifications).toContainText('The global screenshot shortcut could not be registered.');
		expect(await saved.evaluate(state => state.callbacks.size)).toBe(0);
		await notifications.getByRole('button', { name: 'Change Shortcut', exact: true }).click();
		await expect(settings).toHaveCount(0);
		const shortcuts = page.locator('.ash-keybindings-editor');
		await expect(shortcuts.locator('.ash-keybindings-search input')).toHaveValue('@command:workbench.action.chat.attachScreenshot');
		await expect(shortcuts.locator('.ash-keybindings-search input')).toBeFocused();
		await expect(shortcuts.locator('.ash-keybindings-row')).toHaveCount(1);
		await expect(shortcuts.locator('.ash-keybindings-command-id')).toHaveText('workbench.action.chat.attachScreenshot');

		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		await expect(workbench.settingsEditor.element).toBeVisible();
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
		await expect(settings.locator('[data-settings-item-id="snapshot.screen.shortcut"]')).toContainText('B');
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
		const granted = await desktop.evaluate(({ systemPreferences }) => systemPreferences.getMediaAccessStatus('screen') === 'granted');
		if (granted) {
			const overlay = await screenOverlay(desktop);
			await overlay.keyboard.press('Escape').catch(error => { if (!overlay.isClosed()) throw error; });
		} else {
			const setup = page.getByRole('dialog', { name: 'Set Up Desktop Screenshots', exact: true });
			await expect(setup).toBeVisible();
			await setup.press('Escape');
			await expect(setup).toBeHidden();
		}
		await expect.poll(() => desktop.windows().filter(page => page.url().includes('/imageView/imageView.html')).length).toBe(0);
		await expect(page.locator('.ash-chat-input-editor').last()).toContainText('Global capture draft');
		await uncoverDisplays(desktop, covers); covers = [];

		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		await expect(workbench.settingsEditor.element).toBeVisible();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('screenshot');
		settings = page.getByRole('dialog', { name: 'Ash Settings', exact: true });
		const disableBackground = settings.getByRole('switch', { name: 'Capture while Ash is in the background', exact: true });
		await disableBackground.focus(); await disableBackground.press('Space');
		await expect.poll(() => saved.evaluate(state => state.callbacks.size)).toBe(0);
	} finally {
		if (covers.length) await uncoverDisplays(desktop, covers);
		// Release this contribution's registration before restoring the registry mock.
		await page.evaluate(async () => { await (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:global-keybinding:update', { id: 'chat.screenshot', commandId: 'workbench.action.chat.attachScreenshot', accelerator: '', label: '', global: false }); });
		await desktop.evaluate(({ globalShortcut, shell }, state) => {
			shell.openExternal = state.originals.open;
			globalShortcut.register = state.originals.register; globalShortcut.unregister = state.originals.unregister; globalShortcut.isRegistered = state.originals.isRegistered;
		}, saved);
		await saved.dispose();
	}
});

test('built-in code images annotate and copy in a native window without screen permission', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, workbench }, testInfo) => {
	if (!('browserWindow' in application)) throw new Error('Expected Electron');
	const desktop = application;
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await editor.waitForTypeInEditor('const screenshot = "Built-in image editor";');
	await workbench.page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
	const probe = await desktop.evaluateHandle(({ desktopCapturer, systemPreferences }) => {
		const original = { capture: desktopCapturer.getSources, access: systemPreferences.getMediaAccessStatus };
		const state = { original, calls: 0 };
		desktopCapturer.getSources = async () => { state.calls++; throw new Error('Code images must not acquire desktop pixels'); };
		systemPreferences.getMediaAccessStatus = type => type === 'screen' ? 'denied' : original.access.call(systemPreferences, type);
		return state;
	});
	try {
		await workbench.quickaccess.runCommand('snapshot.code');
		const overlay = await screenOverlay(desktop);
		const frame = overlay;
		const toolbar = frame.getByRole('group', { name: 'Screenshot tools' });
		await expect(toolbar).toBeVisible();
		await expect(toolbar.getByRole('button', { name: 'Retake', exact: true })).toHaveCount(0);
		await expect.poll(() => toolbar.evaluate(element => [...element.ownerDocument.fonts].some(font => font.family.includes('Ash Snapshot Icons') && font.status === 'loaded'))).toBe(true);
		const before = await frame.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
		await toolbar.getByRole('button', { name: 'Arrow', exact: true }).click();
		const bounds = (await frame.locator('canvas').boundingBox())!;
		await overlay.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.4);
		await overlay.mouse.down();
		await overlay.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.6, { steps: 5 });
		await overlay.mouse.up();
		await expect(toolbar.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
		expect(await frame.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())).not.toBe(before);
		const reset = toolbar.getByRole('button', { name: 'Reset annotations', exact: true });
		await reset.focus();
		await reset.press('Enter');
		expect(await frame.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())).toBe(before);
		await expect(frame.getByRole('group', { name: 'Frozen screen and region selection' })).toBeFocused();
		expect(await probe.evaluate(state => state.calls)).toBe(0);
		await overlay.screenshot({ path: testInfo.outputPath('builtin-code-image-annotated.png') });
		await toolbar.getByRole('button', { name: 'Copy', exact: true }).click().catch(error => { if (!overlay.isClosed()) throw error; });
		await expect.poll(() => desktop.windows().filter(page => page.url().includes('/imageView/imageView.html')).length).toBe(0);
		expect(await desktop.evaluate(async ({ clipboard }) => (await clipboard.read()).some(item => item.types.includes('image/png')))).toBe(true);
	} finally {
		await desktop.evaluate(({ desktopCapturer, systemPreferences }, state) => {
			desktopCapturer.getSources = state.original.capture;
			systemPreferences.getMediaAccessStatus = state.original.access;
		}, probe);
		await probe.dispose();
	}
});
