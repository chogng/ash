import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { registerAction2, MenuId, MenusRegistry, isMenuItem } from '../../../../../platform/actions/common/actions.js';
import { IAppServerApi, type AppServerConnectionState } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IAgentSessionService } from '../../../../../platform/agentHost/common/agentService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ILoggerService, NullLoggerService, type ILogFile, type ILogFileReadResult, type ILogFileService } from '../../../../../platform/log/common/log.js';
import { INotificationService, type NotificationMessage } from '../../../../../platform/notification/common/notification.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { IOutputService, type IOutputChannel } from '../../../../services/output/common/output.js';
import { IChatDebugService } from '../../common/chatDebugService.js';
import type { AgentTracePage, AgentTraceDiagnosticPage } from '../../common/chatDebugEvents.js';
import { ExportAgentHostDebugLogsAction } from '../../browser/actions/exportAgentHostDebugLogsAction.js';

class ExportFixture extends Disposable {
	readonly dom = new JSDOM('<!doctype html><body></body>');
	readonly services = this._register(new InstantiationService());
	readonly states = this._register(new Emitter<AppServerConnectionState>());
	readonly downloads: Blob[] = [];
	readonly names: string[] = [];
	readonly notifications: { severity: string; message: string; }[] = [];
	readonly reads: string[] = [];
	readonly traceSessions: string[] = [];
	readonly diagnosticSessions: string[] = [];
	readonly hostSessions: string[] = [];
	processLogs: IAgentSessionService['collectDebugLogs'] = async () => ({ files: [{ name: 'app-server.log', bytes: new TextEncoder().encode('owning host process\n'), truncated: false }], omittedFiles: 0 });
	payload: (capture: string, payload: string) => Promise<unknown> = async () => { throw new Error('No saved payload expected'); };
	active: { sessionId: string; threadId: string; } | undefined = { sessionId: 'selected', threadId: 'chat-1' };
	generation = 1;
	listeners = 0;
	cancel: (() => void) | undefined;
	files: ILogFile[] = [
		{ id: 'current/main.log', source: 'main', format: 'jsonl', live: true, currentWindow: false },
		{ id: 'current/window-1.log', source: 'window-1', format: 'jsonl', live: true, currentWindow: true },
		{ id: 'current/window-1.log.1', source: 'window-1', format: 'jsonl', live: false, currentWindow: false },
		{ id: 'app-server', source: 'app-server', format: 'text', live: true, currentWindow: false },
		{ id: 'current/window-2.log', source: 'window-2', format: 'jsonl', live: true, currentWindow: false },
		{ id: 'previous/main.log', source: 'main', format: 'jsonl', live: false, currentWindow: false },
	];
	read: (id: string) => Promise<ILogFileReadResult> = async id => ({ text: `日志 ${id}\n`, cursor: { generation: '1', offset: 20 }, gap: false });
	trace: (sessionId: string, after: Readonly<Record<string, number>>) => Promise<AgentTracePage> = async sessionId => ({
		trace: { formatVersion: 3, sessionId, threads: [], historyPrefixes: [] }, cursors: {}, hasMore: false,
	});
	diagnostics: () => Promise<AgentTraceDiagnosticPage> = async () => ({
		diagnostics: { formatVersion: 2, captureId: null, recordingStatus: 'disabled', droppedRecords: 0, pendingRecords: 0, events: [] }, cursor: 0, hasMore: false,
	});
	channels: IOutputChannel[] = [];
	readonly commands: CommandService;

