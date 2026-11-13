import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron, type ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';

test.use({ electronWindowMode: 'active' });

test('app window screenshot captures a separate synthetic application and preserves cancellation and the draft', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }, testInfo) => {
	if (!('browserWindow' in application)) throw new Error('Expected Electron');
	const desktop = application;
	const permission = await desktop.evaluate(({ systemPreferences }) => process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted');
	test.skip(permission !== 'granted', 'The test host needs Screen Recording permission to capture its synthetic application.');
	const fixturePath = join(testWorkspace.directory, 'synthetic-app.cjs');
	await writeFile(fixturePath, `const { app, BrowserWindow } = require('electron');
		app.whenReady().then(async () => {
			const window = new BrowserWindow({ width: 600, height: 400, useContentSize: true, show: false, webPreferences: { sandbox: true } });
			await window.loadURL('data:text/html,' + encodeURIComponent('<title>Ash app window capture fixture</title><body style="margin:0;background:rgb(37,99,235);height:100vh;color:white">Synthetic application pixels</body>'));
			window.show();
		});
		app.on('window-all-closed', () => app.quit());`);
	const executablePath = await desktop.evaluate(() => process.execPath);
	let fixture: ElectronApplication | undefined;
	try {
		fixture = await _electron.launch({ executablePath, args: [fixturePath, `--user-data-dir=${join(testWorkspace.directory, 'synthetic-profile')}`], cwd: testWorkspace.directory });
		await (await fixture.firstWindow()).getByText('Synthetic application pixels').waitFor();
		const page = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.chat.open');
		const input = page.locator('.ash-chat-input-editor').getByRole('textbox').last();
		await input.focus(); await page.keyboard.insertText('Keep the app screenshot draft');
		const pickWindow = async () => {
			await workbench.quickaccess.runCommand('workbench.action.chat.pickAppWindowScreenshot');
			const picker = page.getByRole('combobox', { name: 'Select an app window to capture', exact: true });
			await expect(picker).toBeVisible();
			await picker.fill('Ash app window capture fixture');
			await picker.press('Enter');
			await expect.poll(() => desktop.windows().filter(window => window.url().includes('/imageView/imageView.html')).length).toBe(1);
			const overlay = desktop.windows().find(window => window.url().includes('/imageView/imageView.html'))!;
			await expect(overlay.getByRole('dialog', { name: 'Screen Capture', exact: true })).toBeVisible();
			return overlay;
		};
		let overlay = await pickWindow();
		await overlay.keyboard.press('Escape').catch(error => { if (!overlay.isClosed()) throw error; });
		await expect.poll(() => desktop.windows().filter(window => window.url().includes('/imageView/imageView.html')).length).toBe(0);
		await expect(input).toBeFocused();
		await expect(page.locator('.ash-chat-input-editor').last()).toContainText('Keep the app screenshot draft');
		await expect(page.getByRole('button', { name: 'Preview Screenshot', exact: true })).toHaveCount(0);
		overlay = await pickWindow();
		await overlay.getByRole('button', { name: 'Entire screen', exact: true }).click();
		await expect(overlay.getByRole('button', { name: 'Retake', exact: true })).toHaveCount(0);
		await expect(overlay.getByRole('button', { name: 'Reset annotations', exact: true })).toBeVisible();
		const pixels = await overlay.locator('canvas').evaluate(element => {
			const canvas = element as HTMLCanvasElement;
			return { width: canvas.width, height: canvas.height, pixel: [...canvas.getContext('2d')!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data] };
		});
		expect(pixels.width).toBeGreaterThanOrEqual(600);
		expect(pixels.height).toBeGreaterThanOrEqual(400);
		expect(pixels.pixel[2]).toBeGreaterThan(pixels.pixel[0] + 80);
		expect(pixels.pixel[3]).toBe(255);
		await testInfo.attach('synthetic app screenshot editor', { body: await overlay.screenshot(), contentType: 'image/png' });
		await overlay.getByRole('button', { name: 'Add to Chat', exact: true }).click().catch(error => { if (!overlay.isClosed()) throw error; });
		await expect.poll(() => desktop.windows().filter(window => window.url().includes('/imageView/imageView.html')).length).toBe(0);
		await expect(input).toBeFocused();
		await expect(page.locator('.ash-chat-input-editor').last()).toContainText('Keep the app screenshot draft');
		await expect(page.getByRole('button', { name: 'Preview Screenshot', exact: true })).toBeVisible();
	} finally {
		await fixture?.close();
	}
});

