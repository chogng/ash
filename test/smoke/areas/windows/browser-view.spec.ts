import { createServer } from 'node:http';
import type { ElectronApplication } from '@playwright/test';
import type { ISandboxGlobals } from "../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js";
import { decodeAppServerServerRequestResult } from '../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { expect, test } from '../../../automation/test.js';
interface BrowserPrompt { options: Electron.MessageBoxOptions; respond: (result: Electron.MessageBoxReturnValue) => void; }

import type { IBrowserViewInfo } from '../../../../src/ash/platform/browserView/common/browserView.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserNetworkToken, installBrowserNetworkPolicy } from '../../../automation/browserNetwork.js';
import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';

test.beforeEach(async ({ target, workbench }) => {
	if (target.kind === 'electron') { await installMainChannelTestClient(workbench.page); }
});

test('agent network authorizes subresources, rejects WebSocket and redirects and releases authority after the tool', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron', 'Request enforcement belongs to Chromium');
	const deniedRequests: string[] = [];
	const denied = createServer((request, response) => { deniedRequests.push(request.url!); response.end('blocked'); });
	await new Promise<void>(resolve => denied.listen(0, '127.0.0.1', resolve));
	const deniedAddress = denied.address();
	if (!deniedAddress || typeof deniedAddress === 'string') { throw new Error('Missing denied endpoint'); }
	const deniedUrl = `http://127.0.0.1:${deniedAddress.port}/`;
	const requests: string[] = [];
	const sockets = new Set<Socket>();
	let upgraded = 0;
	let finishImage: (() => void) | undefined;
	const origin = createServer((request, response) => {
		requests.push(request.url!);
		if (request.url === '/redirect') { response.writeHead(302, { Location: deniedUrl }); response.end(); return; }
		if (request.url === '/data') { response.end('allowed-data'); return; }
		if (request.url === '/image') {
			finishImage = () => { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); };
			return;
		}
		response.setHeader('Content-Type', 'text/html');
		response.end(`<title>Agent network</title><img src="/image"><script>
		fetch('/data').then(r => r.text()).then(value => window.data = value);
		window.socket = new WebSocket('ws://' + location.host + '/socket');
		</script>`);
	});
	origin.on('upgrade', (request, socket) => {
		const connection = socket as Socket;
		sockets.add(connection); connection.once('close', () => sockets.delete(connection));
		const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
		connection.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		upgraded++;
	});
	await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
	const address = origin.address();
	if (!address || typeof address === 'string') { throw new Error('Missing allowed endpoint'); }
	const url = `http://127.0.0.1:${address.port}/`;
	const electron = application as ElectronApplication;
	const page = workbench.page;
	const call = (method: string, params: Record<string, unknown>) => page.evaluate(({ method, params }) => {
		return globalThis.ashTestMainProcess.call('browserHost', method, { id: crypto.randomUUID(), params });
	}, { method, params: { threadId: 'network-test-thread', ...(method === 'close' ? {} : { networkToken: browserNetworkToken }), ...params } });
	try {
		await installBrowserNetworkPolicy(electron, url);
		const pending = call('create', { url });
		await expect.poll(() => ({ image: !!finishImage, data: requests.includes('/data') })).toEqual({ image: true, data: true });
		finishImage!();
		finishImage = undefined;
		const created = decodeAppServerServerRequestResult('browser/create', await pending);
		await expect.poll(() => sockets.size).toBe(0);
		expect(upgraded).toBe(0);
		expect(await electron.evaluate(async ({ BrowserWindow }, url) => {
			const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView;
			return view.webContents.executeJavaScript("fetch('/after-tool').then(() => 'allowed', () => 'denied')");
		}, url)).toBe('denied');
		expect(requests).not.toContain('/after-tool');
		await expect(call('perform', { action: { type: 'navigate', targetId: created.targetId, url: `${url}redirect` } })).rejects.toThrow();
		expect(deniedRequests).toEqual([]);
		await call('close', { targetId: created.targetId });
	} finally {
		finishImage?.();
		for (const socket of sockets) { socket.destroy(); }
		origin.closeAllConnections(); denied.closeAllConnections();
		await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())), new Promise<void>(resolve => denied.close(() => resolve()))]);
	}
});

