import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { createTestWorkspace, disposeTestWorkspace } from '../../../automation/testWorkspace.js';
import { createTestEnvironment } from '../../../automation/testEnvironment.js';
import { developmentAshPackagePath } from '../../../../build/desktop/runtimeStore.js';
import { checkAppServerInitializeCompatibility } from '../../../../src/ash/platform/agentHost/common/appServerProtocolCompatibility.js';
import { decodeAppServerResponse } from '../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const repository = resolve(import.meta.dirname, '../../../..');
const execFileAsync = promisify(execFile);

interface ObservedFrame {
	readonly connection: number;
	readonly direction: 'send' | 'receive';
	readonly frame: Record<string, unknown>;
}

/** Observe existing carriers without replacing their protocol client or changing frames. */
async function observeProtocol(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const frames: ObservedFrame[] = [];
		(globalThis as typeof globalThis & { ashProtocolEvidence: ObservedFrame[]; }).ashProtocolEvidence = frames;
		let nextConnection = 1;
		const connections = new WeakMap<object, { id: number; selected: Set<unknown>; sent: string; received: string; sentDecoder: TextDecoder; receivedDecoder: TextDecoder; }>();
		const read = (owner: object, direction: 'send' | 'receive', value: unknown): void => {
			let connection = connections.get(owner);
			if (!connection) {
				connection = { id: nextConnection++, selected: new Set(), sent: '', received: '', sentDecoder: new TextDecoder(), receivedDecoder: new TextDecoder() };
				connections.set(owner, connection);
			}
			let records: string[];
			if (typeof value === 'string') {
				records = [value];
			} else if (value && typeof value === 'object' && 'data' in value && value.data instanceof Uint8Array) {
				const key = direction === 'send' ? 'sent' : 'received';
				connection[key] += (direction === 'send' ? connection.sentDecoder : connection.receivedDecoder).decode(value.data, { stream: true });
				records = connection[key].split('\n');
				connection[key] = records.pop()!;
			} else { return; }
			for (const text of records) {
				let frame: Record<string, unknown>;
				try { frame = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
				if (frame.jsonrpc !== '2.0') { continue; }
				if (direction === 'send') {
					if (!['initialize', 'fs/readFile', 'env/dirs/set'].includes(String(frame.method))) { continue; }
					connection.selected.add(frame.id);
				} else if (!connection.selected.has(frame.id)) { continue; }
				if (frames.length < 300) { frames.push({ connection: connection.id, direction, frame }); }
			}
		};
		const sendWebSocket = WebSocket.prototype.send;
		const sockets = new WeakSet<WebSocket>();
		WebSocket.prototype.send = function (this: WebSocket, ...args: Parameters<WebSocket['send']>): void {
			if (new URL(this.url).pathname === '/ash/app-server') {
				if (!sockets.has(this)) {
					sockets.add(this);
					this.addEventListener('message', event => read(this, 'receive', event.data));
				}
				read(this, 'send', args[0]);
			}
			Reflect.apply(sendWebSocket, this, args);
		};
		const sendPort = MessagePort.prototype.postMessage;
		MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]): void {
			read(this, 'send', args[0]);
			Reflect.apply(sendPort, this, args);
		};
		window.addEventListener('message', event => {
			if (event.source !== window) { return; }
			for (const port of event.ports) {
				port.addEventListener('message', data => read(port, 'receive', data.data));
			}
		});
	});
}

