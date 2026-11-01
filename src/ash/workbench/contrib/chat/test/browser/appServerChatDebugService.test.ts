import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IAgentSessionService, IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import { AppServerChatDebugService } from '../../browser/chatDebug/appServerChatDebugService.js';
import { IChatDebugService } from '../../common/chatDebugService.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import '../../browser/chat.contribution.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import type { SessionListResult } from '../../../../../platform/agentHost/common/agent.js';

suite('App Server Chat Debug service', () => {
	test('discovers sessions only on request and ignores superseded catalog reads', async () => {
		const first = new DeferredPromise<SessionListResult>();
		let reads = 0;
		using services = new InstantiationService(new ServiceCollection(
			[IAgentThreadService, {} as IAgentThreadService],
			[IAgentSessionService, { list: () => ++reads === 1 ? first.p : Promise.resolve({ sessions: [{ sessionId: 'new', title: 'Current title' }] }) } as unknown as IAgentSessionService],
		));
		using service = services.createInstance(AppServerChatDebugService);
		let updates = 0;
		using listener = service.onDidChangeAvailableSessionResources(() => updates++);
		assert.deepEqual(service.getAvailableSessionResources(), []);
		assert.equal(reads, 0);
		const older = service.refreshAvailableSessions();
		await service.refreshAvailableSessions();
		await first.complete({ sessions: [{ sessionId: 'old', title: 'Stale title', status: 'active', manager: { status: 'idle', statusChangedAtUnixMs: 0 }, threads: [] }] } as SessionListResult);
		await older;
		assert.deepEqual(service.getAvailableSessionResources().map(uri => uri.toString()), ['ash-agent-trace:/new']);
		assert.equal(service.getHistoricalSessionTitle(URI.parse('ash-agent-trace:/new')), 'Current title');
		assert.equal(updates, 1);
	});
	test('uses the injected connection only on explicit reads and validates its evidence', async () => {
		const calls: unknown[] = [];
		let sessionId = 'session';
		const threads = {
			readTrace: async (params: unknown) => { calls.push(params); return { trace: { formatVersion: 3, sessionId, threads: [], historyPrefixes: [] }, cursors: {}, hasMore: false }; },
			readTraceDiagnostics: async (params: unknown) => { calls.push(params); return { diagnostics: { formatVersion: 2, captureId: null, recordingStatus: 'recording', droppedRecords: 0, pendingRecords: 0, events: [] }, cursor: 0, hasMore: false }; },
			readTracePayload: async (params: unknown) => { calls.push(params); return { payload: { semantic: true } }; },
			readTraceGraph: async (params: unknown) => { calls.push(params); return { graph: { nodes: {}, edges: [], warnings: [] } }; },
		} as unknown as IAgentThreadService;
		const registrations = getSingletonServiceDescriptors().filter(([id]) => id === IChatDebugService);
		assert.equal(registrations.length, 1);
		using services = new InstantiationService(new ServiceCollection([IAgentThreadService, threads], [IAgentSessionService, { list: async () => ({ sessions: [] }) } as unknown as IAgentSessionService], registrations[0]!));
		const trace = services.get(IChatDebugService);
		assert.deepEqual(calls, []);
		assert.equal((await trace.readTrace('session', {})).trace.sessionId, 'session');
		assert.equal((await trace.readTraceDiagnostics('session', 0)).diagnostics.formatVersion, 2);
		assert.deepEqual(await trace.readTracePayload('session', 'capture', 'payload-1'), { semantic: true });
		assert.deepEqual(await trace.readTraceGraph('session'), { nodes: {}, edges: [], warnings: [] });
		assert.deepEqual(calls, [{ sessionId: 'session', after: {}, limit: 500 }, { sessionId: 'session', after: 0, limit: 500 }, { sessionId: 'session', captureId: 'capture', payloadId: 'payload-1' }, { sessionId: 'session' }]);
		sessionId = 'another-session';
		await assert.rejects(trace.readTrace('session', {}));
	});

	test('reads current session metadata from its owner and exports a stopped Wire capture without filtering frames', async () => {
		const calls: unknown[] = [];
		const session = { sessionId: 'remote-session', title: 'Current title', manager: { status: 'working' }, threads: [] };
		const record = { sequence: 1, raw: '{ "method": "saved" }', truncated: true, byteLength: 999 };
		using services = new InstantiationService(new ServiceCollection(
			[IAgentSessionService, { read: async (params: unknown) => { calls.push(params); return { session }; } } as unknown as IAgentSessionService],
			[IAgentThreadService, {
				stopWireLog: async (params: unknown) => { calls.push(['stop', params]); },
				readWireLog: async (params: { after: number; }) => {
					calls.push(['read', params]);
					return { captureId: 'wire', connectionId: 'remote-7', recording: false, frames: params.after === 0 ? [record] : [{ ...record, sequence: 2 }], cursor: params.after + 1, hasMore: params.after === 0, droppedFrames: 3 };
				},
			} as unknown as IAgentThreadService],
		));
		using debug = services.createInstance(AppServerChatDebugService);
		assert.equal(await debug.readSession('remote-session'), session);
		const artifact = JSON.parse(new TextDecoder().decode(await debug.exportWireLog('remote-session', 'wire')));
		assert.equal(artifact.formatVersion, 1); assert.equal(artifact.scope, 'appServerConnection');
		assert.equal(artifact.connectionId, 'remote-7'); assert.equal(artifact.droppedFrames, 3);
		assert.equal(artifact.frames.length, 2); assert.equal(artifact.frames[0].raw, record.raw);
		assert.deepEqual(calls, [{ sessionId: 'remote-session' }, ['stop', { sessionId: 'remote-session', captureId: 'wire' }],
		['read', { sessionId: 'remote-session', captureId: 'wire', after: 0, limit: 100 }], ['read', { sessionId: 'remote-session', captureId: 'wire', after: 1, limit: 100 }]]);
	});

	test('requires its transport through production constructor injection', () => {
		using services = new InstantiationService(new ServiceCollection());
		assert.throws(() => services.createInstance(AppServerChatDebugService));
	});
});
