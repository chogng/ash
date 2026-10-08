import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { expect, test } from '../../../automation/test.js';
import { AppServerProtocolClient } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { ChildProcessJsonlTransport } from '../../../../src/ash/platform/agentHost/node/childProcessJsonlTransport.js';
import { createAppServerDaemonLauncher } from '../../../../src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION } from '../../../../src/ash/platform/agentHost/common/appServerTransport.js';

async function openTrace(page: Page): Promise<void> {
	await new QuickAccess(page).runCommand('sessions.trace.open');
	await expect(page.locator('.ash-agent-trace')).toBeVisible();
}

/** Menus read current operation state when opened, including a busy export. */
async function traceAction(viewer: Locator, name: string): Promise<Locator> {
	await viewer.locator('.ash-toolbar-more-actions button').click();
	return viewer.page().getByRole('menuitem', { name, exact: true });
}
async function inspectInput(viewer: Locator, label = 'Input', body = 'Saved body'): Promise<void> {
	await viewer.getByRole('tab', { name: label, exact: true }).click();
	await viewer.getByRole('button', { name: body, exact: true }).click();
}
function selectedEvent(viewer: Locator): Locator { return viewer.locator('[role=treeitem][aria-selected=true] .ash-agent-trace-event'); }

test('Execution Trace shows loop actions, message phases and stop reasons', async ({ workbench }) => {
	await workbench.quickaccess.runCommand('ash.agentTrace.open');
	const viewer = workbench.page.locator('.ash-agent-trace');
	const decisions = [
		{ action: 'executeTools', reason: 'toolRequests', stopReason: { type: 'toolUse' }, messagePhases: ['final_answer'], toolCallCount: 1 },
		{ action: 'continue', reason: 'nonterminalMessage', stopReason: { type: 'completed' }, messagePhases: ['partial_answer'], toolCallCount: 0 },
		{ action: 'complete', reason: 'compatibleCompletion', stopReason: { type: 'completed' }, messagePhases: [null], toolCallCount: 0 },
		{ action: 'fail', reason: 'truncatedOutput', stopReason: { type: 'maxOutputTokens' }, messagePhases: ['partial_answer'], toolCallCount: 0 },
		{ action: 'superseded', reason: 'newInput', stopReason: { type: 'completed' }, messagePhases: ['final_answer'], toolCallCount: 0 },
	];
	const trace = { formatVersion: 3, sessionId: 'loop-import', historyPrefixes: [], threads: [{ threadId: 'root', events: decisions.map((decision, index) => ({ eventId: `e-${index}`, sequence: index + 1, recordedAt: 1, event: { type: 'modelResponseEvaluated', threadId: 'root', turnId: 'turn', sourceThreadSequence: 0, decision } })) }] };
	await viewer.locator('input[type=file]').setInputFiles({ name: 'loop.trace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(trace)) });
	await expect(viewer.locator('.ash-agent-trace-event')).toHaveCount(5);
	await expect(viewer.locator('.ash-agent-trace-tree')).toContainText('Execute tools · Pending tool requests · stop: Tool use · phases: Final answer');
	await expect(viewer.locator('.ash-agent-trace-tree')).toContainText('Continue generation · Nonterminal message received');
	await expect(viewer.locator('.ash-agent-trace-tree')).toContainText('Complete Turn · Completed without a known phase');
	await expect(viewer.locator('.ash-agent-trace-tree')).toContainText('Superseded by new input · New input arrived during generation');
	await viewer.getByRole('button', { name: 'Errors only', exact: true }).click();
	const failure = viewer.locator('.ash-agent-trace-event:visible');
	await expect(failure).toHaveCount(1);
	await failure.click();
	await viewer.getByRole('tree').focus();
	await viewer.getByRole('tree').press('End');
	await expect(selectedEvent(viewer)).toHaveAttribute('data-key', 'root:4');
	await expect(viewer.getByRole('tabpanel')).toContainText('maxOutputTokens');
	await viewer.getByRole('tab', { name: 'Raw record', exact: true }).click();
	await expect(viewer.getByRole('tabpanel')).toContainText('sourceThreadSequence');
});

test('Workbench opens the shared Execution Trace editor and imports a capture', async ({ workbench }) => {
	await workbench.quickaccess.runCommand('ash.agentTrace.open');
	const viewer = workbench.page.locator('.ash-agent-trace');
	await expect(viewer).toBeVisible();
	await expect(viewer.locator('.ash-agent-trace-empty')).toContainText('Open a saved conversation');
	await expect(await traceAction(viewer, 'Export trace')).toBeDisabled();
	await viewer.page().keyboard.press('Escape');
	const trace = { formatVersion: 3, sessionId: 'workbench-import', threads: [], historyPrefixes: [] };
	await viewer.locator('input[type=file]').setInputFiles({ name: 'workbench.trace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(trace)) });
	await expect(viewer.getByRole('status')).toContainText('Imported');
	await expect(await traceAction(viewer, 'Export trace')).toBeEnabled();
	await viewer.page().keyboard.press('Escape');
	await (await traceAction(viewer, 'Help')).click();
	await expect(workbench.page.getByRole('dialog', { name: 'Accessibility Help' }).getByRole('textbox')).toHaveValue(/Execution Trace[\s\S]*Hiding or closing the editor stops polling/u);
	await workbench.page.keyboard.press('Escape');
	await workbench.page.getByRole('button', { name: 'Close Execution Trace', exact: true }).click();
	await expect(viewer).toHaveCount(0);
});

test('Execution Trace imports evaluation history, nests child Threads and exports every event', async ({ target, application, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await openTrace(page);
	const viewer = page.locator('.ash-agent-trace');
	await expect(await traceAction(viewer, 'Export trace')).toBeDisabled();
	await viewer.page().keyboard.press('Escape');
	const event = (threadId: string, sequence: number, value: Record<string, unknown>): unknown => ({ threadId, eventId: `${threadId}-${sequence}`, schemaVersion: 16, sequence, recordedAt: sequence, event: { ...value, threadId } });
	const trace = {
		formatVersion: 3, sessionId: 'evaluation', futureField: 'preserved', historyPrefixes: [{ events: [] }],
		diagnostics: { formatVersion: 1, captureId: 'capture', recordingStatus: 'recording', droppedRecords: 0, events: [{ eventId: 'diagnostic-1', threadId: 'root', turnId: 'turn', sequence: 1, recordedAt: 1, event: { type: 'modelAttemptStarted', attemptId: 'attempt', requestPayload: { payloadId: 'payload-1', kind: 'coreRequest', byteLength: 1, status: 'saved', digest: 'sha256:' + '0'.repeat(64) } } }], payloads: { 'payload-1': { instructions: 'saved semantic instructions', input: [] } } },
		graph: { nodes: { attempt: { id: 'attempt', kind: 'modelAttempt', label: 'fixture-model', threadId: 'root', turnId: 'turn', eventKey: 'diagnostic:1' }, root: { id: 'root', kind: 'thread', label: 'Evaluation root', threadId: 'root', turnId: null, eventKey: 'root:1' } }, edges: [{ from: 'root', to: 'attempt', kind: 'owns' }], warnings: [] },
		threads: [
			{ threadId: 'child', events: [event('child', 1, { type: 'threadCreated', title: 'Child agent', origin: { type: 'agentSpawn', parentThreadId: 'root', parentSequence: 1 } }), event('child', 2, { type: 'turnFailed', turnId: 'child-turn', error: { message: 'fixture failure' } })] },
			{ threadId: 'root', events: [event('root', 1, { type: 'threadCreated', title: 'Evaluation root' }), event('root', 2, { type: 'modelInvocationRecorded', turnId: 'turn', record: { resolvedModel: 'fixture-model', outcome: 'completed', startedAtUnixMs: 1, completedAtUnixMs: 2, usage: { inputTokens: 10, outputTokens: 2 } } })] },
		],
	};
	await viewer.locator('input[type=file]').setInputFiles({ name: 'evaluation.trace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(trace)) });
	await expect(viewer.getByRole('status')).toContainText('Imported');
	const rootRow = viewer.getByRole('treeitem').filter({ has: viewer.locator('.ash-agent-trace-thread[data-thread-id="root"]') });
	const childRow = viewer.getByRole('treeitem').filter({ has: viewer.locator('.ash-agent-trace-thread[data-thread-id="child"]') });
	await expect(rootRow).toHaveAttribute('aria-level', '1');
	await expect(childRow).toHaveAttribute('aria-level', '2');
	await expect(viewer.locator('.ash-agent-trace-turn')).toHaveCount(2);
	await expect(viewer.locator('.ash-agent-trace-tree')).toContainText('10 input / 2 output tokens');
	await viewer.locator('.ash-agent-trace-event[data-key="diagnostic:1"]').click();
	await inspectInput(viewer);
	await expect(viewer.getByRole('tabpanel')).toContainText('saved semantic instructions');
	await expect(viewer.getByRole('tabpanel')).toContainText('Core semantic request');
	await viewer.getByRole('tab', { name: 'Relations', exact: true }).click();
	await viewer.locator('.ash-agent-trace-relation').filter({ hasText: 'Evaluation root' }).click();
	await expect(selectedEvent(viewer)).toHaveAttribute('data-key', 'root:1');
	const filter = viewer.getByRole('textbox', { name: 'Filter execution events' });
	await filter.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: 'Accessibility Help' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(filter).toBeFocused();
	await page.keyboard.press('Alt+F2');
	await expect(page.getByRole('dialog', { name: 'Accessible View' }).getByRole('textbox')).toHaveValue(/Evaluation root[\s\S]*Child agent/u);
	await page.keyboard.press('Escape');
	await expect(filter).toBeFocused();
	await viewer.getByRole('button', { name: 'Errors only', exact: true }).click();
	await expect(viewer.locator('.ash-agent-trace-event:visible')).toHaveCount(1);
	const selected = viewer.locator('.ash-agent-trace-event:visible');
	await selected.click();
	await viewer.getByRole('tree').focus();
	await page.keyboard.press('End');
	await expect(selectedEvent(viewer)).toHaveAttribute('data-key', 'child:2');
	await viewer.getByRole('tab', { name: 'Overview', exact: true }).click();
	await expect(viewer.getByRole('tabpanel')).toContainText('fixture failure');
	let exportedPath: string;
	if ('windows' in application) {
		exportedPath = testInfo.outputPath('exported.trace.json');
		await application.evaluate(({ BrowserWindow }, path) => {
			BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_event, item) => item.setSavePath(path));
		}, exportedPath);
		await (await traceAction(viewer, 'Export trace')).click();
		await expect.poll(async () => { try { return JSON.parse(await readFile(exportedPath, 'utf8')); } catch { return undefined; } }).toEqual(trace);
	} else {
		const pending = page.waitForEvent('download');
		await (await traceAction(viewer, 'Export trace')).click();
		exportedPath = (await (await pending).path())!;
	}
	expect(JSON.parse(await readFile(exportedPath, 'utf8'))).toEqual(trace);
	if (process.env.ASH_AGENT_TRACE_EVAL_FIXTURE) {
		await viewer.locator('input[type=file]').setInputFiles(process.env.ASH_AGENT_TRACE_EVAL_FIXTURE);
		await expect(viewer.getByRole('status')).toContainText('Imported');
		await viewer.getByRole('button', { name: 'Errors only', exact: true }).click();
		await filter.fill('modelInvocationRecorded');
		await expect(viewer.locator('.ash-agent-trace-tree')).toContainText('Model call · fixture-model');
		await expect(viewer.getByRole('tabpanel')).toContainText('modelInvocationRecorded');
		await filter.fill('modelRequestPrepared');
		const prepared = viewer.locator('.ash-agent-trace-event:visible').first();
		await prepared.click();
		await inspectInput(viewer);
		await expect(viewer.getByRole('tabpanel')).toContainText('after attachment materialization');
		await expect(viewer.getByRole('tabpanel')).toContainText('instructions');
	}
	await viewer.locator('input[type=file]').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"formatVersion":2}') });
	await expect(viewer.getByRole('status')).toContainText('Expected rollout format version 3');
	await page.getByRole('button', { name: 'Close Execution Trace', exact: true }).click();
	await expect(viewer).toHaveCount(0);
});

test('Execution Trace command and help use Chinese in the real Sessions window', async ({ target, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	await workbench.quickaccess.runCommand('ash.agentTrace.open');
	await expect(await traceAction(workbench.page.locator('.ash-agent-trace'), '导入 Trace')).toBeVisible();
	await workbench.page.keyboard.press('Escape');
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await expect(workbench.page.locator('.ash-agent-trace')).toHaveCount(0);
	const page = await workbench.openAgentsWindow(target.kind);
	await openTrace(page);
	const viewer = page.locator('.ash-agent-trace');
	await expect(await traceAction(viewer, '导入 Trace')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(viewer.getByRole('tab', { name: '输入', exact: true })).toBeVisible();
	await expect(viewer.getByRole('tab', { name: '关系', exact: true })).toBeVisible();
	await expect(viewer.locator('.ash-agent-trace-empty')).toContainText('打开已保存的对话');
	const trace = { formatVersion: 3, sessionId: 'loop-zh', historyPrefixes: [], threads: [{ threadId: 'root', events: [{ eventId: 'loop', sequence: 1, recordedAt: 1, event: { type: 'modelResponseEvaluated', threadId: 'root', turnId: 'turn', decision: { action: 'continue', reason: 'nonterminalMessage', stopReason: { type: 'completed' }, messagePhases: ['commentary'], toolCallCount: 0 } } }] }] };
	await viewer.locator('input[type=file]').setInputFiles({ name: 'loop-zh.trace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(trace)) });
	await expect(viewer.locator('.ash-agent-trace-tree')).toContainText('循环决策 · 继续生成 · 当前消息尚未结束任务 · 停止原因：本次生成完成 · 消息阶段：进度说明');
	await viewer.getByRole('textbox', { name: '筛选执行事件' }).fill('继续生成');
	await expect(viewer.locator('.ash-agent-trace-event:visible')).toHaveCount(1);
	await viewer.getByRole('textbox', { name: '筛选执行事件' }).fill('');
	await (await traceAction(viewer, '帮助')).click();
	await expect(page.getByRole('dialog', { name: '无障碍帮助' }).getByRole('textbox')).toHaveValue(/各 Thread 自己的顺序[\s\S]*指定定位[\s\S]*显示筛选[\s\S]*ModelService 的语义输入/u);
	await page.keyboard.press('Escape');
	if (process.env.ASH_AGENT_TRACE_EVAL_FIXTURE) {
		await viewer.locator('input[type=file]').setInputFiles(process.env.ASH_AGENT_TRACE_EVAL_FIXTURE);
		await expect(viewer.getByRole('status')).toContainText('已导入');
		await viewer.getByRole('textbox', { name: '筛选执行事件' }).fill('modelRequestPrepared');
		await viewer.locator('.ash-agent-trace-event:visible').first().click();
		await inspectInput(viewer, '输入', '已保存正文');
		await expect(viewer.getByRole('tabpanel')).toContainText('模型服务语义请求 · 附件转换后');
	}
});

test('Execution Trace opens current saved history and follows real new Turns and child Threads', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Uses real persistent history from the product App Server.');
	test.setTimeout(120_000);
	const page = await workbench.openAgentsWindow(target.kind);
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const emit = (event: string, value: unknown): void => { for (const listener of listeners.get(event) ?? []) { listener(value); } };
	let frames: ChildProcessJsonlTransport | undefined;
	let launcher: ReturnType<typeof createAppServerDaemonLauncher>['launcher'] | undefined;
	let frameSubscription: { dispose(): void; } | undefined;
	let closeSubscription: { dispose(): void; } | undefined;
	if ('evaluate' in application) {
		const host = await application.evaluate(({ app }) => ({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, electronExecutable: process.execPath, profileRoot: process.env.ASH_HOME!, sourceEnvironment: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, ASH_RG_PATH: process.env.ASH_RG_PATH, ASH_PRODUCT_SERVICES_PATH: process.env.ASH_PRODUCT_SERVICES_PATH } }));
		({ launcher } = createAppServerDaemonLauncher({ ...host, packageLocation: { appPath: host.appPath, resourcesPath: host.resourcesPath, isPackaged: false, platform: process.platform }, workspaceRoot: testWorkspace.directory, role: 'agents' }));
		await launcher.validate();
		frames = new ChildProcessJsonlTransport(launcher.launch());
		frameSubscription = frames.onFrame(frame => emit(WEB_APP_SERVER_FRAME_EVENT, { frame }));
		closeSubscription = frames.onClose(error => emit(WEB_APP_SERVER_CLOSED_EVENT, { message: error.message }));
	} else {
		await page.exposeFunction('ashTraceFixtureFrame', (frame: string) => emit(WEB_APP_SERVER_FRAME_EVENT, { frame }));
		await page.evaluate(async () => {
			const endpoint = new URL('/ash/app-server', sessionStorage.getItem('ash.appServer.endpoint')!);
			const token = sessionStorage.getItem(`ash.appServer.session:${endpoint.origin}`)!;
			endpoint.protocol = 'ws:';
			const socket = new WebSocket(endpoint, `ash-session.${token}`);
			const fixture = globalThis as typeof globalThis & { ashTraceFixtureSocket?: WebSocket; ashTraceFixtureFrame(frame: string): Promise<void>; };
			fixture.ashTraceFixtureSocket = socket;
			socket.onmessage = event => { void fixture.ashTraceFixtureFrame(String(event.data)); };
			await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('Trace fixture connection failed')); });
		});
	}
	const client = new AppServerProtocolClient({
		on(event, listener) { let group = listeners.get(event); if (!group) { group = new Set(); listeners.set(event, group); } group.add(listener); },
		off(event, listener) { listeners.get(event)?.delete(listener); },
		send(event, value) {
			if (event === WEB_APP_SERVER_CONNECT_EVENT) { emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'trace-fixture', workspaceRoot: testWorkspace.directory }); }
			else if (event === WEB_APP_SERVER_FRAME_EVENT) {
				const frame = (value as { frame: string; }).frame;
				if (frames) { void frames.send(frame); }
				else { void page.evaluate(frame => (globalThis as typeof globalThis & { ashTraceFixtureSocket: WebSocket; }).ashTraceFixtureSocket.send(frame), frame); }
			} else if (event !== WEB_APP_SERVER_DISCONNECT_EVENT) { throw new Error(`Unexpected trace fixture event ${event}`); }
		},
	});
	try {
		await client.connect();
		const session = await client.request(APP_SERVER_METHODS['session/create'], { commandId: 'trace-create', title: 'Trace live session', agent: { type: 'default' }, executionTarget: { type: 'local', root: testWorkspace.directory } });
		const sessionId = session.session.sessionId;
		const created = await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'trace-thread', sessionId, request: { type: 'createThread', title: 'Trace root' } });
		if (created.type !== 'thread') { throw new Error('Expected trace Thread'); }
		const threadId = created.value.threadId;
		const shell = async (commandId: string, command: string): Promise<string> => {
			const thread = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
			await client.request(APP_SERVER_METHODS['session/request'], { commandId, sessionId, request: { type: 'startShellTurn', threadId, expectedSequence: thread.thread.sequence, command, workingDirectory: '.', approvalMode: 'bypassPermissions' } });
			await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread.turns.at(-1)?.status).toBe('completed');
			return (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread.turns.at(-1)!.turnId;
		};
		await shell('trace-earlier-turn', 'echo trace-earlier');
		const historyTurn = await shell('trace-history-turn', 'echo trace-history');
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Trace live session' }).click();
		await openTrace(page);
		const viewer = page.locator('.ash-agent-trace');
		await expect(viewer.getByRole('status')).toContainText('Live');
		await expect(viewer.locator('.ash-agent-trace-location')).toHaveText(`Located ${threadId} / ${historyTurn}.`);
		await expect(selectedEvent(viewer)).toHaveAttribute('data-turn-id', historyTurn);
		await expect(viewer.getByRole('tabpanel')).toContainText(historyTurn);
		await expect(viewer.locator('.ash-agent-trace-tree')).toContainText('Turn completed');
		const before = Number((await viewer.locator('.ash-agent-trace-summary').textContent())!.match(/\/ (\d+) events/)![1]);
		await shell('trace-new-turn', 'echo trace-live');
		await expect.poll(async () => Number((await viewer.locator('.ash-agent-trace-summary').textContent())!.match(/\/ (\d+) events/)![1])).toBeGreaterThan(before);
		await viewer.getByRole('textbox', { name: 'Filter execution events' }).fill('trace-live');
		await expect(viewer.locator('.ash-agent-trace-location')).toContainText('hidden by the display filter');
		await expect(viewer.getByRole('tabpanel')).toContainText(historyTurn);
		await viewer.locator('.ash-agent-trace-event:visible').first().click();
		await viewer.getByRole('tab', { name: 'Raw record', exact: true }).click();
		await expect(viewer.getByRole('tabpanel')).toContainText('trace-live');
		await viewer.getByRole('textbox', { name: 'Filter execution events' }).fill('');
		const child = await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'trace-child', sessionId, request: { type: 'forkThread', parentThreadId: threadId, title: 'Trace child' } });
		if (child.type !== 'thread') { throw new Error('Expected child Thread'); }
		await viewer.getByRole('textbox', { name: 'Filter execution events' }).fill(child.value.threadId);
		await expect(viewer.getByRole('treeitem').filter({ has: viewer.locator(`.ash-agent-trace-thread[data-thread-id="${child.value.threadId}"]`) })).toHaveAttribute('aria-level', '2');
		await page.getByRole('button', { name: 'Close Execution Trace', exact: true }).click();
		await expect(viewer).toHaveCount(0);
		const afterCloseTurn = await shell('trace-after-close', 'echo trace-after-close');
		await openTrace(page);
		await expect(viewer.getByRole('status')).toContainText('Live');
		await expect(viewer.locator('.ash-agent-trace-location')).toHaveText(`Located ${threadId} / ${afterCloseTurn}.`);
		await expect(viewer.getByRole('tabpanel')).toContainText(afterCloseTurn);
		await viewer.getByRole('textbox', { name: 'Filter execution events' }).fill('trace-after-close');
		await viewer.locator('.ash-agent-trace-event:visible').first().click();
		await viewer.getByRole('tab', { name: 'Raw record', exact: true }).click();
		await expect(viewer.getByRole('tabpanel')).toContainText('trace-after-close');
	} finally {
		client.dispose(); frameSubscription?.dispose(); closeSubscription?.dispose();
		await frames?.close(); launcher?.dispose();
		if (!frames && !page.isClosed()) { await page.evaluate(() => (globalThis as typeof globalThis & { ashTraceFixtureSocket?: WebSocket; }).ashTraceFixtureSocket?.close()); }
	}
});