async function initializationEvidence(page: Page): Promise<{ requestId: unknown; schemaHash: string; server: string; frames: ObservedFrame[]; }> {
	await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { ashProtocolEvidence: ObservedFrame[]; }).ashProtocolEvidence?.some(entry => entry.direction === 'receive' && 'result' in entry.frame))).toBe(true);
	const frames = await page.evaluate(() => (globalThis as typeof globalThis & { ashProtocolEvidence: ObservedFrame[]; }).ashProtocolEvidence);
	const request = frames.find(entry => entry.direction === 'send' && entry.frame.method === 'initialize');
	expect(request).toBeDefined();
	const response = frames.find(entry => entry.direction === 'receive' && entry.connection === request!.connection && entry.frame.id === request!.frame.id);
	expect(response).toBeDefined();
	const decoded = decodeAppServerResponse('initialize', response!.frame);
	expect('result' in decoded).toBe(true);
	if (!('result' in decoded)) { throw new Error('Initialize returned an error'); }
	const initialized = checkAppServerInitializeCompatibility(decoded.result, { expectedServerName: 'ash-app-server' });
	return { requestId: request!.frame.id, schemaHash: initialized.schemaHash, server: initialized.serverInfo.name, frames };
}

async function backendIdentity(environment: Readonly<NodeJS.ProcessEnv>, runtime: 'packaged-node' | 'host-provided-node'): Promise<{ pid: number; instanceId: string; }> {
	const root = developmentAshPackagePath(repository, runtime);
	const executable = join(root, 'bin', process.platform === 'win32' ? 'ash-app-server-daemon.exe' : 'ash-app-server-daemon');
	const output = await execFileAsync(executable, ['version'], { env: { ...process.env, ...environment }, windowsHide: true, timeout: 10_000 });
	const value = JSON.parse(output.stdout) as { pid: number; instanceId: string; };
	expect(value.pid).toBeGreaterThan(0);
	expect(value.instanceId).toBeTruthy();
	return { pid: value.pid, instanceId: value.instanceId };
}

