import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import { AppServerChatDebugService } from '../../browser/chatDebug/appServerChatDebugService.js';
import { IChatDebugService } from '../../common/chatDebugService.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import '../../browser/chat.contribution.js';

suite('App Server Chat Debug service', () => {
	test('uses the injected connection only on explicit reads and validates its evidence', async () => {
		const calls: unknown[] = [];
		let sessionId = 'session';
		const threads = {
			readTrace: async (params: unknown) => {
				calls.push(params);
				return {
					trace: { formatVersion: 3, sessionId, threads: [], historyPrefixes: [] },
					cursors: {},
					hasMore: false,
				};
			},
			readTraceDiagnostics: async (params: unknown) => {
				calls.push(params);
				return {
					diagnostics: {
						formatVersion: 2,
						captureId: null,
						recordingStatus: 'recording',
						droppedRecords: 0,
						pendingRecords: 0,
						events: [],
					},
					cursor: 0,
					hasMore: false,
				};
			},
			readTracePayload: async (params: unknown) => {
				calls.push(params);
				return { payload: { semantic: true } };
			},
			readTraceGraph: async (params: unknown) => {
				calls.push(params);
				return { graph: { nodes: {}, edges: [], warnings: [] } };
			},
		} as unknown as IAgentThreadService;
		const registrations = getSingletonServiceDescriptors().filter(([id]) => id === IChatDebugService);
		assert.equal(registrations.length, 1);
		using services = new InstantiationService(new ServiceCollection([IAgentThreadService, threads], registrations[0]!));
		const trace = services.get(IChatDebugService);
		assert.deepEqual(calls, []);
		assert.equal((await trace.readTrace('session', {})).trace.sessionId, 'session');
		assert.equal((await trace.readTraceDiagnostics('session', 0)).diagnostics.formatVersion, 2);
		assert.deepEqual(await trace.readTracePayload('session', 'capture', 'payload-1'), { semantic: true });
		assert.deepEqual(await trace.readTraceGraph('session'), { nodes: {}, edges: [], warnings: [] });
		assert.deepEqual(calls, [
			{ sessionId: 'session', after: {}, limit: 500 },
			{ sessionId: 'session', after: 0, limit: 500 },
			{ sessionId: 'session', captureId: 'capture', payloadId: 'payload-1' },
			{ sessionId: 'session' },
		]);
		sessionId = 'another-session';
		await assert.rejects(trace.readTrace('session', {}));
	});

	test('requires its transport through production constructor injection', () => {
		using services = new InstantiationService(new ServiceCollection());
		assert.throws(() => services.createInstance(AppServerChatDebugService));
	});
});
