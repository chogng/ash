import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer as httpServer } from 'node:http';
import { createServer as socketServer, connect, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test as baseTest } from '../../../automation/test.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { Workbench } from '../../../automation/workbench.js';
import { WorkbenchDiagnostics } from '../../../automation/playwrightDriver.js';

interface NetworkScenario { remote: boolean; proxies: Set<AbortController>; released: number; }
interface NetworkHarness {
	application: ElectronApplication;
	page: Page;
	workbench: Workbench;
	port: number;
	hosts: string[];
	requests: string[];
	stopProxy(): Promise<void>;
}

const test = baseTest.extend<{ network: NetworkHarness }>({ network: async ({ target }, use, testInfo) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled', 'This Chromium network scenario runs in Electron UI');
	const sockets = new Set<Socket>();
	const track = (socket: Socket): Socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
	const requests: string[] = [];
	const origin = httpServer((request, response) => {
		requests.push(request.url!);
		response.setHeader('Connection', 'close');
		if (request.url === '/data') { response.end('remote-data'); return; }
		if (request.url === '/image') { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); return; }
		response.setHeader('Content-Type', 'text/html');
		response.end(`<title>Remote network fixture</title><img src="/image"><script>
		fetch('/data').then(response => response.text()).then(value => window.remoteData = value);
		const socket = new WebSocket('ws://' + location.host + '/socket');
		socket.onmessage = event => window.remoteSocket = event.data;
		</script>`);
	});
	origin.on('connection', track);
	origin.on('upgrade', (request, socket) => {
		const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		const message = Buffer.from('remote-ws');
		socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
	});
	await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
	const endpoint = origin.address();
	if (!endpoint || typeof endpoint === 'string') throw new Error('Missing remote origin');
	const hosts: string[] = [];
	const proxy = socketServer(socket => {
		track(socket);
		let buffer = Buffer.alloc(0);
		let greeted = false;
		const receive = (data: Buffer): void => {
			buffer = Buffer.concat([buffer, data]);
			if (!greeted) {
				if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
				buffer = buffer.subarray(2 + buffer[1]!); greeted = true; socket.write(Buffer.from([5, 0]));
			}
			if (buffer.length < 5) return;
			const length = buffer[3] === 3 ? 7 + buffer[4]! : 10;
			if (buffer.length < length) return;
			const host = buffer[3] === 3 ? buffer.subarray(5, 5 + buffer[4]!).toString() : [...buffer.subarray(4, 8)].join('.');
			hosts.push(host);
			if (host !== 'localhost' && host !== '127.0.0.1') { socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
			socket.removeListener('data', receive);
			const upstream = track(connect(endpoint.port, '127.0.0.1', () => {
				socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
				if (buffer.length > length) upstream.write(buffer.subarray(length));
				socket.pipe(upstream); upstream.pipe(socket);
			}));
			upstream.on('error', () => socket.destroy());
			socket.once('close', () => upstream.destroy());
		};
		socket.on('data', receive);
		socket.on('error', () => socket.destroy());
	});
	await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
	const proxyAddress = proxy.address();
	if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing proxy');
	const directory = await mkdtemp(join(tmpdir(), 'ash-browser-network-'));
	const desktop = resolve(import.meta.dirname, '../../../..');
	const output = resolve(desktop, '../.build/app-ts/main/src');
	const entry = testInfo.outputPath('browser-network.mjs');
	await writeFile(entry, `
import { app } from 'electron/main';
import { bootstrapElectronMain } from ${JSON.stringify(pathToFileURL(join(output, 'bootstrap.js')).href)};
bootstrapElectronMain(); app.setAppPath(${JSON.stringify(desktop)});
const { BrowserViewMainService } = await import(${JSON.stringify(pathToFileURL(join(output, 'ash/platform/browserView/electron-main/browserViewMainService.js')).href)});
const { toDisposable } = await import(${JSON.stringify(pathToFileURL(join(output, 'ash/base/common/lifecycle.js')).href)});
const scenario = globalThis.networkScenario = { remote: true, proxies: new Set(), released: 0 };
// Substitute only the SSH endpoint. Production page creation, session partitioning and Chromium proxy policy run unchanged.
const create = BrowserViewMainService.prototype.getOrCreateBrowserView;
BrowserViewMainService.prototype.getOrCreateBrowserView = function(...args) {
  this.options.getRemoteNetwork = () => scenario.remote ? { authority: 'ssh+fixture', tunnels: {
    async openProxy() {
      const controller = new AbortController(); scenario.proxies.add(controller);
      return Object.assign(toDisposable(() => { controller.abort(); scenario.proxies.delete(controller); scenario.released++; }), { localPort: ${proxyAddress.port}, signal: controller.signal });
    }
  } } : undefined;
  return create.apply(this, args);
};
const { startElectronApplication } = await import(${JSON.stringify(pathToFileURL(join(output, 'ash/code/electron-main/main.js')).href)});
startElectronApplication();
`);
	const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory: directory });
	const application = await _electron.launch({ executablePath: configuration.executablePath, args: configuration.args.map(argument => argument === desktop ? entry : argument), cwd: configuration.cwd, env: configuration.env });
	using diagnostics = new WorkbenchDiagnostics(application.context());
	let stopped = false;
	const stopProxy = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(resolve => proxy.close(() => resolve()));
		await application.evaluate(() => { for (const controller of (globalThis as unknown as { networkScenario: NetworkScenario }).networkScenario.proxies) controller.abort(); });
	};
	try {
		const page = await application.firstWindow();
		const workbench = new Workbench(page);
		await workbench.waitForReady();
		await use({ application, page, workbench, port: endpoint.port, hosts, requests, stopProxy });
		expect(diagnostics.errors).toEqual([]);
	} finally {
		await testInfo.attach('network-state', { body: JSON.stringify({ hosts, requests, errors: diagnostics.errors }), contentType: 'application/json' });
		await stopProxy();
		await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
		await application.close();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(resolve => origin.close(() => resolve()));
		await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
} });