test('downloads report completion and cancellation and closing a page releases the active download', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.kind !== 'electron', 'Downloads belong to the desktop page session');
	const server = createServer((request, response) => {
		if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Download fixture</title>'); return; }
		response.setHeader('Content-Disposition', `attachment; filename="${request.url === '/complete' ? 'completed.txt' : 'pending.txt'}"`);
		response.setHeader('Content-Type', 'application/octet-stream');
		if (request.url === '/complete') { response.end('downloaded content'); return; }
		response.setHeader('Content-Length', '1048576'); response.write('pending content');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const endpoint = server.address();
	if (!endpoint || typeof endpoint === 'string') throw new Error('Missing download endpoint');
	const url = `http://127.0.0.1:${endpoint.port}/`;
	const electron = application as ElectronApplication;
	const page = workbench.page;
	try {
		await workbench.quickaccess.runCommand('ash.browser.open');
		const editor = page.locator('.ash-browser-editor');
		const address = editor.getByRole('textbox', { name: 'Browser address' });
		await address.fill(url); await address.press('Enter');
		await expect(editor.getByRole('status')).toHaveText('Download fixture');
		const start = (path: string, filename: string) => electron.evaluate(async ({ BrowserWindow }, { url, path, filename }) => {
			const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView;
			// Simulate choosing the test directory in Electron's save-location dialog.
			view.webContents.session.once('will-download', (_event, item) => {
				item.setSavePath(filename);
				(globalThis as unknown as { browserDownloadState: string; }).browserDownloadState = 'progressing';
				item.once('done', (_event, state) => { (globalThis as unknown as { browserDownloadState: string; }).browserDownloadState = state; });
			});
			await view.webContents.executeJavaScript(`(() => { const link = document.createElement('a'); link.href = ${JSON.stringify(path)}; link.click(); })()`, true);
		}, { url, path, filename });
		const filename = join(testWorkspace.directory, 'completed.txt');
		await start('/complete', filename);
		const progress = editor.getByRole('status', { name: 'Downloads', exact: true });
		await expect(progress).toHaveText(/bytes \(completed\)$/);
		expect(await readFile(filename, 'utf8')).toBe('downloaded content');
		await start('/pending', join(testWorkspace.directory, 'pending.txt'));
		await expect(progress).toContainText('downloading');
		await workbench.menus.select(application, () => editor.getByRole('button', { name: 'More Actions', exact: true }).click(), ['Cancel downloads']);
		await expect(progress).toContainText('cancelled');
		await start('/pending', join(testWorkspace.directory, 'closed.txt'));
		await expect(progress).toContainText('downloading');
		await page.getByRole('button', { name: 'Close Download fixture', exact: true }).click();
		await expect.poll(() => electron.evaluate(() => (globalThis as unknown as { browserDownloadState: string; }).browserDownloadState)).toBe('cancelled');
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test('website permission dialogs allow, remember, reset and deny the requesting site', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron', 'Website permissions belong to the desktop page session');
	const server = createServer((_request, response) => {
		response.setHeader('Content-Type', 'text/html');
		response.end('<title>Permission fixture</title>');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const endpoint = server.address();
	if (!endpoint || typeof endpoint === 'string') throw new Error('Missing fixture endpoint');
	const url = `http://127.0.0.1:${endpoint.port}/`;
	const electron = application as ElectronApplication;
	const page = workbench.page;
	const original = await electron.evaluateHandle(({ dialog }) => dialog.showMessageBox);
	await electron.evaluate(({ dialog }) => {
		const prompts: BrowserPrompt[] = [];
		(globalThis as unknown as { browserPrompts: BrowserPrompt[]; }).browserPrompts = prompts;
		dialog.showMessageBox = ((...args: [Electron.MessageBoxOptions] | [Electron.BrowserWindow, Electron.MessageBoxOptions]) => new Promise<Electron.MessageBoxReturnValue>(respond => prompts.push({ options: args.at(-1) as Electron.MessageBoxOptions, respond }))) as typeof dialog.showMessageBox;
	});
	const prompt = () => electron.evaluate(() => (globalThis as unknown as { browserPrompts: BrowserPrompt[]; }).browserPrompts.map(item => item.options));
	const answer = (response: number) => electron.evaluate((_electron, response) => (globalThis as unknown as { browserPrompts: BrowserPrompt[]; }).browserPrompts.shift()!.respond({ response, checkboxChecked: false }), response);
	try {
		await workbench.quickaccess.runCommand('ash.browser.open');
		const editor = page.locator('.ash-browser-editor');
		const location = editor.getByRole('textbox', { name: 'Browser address' });
		await location.fill(url); await location.press('Enter');
		await expect(editor.getByRole('status')).toHaveText('Permission fixture');
		const ask = () => electron.evaluate(({ BrowserWindow }, url) => {
			const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView;
			void view.webContents.executeJavaScript("Notification.requestPermission().then(value => document.title = 'Permission ' + value)", true);
		}, url);
		await ask();
		await expect.poll(prompt).toMatchObject([{ title: 'Website permission', message: expect.stringContaining(new URL(url).origin), buttons: ['Allow', 'Deny'] }]);
		expect((await prompt())[0]!.message).toContain('notifications');
		await answer(0);
		await expect(editor.getByRole('status')).toHaveText('Permission granted');
		await ask();
		expect(await prompt()).toEqual([]);
		await workbench.menus.select(application, () => editor.getByRole('button', { name: 'More Actions', exact: true }).click(), ['Reset all website permissions']);
		await ask();
		await expect.poll(prompt).toHaveLength(1);
		await answer(1);
		await expect(editor.getByRole('status')).toHaveText('Permission denied');
		await page.getByRole('button', { name: 'Close Permission denied', exact: true }).click();
	} finally {
		await electron.evaluate(({ dialog }, original) => { dialog.showMessageBox = original; }, original);
		await original.dispose();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test('sharing a user page exposes only that page to the chosen thread and revocation retains the page', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron', 'Page sharing requires a desktop browser host');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.browser.open');
	const info = await page.evaluate(async () => {
		const views = await (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:browser-view:list') as IBrowserViewInfo[];
		return views.find(view => view.owner.type === 'user')!;
	});
	const call = (method: string, params: Record<string, unknown>) => page.evaluate(({ method, params }) => {
		return globalThis.ashTestMainProcess.call('browserHost', method, { id: crypto.randomUUID(), params });
	}, { method, params: ['create', 'observe', 'perform'].includes(method) ? { networkToken: browserNetworkToken, ...params } : params });
	const observe = { threadId: 'share-test-thread', targetId: info.id, includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false };
	await expect(call('observe', observe)).rejects.toThrow(/BrowserTargetAccessDenied/);
	await call('sharing', { targetId: info.id, threadIds: ['share-test-thread'] });
	expect(decodeAppServerServerRequestResult('browser/observe', await call('observe', observe)).targetId).toBe(info.id);
	await expect(call('perform', { threadId: observe.threadId, action: { type: 'reload', targetId: info.id } })).rejects.toThrow(/BrowserNetworkIsolationRequired/);
	await expect(call('close', { threadId: observe.threadId, targetId: info.id })).rejects.toThrow(/BrowserNetworkIsolationRequired/);
	await expect(call('observe', { ...observe, threadId: 'another-thread' })).rejects.toThrow(/BrowserTargetAccessDenied/);
	if (target.appServerMode === 'required') {
		const electron = application as ElectronApplication;
		const original = await electron.evaluateHandle(({ dialog }) => dialog.showMessageBox);
		await electron.evaluate(({ dialog }) => {
			const prompts: BrowserPrompt[] = [];
			(globalThis as unknown as { browserPrompts: BrowserPrompt[]; }).browserPrompts = prompts;
			dialog.showMessageBox = ((...args: [Electron.MessageBoxOptions] | [Electron.BrowserWindow, Electron.MessageBoxOptions]) => new Promise<Electron.MessageBoxReturnValue>(respond => prompts.push({ options: args.at(-1) as Electron.MessageBoxOptions, respond }))) as typeof dialog.showMessageBox;
		});
		try {
			await workbench.menus.select(application, () => page.locator('.ash-browser-editor').getByRole('button', { name: 'More Actions', exact: true }).click(), ['Share with Agent']);
			await expect.poll(() => electron.evaluate(() => (globalThis as unknown as { browserPrompts: BrowserPrompt[]; }).browserPrompts.map(prompt => prompt.options))).toMatchObject([{ title: 'Share with Agent', detail: 'This page is currently shared.', buttons: ['Revoke all access', 'Cancel'] }]);
			await electron.evaluate(() => (globalThis as unknown as { browserPrompts: BrowserPrompt[]; }).browserPrompts.shift()!.respond({ response: 0, checkboxChecked: false }));
			await expect(page.locator('.ash-browser-editor').getByRole('status')).toHaveText('This page is private.');
		} finally {
			await electron.evaluate(({ dialog }, original) => { dialog.showMessageBox = original; }, original);
			await original.dispose();
		}
	} else {
		await call('sharing', { targetId: info.id, threadIds: [] });
	}
	await expect(call('observe', observe)).rejects.toThrow(/BrowserTargetAccessDenied/);
	await expect(page.getByRole('tab', { name: 'Browser', exact: true })).toHaveCount(1);
	await page.getByRole('button', { name: 'Close Browser', exact: true }).click();
});

test('browser automation runs in one separate process and its crash retains manually usable pages', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron', 'The integrated browser is a desktop capability');
	const electron = application as ElectronApplication;
	const page = workbench.page;
	const invoke = (method: string, params: Record<string, unknown>) => page.evaluate(({ method, params }) => {
		return globalThis.ashTestMainProcess.call('browserHost', method, { id: crypto.randomUUID(), params: { threadId: 'crash-test-thread', ...params } });
	}, { method, params: ['create', 'observe', 'perform'].includes(method) ? { networkToken: browserNetworkToken, ...params } : params });
	const created = decodeAppServerServerRequestResult('browser/create', await invoke('create', { url: 'about:blank' }));
	const options = { targetId: created.targetId, includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot: false };
	await invoke('observe', options);
	const processes = await electron.evaluate(({ app }) => ({ main: process.pid, workers: app.getAppMetrics().filter(metric => metric.name === 'Ash Browser Automation').map(metric => metric.pid) }));
	expect(processes.workers).toHaveLength(1);
	expect(processes.workers[0]).not.toBe(processes.main);
	await electron.evaluate((_electron, pid) => process.kill(pid), processes.workers[0]!);
	await expect.poll(() => electron.evaluate(({ BrowserWindow }) => {
		const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child) as Electron.WebContentsView;
		return view.webContents.debugger.isAttached();
	})).toBe(false);
	await expect(invoke('observe', options)).rejects.toThrow(/IPC connection closed/);
	await expect(page.getByRole('tab', { name: 'Browser', exact: true })).toHaveCount(1);
	const contentsId = await electron.evaluate(async ({ BrowserWindow }) => {
		const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child) as Electron.WebContentsView;
		await view.webContents.executeJavaScript('window.manualProbe = true');
		return view.webContents.id;
	});
	const address = page.locator('.ash-browser-editor').getByRole('textbox', { name: 'Browser address' });
	await address.fill('about:blank'); await address.press('Enter');
	await expect.poll(() => electron.evaluate(async ({ webContents }, contentsId) => {
		return webContents.fromId(contentsId)!.executeJavaScript('Object.hasOwn(window, "manualProbe")');
	}, contentsId)).toBe(false);
	await invoke('close', { targetId: created.targetId });
	await expect(page.locator('.ash-browser-editor')).toHaveCount(0);
});

test('desktop browser retains a live page through renderer reload and restores workspace login after restart', async ({ target, application, workbench, reloadWorkbench }) => {
	test.skip(target.kind !== 'electron', 'The integrated browser is a desktop capability');
	const cookies: string[] = [];
	const server = createServer((request, response) => {
		cookies.push(request.headers.cookie ?? '');
		response.setHeader('Content-Type', 'text/html');
		response.end('<title>Restored browser</title><input aria-label="Saved input">');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') { throw new Error('Missing fixture endpoint'); }
	const url = `http://127.0.0.1:${address.port}/`;
	try {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('ash.browser.open');
		const location = page.locator('.ash-browser-editor').getByRole('textbox', { name: 'Browser address' });
		await location.fill(url); await location.press('Enter');
		await expect(page.getByRole('tab', { name: 'Restored browser', exact: true })).toBeVisible();
		const contentsId = await (application as ElectronApplication).evaluate(async ({ BrowserWindow }, url) => {
			const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView;
			await view.webContents.executeJavaScript("document.cookie = 'browser_login=retained; Max-Age=3600; path=/'; document.querySelector('input').value = 'Unsubmitted input';");
			return view.webContents.id;
		}, url);
		await workbench.reloadWindow();
		await expect(page.getByRole('tab', { name: 'Restored browser', exact: true })).toHaveCount(1);
		const retained = await (application as ElectronApplication).evaluate(async ({ BrowserWindow }, url) => {
			const views = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView[];
			return { ids: views.map(view => view.webContents.id), value: await views[0]!.webContents.executeJavaScript("document.querySelector('input').value") };
		}, url);
		expect(retained).toEqual({ ids: [contentsId], value: 'Unsubmitted input' });
		const restarted = await reloadWorkbench();
		await expect(restarted.workbench.page.getByRole('tab', { name: 'Restored browser', exact: true })).toHaveCount(1);
		await expect.poll(() => cookies.at(-1)).toContain('browser_login=retained');
		await restarted.workbench.page.getByRole('button', { name: 'Close Restored browser', exact: true }).click();
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test('desktop browser agent observes loaded pages, edits fields and follows navigation', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron', 'The integrated browser is a desktop capability');
	const server = createServer((request, response) => {
		response.setHeader('Content-Type', 'text/html');
		if (request.url === '/next') {
			response.end('<title>Agent destination</title><h1>Navigation completed</h1>');
			return;
		}
		response.end('<title>Agent fixture</title><input aria-label="Editable field"><input aria-label="Read-only field" readonly value="Original value"><a href="/next">Continue</a>');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') { throw new Error('Missing fixture endpoint'); }
	const url = `http://127.0.0.1:${address.port}/`;
	const page = workbench.page;
	const electron = application as ElectronApplication;
	const hostCall = (method: string, params: Record<string, unknown>) => page.evaluate(({ method, params }) => {
		return globalThis.ashTestMainProcess.call('browserHost', method, { id: crypto.randomUUID(), params: { threadId: 'browser-smoke-thread', ...params } });
	}, { method, params: ['create', 'observe', 'perform'].includes(method) ? { networkToken: browserNetworkToken, ...params } : params });
	try {
		await installBrowserNetworkPolicy(electron, url);
		const created = decodeAppServerServerRequestResult('browser/create', await hostCall('create', { url }));
		await expect(hostCall('observe', { threadId: 'other-thread', targetId: created.targetId, includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot: false })).rejects.toThrow(/BrowserTargetAccessDenied/);
		const observe = async (includeScreenshot = false) => decodeAppServerServerRequestResult('browser/observe', await hostCall('observe', { targetId: created.targetId, includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot }));
		const initial = await observe(true);
		expect({ url: initial.url, title: initial.title, loading: initial.loading }).toEqual({ url, title: 'Agent fixture', loading: false });
		expect(Buffer.from(initial.screenshot!.dataBase64, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		const tree = JSON.parse(initial.accessibilityTree!) as { nodes: { role?: { value: string; }; name?: { value: string; }; backendDOMNodeId?: number; }[]; };
		const nodeId = (role: string, name: string): string => {
			const node = tree.nodes.find(node => node.role?.value === role && node.name?.value === name);
			if (!node?.backendDOMNodeId) { throw new Error(`Missing observed element: ${name}`); }
			return String(node.backendDOMNodeId);
		};
		await hostCall('perform', { action: { type: 'typeText', targetId: created.targetId, target: { type: 'element', target: { nodeId: nodeId('textbox', 'Editable field') } }, text: 'Agent input' } });
		await expect(hostCall('perform', { action: { type: 'typeText', targetId: created.targetId, target: { type: 'element', target: { nodeId: nodeId('textbox', 'Read-only field') } }, text: 'Wrong field' } })).rejects.toThrow(/BrowserNodeNotEditable/);
		const edited = await observe();
		expect(edited.accessibilityTree).toContain('Agent input');
		expect(edited.accessibilityTree).toContain('Original value');
		expect(edited.accessibilityTree).not.toContain('Wrong field');
		await hostCall('perform', { action: { type: 'click', targetId: created.targetId, target: { nodeId: nodeId('link', 'Continue') } } });
		const destination = await observe();
		expect({ url: destination.url, title: destination.title, loading: destination.loading }).toEqual({ url: `${url}next`, title: 'Agent destination', loading: false });
		await hostCall('perform', { action: { type: 'goBack', targetId: created.targetId } });
		expect((await observe()).title).toBe('Agent fixture');
		await hostCall('perform', { action: { type: 'reload', targetId: created.targetId } });
		expect((await observe()).title).toBe('Agent fixture');
		const navigation = hostCall('perform', { action: { type: 'navigate', targetId: created.targetId, url: `${url}next` } });
		const queuedObservation = observe();
		await navigation;
		expect((await queuedObservation).title).toBe('Agent destination');
		await hostCall('close', { targetId: created.targetId });
		await expect(page.getByRole('tab', { name: 'Agent destination', exact: true })).toHaveCount(0);
		await expect.poll(() => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(view => 'webContents' in view).length)).toBe(0);
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

for (const locale of ['en', 'zh-CN']) {
	test(`desktop BrowserView navigation and accessibility stay usable in ${locale}`, async ({ target, application: initialApplication, workbench: initialWorkbench, restartWorkbench }, testInfo) => {
		test.skip(target.kind !== 'electron', 'The integrated browser is a desktop capability');
		let application = initialApplication;
		let workbench = initialWorkbench;
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('layout');
		await workbench.settingsEditor.element.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
		await workbench.page.getByRole('option', { name: 'Custom', exact: true }).click();
		await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
			await picker.getByRole('combobox').fill('简体中文');
			await picker.getByRole('combobox').press('Enter');
			({ application, workbench } = await restartWorkbench());
		}
		const labels = locale === 'zh-CN' ? {
			toolbar: '浏览器导航', address: '浏览器地址', webpage: '网页。按 F6 返回地址栏。', back: '后退', forward: '前进', reload: '重新加载', stop: '停止', go: '转到', help: '帮助',
			loading: '正在加载网页…', failure: '无法加载页面：', helpTitle: '浏览器无障碍帮助', accessibleViewTitle: '无障碍帮助', helpText: '网页使用浏览器的无障碍树。', pageActions: ['分享给 Agent', '重置所有网站权限', '取消下载'],
		} : {
			toolbar: 'Browser navigation', address: 'Browser address', webpage: 'Webpage. Press F6 to return to the address field.', back: 'Back', forward: 'Forward', reload: 'Reload', stop: 'Stop', go: 'Go', help: 'Help',
			loading: 'Loading page…', failure: 'Unable to load page:', helpTitle: 'Browser accessibility help', accessibleViewTitle: 'Accessibility Help', helpText: 'Webpages use the browser’s accessibility tree.', pageActions: ['Share with Agent', 'Reset all website permissions', 'Cancel downloads'],
		};
		let finishSlowLoad: (() => void) | undefined;
		const server = createServer((request, response) => {
			if (request.url === '/slow') {
				finishSlowLoad = () => response.end('<title>Stopped page</title>');
				return;
			}
			if (request.url === '/failed') { request.socket.destroy(); return; }
			response.setHeader('Content-Type', 'text/html');
			response.end('<title>Navigation page</title><input aria-label="Page keyboard input"><button onclick="document.title = \'Keyboard action\'">Page action</button>');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Missing fixture endpoint'); }
		const url = `http://127.0.0.1:${address.port}/`;
		const electron = application as ElectronApplication;
		const page = workbench.page;
		try {
			await installBrowserNetworkPolicy(electron, url);
			await workbench.quickaccess.runCommand('ash.browser.open');
			const editor = page.locator('.ash-browser-editor');
			await expect(editor).toBeVisible();
			await expect(editor.getByRole('toolbar', { name: labels.toolbar, exact: true })).toBeVisible();
			await expect(editor.locator('.ash-browser-viewport')).toHaveAttribute('aria-label', labels.webpage);
			const addressField = editor.getByRole('textbox', { name: labels.address, exact: true });
			for (const name of [labels.back, labels.forward, labels.reload, labels.go, labels.help]) {
				await expect(editor.getByRole('button', { name, exact: true })).toBeVisible();
			}
			await addressField.fill(url);
			await addressField.press('Enter');
			await expect(editor.getByRole('status')).toHaveText('Navigation page');
			const hostWindow = await electron.browserWindow(page);
			for (const [size, width] of [['normal', 1200], ['narrow', 800]] as const) {
				await hostWindow.evaluate((window, width) => window.setSize(width, 800), width);
				await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
				const geometry = await editor.locator('.ash-browser-toolbar').evaluate(toolbar => {
					const bounds = toolbar.getBoundingClientRect();
					const controls = [toolbar.querySelector('input')!, ...toolbar.querySelectorAll('button')];
					const rectangles = controls.map(control => control.getBoundingClientRect());
					return {
						toolbarWidth: bounds.width, addressWidth: rectangles[0]!.width,
						contained: rectangles.every(rect => rect.width > 0 && rect.height > 0 && rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom),
						nonOverlapping: rectangles.every((rect, index) => rectangles.slice(index + 1).every(other => rect.right <= other.left || other.right <= rect.left || rect.bottom <= other.top || other.bottom <= rect.top)),
						unobscured: controls.every((control, index) => {
							const rect = rectangles[index]!;
							const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
							return target !== null && control.contains(target);
						}),
						singleLine: [...toolbar.querySelectorAll('button')].every(button => {
							const bounds = button.getBoundingClientRect();
							return bounds.height <= 32 && button.scrollHeight <= button.clientHeight && button.scrollWidth <= button.clientWidth;
						}),
						overflow: toolbar.scrollWidth > toolbar.clientWidth,
					};
				});
				await testInfo.attach(`browser-navigation-${locale}-${size}`, { body: await page.screenshot(), contentType: 'image/png' });
				await testInfo.attach(`browser-geometry-${locale}-${size}`, { body: JSON.stringify(geometry), contentType: 'application/json' });
				expect(geometry.addressWidth).toBeGreaterThanOrEqual(120);
				expect(geometry).toMatchObject({ contained: true, nonOverlapping: true, unobscured: true, singleLine: true, overflow: false });
			}
			await hostWindow.dispose();
			const more = editor.locator('.ash-browser-page-actions').getByRole('button', { name: locale === 'en' ? 'More Actions' : '更多操作', exact: true });
			await more.focus();
			await more.press('Enter');
			for (const label of labels.pageActions) { await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible(); }
			await page.keyboard.press('Escape');
			await expect(page.getByRole('menu')).toHaveCount(0);
			await expect(more).toBeFocused();
			const sharing = await workbench.dialogs.expectMessage(application, labels.pageActions[0]!, async () => {
				await more.press('Enter');
				await page.keyboard.press('Home');
				await page.keyboard.press('Enter');
			});
			expect(sharing.title).toBe(labels.pageActions[0]);
			for (const index of [1, 2]) {
				await more.focus(); await more.press('Enter'); await page.keyboard.press('Home');
				for (let step = 0; step < index; step++) { await page.keyboard.press('ArrowDown'); }
				await page.keyboard.press('Enter');
				await expect(page.getByRole('menu')).toHaveCount(0);
				await expect(more).toBeFocused();
			}

			await editor.locator('.ash-browser-viewport').focus();
			await electron.evaluate(async ({ BrowserWindow }) => {
				const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child) as Electron.WebContentsView;
				await view.webContents.executeJavaScript("history.pushState({}, '', '/routed'); document.title = 'Routed page';");
			});
			await expect(addressField).toHaveValue(`${url}routed`);
			await editor.getByRole('button', { name: labels.back, exact: true }).click();
			await expect(addressField).toHaveValue(url);
			await editor.getByRole('button', { name: labels.forward, exact: true }).click();
			await expect(addressField).toHaveValue(`${url}routed`);
			const back = editor.getByRole('button', { name: labels.back, exact: true });
			await back.focus(); await back.press('ArrowRight');
			await expect(editor.getByRole('button', { name: labels.reload, exact: true })).toBeFocused();
			await addressField.fill(`${url}slow`);
			await addressField.press('Enter');
			await expect.poll(() => finishSlowLoad !== undefined).toBe(true);
			await expect(editor.getByRole('status')).toHaveText(labels.loading);
			await editor.getByRole('button', { name: labels.stop, exact: true }).click();
			await expect(editor.getByRole('button', { name: labels.reload, exact: true })).toBeEnabled();
			await expect(editor.getByRole('status')).not.toHaveText(labels.loading);
			await addressField.fill(`${url}failed`);
			await addressField.press('Enter');
			await expect(editor.getByRole('status')).toContainText(labels.failure);
			const helpMessage = await workbench.dialogs.expectMessage(application, labels.helpTitle, () => editor.getByRole('button', { name: labels.help, exact: true }).click());
			expect(helpMessage.message).toContain(labels.helpText);
			await addressField.focus();
			await addressField.press('Alt+F1');
			const helpDialog = page.getByRole('dialog', { name: labels.accessibleViewTitle, exact: true });
			await expect(helpDialog.getByRole('textbox')).toHaveValue(new RegExp(labels.helpText));
			await testInfo.attach(`browser-help-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
			await page.keyboard.press('Escape');
			await expect(addressField).toBeFocused();
			await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
			await expect(editor).toHaveCount(0);
			const urls = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(view => 'webContents' in view).map(view => (view as Electron.WebContentsView).webContents.getURL()));
			await expect.poll(async () => (await urls()).filter(candidate => candidate.startsWith(url))).toEqual([]);
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
	test(`desktop BrowserView Enter hands keyboard input to the page and commands return to Workbench in ${locale}`, async ({ target, application: initialApplication, workbench: initialWorkbench, restartWorkbench }, testInfo) => {
		test.skip(target.kind !== 'electron', 'Keyboard focus crosses real Electron WebContents');
		let application = initialApplication;
		let workbench = initialWorkbench;
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
			await picker.getByRole('combobox').fill('简体中文');
			await picker.getByRole('combobox').press('Enter');
			({ application, workbench } = await restartWorkbench());
		}
		const server = createServer((_request, response) => {
			response.setHeader('Content-Type', 'text/html');
			response.end('<title>Keyboard page</title><input aria-label="Page keyboard input"><button>Page action</button>');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Missing keyboard fixture endpoint'); }
		const url = `http://127.0.0.1:${address.port}/`;
		const electron = application as ElectronApplication;
		const page = workbench.page;
		try {
			await installBrowserNetworkPolicy(electron, url);
			await workbench.quickaccess.runCommand('ash.browser.open');
			const editor = page.locator('.ash-browser-editor');
			const addressField = editor.getByRole('textbox', { name: locale === 'en' ? 'Browser address' : '浏览器地址', exact: true });
			await addressField.fill(url); await addressField.press('Enter');
			await expect(editor.getByRole('status')).toHaveText('Keyboard page');
			const pageView = await electron.evaluateHandle(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView, url);
			try {
				// No test focus/click occurs after Enter: the product must hand keyboard input to the page.
				await expect.poll(() => pageView.evaluate(view => view.webContents.isFocused())).toBe(true);
				await pageView.evaluate(view => {
					view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
					view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
				});
				await expect.poll(() => pageView.evaluate(view => view.webContents.executeJavaScript("document.activeElement?.getAttribute('aria-label')"))).toBe('Page keyboard input');
				await pageView.evaluate(view => {
					for (const character of 'page text') { view.webContents.sendInputEvent({ type: 'char', keyCode: character }); }
				});
				await expect.poll(() => pageView.evaluate(view => view.webContents.executeJavaScript("document.querySelector('input').value"))).toBe('page text');
				await pageView.evaluate(view => {
					const modifiers: ('meta' | 'control' | 'shift')[] = process.platform === 'darwin' ? ['meta', 'shift'] : ['control', 'shift'];
					view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers });
					view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers });
				});
				const commands = workbench.quickaccess.element;
				await expect(commands).toBeVisible();
				await expect(commands.getByRole('combobox')).toBeFocused();
				await expect.poll(() => pageView.evaluate(view => view.getVisible())).toBe(false);
				await page.keyboard.press('Escape');
				await expect.poll(() => pageView.evaluate(view => view.getVisible())).toBe(true);
			} finally { await pageView.dispose(); }
			await testInfo.attach(`browser-keyboard-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
			await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
			await expect(editor).toHaveCount(0);
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

}

test('desktop browser opens visible pages, navigates history, resizes and releases closed tabs', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron', 'The integrated browser is a desktop capability');
	let finishSlowLoad: (() => void) | undefined;
	const server = createServer((request, response) => {
		response.setHeader('Content-Type', 'text/html');
		if (request.url === '/slow') {
			finishSlowLoad = () => response.end('<title>Cancelled page</title>');
			return;
		}
		const title = request.url === '/second' ? 'Second page' : request.url === '/popup' ? 'Popup page' : 'First page';
		response.end(`<title>${title}</title><h1>Visible browser fixture</h1><input aria-label="Page input"><a href="/second">Next</a>`);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') { throw new Error('Missing fixture endpoint'); }
	const url = `http://127.0.0.1:${address.port}/`;
	const electron = application as ElectronApplication;
	const page = workbench.page;
	try {
		await installBrowserNetworkPolicy(electron, url);
		await workbench.quickaccess.runCommand('ash.browser.open');
		const editor = page.locator('.ash-browser-editor');
		await expect(editor).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Editor breadcrumbs' })).toBeHidden();
		const location = editor.getByRole('textbox', { name: 'Browser address' });
		await location.fill(url); await location.press('Enter');
		await expect(editor.getByRole('status')).toHaveText('First page');
		await expect(page.getByRole('tab', { name: 'First page' })).toBeVisible();
		const views = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(view => 'webContents' in view).map(view => ({ bounds: view.getBounds(), visible: view.getVisible(), url: (view as Electron.WebContentsView).webContents.getURL() })));
		await expect.poll(async () => (await views()).filter(view => view.url === url && view.visible).length).toBe(1);
		await editor.locator('.ash-browser-viewport').focus();
		await electron.evaluate(async ({ BrowserWindow }) => {
			const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL().endsWith('/')) as Electron.WebContentsView;
			await view.webContents.executeJavaScript("history.pushState({}, '', '/routed'); document.title = 'Routed page';");
		});
		await expect(location).toHaveValue(`${url}routed`);
		await expect(page.getByRole('tab', { name: 'Routed page' })).toBeVisible();
		await editor.getByRole('button', { name: 'Back', exact: true }).click();
		await expect(location).toHaveValue(url);
		await electron.evaluate(async ({ BrowserWindow }, url) => {
			const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView;
			await view.webContents.executeJavaScript("document.title = 'First page';");
		}, url);
		await location.fill(`${url}second`); await location.press('Enter');
		await expect(editor.getByRole('status')).toHaveText('Second page');
		await workbench.quickaccess.runCommand('ash.browser.open');
		await expect(page.getByRole('tab', { name: 'Second page', exact: true })).toHaveCount(1);
		await expect(page.getByRole('tab', { name: 'Browser', exact: true })).toHaveCount(1);
		await expect.poll(async () => (await views()).filter(view => view.url === `${url}second` && view.visible).length).toBe(0);
		await page.getByRole('tab', { name: 'Second page', exact: true }).click();
		await page.locator('.ash-browser-editor:visible').getByRole('textbox', { name: 'Browser address' }).focus();
		await expect.poll(async () => (await views()).filter(view => view.url === `${url}second` && view.visible).length).toBe(1);
		await page.getByRole('tab', { name: 'Browser', exact: true }).click();
		await page.getByRole('button', { name: 'Close Browser', exact: true }).click();
		await editor.getByRole('button', { name: 'Back', exact: true }).click();
		await expect(editor.getByRole('status')).toHaveText('First page');
		await editor.getByRole('button', { name: 'Forward', exact: true }).click();
		await expect(editor.getByRole('status')).toHaveText('Second page');
		await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
		await expect(page.getByRole('tab', { name: 'Second page', exact: true })).toHaveCount(2);
		expect((await views()).filter(view => view.url === `${url}second`)).toHaveLength(1);
		await electron.evaluate(async ({ BrowserWindow }) => {
			const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL().endsWith('/second')) as Electron.WebContentsView;
			await view.webContents.executeJavaScript("window.open('/popup'); undefined", true);
		});
		await expect(page.getByRole('tab', { name: 'Popup page', exact: true })).toHaveCount(1);
		await page.getByRole('button', { name: 'Close Popup page', exact: true }).click();
		await expect.poll(async () => (await views()).filter(view => view.url === `${url}popup`).length).toBe(0);
		await page.getByRole('button', { name: 'Close Second page', exact: true }).last().click();
		await expect(page.getByRole('tab', { name: 'Second page', exact: true })).toHaveCount(1);
		// Closing the compositor's current split must hand its page to the surviving split without another focus action.
		await expect.poll(async () => {
			const bounds = await page.locator('.ash-browser-editor:visible .ash-browser-viewport').boundingBox();
			const view = (await views()).find(view => view.url === `${url}second` && view.visible);
			return bounds && view ? Math.abs(view.bounds.x - bounds.x) + Math.abs(view.bounds.width - bounds.width) : 1000;
		}).toBeLessThan(3);
		await page.getByRole('tab', { name: 'Second page', exact: true }).click();
		await editor.getByRole('textbox', { name: 'Browser address' }).focus();
		await expect.poll(async () => (await views()).filter(view => view.url === `${url}second` && view.visible).length).toBe(1);
		await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 720));
		await expect.poll(async () => {
			const bounds = await editor.locator('.ash-browser-viewport').boundingBox();
			const view = (await views()).find(view => view.url === `${url}second`);
			return bounds && view ? Math.abs(view.bounds.width - bounds.width) : 1000;
		}).toBeLessThan(2);
		await location.focus(); await location.press('Alt+F1');
		const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
		await expect(help.getByRole('textbox')).toHaveValue(/Webpages use the browser’s accessibility tree/u);
		await expect.poll(async () => (await views()).filter(view => view.url === `${url}second` && view.visible).length).toBe(0);
		await page.keyboard.press('Escape');
		await expect(location).toBeFocused();
		await page.getByRole('button', { name: 'Close Second page', exact: true }).click();
		await expect(page.getByRole('tab', { name: 'Second page', exact: true })).toHaveCount(0);
		await expect.poll(async () => (await views()).filter(view => view.url.startsWith(url)).map(view => view.url)).toEqual([]);
		const hostCall = (method: string, params: Record<string, unknown>) => page.evaluate(({ method, params }) => {
			return globalThis.ashTestMainProcess.call('browserHost', method, { id: crypto.randomUUID(), params: { threadId: 'browser-smoke-thread', ...params } });
		}, { method, params: ['create', 'observe', 'perform'].includes(method) ? { networkToken: browserNetworkToken, ...params } : params });
		const created = decodeAppServerServerRequestResult('browser/create', await hostCall('create', { url }));
		await expect(page.locator('.ash-browser-editor')).toBeVisible();
		await expect.poll(async () => (await views()).filter(view => view.url === url && view.visible).length).toBe(1);
		let nodeId: string | undefined;
		await expect.poll(async () => {
			const observation = decodeAppServerServerRequestResult('browser/observe', await hostCall('observe', { targetId: created.targetId, includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot: false }));
			const tree = JSON.parse(observation.accessibilityTree ?? '{}') as { nodes?: { role?: { value: string; }; name?: { value: string; }; backendDOMNodeId?: number; }[]; };
			const input = tree.nodes?.find(node => node.role?.value === 'textbox' && node.name?.value === 'Page input');
			nodeId = input?.backendDOMNodeId === undefined ? undefined : String(input.backendDOMNodeId);
			return nodeId !== undefined;
		}).toBe(true);
		await hostCall('perform', { action: { type: 'typeText', targetId: created.targetId, target: { type: 'element', target: { nodeId } }, text: 'Agent and user share this page' } });
		const observation = decodeAppServerServerRequestResult('browser/observe', await hostCall('observe', { targetId: created.targetId, includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot: false }));
		expect(observation.accessibilityTree).toContain('Agent and user share this page');
		await page.evaluate(() => globalThis.ashTestMainProcess.call('browserHost', 'disposeSession', { threadId: 'browser-smoke-thread' }));
		await expect.poll(() => electron.evaluate(({ BrowserWindow }) => {
			const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child) as Electron.WebContentsView;
			return view.webContents.debugger.isAttached();
		})).toBe(false);
		await expect(page.locator('.ash-browser-editor')).toBeVisible();
		expect(decodeAppServerServerRequestResult('browser/observe', await hostCall('observe', { targetId: created.targetId, includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot: false })).accessibilityTree).toContain('Agent and user share this page');
		await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
		await expect(page.getByRole('tab', { name: 'First page', exact: true })).toHaveCount(2);
		await hostCall('close', { targetId: created.targetId });
		await expect(page.locator('.ash-browser-editor')).toHaveCount(0);
		await expect.poll(async () => (await views()).filter(view => view.url.startsWith(url)).length).toBe(0);
		const slow = decodeAppServerServerRequestResult('browser/create', await hostCall('create', { url: 'about:blank' }));
		const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const pending = page.evaluate(({ id, url, targetId }) => {
			return globalThis.ashTestMainProcess.call('browserHost', 'perform', { id, params: { threadId: 'browser-smoke-thread', networkToken: 'browser-test-authority', action: { type: 'navigate', targetId, url } } }).then(() => 'completed', () => 'cancelled');
		}, { id: requestId, url: `${url}slow`, targetId: slow.targetId });
		await expect.poll(() => finishSlowLoad !== undefined).toBe(true);
		await page.evaluate(id => globalThis.ashTestMainProcess.call('browserHost', 'cancel', { id }), requestId);
		expect(await pending).toBe('cancelled');
		finishSlowLoad!();
		await hostCall('close', { targetId: slow.targetId });
		await expect(page.getByRole('tab', { name: 'Browser', exact: true })).toHaveCount(0);
		await expect.poll(async () => (await views()).filter(view => view.url.startsWith(url)).length).toBe(0);
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