test('app window screenshot permission and capture IPC reject unexpected window authority', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, workbench }) => {
	if (!('browserWindow' in application)) throw new Error('Expected Electron');
	const page = workbench.page;
	const ownIds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.getMediaSourceId()));
	const result = await page.evaluate(async () => {
		const host = (globalThis as unknown as { ash: ISandboxGlobals; }).ash;
		const windows = await host.ipcRenderer.invoke('ash:native-host:app-windows');
		let rejected = false;
		try { await host.ipcRenderer.invoke('ash:native-host:capture-app-window', { sourceId: 'window:0:0', title: 'Unlisted window' }); } catch { rejected = true; }
		return { windows: windows as { kind: string; windows?: { sourceId: string; }[]; }, rejected };
	});
	expect(result.rejected).toBe(true);
	expect(['windows', 'permissionRequired']).toContain(result.windows.kind);
	for (const window of result.windows.windows ?? []) expect(ownIds).not.toContain(window.sourceId);
});

test('frozen app pixels cross the native editor without desktop capture permission', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, workbench }) => {
	if (!('browserWindow' in application)) throw new Error('Expected Electron');
	const desktop = application;
	const probe = await desktop.evaluateHandle(({ desktopCapturer, systemPreferences }) => {
		const capture = desktopCapturer.getSources;
		const permission = systemPreferences.getMediaAccessStatus;
		const state = { captures: 0, permissionChecks: 0, restore() { desktopCapturer.getSources = capture; systemPreferences.getMediaAccessStatus = permission; } };
		desktopCapturer.getSources = async () => { state.captures++; throw new Error('Frozen image must not acquire desktop pixels'); };
		systemPreferences.getMediaAccessStatus = type => { if (type === 'screen') state.permissionChecks++; return permission.call(systemPreferences, type); };
		return state;
	});
	try {
		await workbench.page.evaluate(async () => {
			const host = (globalThis as unknown as { ash: ISandboxGlobals; }).ash;
			const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 96;
			const context = canvas.getContext('2d')!; context.fillStyle = '#2563eb'; context.fillRect(0, 0, canvas.width, canvas.height);
			const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
			const image = new Uint8Array(await blob.arrayBuffer());
			const html = `<body><canvas></canvas><button>Attach frozen image</button><script>
				let image;
				addEventListener('message', async event => {
					if (event.source !== parent || event.data.type !== 'initialize') return;
					image = event.data.image;
					const bitmap = await createImageBitmap(new Blob([image], { type: 'image/png' }));
					const canvas = document.querySelector('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
					canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
					parent.postMessage({ type: 'ready' }, '*');
				});
				document.querySelector('button').onclick = () => parent.postMessage({ type: 'complete', result: { kind: 'attach', image } }, '*');
				parent.postMessage({ type: 'initialize' }, '*');
			</script>`;
			(globalThis as unknown as { frozenAppResult: Promise<unknown>; }).frozenAppResult = host.ipcRenderer.invoke('ash:image-view:open', {
				id: crypto.randomUUID(), title: 'Synthetic frozen app image', source: 'image', image, html, input: {},
			});
		});
		await expect.poll(() => desktop.windows().filter(window => window.url().includes('/imageView/imageView.html')).length).toBe(1);
		const overlay = desktop.windows().find(window => window.url().includes('/imageView/imageView.html'))!;
		const frame = overlay.frameLocator('iframe');
		await expect(frame.getByRole('button', { name: 'Attach frozen image' })).toBeVisible();
		await expect.poll(() => frame.locator('canvas').evaluate(element => {
			const canvas = element as HTMLCanvasElement;
			return [canvas.width, canvas.height, ...canvas.getContext('2d')!.getImageData(80, 48, 1, 1).data];
		})).toEqual([160, 96, 37, 99, 235, 255]);
		await frame.getByRole('button', { name: 'Attach frozen image' }).click().catch(error => { if (!overlay.isClosed()) throw error; });
		const signature = await workbench.page.evaluate(async () => [...((await (globalThis as unknown as { frozenAppResult: Promise<Uint8Array>; }).frozenAppResult)).slice(0, 8)]);
		expect(signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		expect(await probe.evaluate(state => ({ captures: state.captures, permissionChecks: state.permissionChecks }))).toEqual({ captures: 0, permissionChecks: 0 });
	} finally {
		await probe.evaluate(state => state.restore());
		await probe.dispose();
	}
});