test('remote session proxies DNS, subresources, fetch, WebSocket and loopback, then rejects direct requests after disconnect', async ({ network: { application, page, workbench, port, hosts, requests, stopProxy } }) => {
	await workbench.quickaccess.runCommand('ash.browser.open');
	const editor = page.locator('.ash-browser-editor');
	const address = editor.getByRole('textbox', { name: 'Browser address' });
	const url = `http://localhost:${port}/`;
	await address.fill(url); await address.press('Enter');
	try { await expect(editor.getByRole('status')).toHaveText('Remote network fixture'); }
	catch (error) {
		const state = await application.evaluate(async ({ BrowserWindow }, url) => Promise.all(BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(child => 'webContents' in child).map(async child => {
			const contents = (child as Electron.WebContentsView).webContents;
			return { url: contents.getURL(), loading: contents.isLoading(), proxy: await contents.session.resolveProxy(url) };
		})), url);
		throw new Error(`${String(error)}\n${JSON.stringify({ hosts, requests, state })}`, { cause: error });
	}
	await expect.poll(() => application.evaluate(async ({ BrowserWindow }, url) => {
		const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView;
		return view.webContents.executeJavaScript('({ data: window.remoteData, socket: window.remoteSocket, image: document.images[0].naturalWidth })');
	}, url)).toEqual({ data: 'remote-data', socket: 'remote-ws', image: 1 });
	expect(hosts).toContain('localhost');
	expect(requests).toEqual(expect.arrayContaining(['/image', '/data']));
	const loopback = `http://127.0.0.1:${port}/`;
	await address.fill(loopback); await address.press('Enter');
	await expect.poll(() => hosts.includes('127.0.0.1')).toBe(true);
	await expect(editor.getByRole('status')).toHaveText('Remote network fixture');
	await application.evaluate(async ({ BrowserWindow }, loopback) => {
		const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === loopback) as Electron.WebContentsView;
		await view.webContents.executeJavaScript("document.cookie = 'remote_login=owned; path=/'");
	}, loopback);
	await stopProxy();
	const count = requests.length;
	await address.fill(loopback + 'after-disconnect'); await address.press('Enter');
	await expect(editor.getByRole('status')).toContainText('Unable to load page');
	expect(requests.length).toBe(count);
	await page.keyboard.press('ControlOrMeta+w');
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { networkScenario: NetworkScenario }).networkScenario.released)).toBe(1);
	await application.evaluate(() => { (globalThis as unknown as { networkScenario: NetworkScenario }).networkScenario.remote = false; });
	await workbench.quickaccess.runCommand('ash.browser.open');
	await address.fill(loopback); await address.press('Enter');
	await expect(editor.getByRole('status')).toHaveText('Remote network fixture');
	expect(await application.evaluate(async ({ BrowserWindow }, loopback) => {
		const view = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(child => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL() === loopback) as Electron.WebContentsView;
		return view.webContents.executeJavaScript('document.cookie');
	}, loopback)).toBe('');
});
