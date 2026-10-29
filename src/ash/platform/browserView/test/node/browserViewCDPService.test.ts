import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { WebContents } from 'electron/main';
import { chromium, type BrowserContext } from 'playwright-core';
import { suite, test } from 'mocha';
import { Event } from '../../../../base/common/event.js';
import { promiseWithResolvers } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import type { BrowserCDPOperation, IBrowserUploadFile } from '../../common/browserView.js';
import { BrowserViewDebugger } from '../../electron-main/browserViewDebugger.js';
import { BrowserViewCDPService } from '../../electron-main/browserViewCDPService.js';
import { IBrowserViewMainService } from '../../electron-main/browserViewMainService.js';
import type { BrowserView } from '../../electron-main/browserView.js';

suite('Live browser CDP connection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('commands and events reach Chromium, cancellation releases evaluation, and closing resumes a paused page', async () => {
		const profileRoot = resolve('.build/desktop');
		const profile = mkdtempSync(join(profileRoot, 'browser-cdp-'));
		let context: BrowserContext | undefined;
		let socket: WebSocket | undefined;
		try {
			context = await chromium.launchPersistentContext(profile, {
				headless: true,
				args: ['--remote-debugging-port=0'],
			});
			const page = context.pages()[0]!;
			await page.goto('data:text/html,<input value="before">');
			const inspector = await context.newCDPSession(page);
			const { targetInfo } = await inspector.send('Target.getTargetInfo');
			await inspector.detach();
			const [port, endpoint] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
			socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
			await new Promise<void>((done, fail) => {
				socket!.addEventListener('open', () => done(), { once: true });
				socket!.addEventListener('error', fail, { once: true });
			});
			const debuggerTransport = new EventEmitter();
			const pending = new Map<number, ReturnType<typeof promiseWithResolvers<unknown>>>();
			const evaluationStarted = promiseWithResolvers<void>();
			let sequence = 0;
			let transportSessionId: string | undefined;
			const receive = (event: MessageEvent): void => {
				const message = JSON.parse(String(event.data));
				if (typeof message.id === 'number') {
					const request = pending.get(message.id);
					pending.delete(message.id);
					if (message.error) {
						request?.reject(new Error(message.error.message));
					} else {
						request?.resolve(message.result);
					}
				} else {
					if (message.method === 'Runtime.consoleAPICalled' && message.params.args[0]?.value === 'waiting for cancellation') {
						evaluationStarted.resolve();
					}
					debuggerTransport.emit('message', {}, message.method, message.params, message.sessionId === transportSessionId ? undefined : message.sessionId);
				}
			};
			socket.addEventListener('message', receive);
			const send = (method: string, params?: object, sessionId?: string): Promise<unknown> => {
				const id = ++sequence;
				const response = promiseWithResolvers<unknown>();
				pending.set(id, response);
				socket!.send(JSON.stringify({ id, method, params, sessionId }));
				return response.promise;
			};
			transportSessionId = (
				(await send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true })) as {
					sessionId: string;
				}
			).sessionId;
			let attached = false;
			Object.assign(debuggerTransport, {
				isAttached: () => attached,
				attach: () => {
					attached = true;
				},
				detach: () => {
					attached = false;
					debuggerTransport.emit('detach', {}, 'detached');
				},
				sendCommand: (method: string, params?: object, sessionId?: string) => send(method, params, sessionId ?? transportSessionId),
			});
			using debuggerOwner = new BrowserViewDebugger(
				Object.assign(new EventEmitter(), {
					debugger: debuggerTransport,
					isDestroyed: () => false,
				}) as unknown as WebContents,
			);
			const signal = new AbortController().signal;
			const state = { targetId: 'page', url: page.url(), title: '', loading: false };
			const info = { id: 'page', owner: { type: 'agent', sessionId: 'thread' }, host: { windowId: 1 }, state };
			const view = {
				id: 'page',
				signal,
				session: { id: 'context' },
				debugger: debuggerOwner,
				getInfo: () => info,
				getState: () => state,
				runOperation: async <T>(signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>) => execute(signal),
			} as unknown as BrowserView;
			using services = new InstantiationService();
			services.registerInstance(IBrowserViewMainService, {
				onDidEvent: Event.None,
				getBrowserViews: async () => [info],
				tryGetBrowserView: () => view,
				validateAgentAccess: (id: string, thread: string) => {
					assert.equal(id, 'page');
					assert.equal(thread, 'thread');
					return view;
				},
				agentAccessSignal: () => signal,
			} as unknown as IBrowserViewMainService);
			using cdp = services.createInstance(BrowserViewCDPService);
			const perform = (operation: BrowserCDPOperation, requestSignal = signal, uploads: readonly IBrowserUploadFile[] = []) =>
				cdp.perform('thread', view, operation, requestSignal, null, uploads);
			await perform({ type: 'command', method: 'Runtime.enable', params: {} });
			const evaluated = await perform({
				type: 'command',
				method: 'Runtime.evaluate',
				params: { expression: 'console.log("cdp event"); 6 * 7', returnByValue: true },
			});
			assert.equal(JSON.parse(evaluated.output).result.result.value, 42);
			const events = JSON.parse((await perform({ type: 'readEvents' })).output).events;
			assert.ok(events.some((event: { method: string }) => event.method === 'Runtime.consoleAPICalled'));
			// Browser approval alone cannot upload paths, including when targeting an existing object.
			const input = JSON.parse(
				(
					await perform({
						type: 'command',
						method: 'Runtime.evaluate',
						params: {
							expression: 'document.body.appendChild(Object.assign(document.createElement("input"), { type: "file", id: "upload" }))',
						},
					})
				).output,
			).result.result.objectId;
			const upload = {
				type: 'command' as const,
				method: 'DOM.setFileInputFiles',
				params: { objectId: input, files: ['/not-granted/secret.txt'] },
			};
			assert.match(JSON.parse((await perform(upload)).output).error.message, /BrowserFileAccessDenied/);
			assert.deepEqual(JSON.parse((await perform(upload, signal, [{ name: 'allowed.txt', dataBase64: Buffer.from('authorized content').toString('base64') }])).output).result, {});
			assert.deepEqual(
				await page.locator('#upload').evaluate(async (element: HTMLInputElement) => ({
					name: element.files![0]!.name,
					type: element.files![0]!.type,
					content: await element.files![0]!.text(),
				})),
				{ name: 'allowed.txt', type: 'text/plain', content: 'authorized content' },
			);
			await page.locator('#upload').evaluate(element => element.remove());
			const cancellation = new AbortController();
			const waiting = perform(
				{
					type: 'command',
					method: 'Runtime.evaluate',
					params: {
						expression: 'console.log("waiting for cancellation"); new Promise(() => {})',
						awaitPromise: true,
					},
				},
				cancellation.signal,
			);
			const cancelled = assert.rejects(waiting, /BrowserRequestCancelled/);
			await evaluationStarted.promise;
			cancellation.abort();
			await cancelled;
			assert.equal(
				JSON.parse(
					(
						await perform({
							type: 'command',
							method: 'Runtime.evaluate',
							params: { expression: '2 + 2', returnByValue: true },
						})
					).output,
				).result.result.value,
				4,
			);
			await perform({ type: 'command', method: 'Debugger.enable', params: {} });
			await perform({ type: 'command', method: 'Debugger.pause', params: {} });
			await perform({ type: 'close' });
			await page.locator('input').fill('after CDP', { timeout: 5000 });
			assert.equal(await page.locator('input').inputValue(), 'after CDP');
			assert.equal(page.isClosed(), false);
			socket.removeEventListener('message', receive);
		} finally {
			socket?.close();
			await context?.close();
			assert.equal(dirname(profile), profileRoot);
			await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