test('app screenshot setup rechecks permissions, preserves the draft, and does not capture on setup', { tag: ['@electron-app-server'] }, async ({ application, workbench }, testInfo) => {
	test.skip(process.platform !== 'darwin', 'macOS Screen Recording setup');
	if (!('browserWindow' in application)) throw new Error('Expected Electron');
	const desktop = application;
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.chat.open');
	const input = page.locator('.ash-chat-input-editor').getByRole('textbox').last();
	await input.focus(); await page.keyboard.insertText('Keep the permission setup draft');
	const probe = await desktop.evaluateHandle(({ systemPreferences, desktopCapturer, shell }) => {
		const original = { access: systemPreferences.getMediaAccessStatus, capture: desktopCapturer.getSources, open: shell.openExternal };
		const state = { permission: 'denied' as 'denied' | 'restricted' | 'granted', captures: 0, opened: [] as string[], restore() { systemPreferences.getMediaAccessStatus = original.access; desktopCapturer.getSources = original.capture; shell.openExternal = original.open; } };
		systemPreferences.getMediaAccessStatus = type => type === 'screen' ? state.permission : original.access.call(systemPreferences, type);
		desktopCapturer.getSources = async () => { state.captures++; throw new Error('The fixture denies acquisition'); };
		shell.openExternal = async url => { state.opened.push(url); };
		return state;
	});
	try {
		await workbench.quickaccess.runCommand('workbench.action.chat.attachAppWindowScreenshot');
		const dialog = page.getByRole('dialog', { name: 'Attach Screenshots of Other Apps', exact: true });
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('Screen Recording: Not allowed');
		await dialog.getByRole('button', { name: 'Check Again', exact: true }).focus();
		await page.keyboard.press('Alt+F1');
		await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Returning from System Settings checks permission again/);
		await page.keyboard.press('Escape');
		await expect(dialog.getByRole('button', { name: 'Check Again', exact: true })).toBeFocused();
		await expect(dialog.getByRole('button', { name: 'Restart Ash', exact: true })).toBeHidden();
		expect(await probe.evaluate(state => state.captures)).toBe(0);
		const owner = await desktop.browserWindow(page);
		try {
			await owner.evaluate(window => {
				window.webContents.send('ash:global-keybinding:trigger', { id: 'chat.appWindowScreenshot' });
				window.webContents.send('ash:global-keybinding:trigger', { id: 'chat.appWindowScreenshot' });
			});
			await expect(dialog).toHaveCount(1);
			await dialog.getByRole('button', { name: 'Allow in Settings', exact: true }).click();
			await expect.poll(() => probe.evaluate(state => state.opened)).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
			// System Settings itself is mocked; drive its corresponding browser focus boundary too.
			await page.evaluate(async () => {
				const original = document.hasFocus;
				try {
					document.hasFocus = () => false;
					window.dispatchEvent(new Event('blur'));
					await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
				} finally { document.hasFocus = original; }
				window.dispatchEvent(new Event('focus'));
			});
			await expect(dialog.getByRole('button', { name: 'Restart Ash', exact: true })).toBeVisible();
			await expect(dialog).toContainText('restart Ash to apply it');
			await page.screenshot({ path: testInfo.outputPath('app-window-screenshot-setup.png') });
			await probe.evaluate(state => { state.permission = 'granted'; });
			await dialog.getByRole('button', { name: 'Check Again', exact: true }).click();
			await expect(dialog).toBeHidden();
			await expect(input).toBeFocused();
			await expect(page.locator('.ash-chat-input-editor').last()).toContainText('Keep the permission setup draft');
			expect(desktop.windows().filter(window => window.url().includes('/imageView/imageView.html'))).toHaveLength(0);
			await probe.evaluate(state => { state.permission = 'restricted'; });
			await workbench.quickaccess.runCommand('workbench.action.chat.attachAppWindowScreenshot');
			await expect(dialog).toContainText('Screen Recording: Restricted');
			await expect(dialog.getByRole('button', { name: 'Allow in Settings', exact: true })).toBeHidden();
			await expect(dialog.getByRole('button', { name: 'Restart Ash', exact: true })).toBeHidden();
			await dialog.press('Escape');
			await expect(input).toBeFocused();
		} finally { await owner.dispose(); }
	} finally { await probe.evaluate(state => state.restore()); await probe.dispose(); }
});

