import { createServer } from 'node:http';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import type { WebLaunchResult } from '../../../automation/playwrightWeb.js';
import { AppServerProtocolClient } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { AppServerWebSocketTransport } from '../../../../src/ash/platform/agentHost/browser/appServerWebSocketTransport.js';
import { ChildProcessJsonlTransport } from '../../../../src/ash/platform/agentHost/node/childProcessJsonlTransport.js';
import { createAppServerDaemonLauncher } from '../../../../src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';
import { APP_SERVER_METHODS, type ModelRef } from '../../../../.build/protocol/typescript/index.js';
import { decodeWebSessionInfo } from '../../../../.build/protocol/typescript/WebProtocolDecoder.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION } from '../../../../src/ash/platform/agentHost/common/appServerTransport.js';

interface ModelTraffic {
	dispose(): void;
	readonly catalogReplies: { sessionId: string; model: ModelRef | null | undefined; }[];
	readonly starts: { threadId: string; model: ModelRef | null | undefined; }[];
}

// Observe product transport traffic without replacing services or replies.
// Every recorded connection belongs to this scenario's isolated profile.
function observeModels(): void {
	const traffic: ModelTraffic = { catalogReplies: [], starts: [], dispose() {
		for (const target of watched) target.removeEventListener('message', incoming as EventListener);
		WebSocket.prototype.send = send;
		MessagePort.prototype.postMessage = post;
		methods.clear(); watched.clear();
	} };
	(window as Window & { sessionModelTraffic?: ModelTraffic; }).sessionModelTraffic = traffic;
	const methods = new Map<string | number, string>();
	const watched = new Set<EventTarget>();
	const incoming = (event: MessageEvent): void => {
		const frame = typeof event.data === 'string' ? event.data : event.data?.frame;
		if (typeof frame !== 'string') return;
		const message = JSON.parse(frame);
		if (methods.get(message.id) === 'session/catalog/read' && message.result?.session) {
			traffic.catalogReplies.push({ sessionId: message.result.session.sessionId, model: message.result.session.model });
		}
		if (message.id !== undefined) methods.delete(message.id);
	};
	const outgoing = (target: EventTarget, frame: string): void => {
		if (!watched.has(target)) { watched.add(target); target.addEventListener('message', incoming as EventListener); }
		const message = JSON.parse(frame);
		if (message.id !== undefined && message.method) methods.set(message.id, message.method);
		if (message.method === 'session/request' && message.params?.request?.type === 'startTurn') {
			traffic.starts.push({ threadId: message.params.request.threadId, model: message.params.request.model });
		}
	};
	const send = WebSocket.prototype.send;
	WebSocket.prototype.send = function (data): void {
		if (this.url.includes('/ash/app-server') && typeof data === 'string') outgoing(this, data);
		send.call(this, data);
	};
	const post = MessagePort.prototype.postMessage;
	MessagePort.prototype.postMessage = function (message, options?: Transferable[] | StructuredSerializeOptions): void {
		if (typeof message?.frame === 'string') outgoing(this, message.frame);
		post.call(this, message, Array.isArray(options) ? { transfer: options } : options);
	};
}

