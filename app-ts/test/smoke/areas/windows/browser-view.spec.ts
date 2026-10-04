import { createServer } from 'node:http';
import type { ElectronApplication } from '@playwright/test';
import type { ISandboxGlobals } from "../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js";
import { decodeAppServerServerRequestResult } from '../../../../src/ash/platform/app-server/common/generated/AppServerProtocolDecoder.js';
import { expect, test } from '../../../automation/test.js';

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
	const hostCall = (method: string, params: unknown) => page.evaluate(({ method, params }) => {
		return (globalThis as unknown as { ash: ISandboxGlobals }).ash.ipcRenderer.invoke(`ash:browser-host:${method}`, { id: crypto.randomUUID(), params });
	}, { method, params });
	try {
		const created = decodeAppServerServerRequestResult('browser/create', await hostCall('create', { url }));
		const observe = async (includeScreenshot = false) => decodeAppServerServerRequestResult('browser/observe', await hostCall('observe', { targetId: created.targetId, includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot }));
		const initial = await observe(true);
		expect({ url: initial.url, title: initial.title, loading: initial.loading }).toEqual({ url, title: 'Agent fixture', loading: false });
		expect(Buffer.from(initial.screenshot!.dataBase64, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		const tree = JSON.parse(initial.accessibilityTree!) as { nodes: { role?: { value: string }; name?: { value: string }; backendDOMNodeId?: number }[] };
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
		await page.keyboard.press('ControlOrMeta+Shift+P');
		await page.getByPlaceholder('Type the name of a command to run').fill('Browser: Open Browser');
		await page.keyboard.press('Enter');
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
		await page.keyboard.press('ControlOrMeta+Shift+P');
		await page.getByPlaceholder('Type the name of a command to run').fill('Browser: Open Browser');
		await page.keyboard.press('Enter');
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
		await page.keyboard.press('ControlOrMeta+Shift+P');
		await page.getByPlaceholder('Type the name of a command to run').fill('Split Editor Horizontal');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('tab', { name: 'Second page', exact: true })).toHaveCount(2);
		await electron.evaluate(async ({ BrowserWindow }) => {
			const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL().endsWith('/second')) as Electron.WebContentsView;
			await view.webContents.executeJavaScript("window.open('/popup'); undefined", true);
		});
		await expect(page.getByRole('tab', { name: 'Popup page', exact: true })).toHaveCount(1);
		await page.getByRole('button', { name: 'Close Popup page', exact: true }).click();
		await expect.poll(async () => (await views()).filter(view => view.url === `${url}popup`).length).toBe(0);
		await page.getByRole('button', { name: 'Close Second page', exact: true }).last().click();
		await expect(page.getByRole('tab', { name: 'Second page', exact: true })).toHaveCount(1);
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
		const hostCall = (method: string, params: unknown) => page.evaluate(({ method, params }) => {
			const bridge = (globalThis as unknown as { ash: ISandboxGlobals }).ash;
			return bridge.ipcRenderer.invoke(`ash:browser-host:${method}`, { id: crypto.randomUUID(), params });
		}, { method, params });
		const created = decodeAppServerServerRequestResult('browser/create', await hostCall('create', { url }));
		await expect(page.locator('.ash-browser-editor')).toBeVisible();
		await expect.poll(async () => (await views()).filter(view => view.url === url && view.visible).length).toBe(1);
		let nodeId: string | undefined;
		await expect.poll(async () => {
			const observation = decodeAppServerServerRequestResult('browser/observe', await hostCall('observe', { targetId: created.targetId, includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot: false }));
			const tree = JSON.parse(observation.accessibilityTree ?? '{}') as { nodes?: { role?: { value: string }; name?: { value: string }; backendDOMNodeId?: number }[] };
			const input = tree.nodes?.find(node => node.role?.value === 'textbox' && node.name?.value === 'Page input');
			nodeId = input?.backendDOMNodeId === undefined ? undefined : String(input.backendDOMNodeId);
			return nodeId !== undefined;
		}).toBe(true);
		await hostCall('perform', { action: { type: 'typeText', targetId: created.targetId, target: { type: 'element', target: { nodeId } }, text: 'Agent and user share this page' } });
		const observation = decodeAppServerServerRequestResult('browser/observe', await hostCall('observe', { targetId: created.targetId, includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot: false }));
		expect(observation.accessibilityTree).toContain('Agent and user share this page');
		await hostCall('close', { targetId: created.targetId });
		await expect(page.locator('.ash-browser-editor')).toHaveCount(0);
		await expect.poll(async () => (await views()).filter(view => view.url.startsWith(url)).length).toBe(0);
		const slow = decodeAppServerServerRequestResult('browser/create', await hostCall('create', { url: 'about:blank' }));
		const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const pending = page.evaluate(({ id, url, targetId }) => {
			return (globalThis as unknown as { ash: ISandboxGlobals }).ash.ipcRenderer.invoke('ash:browser-host:perform', { id, params: { action: { type: 'navigate', targetId, url } } }).then(() => 'completed', () => 'cancelled');
		}, { id: requestId, url: `${url}slow`, targetId: slow.targetId });
		await expect.poll(() => finishSlowLoad !== undefined).toBe(true);
		await page.evaluate(id => (globalThis as unknown as { ash: ISandboxGlobals }).ash.ipcRenderer.invoke('ash:browser-host:cancel', { id }), requestId);
		expect(await pending).toBe('cancelled');
		finishSlowLoad!();
		await hostCall('close', { targetId: slow.targetId });
		await expect(page.getByRole('tab', { name: 'Browser', exact: true })).toHaveCount(0);
		await expect.poll(async () => (await views()).filter(view => view.url.startsWith(url)).length).toBe(0);
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
