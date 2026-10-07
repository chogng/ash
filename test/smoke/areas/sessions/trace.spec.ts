import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { AppServerProtocolClient } from '../../../../src/ash/platform/app-server/browser/appServerProtocolClient.js';
import { ChildProcessJsonlTransport } from '../../../../src/ash/platform/app-server/node/childProcessJsonlTransport.js';
import { createAppServerDaemonLauncher } from '../../../../src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_DISCONNECT_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION } from '../../../../src/ash/platform/app-server/common/appServerTransport.js';

async function openTrace(page: Page, title = 'View Execution Trace'): Promise<void> {
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill(title);
	await page.locator('.ash-quick-pick').getByRole('combobox').press('Enter');
	await expect(page.locator('.ash-agent-trace')).toBeVisible();
}

test('Workbench opens the shared Execution Trace editor and imports a capture', async ({ workbench }) => {
	await workbench.quickaccess.runCommand('ash.agentTrace.open');
	const viewer = workbench.page.locator('.ash-agent-trace');
	await expect(viewer).toBeVisible();
	await expect(viewer.getByRole('status')).toContainText('Open a saved conversation');
	await expect(viewer.getByRole('button', { name: 'Export trace', exact: true })).toBeDisabled();
	const trace = { formatVersion: 3, sessionId: 'workbench-import', threads: [], historyPrefixes: [] };
	await viewer.locator('input[type=file]').setInputFiles({ name: 'workbench.trace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(trace)) });
	await expect(viewer.getByRole('status')).toContainText('Imported');
	await expect(viewer.getByRole('button', { name: 'Export trace', exact: true })).toBeEnabled();
	await viewer.getByRole('button', { name: 'Help', exact: true }).click();
	await expect(workbench.page.getByRole('dialog', { name: 'Accessibility Help' }).getByRole('textbox')).toHaveValue(/Execution Trace[\s\S]*Hiding or closing the editor stops polling/u);
	await workbench.page.keyboard.press('Escape');
	await workbench.page.getByRole('button', { name: 'Close Execution Trace', exact: true }).click();
	await expect(viewer).toHaveCount(0);
});

test('Execution Trace imports evaluation history, nests child Threads and exports every event', async ({ target, application, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await openTrace(page);
	const viewer = page.locator('.ash-agent-trace');
	await expect(viewer.getByRole('button', { name: 'Export trace', exact: true })).toBeDisabled();
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
	await expect(viewer.locator('.ash-agent-trace-thread[data-thread-id="root"] > .ash-agent-trace-children > .ash-agent-trace-thread[data-thread-id="child"]')).toBeVisible();
	await expect(viewer.locator('.ash-agent-trace-turn')).toHaveCount(2);
	await expect(viewer.locator('.ash-agent-trace-list')).toContainText('10 input / 2 output tokens');
	await viewer.locator('.ash-agent-trace-event[data-key="diagnostic:1"]').click();
	await viewer.getByRole('button', { name: 'View request / response', exact: true }).click();
	await expect(viewer.getByRole('region', { name: 'Execution event details' })).toContainText('saved semantic instructions');
	await expect(viewer.getByRole('region', { name: 'Execution event details' })).toContainText('Core semantic request');
	await viewer.getByRole('button', { name: 'View relationships', exact: true }).click();
	await viewer.locator('.ash-agent-trace-relation').filter({ hasText: 'Evaluation root' }).press('Enter');
	await expect(viewer.locator('.ash-agent-trace-event[data-key="root:1"]')).toHaveAttribute('aria-pressed', 'true');
	const filter = viewer.getByRole('textbox', { name: 'Filter execution events' });
	await filter.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: 'Accessibility Help' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(filter).toBeFocused();
	await page.keyboard.press('Alt+F2');
	await expect(page.getByRole('dialog', { name: 'Accessible View' }).getByRole('textbox')).toHaveValue(/Thread · Evaluation root[\s\S]*Thread · Child agent/u);
	await page.keyboard.press('Escape');
	await expect(filter).toBeFocused();
	await viewer.getByRole('button', { name: 'Errors only', exact: true }).click();
	await expect(viewer.locator('.ash-agent-trace-event:visible')).toHaveCount(1);
	const selected = viewer.locator('.ash-agent-trace-event:visible');
	await selected.focus();
	await page.keyboard.press('End');
	await expect(selected).toHaveAttribute('aria-pressed', 'true');
	await expect(viewer.getByRole('region', { name: 'Execution event details' })).toContainText('fixture failure');
	let exportedPath: string;
	if ('windows' in application) {
		exportedPath = testInfo.outputPath('exported.trace.json');
		await application.evaluate(({ BrowserWindow }, path) => {
			BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_event, item) => item.setSavePath(path));
		}, exportedPath);
		await viewer.getByRole('button', { name: 'Export trace', exact: true }).click();
		await expect.poll(async () => { try { return JSON.parse(await readFile(exportedPath, 'utf8')); } catch { return undefined; } }).toEqual(trace);
	} else {
		const pending = page.waitForEvent('download');
		await viewer.getByRole('button', { name: 'Export trace', exact: true }).click();
		exportedPath = (await (await pending).path())!;
	}
	expect(JSON.parse(await readFile(exportedPath, 'utf8'))).toEqual(trace);
	if (process.env.ASH_AGENT_TRACE_EVAL_FIXTURE) {
		await viewer.locator('input[type=file]').setInputFiles(process.env.ASH_AGENT_TRACE_EVAL_FIXTURE);
		await expect(viewer.getByRole('status')).toContainText('Imported');
		await viewer.getByRole('button', { name: 'Errors only', exact: true }).click();
		await filter.fill('modelInvocationRecorded');
		await expect(viewer.locator('.ash-agent-trace-list')).toContainText('Model call · fixture-model');
		await expect(viewer.getByRole('region', { name: 'Execution event details' })).toContainText('modelInvocationRecorded');
		await filter.fill('modelRequestPrepared');
		const prepared = viewer.locator('.ash-agent-trace-event:visible').first();
		await prepared.click();
		await viewer.getByRole('button', { name: 'View request / response', exact: true }).click();
		await expect(viewer.getByRole('region', { name: 'Execution event details' })).toContainText('after attachment materialization');
		await expect(viewer.getByRole('region', { name: 'Execution event details' })).toContainText('instructions');
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
	await expect(workbench.page.locator('.ash-agent-trace').getByRole('button', { name: '导入 Trace', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await expect(workbench.page.locator('.ash-agent-trace')).toHaveCount(0);
	const page = await workbench.openAgentsWindow(target.kind);
	await openTrace(page, '查看执行 Trace');
	const viewer = page.locator('.ash-agent-trace');
	await expect(viewer.getByRole('button', { name: '导入 Trace', exact: true })).toBeVisible();
	await expect(viewer.getByRole('button', { name: '查看请求／响应', exact: true })).toBeVisible();
	await expect(viewer.getByRole('button', { name: '查看执行关系', exact: true })).toBeVisible();
	await expect(viewer.getByRole('status')).toContainText('打开已保存的对话');
	await viewer.getByRole('button', { name: '帮助', exact: true }).click();
	await expect(page.getByRole('dialog', { name: '无障碍帮助' }).getByRole('textbox')).toHaveValue(/各 Thread 自己的顺序[\s\S]*ModelService 的语义输入/u);
	await page.keyboard.press('Escape');
	if (process.env.ASH_AGENT_TRACE_EVAL_FIXTURE) {
		await viewer.locator('input[type=file]').setInputFiles(process.env.ASH_AGENT_TRACE_EVAL_FIXTURE);
		await expect(viewer.getByRole('status')).toContainText('已导入');
		await viewer.getByRole('textbox', { name: '筛选执行事件' }).fill('modelRequestPrepared');
		await viewer.locator('.ash-agent-trace-event:visible').first().click();
		await viewer.getByRole('button', { name: '查看请求／响应', exact: true }).click();
		await expect(viewer.getByRole('region', { name: '执行事件详情' })).toContainText('模型服务语义请求 · 附件转换后');
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
		const shell = async (commandId: string, command: string): Promise<void> => {
			const thread = await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId });
			await client.request(APP_SERVER_METHODS['session/request'], { commandId, sessionId, request: { type: 'startShellTurn', threadId, expectedSequence: thread.thread.sequence, command, workingDirectory: '.', approvalMode: 'bypassPermissions' } });
			await expect.poll(async () => (await client.request(APP_SERVER_METHODS['session/thread/read'], { sessionId, threadId })).thread.turns.at(-1)?.status).toBe('completed');
		};
		await shell('trace-history-turn', 'echo trace-history');
		await page.locator('.ash-sessions-list-item').filter({ hasText: 'Trace live session' }).click();
		await openTrace(page);
		const viewer = page.locator('.ash-agent-trace');
		await expect(viewer.getByRole('status')).toContainText('Live');
		await expect(viewer.locator('.ash-agent-trace-list')).toContainText('Turn completed');
		const before = await viewer.locator('.ash-agent-trace-event').count();
		await shell('trace-new-turn', 'echo trace-live');
		await expect.poll(() => viewer.locator('.ash-agent-trace-event').count()).toBeGreaterThan(before);
		await viewer.getByRole('textbox', { name: 'Filter execution events' }).fill('trace-live');
		await expect(viewer.getByRole('region', { name: 'Execution event details' })).toContainText('trace-live');
		await viewer.getByRole('textbox', { name: 'Filter execution events' }).fill('');
		const child = await client.request(APP_SERVER_METHODS['session/request'], { commandId: 'trace-child', sessionId, request: { type: 'forkThread', parentThreadId: threadId, title: 'Trace child' } });
		if (child.type !== 'thread') { throw new Error('Expected child Thread'); }
		await expect(viewer.locator(`.ash-agent-trace-thread[data-thread-id="${threadId}"] > .ash-agent-trace-children > .ash-agent-trace-thread[data-thread-id="${child.value.threadId}"]`)).toBeVisible();
		await page.getByRole('button', { name: 'Close Execution Trace', exact: true }).click();
		await expect(viewer).toHaveCount(0);
		await shell('trace-after-close', 'echo trace-after-close');
		await openTrace(page);
		await expect(viewer.getByRole('status')).toContainText('Live');
		await viewer.getByRole('textbox', { name: 'Filter execution events' }).fill('trace-after-close');
		await expect(viewer.getByRole('region', { name: 'Execution event details' })).toContainText('trace-after-close');
	} finally {
		client.dispose(); frameSubscription?.dispose(); closeSubscription?.dispose();
		await frames?.close(); launcher?.dispose();
		if (!frames && !page.isClosed()) { await page.evaluate(() => (globalThis as typeof globalThis & { ashTraceFixtureSocket?: WebSocket; }).ashTraceFixtureSocket?.close()); }
	}
});