// Each scenario shares its product's real profile daemon. This extra connection
// seeds durable facts through the public API and is released before fixture cleanup.
async function connectProfile(application: PlaywrightApplication, web: WebLaunchResult | undefined, workspaceRoot: string): Promise<{ client: AppServerProtocolClient; close(): Promise<void>; }> {
	if (web) {
		const endpoint = new URL(web.connection.endpoint);
		const response = await fetch(new URL('/ash/session', endpoint), { method: 'POST', headers: { Authorization: `Bearer ${web.connection.token}` }, body: '', signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`Fixture authentication failed: ${response.status}`);
		const transport = new AppServerWebSocketTransport(endpoint, decodeWebSessionInfo(await response.json()));
		const client = new AppServerProtocolClient(transport);
		try { await client.connect(); } catch (error) { client.dispose(); transport.dispose(); throw error; }
		return { client, async close() { client.dispose(); transport.dispose(); } };
	}
	if (!('evaluate' in application)) throw new Error('Expected an Electron profile');
	const host = await application.evaluate(({ app }) => ({
		appPath: app.getAppPath(), resourcesPath: process.resourcesPath, electronExecutable: process.execPath,
		profileRoot: process.env.ASH_HOME!, sourceEnvironment: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, ASH_RG_PATH: process.env.ASH_RG_PATH, ASH_PRODUCT_SERVICES_PATH: process.env.ASH_PRODUCT_SERVICES_PATH },
	}));
	const { launcher } = createAppServerDaemonLauncher({ ...host, packageLocation: { appPath: host.appPath, resourcesPath: host.resourcesPath, isPackaged: false, platform: process.platform }, workspaceRoot, role: 'agents' });
	let frames: ChildProcessJsonlTransport | undefined;
	let client: AppServerProtocolClient | undefined;
	let incoming: { dispose(): void; } | undefined;
	let closed: { dispose(): void; } | undefined;
	const close = async (): Promise<void> => {
		client?.dispose(); incoming?.dispose(); closed?.dispose();
		try { await frames?.close(); } finally { launcher.dispose(); }
	};
	try {
		await launcher.validate();
		frames = new ChildProcessJsonlTransport(launcher.launch());
		const listeners = new Map<string, Set<(payload: unknown) => void>>();
		const emit = (event: string, payload: unknown): void => { for (const listener of listeners.get(event) ?? []) listener(payload); };
		incoming = frames.onFrame(frame => emit(WEB_APP_SERVER_FRAME_EVENT, { frame }));
		closed = frames.onClose(error => emit(WEB_APP_SERVER_CLOSED_EVENT, { message: error.message }));
		client = new AppServerProtocolClient({
			on(event, listener) { let group = listeners.get(event); if (!group) listeners.set(event, group = new Set()); group.add(listener); },
			off(event, listener) { listeners.get(event)?.delete(listener); },
			send(event, payload) {
				if (event === WEB_APP_SERVER_CONNECT_EVENT) emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'session-models', workspaceRoot });
				else if (event === WEB_APP_SERVER_FRAME_EVENT) { void frames!.send((payload as { frame: string; }).frame); }
				else if (event !== WEB_APP_SERVER_DISCONNECT_EVENT) throw new Error(`Unexpected model fixture event ${event}`);
			},
		});
		await client.connect();
		return { client, close };
	} catch (error) { await close(); throw error; }
}

async function selectModel(page: Page, composer: ReturnType<Page['locator']>, name: string): Promise<void> {
	await composer.locator('.ash-chat-input-model-action').press('ArrowDown');
	const picker = page.getByRole('dialog', { name: 'Choose a chat model', exact: true });
	const auto = picker.getByRole('switch', { name: 'Auto', exact: true });
	if (await auto.isChecked()) await auto.press('Space');
	const search = picker.getByRole('combobox');
	await search.fill(name);
	await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
	await search.press('Enter');
	await expect(composer.locator('.ash-chat-input-model-action')).toHaveText(name);
}