	constructor(persistentLogs = true) {
		super();
		const fixture = this;
		const logs: ILogFileService = {
			list: async () => this.files,
			read: async id => { this.reads.push(id); return await this.read(id); },
		};
		this.services.registerInstance(ILoggerService, Object.assign(new NullLoggerService(), { files: persistentLogs ? logs : undefined }));
		this.services.registerInstance(IChatSessionNavigationService, {
			getActiveConversation: () => this.active,
		} as IChatSessionNavigationService);
		this.services.registerInstance(IOutputService, { get channels() { return fixture.channels; } } as unknown as IOutputService);
		this.services.registerInstance(IChatDebugService, {
			readTrace: async (id, after) => { this.traceSessions.push(id); return await this.trace(id, after); },
			readTraceDiagnostics: async id => { this.diagnosticSessions.push(id); return await this.diagnostics(); },
			readTraceGraph: async () => { throw new Error('Graph is not part of this export'); },
			readTracePayload: async (_session, capture, payload) => this.payload(capture, payload),
		});
		this.services.registerInstance(IAgentSessionService, { collectDebugLogs: async (params, signal) => { this.hostSessions.push(params.sessionId); return await this.processLogs(params, signal); } } as IAgentSessionService);
		this.services.registerInstance(IAppServerApi, {
			get connectionGeneration() { return fixture.generation; },
			onConnectionState: (listener: (state: AppServerConnectionState) => void) => {
				this.listeners++;
				const registration = this.states.event(listener);
				return { dispose: () => { this.listeners--; registration.dispose(); } };
			},
		} as IAppServerApi);
		this.services.registerInstance(IProgressService, {
			withProgress: async (_options, task, onDidCancel) => {
				this.cancel = onDidCancel;
				return await task({ report: () => { } });
			},
		});
		const recordNotification = (severity: string, messages: NotificationMessage | NotificationMessage[]): void => {
			for (const message of Array.isArray(messages) ? messages : [messages]) {
				this.notifications.push({ severity, message: typeof message === 'string' ? message : message.message });
			}
		};
		this.services.registerInstance(INotificationService, {
			notify: () => { throw new Error('Unexpected notification'); },
			info: message => recordNotification('info', message),
			warn: message => recordNotification('warning', message),
			error: message => recordNotification('error', message),
		});
		this.services.registerInstance(ILayoutService, { mainContainer: this.dom.window.document.body } as ILayoutService);
		this.dom.window.URL.createObjectURL = blob => { assert(blob instanceof Blob); this.downloads.push(blob); return 'blob:debug-logs'; };
		this.dom.window.URL.revokeObjectURL = () => { };
		this.dom.window.HTMLAnchorElement.prototype.click = function () { fixture.names.push(this.download); };
		this._register(registerAction2(ExportAgentHostDebugLogsAction));
		this.commands = this._register(new CommandService(this.services));
	}

	run(): Promise<void> { return this.commands.executeCommand(ExportAgentHostDebugLogsAction.ID); }

	protected override disposeCore(): void {
		this.dom.window.close();
		super.disposeCore();
	}
}

/** Check ZIP headers and central-directory offsets, with Node's independent CRC implementation. */
async function unzip(blob: Blob): Promise<Map<string, string>> {
	const bytes = Buffer.from(await blob.arrayBuffer());
	const result = new Map<string, string>();
	const entries: { path: string; offset: number; crc: number; size: number; }[] = [];
	let offset = 0;
	while (bytes.readUInt32LE(offset) === 0x04034b50) {
		assert.equal(bytes.readUInt16LE(offset + 8), 0);
		const size = bytes.readUInt32LE(offset + 18);
		const nameLength = bytes.readUInt16LE(offset + 26);
		const path = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
		const content = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
		assert.equal(bytes.readUInt32LE(offset + 14), crc32(content));
		assert.equal(bytes.readUInt16LE(offset + 6), 0x800);
		assert(!result.has(path));
		result.set(path, content.toString('utf8'));
		entries.push({ path, offset, size, crc: crc32(content) });
		offset += 30 + nameLength + size;
	}
	const directoryOffset = offset;
	for (const entry of entries) {
		assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
		assert.equal(bytes.readUInt32LE(offset + 16), entry.crc);
		assert.equal(bytes.readUInt32LE(offset + 20), entry.size);
		assert.equal(bytes.readUInt32LE(offset + 42), entry.offset);
		const nameLength = bytes.readUInt16LE(offset + 28);
		assert.equal(bytes.subarray(offset + 46, offset + 46 + nameLength).toString(), entry.path);
		offset += 46 + nameLength;
	}
	assert.equal(bytes.readUInt32LE(offset), 0x06054b50);
	assert.equal(bytes.readUInt16LE(offset + 10), entries.length);
	assert.equal(bytes.readUInt32LE(offset + 12), offset - directoryOffset);
	assert.equal(bytes.readUInt32LE(offset + 16), directoryOffset);
	assert.equal(offset + 22, bytes.length);
	return result;
}