test('pasted images show the app screenshot hint once across Desktop and Agents', { tag: ['@electron-app-server'] }, async ({ application, workbench, target }, testInfo) => {
	await workbench.quickaccess.runCommand('workbench.action.chat.open');
	const paste = async (page: import('@playwright/test').Page) => {
		const input = page.locator('.ash-chat-input-editor').getByRole('textbox').last();
		await input.focus();
		await input.evaluate(async element => {
			const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20;
			const context = canvas.getContext('2d')!; context.fillStyle = '#2563eb'; context.fillRect(0, 0, 20, 20);
			const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
			const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'synthetic-hint.png', { type: 'image/png' }));
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
		});
		await expect(page.getByRole('region', { name: 'Chat message', exact: true }).getByRole('button', { name: 'Preview synthetic-hint.png', exact: true })).toBeVisible();
	};
	await paste(workbench.page);
	const hint = workbench.page.locator('.ash-app-window-screenshot-hint');
	await installMainChannelTestClient(workbench.page);
	try { await expect(hint).toBeVisible(); }
	catch (error) {
		const evidence = await workbench.page.evaluate(async () => {
			await globalThis.ashTestMainProcess.call('logger', 'flush');
			const files = await globalThis.ashTestMainProcess.call<{ id: string; }[]>('logger', 'list');
			const logs = await Promise.all(files.map(file => globalThis.ashTestMainProcess.call<{ text: string; }>('logger', 'read', { id: file.id })));
			const storage = await globalThis.ashTestMainProcess.call<{ entries: Record<string, unknown>; }>('storage', 'getItems', { identity: { scope: 'application', id: 'application' } });
			return { logs: logs.map(log => log.text.split('\n').filter(line => /screenshot|chatUserImage/i.test(line))), state: Object.fromEntries(Object.entries(storage.entries).filter(([key]) => /screenshot/.test(key))) };
		});
		console.log('App screenshot hint diagnostics:', JSON.stringify(evidence));
		await testInfo.attach('hint-diagnostics', { body: JSON.stringify(evidence), contentType: 'application/json' });
		throw error;
	}
	const input = workbench.page.locator('.ash-chat-input-editor').last();
	const hintBounds = (await hint.boundingBox())!; const inputBounds = (await input.boundingBox())!;
	expect(hintBounds.y + hintBounds.height).toBeLessThanOrEqual(inputBounds.y);
	for (const [theme, id] of [['Ash Light', 'ash-light'], ['Ash Dark', 'ash-dark'], ['Ash High Contrast Dark', 'ash-high-contrast-dark'], ['Ash High Contrast Light', 'ash-high-contrast-light']]) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const search = workbench.page.locator('.ash-quick-pick').getByRole('combobox');
		await search.fill(theme);
		await search.press('Enter');
		await expect(workbench.page.locator('#app')).toHaveAttribute('data-color-theme', id);
		await expect(hint).toBeVisible();
		expect(await hint.evaluate(element => {
			const bounds = element.getBoundingClientRect();
			return [...element.querySelectorAll('button')].every(button => {
				const rect = button.getBoundingClientRect();
				return rect.left >= bounds.left && rect.right <= bounds.right;
			});
		})).toBe(true);
		await workbench.page.screenshot({ path: testInfo.outputPath(`app-window-screenshot-hint-${id}.png`) });
	}
	await hint.getByRole('button', { name: 'Dismiss', exact: true }).focus();
	await hint.press('Escape');
	await expect(hint).toHaveCount(0);
	const agents = await workbench.openAgentsWindow(target.kind);
	await paste(agents);
	await expect(agents.locator('.ash-app-window-screenshot-hint')).toHaveCount(0);
	await agents.screenshot({ path: testInfo.outputPath('app-window-hint-once-agents.png') });
});