test('Persisted root and child models survive profile reopen without taking the default or another window selection', async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
	test.skip(target.appServerMode !== 'required', 'Requires the real durable Session catalog.');
	test.setTimeout(150_000);
	const provider = 'session-model-fixture';
	await workbench.page.context().addInitScript(observeModels);
	await workbench.page.evaluate(observeModels);
	const rootModel: ModelRef = { provider, model: 'root-a' };
	const childModel: ModelRef = { provider, model: 'child-b' };
	const defaultModel: ModelRef = { provider, model: 'default-c' };
	const invokedModels: string[] = [];
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [rootModel, childModel, defaultModel].map(model => ({ id: model.model })) })); return; }
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; };
		invokedModels.push(body.model);
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end('data: {"id":"model-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Isolated fixture answer"},"finish_reason":null}]}\n\ndata: {"id":"model-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	let connection: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		connection = await connectProfile(application, webAppServer, testWorkspace.directory);
		const { client } = connection;
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Model fixture has no port');
		const config = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['provider/configure'], { commandId: 'models-provider', expectedRevision: config.revision, config: {
			connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
			custom: { name: 'Isolated Session models', protocol: 'chatCompletions', order: 0, contextWindow: 32_000 },
			modelContext: Object.fromEntries([rootModel, childModel, defaultModel].map(model => [model.model, { contextWindow: 32_000 }])),
		} });
		await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-fixture-key' });
		const configured = await client.request(APP_SERVER_METHODS['config/read'], {});
		await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'models-default', expectedRevision: configured.revision, model: defaultModel });
		const created = await client.request(APP_SERVER_METHODS['session/create'], { commandId: 'models-session', title: 'Persisted model choices', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = created.session.sessionId;
		const root = await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'models-root', sessionId, request: { type: 'createThread', title: 'Root model choice' } });
		if (root.type !== 'thread') throw new Error('Expected root Thread');
		const rootThreadId = root.value.threadId;
		const start = async (threadId: string, model: ModelRef, commandId: string): Promise<void> => {
			const before = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
			await client.request(APP_SERVER_METHODS['session/request'], { commandId, sessionId, request: { type: 'startTurn', threadId, expectedSequence: before.thread.sequence, mode: 'ask', approvalMode: 'bypassPermissions', model, input: [{ type: 'text', text: 'Return the fixture answer without using tools.' }] } });
			await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread.turns.at(-1)?.status).toBe('completed');
		};
		await start(rootThreadId, rootModel, 'models-root-turn');
		const fork = await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'models-child', sessionId, request: { type: 'forkThread', parentThreadId: rootThreadId, title: 'Child model choice' } });
		if (fork.type !== 'thread') throw new Error('Expected child Thread');
		await start(fork.value.threadId, childModel, 'models-child-turn');
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId })).session?.model).toEqual(rootModel);
		expect((await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: fork.value.threadId })).thread.turns.at(-1)?.model).toEqual(childModel);

		const empty = await client.request(APP_SERVER_METHODS['session/create'], { commandId: 'models-empty', title: 'No persisted model', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const emptyThread = await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'models-empty-thread', sessionId: empty.session.sessionId, request: { type: 'createThread', title: 'Model-less root' } });
		if (emptyThread.type !== 'thread') throw new Error('Expected model-less Thread');
		expect((await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId: empty.session.sessionId })).session?.model ?? null).toBeNull();

		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('agents');
		await workbench.settingsEditor.selectCategory('models');
		const settings = workbench.page.getByRole('dialog', { name: 'Ash Settings', exact: true });
		for (const model of [rootModel, childModel, defaultModel]) {
			const enabled = settings.getByRole('switch', { name: `Enable ${model.model}`, exact: true });
			if (!await enabled.isChecked()) await enabled.press('Space');
			await expect(enabled).toBeChecked();
		}
		await workbench.page.locator('.ash-modal-editor-close').click();

		// History is the product's public Thread selection path. Keep the source
		// Workbench alive while the Agents Window independently changes its picker.
		const source = workbench.page;
		await new QuickAccess(source).runCommand('workbench.action.chat.showHistory');
		await source.locator('.ash-quick-pick .ash-list-row').filter({ hasText: 'Persisted model choices' }).filter({ hasText: 'Thread 2' }).click();
		const sourceChat = source.locator('.ash-chat-view-pane :is(.ash-chat,.ash-cowork):visible');
		await expect(sourceChat).toHaveAttribute('data-thread-id', fork.value.threadId);
		await expect(sourceChat.locator('.ash-chat-input-model-action')).toHaveText(childModel.model);
		await new QuickAccess(source).runCommand('workbench.action.chat.showHistory');
		await source.locator('.ash-quick-pick .ash-list-row').filter({ hasText: 'Persisted model choices' }).filter({ hasText: 'Thread 1' }).click();
		await expect(sourceChat).toHaveAttribute('data-thread-id', rootThreadId);
		await expect(sourceChat.locator('.ash-chat-input-model-action')).toHaveText(rootModel.model);
		let page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Persisted model choices' }).click();
		const active = (): ReturnType<Page['locator']> => page.locator('.ash-sessions-chat-slot.active:visible :is(.ash-chat,.ash-cowork)');
		await expect(active()).toHaveAttribute('data-thread-id', rootThreadId);
		await expect(active().locator('.ash-chat-input-model-action')).toHaveText(rootModel.model);
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'No persisted model' }).click();
		await expect(active()).toHaveAttribute('data-thread-id', emptyThread.value.threadId);
		await active().locator('.ash-chat-input-model-action').press('ArrowDown');
		await expect(page.getByRole('dialog', { name: 'Choose a chat model', exact: true }).getByRole('switch', { name: 'Auto', exact: true })).not.toBeChecked();
		await page.keyboard.press('Escape');
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Persisted model choices' }).click();
		await selectModel(page, active(), childModel.model);
		const catalogCount = async (): Promise<number> => page.evaluate(sessionId => (window as Window & { sessionModelTraffic?: ModelTraffic; }).sessionModelTraffic!.catalogReplies.filter(reply => reply.sessionId === sessionId).length, sessionId);
		let beforeRefresh = await catalogCount();
		await start(fork.value.threadId, childModel, 'models-manual-refresh');
		await expect.poll(catalogCount).toBeGreaterThan(beforeRefresh);
		await expect(active().locator('.ash-chat-input-model-action')).toHaveText(childModel.model);
		await active().locator('.ash-chat-input-model-action').press('ArrowDown');
		await page.getByRole('dialog', { name: 'Choose a chat model', exact: true }).getByRole('switch', { name: 'Auto', exact: true }).press('Space');
		await page.keyboard.press('Escape');
		beforeRefresh = await catalogCount();
		await start(fork.value.threadId, childModel, 'models-auto-refresh');
		await expect.poll(catalogCount).toBeGreaterThan(beforeRefresh);
		await active().locator('.ash-chat-input-model-action').press('ArrowDown');
		await expect(page.getByRole('dialog', { name: 'Choose a chat model', exact: true }).getByRole('switch', { name: 'Auto', exact: true })).toBeChecked();
		await page.keyboard.press('Escape');
		await expect(sourceChat.locator('.ash-chat-input-model-action')).toHaveText(rootModel.model);
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId })).session?.model).toEqual(rootModel);
		expect((await client.request(APP_SERVER_METHODS['config/read'], {})).model).toEqual(defaultModel);
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Chat', exact: true }).click();
		await expect(active().locator('.ash-chat-input-model-action')).toHaveText(rootModel.model);
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'No persisted model' }).click();
		await active().locator('.ash-chat-input-model-action').press('ArrowDown');
		await expect(page.getByRole('dialog', { name: 'Choose a chat model', exact: true }).getByRole('switch', { name: 'Auto', exact: true })).not.toBeChecked();
		await page.keyboard.press('Escape');
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Persisted model choices' }).click();
		page = await workbench.reopenAgentsWindow(application, page);
		await expect(active()).toHaveAttribute('data-thread-id', rootThreadId);
		await expect(active().locator('.ash-chat-input-model-action')).toHaveText(rootModel.model);
		await selectModel(page, active(), childModel.model);
		await active().getByRole('textbox', { name: 'Chat message', exact: true }).focus();
		await page.keyboard.insertText('Accept the retained model choice.');
		await active().locator('[data-action-id="ash.chat.input.send"] button').click();
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: rootThreadId })).thread.turns.at(-1)?.model).toEqual(childModel);
		await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId: rootThreadId })).thread.turns.at(-1)?.status).toBe('completed');
		await expect(sourceChat.locator('.ash-chat-input-model-action')).toHaveText(childModel.model);
		expect(invokedModels).toEqual([rootModel.model, childModel.model, childModel.model, childModel.model, childModel.model]);
		expect(await page.evaluate(() => (window as Window & { sessionModelTraffic?: ModelTraffic; }).sessionModelTraffic!.starts)).toEqual([{ threadId: rootThreadId, model: childModel }]);
		await testInfo.attach('durable-models', { body: JSON.stringify({ rootThreadId, childThreadId: fork.value.threadId, defaultModel, invokedModels, session: (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId })).session }, null, 2), contentType: 'application/json' });
		const screenshot = testInfo.outputPath('session-model-choice.png');
		await page.screenshot({ path: screenshot });
		await testInfo.attach('session-model-choice', { path: screenshot, contentType: 'image/png' });
	} finally {
		try {
			for (const page of workbench.page.context().pages()) {
				if (!page.isClosed()) await page.evaluate(() => (window as Window & { sessionModelTraffic?: ModelTraffic; }).sessionModelTraffic?.dispose());
			}
		} finally {
			try { await connection?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
		}
	}
});
