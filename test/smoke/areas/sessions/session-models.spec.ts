import { connectProfile } from './sessionProfileFixture.js';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Workbench } from '../../../automation/workbench.js';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import type { WebLaunchResult } from '../../../automation/playwrightWeb.js';
import type { AppServerProtocolClient } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { APP_SERVER_METHODS, type ModelRef, type ProviderModelsUpdated } from '../../../../.build/protocol/typescript/index.js';

test.use({ video: 'on' });

interface ModelTraffic {
	dispose(): void;
	readonly catalogReplies: { sessionId: string; model: ModelRef | null | undefined; }[];
	readonly modelReads: string[];
	readonly starts: { threadId: string; model: ModelRef | null | undefined; }[];
}

// Observe product transport traffic without replacing services or replies.
// Every recorded connection belongs to this scenario's isolated profile.
function observeModels(): void {
	const watched = new Map<EventTarget, { methods: Map<string | number, string>; incoming: EventListener; }>();
	const send = WebSocket.prototype.send;
	const post = MessagePort.prototype.postMessage;
	const traffic: ModelTraffic = {
		catalogReplies: [], starts: [], modelReads: [], dispose() {
			for (const [target, channel] of watched) target.removeEventListener('message', channel.incoming);
			WebSocket.prototype.send = send;
			MessagePort.prototype.postMessage = post;
			watched.clear();
		}
	};
	(window as Window & { sessionModelTraffic?: ModelTraffic; }).sessionModelTraffic = traffic;
	const outgoing = (target: EventTarget, frame: string): void => {
		let channel = watched.get(target);
		if (!channel) {
			// Request IDs are local to one socket or port, including the fixture connection.
			const methods = new Map<string | number, string>();
			const incoming = ((event: MessageEvent): void => {
				const frame = typeof event.data === 'string' ? event.data : event.data?.frame;
				if (typeof frame !== 'string') return;
				const message = JSON.parse(frame);
				if (methods.get(message.id) === 'session/catalog/read' && message.result?.session) {
					traffic.catalogReplies.push({ sessionId: message.result.session.sessionId, model: message.result.session.model });
				}
				if (message.id !== undefined && !message.method) methods.delete(message.id);
			}) as EventListener;
			channel = { methods, incoming }; watched.set(target, channel); target.addEventListener('message', incoming);
		}
		const message = JSON.parse(frame);
		if (message.id !== undefined && message.method) channel.methods.set(message.id, message.method);
		if (message.method === 'model/list') traffic.modelReads.push(new Date().toISOString());
		if (message.method === 'session/request' && message.params?.request?.type === 'startTurn') {
			traffic.starts.push({ threadId: message.params.request.threadId, model: message.params.request.model });
		}
	};
	WebSocket.prototype.send = function (data): void {
		if (this.url.includes('/ash/app-server') && typeof data === 'string') outgoing(this, data);
		send.call(this, data);
	};
	MessagePort.prototype.postMessage = function (message, options?: Transferable[] | StructuredSerializeOptions): void {
		if (typeof message?.frame === 'string') outgoing(this, message.frame);
		post.call(this, message, Array.isArray(options) ? { transfer: options } : options);
	};
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

// The real observer has a five-minute remote cadence. Keep this long scenario
// opt-in: its installed Codex source is version-checked and never uses real credentials.
for (const scenario of [
	{ title: 'Persisted root and child models survive profile reopen without taking the default or another window selection', subscription: false },
	{ title: 'Rust subscription notifications update open Code and Cowork model pickers within the same account', subscription: true },
]) {
	test(scenario.title, async ({ application, target, webAppServer, workbench, testWorkspace }, testInfo) => {
		test.skip(target.appServerMode !== 'required', 'Requires the real durable Session catalog.');
		test.skip(scenario.subscription && process.env.ASH_SMOKE_SUBSCRIPTION_CATALOG_FIXTURE !== '1', 'Opt in to the isolated, version-checked Codex catalog source.');
		test.setTimeout(scenario.subscription ? 900_000 : 150_000);
		const provider = 'custom-session-model-fixture';
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
			connection = await connectProfile(application, webAppServer, testWorkspace.directory, workbench.page);
			const { client } = connection;
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Model fixture has no port');
			const config = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['provider/configure'], {
				commandId: 'models-provider', expectedRevision: config.revision, config: {
					connection: provider, provider, baseUrl: `http://127.0.0.1:${address.port}/v1`,
					custom: { name: 'Isolated Session models', protocol: 'chatCompletions', order: 0, contextWindow: 272_000 },
					modelContext: Object.fromEntries([rootModel, childModel, defaultModel].map(model => [model.model, { contextWindow: 272_000 }])),
				}
			});
			await client.request(APP_SERVER_METHODS['provider/apiKey/set'], { connection: provider, apiKey: 'isolated-fixture-key' });
			const configured = await client.request(APP_SERVER_METHODS['config/read'], {});
			await client.request(APP_SERVER_METHODS['config/update'], { commandId: 'models-default', expectedRevision: configured.revision, model: defaultModel });
			const created = await client.request(APP_SERVER_METHODS['session/create'], { commandId: 'models-session', title: 'Persisted model choices', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
			const sessionId = created.session.sessionId;
			// Session creation already owns its root; createThread would add another root branch.
			expect(created.session.threads).toHaveLength(1);
			const root = created.session.threads[0];
			if (!root || root.parentThreadId) throw new Error('Expected the created Session root');
			const rootThreadId = root.threadId;
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
			expect(empty.session.threads).toHaveLength(1);
			const emptyThread = empty.session.threads[0];
			if (!emptyThread || emptyThread.parentThreadId) throw new Error('Expected the model-less Session root');
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
			const history = (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId })).session;
			if (!history) throw new Error('Expected Session history');
			const historyThreads = history.threads.filter(thread => thread.status === 'active');
			expect(historyThreads).toHaveLength(2);
			const historyDescription = (threadId: string): string => {
				const index = historyThreads.findIndex(thread => thread.threadId === threadId);
				if (index < 0) throw new Error(`Expected history Thread ${threadId}`);
				// History labels follow catalog order; root and fork IDs are not ordered by lineage.
				return `Thread ${index + 1}`;
			};
			const source = workbench.page;
			await new QuickAccess(source).runCommand('workbench.action.chat.showHistory');
			await source.locator('.ash-quick-pick .ash-list-row').filter({ hasText: 'Persisted model choices' }).filter({ hasText: historyDescription(fork.value.threadId) }).click();
			const sourceChat = source.locator('.ash-chat-view-pane :is(.ash-chat,.ash-cowork):visible');
			await expect(sourceChat).toHaveAttribute('data-thread-id', fork.value.threadId);
			await expect(sourceChat.locator('.ash-chat-input-model-action')).toHaveText(childModel.model);
			await new QuickAccess(source).runCommand('workbench.action.chat.showHistory');
			await source.locator('.ash-quick-pick .ash-list-row').filter({ hasText: 'Persisted model choices' }).filter({ hasText: historyDescription(rootThreadId) }).click();
			await expect(sourceChat).toHaveAttribute('data-thread-id', rootThreadId);
			await expect(sourceChat.locator('.ash-chat-input-model-action')).toHaveText(rootModel.model);
			let agentsWorkbench = workbench;
			if (target.kind === 'browser') {
				// Browser navigation replaces its source page; a second authenticated page
				// keeps the first connection and its unsent selection independently observable.
				const agentsSource = await source.context().newPage();
				await agentsSource.goto(source.url(), { waitUntil: 'domcontentloaded' });
				agentsWorkbench = new Workbench(agentsSource);
				await agentsWorkbench.waitForReady();
			}
			let page = await agentsWorkbench.openAgentsWindow(target.kind);
			expect(page).not.toBe(source);
			await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
			await page.locator('.ash-sessions-list-item').filter({ hasText: 'Persisted model choices' }).click();
			const active = (): ReturnType<Page['locator']> => page.locator('.ash-sessions-chat-slot.active:visible :is(.ash-chat,.ash-cowork)');
			await expect(active()).toHaveAttribute('data-thread-id', rootThreadId);
			await expect(active().locator('.ash-chat-input-model-action')).toHaveText(rootModel.model);
			await page.locator('.ash-sessions-list-item').filter({ hasText: 'No persisted model' }).click();
			await expect(active()).toHaveAttribute('data-thread-id', emptyThread.threadId);
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
			page = await agentsWorkbench.reopenAgentsWindow(application, page);
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
			if (scenario.subscription) await verifySubscriptionUpdates(application, webAppServer, client, source, sourceChat, page, active(), defaultModel, testInfo);
			await attachJson(testInfo, 'durable-models', { rootThreadId, childThreadId: fork.value.threadId, defaultModel, invokedModels, session: (await client.request(APP_SERVER_METHODS['session/catalog/read'], { sessionId })).session });
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

}


/** Only writes the launcher-owned HOME; the real Codex source validates cache identity. */
async function verifySubscriptionUpdates(application: PlaywrightApplication, web: WebLaunchResult | undefined, client: AppServerProtocolClient, source: Page, sourceChat: ReturnType<Page['locator']>, cowork: Page, coworkChat: ReturnType<Page['locator']>, defaultModel: ModelRef, testInfo: TestInfo): Promise<void> {
	const cli = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
	expect(execFileSync(cli, ['--version'], { encoding: 'utf8' }).trim()).toBe('codex-cli 0.160.1');
	const home = web ? web.profileDirectory : 'evaluate' in application ? await application.evaluate(() => process.env.HOME) : undefined;
	if (!home) throw new Error('Expected the fixture launcher-owned HOME');
	const directory = join(home, '.codex');
	await mkdir(directory, { recursive: true });
	// This identity was verified against the installed CLI with outbound network
	// denied. The version check prevents a changed cache schema from using a remote fallback.
	const digest = createHash('sha256');
	const count = (value: number): Buffer => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer; };
	for (const value of [
		Buffer.from('models-cache-v1'), Buffer.from('OpenAI'), Buffer.from('https://chatgpt.com/backend-api/codex'), count(0), Buffer.from([1]), Buffer.from([0]),
		Buffer.from('Some(Chatgpt)'), Buffer.from('Some("catalog-fixture-account")'), Buffer.from('Some("catalog-fixture-user")'), Buffer.from('Some("catalog-fixture@example.invalid")'),
		Buffer.from('Some(Plus)'), Buffer.from('Some("plus")'), Buffer.from([0]), count(1), Buffer.from('version'), Buffer.from('0.160.1'),
	]) { digest.update(count(value.length)); digest.update(value); }
	const identity = digest.digest('hex');
	const writeCache = async (name: string, effort: 'medium' | 'high', invalid: boolean): Promise<void> => {
		// ModelId rejects whitespace after trimming; the CLI still returns this nonempty row.
		const model = {
			slug: invalid ? ' ' : 'gpt-6.1-sol', display_name: name, description: 'Offline fixture', default_reasoning_level: effort,
			supported_reasoning_levels: [{ effort: 'low', description: 'Quick fixture' }, { effort, description: 'Deep fixture' }],
			shell_type: 'shell_command', visibility: 'list', minimal_client_version: '0.1.0', supported_in_api: true, priority: 0, upgrade: null,
			base_instructions: 'Synthetic fixture instructions', model_messages: { instructions_template: 'Synthetic fixture instructions', approvals: null, auto_review: null, permissions: null },
			support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null, truncation_policy: { mode: 'bytes', limit: 10000 },
			supports_image_detail_original: false, context_window: 272000, max_context_window: 272000, experimental_supported_tools: [],
		};
		// Atomic renewal keeps the source fresh through the real five-minute tick;
		// metadata and account identity stay fixed while waiting for the notification.
		const temporary = join(directory, 'models_cache.fixture.json');
		await writeFile(temporary, JSON.stringify({ fetched_at: new Date().toISOString(), client_version: '0.160.1', identity, models: [model] }));
		await rename(temporary, join(directory, 'models_cache.json'));
	};
	const updates: { at: string; value: ProviderModelsUpdated; }[] = [];
	let accountUpdates = 0;
	using listener = client.onNotification(notification => {
		if (notification.method === 'provider/models/updated' && notification.params.connection === 'chatgpt-subscription') {
			updates.push({ at: new Date().toISOString(), value: notification.params });
			console.log(`Real subscription notification: ${JSON.stringify(updates.at(-1))}`);
		} else if (notification.method === 'account/updated' || notification.method === 'account/login/completed') { accountUpdates++; }
	});
	const initial = 'Synthetic catalog initial';
	const updated = 'Synthetic catalog updated';
	await writeFile(join(directory, 'config.toml'), 'cli_auth_credentials_store = "file"\n[features]\nsecret_auth_storage = false\n');
	await writeCache(initial, 'medium', false);
	const jwt = (value: unknown): string => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(value)).toString('base64url')}.fixture`;
	await writeFile(join(directory, 'auth.json'), JSON.stringify({
		auth_mode: 'chatgpt', OPENAI_API_KEY: null,
		tokens: { id_token: jwt({ email: 'catalog-fixture@example.invalid', 'https://api.openai.com/auth': { chatgpt_user_id: 'catalog-fixture-user', chatgpt_account_id: 'catalog-fixture-account', chatgpt_plan_type: 'plus' } }), access_token: jwt({ exp: 4102444800 }), refresh_token: 'synthetic-never-used', account_id: 'catalog-fixture-account' },
		last_refresh: new Date().toISOString(),
	}));
	await client.request(APP_SERVER_METHODS['account/read'], {});
	const waitFor = async (name: string, effort: 'medium' | 'high', invalid: boolean, from: number, timeout: number): Promise<Extract<ProviderModelsUpdated, { accountId: string; }>> => {
		let found: Extract<ProviderModelsUpdated, { accountId: string; }> | undefined;
		await expect.poll(async () => {
			await writeCache(name, effort, invalid);
			found = updates.slice(from).map(update => update.value).find((update): update is Extract<ProviderModelsUpdated, { accountId: string; }> => 'accountId' in update && (invalid ? update.result.type === 'failed' : update.result.type === 'models' && update.result.models.some(entry => entry.display_name === name)));
			return !!found;
		}, { message: `Expected real Rust ${invalid ? 'failed' : name} notification`, timeout, intervals: [1000, 5000, 10000] }).toBe(true);
		return found!;
	};
	await waitFor(initial, 'medium', false, 0, 90_000);
	const account = await client.request(APP_SERVER_METHODS['account/read'], {});
	const accountCount = accountUpdates;
	const config = await client.request(APP_SERVER_METHODS['config/read'], {});
	expect(config.model).toEqual(defaultModel);
	// Code and Cowork retain separate composer modes. Keep an explicit Auto
	// choice in Agents Code while both manually selected pickers remain open.
	const activity = cowork.locator('.ash-sessions-activity-content');
	await activity.getByRole('button', { name: 'Code', exact: true }).click();
	await coworkChat.locator('.ash-chat-input-model-action').press('ArrowDown');
	const codeAuto = cowork.getByRole('dialog', { name: 'Choose a chat model', exact: true }).getByRole('switch', { name: 'Auto', exact: true });
	if (!await codeAuto.isChecked()) await codeAuto.press('Space');
	await expect(codeAuto).toBeChecked();
	await cowork.keyboard.press('Escape');
	await activity.getByRole('button', { name: 'Chat', exact: true }).click();
	await selectModel(source, sourceChat, initial);
	await selectModel(cowork, coworkChat, initial);
	await expect(sourceChat.locator('.ash-chat-input-configuration-action')).toHaveText('Medium');
	await expect(coworkChat.locator('.ash-chat-input-configuration-action')).toHaveText('Medium');
	const picker = (page: Page): ReturnType<Page['getByRole']> => page.getByRole('dialog', { name: 'Choose a chat model', exact: true });
	for (const [page, chat] of [[source, sourceChat], [cowork, coworkChat]] as const) {
		await chat.locator('.ash-chat-input-model-action').press('ArrowDown');
		await picker(page).getByRole('combobox').fill('Synthetic catalog');
		await expect(picker(page).getByRole('menuitemradio')).toHaveCount(1);
		await expect(picker(page).getByRole('menuitemradio')).toContainText(initial);
	}
	const reads = (page: Page): Promise<number> => page.evaluate(() => (window as Window & { sessionModelTraffic?: ModelTraffic; }).sessionModelTraffic!.modelReads.length);
	const expectCodeAuto = async (): Promise<void> => {
		await cowork.keyboard.press('Escape');
		await activity.getByRole('button', { name: 'Code', exact: true }).click();
		await coworkChat.locator('.ash-chat-input-model-action').press('ArrowDown');
		await expect(codeAuto).toBeChecked();
		await cowork.keyboard.press('Escape');
		await activity.getByRole('button', { name: 'Chat', exact: true }).click();
		await expect(coworkChat.locator('.ash-chat-input-model-action')).toHaveText(updated);
		await coworkChat.locator('.ash-chat-input-model-action').press('ArrowDown');
		await picker(cowork).getByRole('combobox').fill('Synthetic catalog');
	};
	const beforeMetadataReads = await Promise.all([reads(source), reads(cowork)]);
	const beforeMetadata = updates.length;
	await writeCache(updated, 'high', false);
	console.log('Waiting for unchanged-account metadata at the real five-minute observer tick.');
	const changed = await waitFor(updated, 'high', false, beforeMetadata, 370_000);
	expect(changed).toMatchObject({ accountId: 'catalog-fixture-account', plan: 'plus', result: { type: 'models' } });
	if (changed.result.type !== 'models') throw new Error('Expected successful subscription catalog');
	const model = changed.result.models.find(entry => entry.display_name === updated);
	expect(model).toMatchObject({ model: { provider: 'openai', model: 'gpt-6.1-sol' }, default_reasoning_effort: 'high', supported_reasoning_efforts: [{ effort: 'low' }, { effort: 'high' }] });
	for (const [page, chat] of [[source, sourceChat], [cowork, coworkChat]] as const) {
		await expect(picker(page)).toBeVisible();
		await expect(picker(page).getByRole('menuitemradio')).toHaveCount(1);
		await expect(picker(page).getByRole('menuitemradio')).toContainText(updated);
		await expect(picker(page).getByRole('switch', { name: 'Auto', exact: true })).not.toBeChecked();
		await expect(chat.locator('.ash-chat-input-model-action')).toHaveText(updated);
		await expect(chat.locator('.ash-chat-input-configuration-action')).toHaveText('High');
	}
	for (const [index, page] of [source, cowork].entries()) await expect.poll(() => reads(page)).toBeGreaterThan(beforeMetadataReads[index]!);
	await expectCodeAuto();
	expect(accountUpdates).toBe(accountCount);
	expect(await client.request(APP_SERVER_METHODS['account/read'], {})).toEqual(account);
	const after = await client.request(APP_SERVER_METHODS['config/read'], {});
	expect({ model: after.model, gui: after.gui }).toEqual({ model: config.model, gui: config.gui });
	const authoritative = await client.request(APP_SERVER_METHODS['model/list'], {});
	if (!model) throw new Error('Expected the updated subscription model');
	// Provider discovery adds its source flag; global list exposes the shared
	// model metadata without that per-discovery marker (local.rs catalog owner).
	const { discovered, ...metadata } = model;
	expect(discovered).toBe(true);
	expect(authoritative.models.find(entry => entry.model.provider === 'openai' && entry.model.model === 'gpt-6.1-sol')).toEqual(metadata);
	await attachJson(testInfo, 'subscription-models-before-failure', { updates, account, config: { model: config.model, gui: config.gui }, authoritative });
	for (const [name, page] of [['code', source], ['cowork', cowork]] as const) {
		const path = testInfo.outputPath(`subscription-${name}-updated.png`);
		await page.screenshot({ path });
		await testInfo.attach(`subscription-${name}-updated`, { path, contentType: 'image/png' });
	}
	const beforeFailureReads = await Promise.all([reads(source), reads(cowork)]);
	const beforeFailure = updates.length;
	await writeCache(updated, 'high', true);
	console.log('Waiting for unchanged-account invalidResponse at the next real five-minute observer tick.');
	const failed = await waitFor(updated, 'high', true, beforeFailure, 370_000);
	expect(failed).toMatchObject({ accountId: changed.accountId, organization: changed.organization, plan: changed.plan, result: { type: 'failed', failure: { code: 'invalidResponse' } } });
	for (const [index, page] of [source, cowork].entries()) await expect.poll(() => reads(page)).toBeGreaterThan(beforeFailureReads[index]!);
	await expectCodeAuto();
	for (const [page, chat] of [[source, sourceChat], [cowork, coworkChat]] as const) {
		await expect(picker(page)).toBeVisible();
		await expect(picker(page).getByRole('menuitemradio')).toContainText(updated);
		await expect(picker(page).getByRole('switch', { name: 'Auto', exact: true })).not.toBeChecked();
		await expect(chat.locator('.ash-chat-input-model-action')).toHaveText(updated);
		await expect(chat.locator('.ash-chat-input-configuration-action')).toHaveText('High');
		await page.keyboard.press('Escape');
		await chat.locator('.ash-chat-input-configuration-action').press('ArrowDown');
		const options = page.getByRole('menu', { name: 'Model options', exact: true });
		await expect(options.getByRole('menuitemradio', { name: 'High', exact: true })).toBeChecked();
		await expect(options.getByRole('menuitemradio', { name: 'Low', exact: true })).not.toBeChecked();
		await expect(options.getByRole('menuitemradio', { name: 'Medium', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
	}
	expect(accountUpdates).toBe(accountCount);
	const final = await client.request(APP_SERVER_METHODS['config/read'], {});
	expect({ model: final.model, gui: final.gui }).toEqual({ model: config.model, gui: config.gui });
	expect((await client.request(APP_SERVER_METHODS['model/list'], {})).models.find(entry => entry.model.provider === 'openai' && entry.model.model === 'gpt-6.1-sol')).toEqual(metadata);
	await attachJson(testInfo, 'subscription-model-notifications', { updates, account, accountUpdates: accountCount, cacheIdentity: identity, cliVersion: '0.160.1', beforeMetadataReads, beforeFailureReads, finalReads: await Promise.all([reads(source), reads(cowork)]) });
}


async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
	const path = testInfo.outputPath(`${name}.json`);
	await writeFile(path, JSON.stringify(value, null, 2) + '\n');
	await testInfo.attach(name, { path, contentType: 'application/json' });
}