test('Browser protocol isolates matching request IDs and closing a page preserves its peer', { tag: ['@browser-app-server'] }, async ({ workbench, webAppServer }, testInfo) => {
	const page = workbench.page;
	await observeProtocol(page);
	await page.reload();
	await workbench.waitForReady();
	const first = await initializationEvidence(page);
	const peer = await page.context().newPage();
	try {
		await observeProtocol(peer);
		await peer.addInitScript(({ endpoint, token }) => {
			sessionStorage.setItem('ash.appServer.endpoint', endpoint);
			sessionStorage.setItem(`ash.appServer.session:${new URL(endpoint).origin}`, token);
		}, webAppServer!.connection);
		await peer.goto(page.url());
		await new Workbench(peer).waitForReady();
		const second = await initializationEvidence(peer);
		expect(first.requestId).toBe(1);
		expect(second.requestId).toBe(first.requestId);
		expect(second.schemaHash).toBe(first.schemaHash);
		// The profile's product services own its Extensions authority, including health probes.
		const backendEnvironment = { ...createTestEnvironment(webAppServer!.profileDirectory, process.env), ASH_HOME: webAppServer!.profileDirectory, ASH_PRODUCT_SERVICES_PATH: join(webAppServer!.profileDirectory, 'product-services.json') };
		const before = await backendIdentity(backendEnvironment, 'packaged-node');
		const pair = await page.evaluate(async () => {
			const endpoint = new URL(sessionStorage.getItem('ash.appServer.endpoint')!);
			const token = sessionStorage.getItem(`ash.appServer.session:${endpoint.origin}`)!;
			const url = new URL('/ash/app-server', endpoint);
			url.protocol = 'ws:';
			const connect = async (label: string) => {
				const socket = new WebSocket(url, `ash-session.${token}`);
				const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; }>();
				const request = (id: number, method: string, params: unknown): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
					const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${label} ${method} timed out`)); }, 10_000);
					pending.set(id, { resolve, reject, timer });
					socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
				});
				socket.addEventListener('message', event => {
					const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
					if (typeof frame.id !== 'number') { return; }
					const waiter = pending.get(frame.id);
					if (waiter) { pending.delete(frame.id); clearTimeout(waiter.timer); waiter.resolve(frame); }
				});
				socket.addEventListener('close', () => {
					for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`${label} closed`)); }
					pending.clear();
				});
				await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error(`${label} failed to open`)), { once: true }); });
				try {
					const initialized = await request(1, 'initialize', { clientInfo: { name: `ash-protocol-acceptance-${label}`, version: '1' }, capabilities: { notifications: true } });
					return { socket, request, initialized };
				} catch (error) { socket.close(); throw error; }
			};
			const connected = await Promise.allSettled([connect('left'), connect('right')]);
			const peers = connected.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
			try {
				const failed = connected.find(result => result.status === 'rejected');
				if (failed?.status === 'rejected') { throw failed.reason; }
				const create = (title: string) => ({ commandId: crypto.randomUUID(), title, executionTarget: null, agent: { type: 'default' } });
				const left = peers[0];
				const right = peers[1];
				const [leftResult, rightResult] = await Promise.all([left.request(2, 'session/create', create('A protocol left')), right.request(2, 'session/create', create('A protocol right'))]);
				const closed = new Promise<void>(resolve => left.socket.addEventListener('close', () => resolve(), { once: true }));
				left.socket.close();
				await closed;
				const survivor = await right.request(3, 'session/create', create('A protocol survivor'));
				return { leftInitialize: left.initialized, rightInitialize: right.initialized, leftResult, rightResult, survivor };
			} finally { for (const peer of peers) { peer.socket.close(); } }
		});
		for (const response of [pair.leftInitialize, pair.rightInitialize]) {
			const initialized = decodeAppServerResponse('initialize', response);
			expect('result' in initialized).toBe(true);
			if ('result' in initialized) { checkAppServerInitializeCompatibility(initialized.result, { expectedServerName: 'ash-app-server' }); }
		}
		const left = decodeAppServerResponse('session/create', pair.leftResult);
		const right = decodeAppServerResponse('session/create', pair.rightResult);
		const survivor = decodeAppServerResponse('session/create', pair.survivor);
		expect(left.id).toBe(2);
		expect(right.id).toBe(2);
		expect('result' in left && left.result.session.title).toBe('A protocol left');
		expect('result' in right && right.result.session.title).toBe('A protocol right');
		expect('result' in survivor && survivor.result.session.title).toBe('A protocol survivor');
		const generation = await page.evaluate(() => globalThis.ashWebWorkbenchHost!.api.appServer.connectionGeneration);
		await peer.close();
		const content = await page.evaluate(async () => {
			const host = globalThis.ashWebWorkbenchHost!;
			return (await host.api.fs.readFile({ dirId: host.workspace!.id, path: 'main.ts' })).content;
		});
		expect(content).toBe('const value = 1;\n');
		expect(await page.evaluate(() => globalThis.ashWebWorkbenchHost!.api.appServer.connectionGeneration)).toBe(generation);
		const after = await backendIdentity(backendEnvironment, 'packaged-node');
		expect(after).toEqual(before);
		await testInfo.attach('browser-protocol-isolation', { body: JSON.stringify({ first, second, requestIds: { left: left.id, right: right.id, survivor: survivor.id }, before, after, survivorContent: content }), contentType: 'application/json' });
	} finally { if (!peer.isClosed()) { await peer.close(); } }
});

test('Desktop MessagePort handshakes isolate equal IDs and closing one window preserves the other', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }, testInfo) => {
	const electron = application as ElectronApplication;
	const firstPage = workbench.page;
	const secondWorkspace = await createTestWorkspace();
	let secondPage: Page | undefined;
	try {
		const firstProof = join(testWorkspace.directory, 'protocol-scope.txt');
		const secondProof = join(secondWorkspace.directory, 'protocol-scope.txt');
		await writeFile(firstProof, 'window one proof\n');
		await writeFile(secondProof, 'window two proof\n');
		await observeProtocol(firstPage);
		await firstPage.reload();
		await workbench.waitForReady();
		const first = await initializationEvidence(firstPage);
		const opening = electron.waitForEvent('window');
		await electron.evaluate(({ app }, directory) => { app.emit('second-instance', {} as never, [process.execPath, app.getAppPath(), '--folder', directory], process.cwd(), {}); }, secondWorkspace.directory);
		secondPage = await opening;
		// A new folder restores its Workbench only after the real trust decision.
		await secondPage.getByRole('dialog', { name: 'Ash' }).getByRole('button', { name: 'Trust Folder & Enable Features', exact: true }).click();
		const peerWorkbench = new Workbench(secondPage);
		await peerWorkbench.waitForReady();
		await observeProtocol(secondPage);
		await secondPage.reload();
		await peerWorkbench.waitForReady();
		const second = await initializationEvidence(secondPage);
		expect(first.requestId).toBe(1);
		expect(second.requestId).toBe(first.requestId);
		expect(second.schemaHash).toBe(first.schemaHash);
		const backendEnvironment = await electron.evaluate(() => ({ HOME: process.env.HOME, ASH_HOME: process.env.ASH_HOME, ASH_PRODUCT_SERVICES_PATH: process.env.ASH_PRODUCT_SERVICES_PATH }));
		const before = await backendIdentity(backendEnvironment, 'host-provided-node');
		await workbench.quickaccess.open(firstProof);
		await workbench.quickaccess.select('protocol-scope.txt');
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'window one proof\n');
		await peerWorkbench.quickaccess.open(secondProof);
		await peerWorkbench.quickaccess.select('protocol-scope.txt');
		await peerWorkbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'window two proof\n');
		const secondFrames = await secondPage.evaluate(() => (globalThis as typeof globalThis & { ashProtocolEvidence: ObservedFrame[]; }).ashProtocolEvidence);
		expect(secondFrames.some(entry => entry.direction === 'send' && entry.frame.method === 'fs/readFile')).toBe(true);
		const closed = firstPage.waitForEvent('close');
		const firstWindow = await electron.browserWindow(firstPage);
		await firstWindow.evaluate(window => window.close());
		await closed;
		expect(electron.process().exitCode).toBeNull();
		// Open a new file so success requires the surviving MessagePort to reach the backend.
		const survivingProof = join(secondWorkspace.directory, 'protocol-survivor.txt');
		await writeFile(survivingProof, 'survivor after first close\n');
		await peerWorkbench.quickaccess.open(survivingProof);
		await peerWorkbench.quickaccess.select('protocol-survivor.txt');
		await peerWorkbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'survivor after first close\n');
		const survivingFrames = await secondPage.evaluate(() => (globalThis as typeof globalThis & { ashProtocolEvidence: ObservedFrame[]; }).ashProtocolEvidence);
		const survivingRead = survivingFrames.find(entry => entry.direction === 'send' && entry.frame.method === 'fs/readFile' && String((entry.frame.params as { path?: string; } | undefined)?.path).endsWith('protocol-survivor.txt'));
		expect(survivingRead).toBeDefined();
		const survivingResponse = survivingFrames.find(entry => entry.direction === 'receive' && entry.connection === survivingRead!.connection && entry.frame.id === survivingRead!.frame.id);
		expect(survivingResponse).toBeDefined();
		const decodedRead = decodeAppServerResponse('fs/readFile', survivingResponse!.frame);
		expect('result' in decodedRead && decodedRead.result.content).toBe('survivor after first close\n');
		const after = await backendIdentity(backendEnvironment, 'host-provided-node');
		expect(after).toEqual(before);
		await testInfo.attach('desktop-protocol-isolation', { body: JSON.stringify({ first, second, before, after, survivingFrames: await secondPage.evaluate(() => (globalThis as typeof globalThis & { ashProtocolEvidence: ObservedFrame[]; }).ashProtocolEvidence) }), contentType: 'application/json' });
	} finally {
		if (secondPage && !secondPage.isClosed()) { await secondPage.close().catch(() => undefined); }
		await disposeTestWorkspace(secondWorkspace);
	}
});