suite('Export Agent Host debug logs', () => {
	test('exports selected-chat and subagent bodies without collecting an independent peer chat', async () => {
		using fixture = new ExportFixture();
		fixture.trace = async sessionId => ({
			trace: {
				formatVersion: 3, sessionId, historyPrefixes: [], threads: [
					{ threadId: 'child', events: [{ eventId: 'child-created', sequence: 1, recordedAt: 0, event: { type: 'threadCreated', threadId: 'child', origin: { type: 'agentSpawn', parentThreadId: 'chat-1' } } }] },
					{ threadId: 'peer', events: [{ eventId: 'peer-created', sequence: 1, recordedAt: 0, event: { type: 'threadCreated', threadId: 'peer', origin: { type: 'fork', forkedFromId: 'chat-1' } } }] },
				]
			}, cursors: { child: 1, peer: 1 }, hasMore: false
		});
		fixture.diagnostics = async () => ({
			diagnostics: {
				formatVersion: 2, captureId: 'capture', recordingStatus: 'recording', droppedRecords: 0, pendingRecords: 0,
				events: ['chat-1', 'child', 'peer'].map((threadId, index) => ({
					eventId: `event-${index}`, sequence: index + 1, recordedAt: 0, threadId, turnId: null,
					event: { type: 'modelRequestPrepared', requestPayload: { payloadId: `payload-${index + 1}`, kind: 'coreRequest', byteLength: 10, status: 'saved', digest: `sha256:${'a'.repeat(64)}` } }
				})),
			}, cursor: 3, hasMore: false
		});
		const reads: string[] = [];
		fixture.payload = async (_capture, id) => { reads.push(id); return { id }; };
		await fixture.run();
		const files = await unzip(fixture.downloads[0]);
		assert.deepEqual(reads, ['payload-1', 'payload-2']);
		assert.deepEqual(JSON.parse(files.get('manifest.json')!).coverage.requestPayloads.threadIds, ['chat-1', 'child']);
	});
	test('exports all saved body kinds, deduplicates references and keeps bodies larger than one MiB', async () => {
		using fixture = new ExportFixture();
		const kinds = ['coreRequest', 'materializedRequest', 'modelResponse', 'partialOutput', 'hookExecution'];
		fixture.diagnostics = async () => ({
			diagnostics: {
				formatVersion: 2, captureId: 'capture', recordingStatus: 'recording', droppedRecords: 0, pendingRecords: 0,
				events: [...kinds, kinds[0]].map((kind, index) => ({
					eventId: `event-${index}`, sequence: index + 1, recordedAt: 0, threadId: 'chat-1', turnId: null,
					event: { type: 'modelRequestPrepared', requestPayload: { payloadId: `payload-${index === 5 ? 1 : index + 1}`, kind, byteLength: 2 * 1024 * 1024, status: 'saved', digest: `sha256:${'a'.repeat(64)}` } }
				})),
			}, cursor: 6, hasMore: false
		});
		const reads: string[] = [];
		fixture.payload = async (capture, payload) => { assert.equal(capture, 'capture'); reads.push(payload); return { body: payload === 'payload-1' ? 'x'.repeat(2 * 1024 * 1024) : payload }; };
		await fixture.run();
		const files = await unzip(fixture.downloads[0]);
		const manifest = JSON.parse(files.get('manifest.json')!);
		assert.deepEqual(reads, ['payload-1', 'payload-2', 'payload-3', 'payload-4', 'payload-5']);
		assert.deepEqual(manifest.coverage.requestPayloads.references.map((entry: { kind: string; status: string; }) => [entry.kind, entry.status]), kinds.map(kind => [kind, 'saved']));
		assert.equal(JSON.parse(files.get('session/payloads/1.json')!).body.length, 2 * 1024 * 1024);
	});

	test('retains omitted and failed body references while exporting readable bodies', async () => {
		using fixture = new ExportFixture();
		fixture.diagnostics = async () => ({
			diagnostics: {
				formatVersion: 2, captureId: 'capture', recordingStatus: 'incomplete', droppedRecords: 1, pendingRecords: 1,
				events: [1, 2, 3].map(index => ({
					eventId: `event-${index}`, sequence: index, recordedAt: 0, threadId: 'chat-1', turnId: null,
					event: { type: 'modelRequestPrepared', requestPayload: { payloadId: `payload-${index}`, kind: 'coreRequest', byteLength: 10, status: index === 3 ? 'omitted' : 'saved', digest: `sha256:${'a'.repeat(64)}` } }
				})),
			}, cursor: 3, hasMore: false
		});
		fixture.payload = async (_capture, payload) => { if (payload === 'payload-1') throw new Error('Digest mismatch'); return { input: 'saved request' }; };
		await fixture.run();
		const files = await unzip(fixture.downloads[0]);
		const manifest = JSON.parse(files.get('manifest.json')!);
		assert.deepEqual(manifest.coverage.requestPayloads.references.map((entry: { status: string; }) => entry.status), ['failed', 'saved', 'omitted']);
		assert(manifest.issues.some((issue: { reason: string; }) => issue.reason === 'notRecorded'));
		assert(manifest.issues.some((issue: { reason: string; }) => issue.reason === 'truncated'));
		assert.equal(fixture.notifications[0].severity, 'warning');
		assert(files.has('session/payloads/2.json'));
	});

	test('rejects a replacement capture between diagnostic pages', async () => {
		using fixture = new ExportFixture();
		let page = 0;
		fixture.diagnostics = async () => ({ diagnostics: { formatVersion: 2, captureId: ++page === 1 ? 'original' : 'replacement', recordingStatus: 'recording', droppedRecords: 0, pendingRecords: 0, events: [] }, cursor: page, hasMore: page === 1 });
		await fixture.run();
		const files = await unzip(fixture.downloads[0]);
		const manifest = JSON.parse(files.get('manifest.json')!);
		assert.equal(manifest.coverage.requestPayloads.captureId, 'original');
		assert(!files.has('session/diagnostics-2.json'));
		assert(manifest.issues.some((issue: { source: string; reason: string; }) => issue.source === 'sessionDiagnostics' && issue.reason === 'readFailed'));
	});

	test('keeps local evidence when the owning host log collection fails', async () => {
		using fixture = new ExportFixture();
		fixture.processLogs = async () => { throw new Error('Remote host disconnected'); };
		await fixture.run();
		const files = await unzip(fixture.downloads[0]);
		const manifest = JSON.parse(files.get('manifest.json')!);
		assert.equal(manifest.coverage.sessionHostProcessLogs, 'unavailable');
		assert(files.has('logs/1.log'));
		assert(manifest.issues.some((issue: { source: string; }) => issue.source === 'sessionHostLogs'));
	});
	test('command exports host logs, provider logs and session evidence as a valid ZIP', async () => {
		using fixture = new ExportFixture();
		fixture.channels = [
			{ id: 'provider/../日志', kind: 'log', getText: () => 'provider diagnostic\n' } as IOutputChannel,
			{ id: 'saved-log.other-window', kind: 'log', getText: () => { throw new Error('Do not export another window or an older saved log'); } } as unknown as IOutputChannel,
		];
		await fixture.run();
		assert.deepEqual(fixture.names, ['ash-agent-host-debug-logs.zip']);
		const files = await unzip(fixture.downloads[0]);
		assert.deepEqual(fixture.reads, ['current/main.log', 'current/window-1.log', 'current/window-1.log.1', 'app-server']);
		assert.equal(files.get('logs/2.log'), '日志 current/window-1.log\n');
		assert.equal(files.get('output/6.log'), 'provider diagnostic\n');
		const manifest = JSON.parse(files.get('manifest.json')!);
		assert.deepEqual(manifest.conversation, fixture.active);
		assert.deepEqual(manifest.issues, []);
		assert.equal(manifest.coverage.sessionHostProcessLogs, 'collected');
		assert.equal(manifest.coverage.requestPayloads.recordingStatus, 'disabled');
		assert.deepEqual(fixture.hostSessions, ['selected']);
		assert.equal(files.get('host/1.log'), 'owning host process\n');
		assert(files.has('session/trace-1.json'));
		assert(files.has('session/diagnostics-1.json'));
		assert.equal(fixture.listeners, 0);
		assert.equal(fixture.notifications[0].severity, 'info');
	});

	test('freezes the selected conversation and shares an in-flight command across repeat invocations', async () => {
		using fixture = new ExportFixture();
		const entered = new DeferredPromise<void>();
		const read = new DeferredPromise<ILogFileReadResult>();
		fixture.read = async () => { await entered.complete(); return await read.p; };
		const first = fixture.run();
		await entered.p;
		fixture.active = { sessionId: 'other', threadId: 'chat-2' };
		const second = fixture.run();
		await read.complete({ text: 'log\n', cursor: { generation: '1', offset: 4 }, gap: false });
		await Promise.all([first, second]);
		assert.equal(fixture.downloads.length, 1);
		assert.deepEqual(fixture.traceSessions, ['selected']);
		assert.deepEqual(fixture.diagnosticSessions, ['selected']);
		const files = await unzip(fixture.downloads[0]);
		assert.deepEqual(JSON.parse(files.get('manifest.json')!).conversation, { sessionId: 'selected', threadId: 'chat-1' });
	});

	test('cancellation waits for the bounded read, starts no more reads and downloads nothing', async () => {
		using fixture = new ExportFixture();
		const entered = new DeferredPromise<void>();
		const read = new DeferredPromise<ILogFileReadResult>();
		fixture.read = async () => { await entered.complete(); return await read.p; };
		let settled = false;
		const operation = fixture.run().then(() => { settled = true; });
		await entered.p;
		fixture.cancel!();
		assert.equal(settled, false);
		await read.complete({ text: 'late log\n', cursor: { generation: '1', offset: 9 }, gap: false });
		await operation;
		assert.deepEqual(fixture.reads, ['current/main.log']);
		assert.deepEqual(fixture.traceSessions, []);
		assert.deepEqual(fixture.downloads, []);
		assert.deepEqual(fixture.notifications, []);
		assert.equal(fixture.listeners, 0);
	});

	test('reconnection rejects late backend evidence and preserves client logs as a partial export', async () => {
		using fixture = new ExportFixture();
		const entered = new DeferredPromise<void>();
		const page = new DeferredPromise<AgentTracePage>();
		fixture.trace = async () => { await entered.complete(); return await page.p; };
		const operation = fixture.run();
		await entered.p;
		fixture.generation++;
		fixture.states.fire('restarting');
		await page.complete({ trace: { formatVersion: 3, sessionId: 'selected', threads: [], historyPrefixes: [] }, cursors: {}, hasMore: false });
		await operation;
		const files = await unzip(fixture.downloads[0]);
		assert(files.has('logs/1.log'));
		assert(!files.has('session/trace-1.json'));
		assert.deepEqual(fixture.diagnosticSessions, []);
		assert.deepEqual(JSON.parse(files.get('manifest.json')!).issues.map((issue: { source: string; }) => issue.source), ['sessionTrace', 'sessionDiagnostics']);
		assert.equal(fixture.notifications[0].severity, 'warning');
		assert.equal(fixture.listeners, 0);
	});

	test('records source failures, bounded tails and pagination limits without failing the whole bundle', async () => {
		using fixture = new ExportFixture();
		fixture.read = async id => {
			if (id === 'app-server') throw new Error('log unavailable');
			return { text: id.includes('window') ? 'x'.repeat(16 * 1024 * 1024 + 1) : 'tail\n', cursor: { generation: '1', offset: 5 }, gap: id.includes('main') };
		};
		fixture.trace = async (sessionId, after) => ({ trace: { formatVersion: 3, sessionId, threads: [], historyPrefixes: [] }, cursors: { thread: (after.thread ?? 0) + 1 }, hasMore: true });
		await fixture.run();
		const files = await unzip(fixture.downloads[0]);
		const issues = JSON.parse(files.get('manifest.json')!).issues;
		assert(issues.some((issue: { reason: string; }) => issue.reason === 'truncated'));
		assert(issues.some((issue: { reason: string; }) => issue.reason === 'byteLimit'));
		assert(issues.some((issue: { reason: string; }) => issue.reason === 'readFailed'));
		assert(issues.some((issue: { reason: string; }) => issue.reason === 'pageLimit'));
		assert.equal(fixture.traceSessions.length, 64);
		assert.equal(fixture.notifications[0].severity, 'warning');
	});

	test('reports absent host sources and exports retained logs without an active conversation', async () => {
		using fixture = new ExportFixture(false);
		fixture.active = undefined;
		fixture.channels = [{ id: 'retained', kind: 'log', getText: () => 'retained\n' } as IOutputChannel];
		await fixture.run();
		const files = await unzip(fixture.downloads[0]);
		const manifest = JSON.parse(files.get('manifest.json')!);
		assert.deepEqual(manifest.issues, [{ source: 'hostLogs', reason: 'unavailable' }]);
		assert.equal(manifest.conversation, null);
		assert.deepEqual(fixture.traceSessions, []);
		assert.equal(files.get('output/1.log'), 'retained\n');
	});

	test('keeps the manifest inside the file and byte budgets', async () => {
		using fixture = new ExportFixture(false);
		fixture.active = undefined;
		fixture.channels = Array.from({ length: 70 }, (_, index) => ({ id: `channel-${index}`, kind: 'log', getText: () => 'x'.repeat(1024 * 1024) } as IOutputChannel));
		await fixture.run();
		const files = await unzip(fixture.downloads[0]);
		const manifest = JSON.parse(files.get('manifest.json')!);
		assert(files.size <= manifest.limits.maxFiles);
		assert(fixture.downloads[0].size <= manifest.limits.maxBundleBytes);
		assert(manifest.issues.some((issue: { reason: string; }) => issue.reason === 'byteLimit'));
	});

	test('localizes the command and partial-export notification in Simplified Chinese', async () => {
		initializeTestLocalization('zh-CN');
		try {
			using fixture = new ExportFixture(false);
			fixture.active = undefined;
			const item = MenusRegistry.getMenuItems(MenuId.CommandPalette).find(item => isMenuItem(item) && item.command.id === ExportAgentHostDebugLogsAction.ID);
			assert(item && isMenuItem(item));
			assert.deepEqual(item.command.title, { original: 'Export Agent Host Debug Logs…', value: '导出 Agent Host 调试日志…' });
			await fixture.run();
			assert.match(fixture.notifications[0].message, /调试日志已导出，但有 1 项收集问题/);
		} finally { resetNlsResolver(); }
	});
});
