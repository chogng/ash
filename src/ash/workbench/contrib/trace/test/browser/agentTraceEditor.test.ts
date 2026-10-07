import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IContextKeyService, ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IChatService, type ThreadSubscription, type ThreadUpdateEnvelope } from '../../../../services/chat/common/chatService.js';
import type { AgentTracePage } from '../../../../services/chat/common/agentTrace.js';
import { registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
import { AgentTraceEditor } from '../../browser/agentTraceEditor.js';

suite('Execution Trace editor', () => {
	test('discovers child Threads through shared Session invalidation without Sessions services', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			using configuration = new InMemoryConfigurationService();
			using context = new ContextKeyService();
			using changes = new Emitter<{ sessionId: string; agentTreeChanged: boolean; }>();
			const discovered = new DeferredPromise<void>();
			const subscribed: string[] = [];
			const released: string[] = [];
			let reads = 0;
			services.registerInstance(IConfigurationService, configuration);
			services.registerInstance(IContextKeyService, context);
			services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
			services.registerInstance(IChatService, {
				onDidChangeSession: changes.event,
				onDidUpdateThread: Event.None,
				onDidBecomeReady: Event.None,
				readTrace: async (_session: string, after: Readonly<Record<string, number>>): Promise<AgentTracePage> => {
					reads++;
					if (reads > 1) { assert.deepEqual(after, { root: 1 }); }
					const threads = reads === 1 ? ['root'] : ['root', 'child'];
					return {
						trace: {
							formatVersion: 3, sessionId: 's', historyPrefixes: [],
							threads: threads.map(threadId => ({ threadId, events: after[threadId] ? [] : [{
								eventId: `${threadId}-1`, sequence: 1, recordedAt: 1,
								event: { type: 'threadCreated', threadId, title: threadId, origin: threadId === 'child' ? { type: 'agentSpawn', parentThreadId: 'root', parentSequence: 1 } : undefined },
							}] })),
						},
						cursors: Object.fromEntries(threads.map(threadId => [threadId, 1])), hasMore: false,
					};
				},
				readTraceDiagnostics: async () => {
					if (reads > 1) { void discovered.complete(); }
					return { diagnostics: { formatVersion: 1, captureId: null, recordingStatus: 'disabled', droppedRecords: 0, events: [] }, cursor: 0, hasMore: false };
				},
				subscribeThread: async (_session: string, threadId: string) => {
					subscribed.push(threadId);
					return { thread: { sequence: 1 } } as ThreadSubscription;
				},
				unsubscribeThread: async (_session: string, threadId: string) => { released.push(threadId); },
			} as unknown as IChatService);
			using pane = registerTestComponentServices(services).createInstance(AgentTraceEditor);
			pane.create(dom.window.document.body);
			await pane.setInput({ resource: URI.parse('ash-agent-trace:/s') }, new AbortController().signal);
			changes.fire({ sessionId: 'other', agentTreeChanged: true });
			changes.fire({ sessionId: 's', agentTreeChanged: false });
			await discovered.p;
			await Promise.resolve();
			assert.equal(reads, 2);
			assert.deepEqual(subscribed, ['root', 'child']);
			assert.equal(dom.window.document.querySelectorAll('.ash-agent-trace-thread[data-thread-id="root"] > .ash-agent-trace-children > .ash-agent-trace-thread[data-thread-id="child"]').length, 1);
			pane.clearInput();
			changes.fire({ sessionId: 's', agentTreeChanged: true });
			assert.deepEqual(released, ['root', 'child']);
			assert.equal(reads, 2);
		} finally { dom.window.close(); }
	});

	test('loads selected evidence only on demand and ignores a response after closing', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			using configuration = new InMemoryConfigurationService();
			using context = new ContextKeyService();
			const requested = new DeferredPromise<void>();
			const evidence = new DeferredPromise<unknown>();
			let payloadReads = 0;
			services.registerInstance(IConfigurationService, configuration);
			services.registerInstance(IContextKeyService, context);
			services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
			services.registerInstance(IChatService, {
				onDidChangeSession: Event.None, onDidUpdateThread: Event.None, onDidBecomeReady: Event.None,
				readTrace: async () => ({ trace: { formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [{ threadId: 'root', events: [] }] }, cursors: { root: 0 }, hasMore: false }),
				readTraceDiagnostics: async () => ({ diagnostics: { formatVersion: 1, captureId: 'capture', recordingStatus: 'recording', droppedRecords: 0, events: [{ eventId: 'e', threadId: 'root', turnId: 'turn', sequence: 1, recordedAt: 1, event: { type: 'modelAttemptStarted', attemptId: 'attempt', requestPayload: { payloadId: 'payload-1', kind: 'coreRequest', byteLength: 1, status: 'saved', digest: 'sha256:' + '0'.repeat(64) } } }] }, cursor: 1, hasMore: false }),
				readTracePayload: async (session: string, capture: string, payload: string) => { assert.deepEqual([session, capture, payload], ['s', 'capture', 'payload-1']); payloadReads++; void requested.complete(); return evidence.p; },
				subscribeThread: async () => ({ thread: { sequence: 0 } }), unsubscribeThread: async () => { },
			} as unknown as IChatService);
			using pane = registerTestComponentServices(services).createInstance(AgentTraceEditor);
			pane.create(dom.window.document.body);
			await pane.setInput({ resource: URI.parse('ash-agent-trace:/s') }, new AbortController().signal);
			assert.equal(payloadReads, 0);
			assert.match(pane.getAccessibleContent(), /Model attempt started/);
			const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'View request / response')!;
			button.click();
			await requested.p;
			pane.clearInput();
			await evidence.complete({ instructions: 'late private evidence' });
			await Promise.resolve();
			assert.equal(payloadReads, 1);
			assert.doesNotMatch(pane.getAccessibleContent(), /late private evidence/);
			assert.equal(dom.window.document.querySelectorAll('.ash-agent-trace-event').length, 0);
		} finally { dom.window.close(); }
	});
	test('closes the read/subscribe gap, releases hidden ownership and resumes before abort', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			using configuration = new InMemoryConfigurationService();
			using context = new ContextKeyService();
			using updates = new Emitter<ThreadUpdateEnvelope>();
			using ready = new Emitter<void>();
			const refreshed = new DeferredPromise<void>();
			const resumed = new DeferredPromise<void>();
			const released: string[] = [];
			const owners: object[] = [];
			let reads = 0;
			services.registerInstance(IConfigurationService, configuration);
			services.registerInstance(IContextKeyService, context);
			services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
			services.registerInstance(IChatService, {
				onDidChangeSession: Event.None, onDidUpdateThread: updates.event, onDidBecomeReady: ready.event,
				readTraceDiagnostics: async () => ({ diagnostics: { formatVersion: 1, captureId: null, recordingStatus: 'disabled', droppedRecords: 0, events: [] }, cursor: 0, hasMore: false }),
				readTrace: async (_session: string, after: Readonly<Record<string, number>>): Promise<AgentTracePage> => {
					reads++;
					const sequence = reads === 1 ? 1 : 2;
					if (reads === 2) { assert.deepEqual(after, { root: 1 }); void refreshed.complete(); }
					if (reads === 3) { assert.deepEqual(after, { root: 2 }); void resumed.complete(); }
					return { trace: { formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [{ threadId: 'root', events: reads === 3 ? [] : [{ eventId: `e-${sequence}`, sequence, recordedAt: 1, event: { type: sequence === 1 ? 'threadCreated' : 'turnCompleted', threadId: 'root', turnId: 'turn' } }] }] }, cursors: { root: sequence }, hasMore: false };
				},
				subscribeThread: async (_session: string, _thread: string, _after: number, owner: object) => { owners.push(owner); return { thread: { sequence: 2 } } as ThreadSubscription; },
				unsubscribeThread: async (_session: string, threadId: string) => { released.push(threadId); },
			} as unknown as IChatService);
			using pane = registerTestComponentServices(services).createInstance(AgentTraceEditor);
			pane.create(dom.window.document.body);
			const abort = new AbortController();
			await pane.setInput({ resource: URI.parse('ash-agent-trace:/s') }, abort.signal);
			await refreshed.p;
			await Promise.resolve();
			assert.match(pane.getAccessibleContent(), /Turn completed/);
			assert.equal(reads, 2);
			pane.setVisible(false);
			assert.deepEqual(released, ['root']);
			updates.fire({ sessionId: 's', threadId: 'root', durableSequence: 3 } as ThreadUpdateEnvelope);
			assert.equal(reads, 2);
			pane.setVisible(true);
			await resumed.p;
			await Promise.resolve();
			assert.equal(owners.length, 2);
			assert.notEqual(owners[0], owners[1]);
			abort.abort();
			assert.deepEqual(released, ['root', 'root']);
			assert.equal(dom.window.document.querySelectorAll('.ash-agent-trace-event').length, 0);
		} finally { dom.window.close(); }
	});

	test('ignores a late subscription result after its conversation is closed', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			using configuration = new InMemoryConfigurationService();
			using context = new ContextKeyService();
			using updates = new Emitter<ThreadUpdateEnvelope>();
			using ready = new Emitter<void>();
			const subscribing = new DeferredPromise<void>();
			const result = new DeferredPromise<ThreadSubscription>();
			const released = new Set<object>();
			services.registerInstance(IConfigurationService, configuration);
			services.registerInstance(IContextKeyService, context);
			services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
			services.registerInstance(IChatService, {
				onDidChangeSession: Event.None, onDidUpdateThread: updates.event, onDidBecomeReady: ready.event,
				readTraceDiagnostics: async () => ({ diagnostics: { formatVersion: 1, captureId: null, recordingStatus: 'disabled', droppedRecords: 0, events: [] }, cursor: 0, hasMore: false }),
				readTrace: async (): Promise<AgentTracePage> => ({ trace: { formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [{ threadId: 'root', events: [{ eventId: 'e', sequence: 1, recordedAt: 1, event: { type: 'threadCreated', threadId: 'root' } }] }] }, cursors: { root: 1 }, hasMore: false }),
				subscribeThread: () => { void subscribing.complete(); return result.p; },
				unsubscribeThread: async (_session: string, _thread: string, owner: object) => { released.add(owner); },
			} as unknown as IChatService);
			using pane = registerTestComponentServices(services).createInstance(AgentTraceEditor);
			pane.create(dom.window.document.body);
			const pending = pane.setInput({ resource: URI.parse('ash-agent-trace:/s') }, new AbortController().signal);
			await subscribing.p;
			pane.clearInput();
			await result.complete({ thread: { sequence: 1 } } as ThreadSubscription);
			await pending;
			assert.equal(released.size, 1);
			assert.equal(dom.window.document.querySelectorAll('.ash-agent-trace-event').length, 0);
			assert.match(pane.getAccessibleContent(), /Open a saved conversation/);
		} finally { dom.window.close(); }
	});
});