test('Execution Trace keeps the latest import and reviews exported evidence offline', async ({ application, workbench }, testInfo) => {
	await workbench.quickaccess.runCommand('ash.agentTrace.open');
	const page = workbench.page;
	const viewer = page.locator('.ash-agent-trace');
	await page.evaluate(() => {
		const read = File.prototype.text;
		const pending = new Map<string, (text: string) => void>();
		File.prototype.text = function (): Promise<string> {
			if (['earlier.json', 'latest.json'].includes(this.name)) { return new Promise(resolve => pending.set(this.name, resolve)); }
			return read.call(this);
		};
		(globalThis as typeof globalThis & { ashTraceImportFixture: { names(): string[]; finish(name: string, text: string): void; }; }).ashTraceImportFixture = {
			names: () => [...pending.keys()],
			finish(name, text) { pending.get(name)!(text); pending.delete(name); },
		};
	});
	const event = (sequence: number, value: Record<string, unknown>): unknown => ({ eventId: `event-${sequence}`, sequence, recordedAt: sequence, event: { ...value, threadId: 'root', turnId: 'review-turn' } });
	const trace = {
		formatVersion: 3, sessionId: 'offline-review', futureField: 'retained', historyPrefixes: [{ prefixId: 'retained-prefix', events: [] }],
		threads: [{
			threadId: 'root', events: [
				event(1, { type: 'threadCreated', title: 'Offline execution review' }),
				event(2, { type: 'turnAccepted' }),
				event(3, { type: 'itemCompleted', item: { type: 'toolCall', toolCallId: 'shell-call', name: 'shell' } }),
				event(4, { type: 'itemCompleted', item: { type: 'toolResult', toolCallId: 'shell-call', text: 'offline failure: exit 1', isError: true } }),
			]
		}],
		diagnostics: {
			formatVersion: 1, captureId: 'review-capture', recordingStatus: 'incomplete', droppedRecords: 1,
			events: [
				{ eventId: 'model-start', sequence: 1, recordedAt: 1, threadId: 'root', turnId: 'review-turn', event: { type: 'modelAttemptStarted', attemptId: 'review-model', requestPayload: { payloadId: 'payload-1', kind: 'coreRequest', byteLength: 1, status: 'saved', digest: 'sha256:' + '0'.repeat(64) } } },
				{ eventId: 'model-response', sequence: 2, recordedAt: 2, threadId: 'root', turnId: 'review-turn', event: { type: 'modelAttemptCompleted', attemptId: 'review-model', responsePayload: { payloadId: 'payload-2', kind: 'modelResponse', byteLength: 1, status: 'saved', digest: 'sha256:' + '0'.repeat(64) } } },
			],
			payloads: { 'payload-1': { instructions: 'Offline review instructions', input: [] }, 'payload-2': { output: [{ type: 'toolCall', value: { id: 'shell-call' } }] } },
		},
		graph: {
			nodes: {
				model: { id: 'model', kind: 'modelAttempt', label: 'Offline model', threadId: 'root', turnId: 'review-turn', eventKey: 'diagnostic:1' },
				tool: { id: 'tool', kind: 'toolCall', label: 'shell', threadId: 'root', turnId: 'review-turn', eventKey: 'root:3' },
				result: { id: 'result', kind: 'toolResult', label: 'failed result', threadId: 'root', turnId: 'review-turn', eventKey: 'root:4' },
			},
			edges: [{ from: 'model', to: 'tool', kind: 'requestsTool' }, { from: 'tool', to: 'result', kind: 'result' }], warnings: ['one historical record omitted'],
		},
	};
	await viewer.locator('input[type=file]').setInputFiles({ name: 'earlier.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
	await viewer.locator('input[type=file]').setInputFiles({ name: 'latest.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
	await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { ashTraceImportFixture: { names(): string[]; }; }).ashTraceImportFixture.names())).toEqual(['earlier.json', 'latest.json']);
	await page.evaluate(() => (globalThis as typeof globalThis & { ashTraceImportFixture: { finish(name: string, text: string): void; }; }).ashTraceImportFixture.finish('earlier.json', JSON.stringify({ formatVersion: 3, sessionId: 'earlier', threads: [], historyPrefixes: [] })));
	await expect(await traceAction(viewer, 'Export trace')).toBeDisabled();
	await viewer.page().keyboard.press('Escape');
	await page.evaluate(trace => (globalThis as typeof globalThis & { ashTraceImportFixture: { finish(name: string, text: string): void; }; }).ashTraceImportFixture.finish('latest.json', JSON.stringify(trace)), trace);
	await expect(viewer.getByRole('status')).toHaveText('Imported · latest.json');
	await expect(viewer.locator('.ash-agent-trace-event')).toHaveCount(6);
	await viewer.locator('.ash-agent-trace-event[data-key="diagnostic:1"]').click();
	await inspectInput(viewer);
	await expect(viewer.getByRole('tabpanel')).toContainText('Offline review instructions');
	await viewer.getByRole('tab', { name: 'Relations', exact: true }).click();
	await viewer.locator('.ash-agent-trace-relation').filter({ hasText: 'shell' }).click();
	await expect(selectedEvent(viewer)).toHaveAttribute('data-key', 'root:3');
	await viewer.getByRole('button', { name: 'Errors only', exact: true }).click();
	await expect(viewer.locator('.ash-agent-trace-event:visible')).toHaveCount(1);
	await viewer.locator('.ash-agent-trace-event[data-key="root:4"]').click();
	await viewer.getByRole('tab', { name: 'Overview', exact: true }).click();
	await expect(viewer.getByRole('tabpanel')).toContainText('offline failure: exit 1');
	let exportedPath: string;
	if ('windows' in application) {
		exportedPath = testInfo.outputPath('offline-review.json');
		await application.evaluate(({ BrowserWindow }, path) => {
			BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_event, item) => item.setSavePath(path));
		}, exportedPath);
		await (await traceAction(viewer, 'Export trace')).click();
		await expect.poll(async () => { try { return JSON.parse(await readFile(exportedPath, 'utf8')); } catch { return undefined; } }).toEqual(trace);
	} else {
		const pending = page.waitForEvent('download');
		await (await traceAction(viewer, 'Export trace')).click();
		exportedPath = (await (await pending).path())!;
	}
	const exported = await readFile(exportedPath);
	expect(JSON.parse(exported.toString())).toEqual(trace);
	await viewer.locator('input[type=file]').setInputFiles({ name: 'reviewed.json', mimeType: 'application/json', buffer: exported });
	await expect(viewer.getByRole('status')).toHaveText('Imported · reviewed.json');
	await viewer.locator('.ash-agent-trace-event[data-key="root:4"]').click();
	await expect(viewer.getByRole('tabpanel')).toContainText('offline failure: exit 1');
	await expect(viewer.getByRole('tabpanel')).toContainText('1 records omitted');
	await testInfo.attach('execution-trace-offline-review', { body: await viewer.screenshot(), contentType: 'image/png' });
});
