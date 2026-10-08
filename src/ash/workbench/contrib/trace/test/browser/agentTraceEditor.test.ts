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
import { createAgentTraceResource } from '../../common/trace.js';

suite('Execution Trace editor', () => {

	test('explains loop decisions and message phases in the timeline and accessible view', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			using configuration = new InMemoryConfigurationService();
			using context = new ContextKeyService();
			services.registerInstance(IConfigurationService, configuration);
			services.registerInstance(IContextKeyService, context);
			services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
			const events = [
				{ type: 'itemCompleted', item: { type: 'agentMessage', text: 'working', phase: 'commentary' } },
				{ type: 'modelResponseEvaluated', decision: { action: 'continue', reason: 'nonterminalMessage', stopReason: { type: 'completed' }, messagePhases: ['commentary'], toolCallCount: 0 } },
				{ type: 'modelResponseEvaluated', decision: { action: 'fail', reason: 'truncatedOutput', stopReason: { type: 'maxOutputTokens' }, messagePhases: ['partial_answer'], toolCallCount: 0 } },
			];
			services.registerInstance(IChatService, {
				onDidChangeSession: Event.None, onDidUpdateThread: Event.None, onDidBecomeReady: Event.None,
				readTrace: async () => ({ trace: { formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [{ threadId: 'root', events: events.map((event, index) => ({ eventId: `e-${index}`, sequence: index + 1, recordedAt: 1, event: { ...event, threadId: 'root', turnId: 'turn' } })) }] }, cursors: { root: 3 }, hasMore: false }),
				readTraceDiagnostics: async () => ({ diagnostics: { formatVersion: 1, captureId: null, recordingStatus: 'disabled', droppedRecords: 0, events: [] }, cursor: 0, hasMore: false }),
				subscribeThread: async () => ({ thread: { sequence: 3 } }), unsubscribeThread: async () => { },
			} as unknown as IChatService);
			using pane = registerTestComponentServices(services).createInstance(AgentTraceEditor);
			pane.create(dom.window.document.body);
			await pane.setInput({ resource: URI.parse('ash-agent-trace:/s') }, new AbortController().signal);
			assert.match(pane.getAccessibleContent(), /Agent output · Commentary · working/);
			assert.match(pane.getAccessibleContent(), /Continue generation · Nonterminal message received · stop: Generation completed · phases: Commentary/);
			const buttons = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')];
			buttons.find(button => button.textContent === 'Errors only')!.click();
			const visible = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.ash-agent-trace-event')].filter(row => !row.hidden);
			assert.equal(visible.length, 1);
			assert.match(visible[0].textContent!, /Fail Turn · Output was truncated · stop: Output token limit · phases: Partial answer/);
			visible[0].click();
			assert.match(pane.getAccessibleContent(), /"toolCallCount": 0/);
		} finally { dom.window.close(); }
	});
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
							threads: threads.map(threadId => ({
								threadId, events: after[threadId] ? [] : [{
									eventId: `${threadId}-1`, sequence: 1, recordedAt: 1,
									event: { type: 'threadCreated', threadId, title: threadId, origin: threadId === 'child' ? { type: 'agentSpawn', parentThreadId: 'root', parentSequence: 1 } : undefined },
								}]
							})),
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
	for (const scenario of [
		{ name: 'Thread', target: { sessionId: 's', threadId: 'child' }, key: 'child:1', eventId: 'child-created' },
		{ name: 'Turn', target: { sessionId: 's', threadId: 'child', turnId: 'later' }, key: 'child:2', eventId: 'child-accepted' },
		{ name: 'durable event', target: { sessionId: 's', threadId: 'child', turnId: 'later', eventId: 'child-event' }, key: 'child:3', eventId: 'child-event' },
		{ name: 'diagnostic event', target: { sessionId: 's', threadId: 'child', turnId: 'later', eventId: 'diagnostic-event' }, key: 'diagnostic:1', eventId: 'diagnostic-event' },
		{ name: 'missing event', target: { sessionId: 's', threadId: 'child', eventId: 'missing' }, key: undefined, eventId: undefined },
		{ name: 'closed input', target: { sessionId: 's', threadId: 'child', turnId: 'later' }, key: undefined, eventId: undefined },
	]) {
		test(`locates the requested ${scenario.name} after pagination without selecting an unrelated event`, async () => {
			const dom = new JSDOM('<!doctype html><body></body>');
			try {
				using services = new InstantiationService();
				using configuration = new InMemoryConfigurationService();
				using context = new ContextKeyService();
				const reading = new DeferredPromise<void>();
				const page = new DeferredPromise<AgentTracePage>();
				const released: string[] = [];
				services.registerInstance(IConfigurationService, configuration);
				services.registerInstance(IContextKeyService, context);
				services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
				services.registerInstance(IChatService, {
					onDidChangeSession: Event.None, onDidUpdateThread: Event.None, onDidBecomeReady: Event.None,
					readTrace: async (_session: string, after: Readonly<Record<string, number>>): Promise<AgentTracePage> => {
						if (after.root) { void reading.complete(); return page.p; }
						return {
							trace: {
								formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [
									{ threadId: 'root', events: [{ eventId: 'before', sequence: 1, recordedAt: 1, event: { type: 'turnAccepted', threadId: 'root', turnId: 'before' } }] },
									{ threadId: 'child', events: [] },
								]
							}, cursors: { root: 1, child: 0 }, hasMore: true
						};
					},
					readTraceDiagnostics: async () => ({
						diagnostics: {
							formatVersion: 1, captureId: 'capture', recordingStatus: 'disabled', droppedRecords: 0, events: [
								{ eventId: 'diagnostic-event', sequence: 1, recordedAt: 1, threadId: 'child', turnId: 'later', event: { type: 'modelAttemptFailed', attemptId: 'attempt', error: 'saved model error' } },
							]
						}, cursor: 1, hasMore: false
					}),
					subscribeThread: async (_session: string, _thread: string, after: number) => ({ thread: { sequence: after } }),
					unsubscribeThread: async (_session: string, thread: string) => { released.push(thread); },
				} as unknown as IChatService);
				using pane = registerTestComponentServices(services).createInstance(AgentTraceEditor);
				pane.create(dom.window.document.body);
				const resource = URI.parse(createAgentTraceResource(scenario.target).toString());
				const pending = pane.setInput({ resource }, new AbortController().signal);
				await reading.p;
				assert.equal(dom.window.document.querySelector('.ash-agent-trace-event[aria-pressed="true"]'), null);
				assert.match(dom.window.document.querySelector('.ash-agent-trace-details')!.textContent!, /Finding saved execution event/);
				if (scenario.name === 'closed input') { pane.clearInput(); }
				await page.complete({
					trace: {
						formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [
							{ threadId: 'root', events: [] },
							{
								threadId: 'child', events: [
									{ eventId: 'child-created', sequence: 1, recordedAt: 1, event: { type: 'threadCreated', threadId: 'child', origin: { parentThreadId: 'root' } } },
									{ eventId: 'child-accepted', sequence: 2, recordedAt: 1, event: { type: 'turnAccepted', threadId: 'child', turnId: 'later' } },
									{ eventId: 'child-event', sequence: 3, recordedAt: 1, event: { type: 'itemCompleted', threadId: 'child', turnId: 'later', item: { type: 'toolResult', toolCallId: 'tool', text: 'saved result' } } },
								]
							},
						]
					}, cursors: { root: 1, child: 3 }, hasMore: false
				});
				await pending;
				const selected = dom.window.document.querySelector<HTMLButtonElement>('.ash-agent-trace-event[aria-pressed="true"]');
				assert.equal(selected?.dataset.key, scenario.key);
				if (scenario.eventId) {
					assert.match(pane.getAccessibleContent(), new RegExp(`"eventId": "${scenario.eventId}"`));
					const filter = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Filter execution events"]')!;
					filter.value = 'no-such-filter-match';
					filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
					assert.equal(selected!.hidden, true);
					assert.equal(selected!.getAttribute('aria-pressed'), 'true');
					assert.match(pane.getAccessibleContent(), /hidden by the display filter/);
					await pane.setInput({ resource: createAgentTraceResource({ sessionId: 's', threadId: 'root', turnId: 'before' }) }, new AbortController().signal);
					assert.equal(dom.window.document.querySelector<HTMLButtonElement>('.ash-agent-trace-event[aria-pressed="true"]')?.dataset.key, 'root:1');
					assert.deepEqual(released, ['root', 'child']);
				} else if (scenario.name === 'missing event') {
					assert.match(pane.getAccessibleContent(), /No saved execution event matches child \/ missing/);
				} else {
					assert.equal(dom.window.document.querySelectorAll('.ash-agent-trace-event').length, 0);
					assert.doesNotMatch(pane.getAccessibleContent(), /Finding saved execution event|Located child/);
				}
			} finally { dom.window.close(); }
		});
	}

	for (const order of ['older first', 'newer first', 'newer invalid', 'older fails'] as const) {
		test(`keeps the last selected import when ${order}`, async () => {
			const dom = new JSDOM('<!doctype html><body></body>');
			try {
				using services = new InstantiationService();
				using configuration = new InMemoryConfigurationService();
				using context = new ContextKeyService();
				services.registerInstance(IConfigurationService, configuration);
				services.registerInstance(IContextKeyService, context);
				services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
				services.registerInstance(IChatService, { onDidChangeSession: Event.None, onDidUpdateThread: Event.None, onDidBecomeReady: Event.None } as unknown as IChatService);
				using pane = registerTestComponentServices(services).createInstance(AgentTraceEditor);
				pane.create(dom.window.document.body);
				await pane.setInput({ resource: createAgentTraceResource() }, new AbortController().signal);
				const input = dom.window.document.querySelector<HTMLInputElement>('input[type=file]')!;
				const selectFile = (name: string, content: Promise<string>): void => {
					const file = new dom.window.File([], name);
					Object.defineProperty(file, 'text', { value: () => content });
					Object.defineProperty(input, 'files', { configurable: true, value: [file] });
					input.dispatchEvent(new dom.window.Event('change'));
				};
				const capture = (id: string): string => JSON.stringify({ formatVersion: 3, sessionId: id, historyPrefixes: [], threads: [{ threadId: id, events: [{ eventId: id, sequence: 1, recordedAt: 1, event: { type: 'threadCreated', threadId: id, title: id } }] }] });
				const older = new DeferredPromise<string>();
				const newer = new DeferredPromise<string>();
				selectFile('older.json', older.p);
				selectFile('newer.json', newer.p);
				if (order === 'older first') {
					await older.complete(capture('older'));
					assert.equal(dom.window.document.querySelectorAll('.ash-agent-trace-event').length, 0);
					await newer.complete(capture('newer'));
				} else if (order === 'newer invalid') {
					await newer.complete('{"formatVersion":2}');
					await older.complete(capture('older'));
				} else if (order === 'older fails') {
					await older.error(new Error('old file failed'));
					assert.doesNotMatch(pane.getAccessibleContent(), /old file failed/);
					await newer.complete(capture('newer'));
				} else {
					await newer.complete(capture('newer'));
					await older.complete(capture('older'));
				}
				await Promise.resolve();
				if (order === 'newer invalid') {
					assert.match(pane.getAccessibleContent(), /Expected rollout format version 3/);
					assert.equal(dom.window.document.querySelectorAll('.ash-agent-trace-event').length, 0);
				} else {
					assert.match(pane.getAccessibleContent(), /Imported · newer.json/);
					assert.equal(dom.window.document.querySelector<HTMLElement>('.ash-agent-trace-thread')?.dataset.threadId, 'newer');
				}
			} finally { dom.window.close(); }
		});
	}

	for (const scenario of ['refresh', 'hide', 'close', 'replace', 'payload failure', 'captured relationships'] as const) {
		test(`keeps one bounded export while ${scenario}`, async () => {
			const dom = new JSDOM('<!doctype html><body></body>');
			try {
				using services = new InstantiationService();
				using configuration = new InMemoryConfigurationService();
				using context = new ContextKeyService();
				const payload = new DeferredPromise<unknown>();
				const requested = new DeferredPromise<void>();
				const refreshed = new DeferredPromise<void>();
				const downloaded = new DeferredPromise<void>();
				const artifacts: Blob[] = [];
				const captured = scenario === 'captured relationships';
				let payloadReads = 0;
				let graphReads = 0;
				dom.window.URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); artifacts.push(blob); void downloaded.complete(); return 'blob:trace'; };
				dom.window.URL.revokeObjectURL = () => { };
				dom.window.HTMLAnchorElement.prototype.click = () => { };
				services.registerInstance(IConfigurationService, configuration);
				services.registerInstance(IContextKeyService, context);
				services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
				const graph = {
					nodes: {
						root: { id: 'root', kind: 'thread', label: 'Root', threadId: 'root', turnId: null, eventKey: 'root:1' },
						tool: { id: 'tool', kind: 'toolCall', label: 'Tool', threadId: 'root', turnId: 'turn', eventKey: 'root:2' },
						attempt: { id: 'attempt', kind: 'modelAttempt', label: 'Model', threadId: 'root', turnId: 'turn', eventKey: 'diagnostic:1' },
						later: { id: 'later', kind: 'toolCall', label: 'Later nested call', threadId: 'root', turnId: 'turn', eventKey: 'root:3' },
						cell: { id: 'cell', kind: 'codeCell', label: 'Later cell', threadId: 'root', turnId: 'turn', eventKey: 'root:2' },
					},
					edges: [{ from: 'root', to: 'tool', kind: 'owns' }, { from: 'root', to: 'attempt', kind: 'owns' }, { from: 'attempt', to: 'tool', kind: 'requestsTool' }, { from: 'tool', to: 'cell', kind: 'executes' }, { from: 'cell', to: 'later', kind: 'nestedTool' }], warnings: [],
				};
				services.registerInstance(IChatService, {
					onDidChangeSession: Event.None, onDidUpdateThread: Event.None, onDidBecomeReady: Event.None,
					readTrace: async (sessionId: string, after: Readonly<Record<string, number>>) => ({
						trace: { formatVersion: 3, sessionId, futureField: 'retained', historyPrefixes: [{ prefixId: 'saved' }], threads: [{ threadId: 'root', events: after.root ? [{ eventId: 'later', sequence: 3, recordedAt: 3, event: { type: 'turnCompleted', threadId: 'root', turnId: 'later' } }] : [{ eventId: 'root', sequence: 1, recordedAt: 1, event: { type: 'threadCreated', threadId: 'root' } }, { eventId: 'tool', sequence: 2, recordedAt: 2, event: { type: 'itemCompleted', threadId: 'root', turnId: 'turn', item: { type: 'toolCall', toolCallId: 'tool', name: 'shell' } } }, ...(captured ? [{ eventId: 'nested', sequence: 3, recordedAt: 3, event: { type: 'itemCompleted', threadId: 'root', turnId: 'turn', item: { type: 'toolCall', toolCallId: 'nested', name: 'nested' } } }] : [])] }] }, cursors: { root: after.root ? 3 : captured ? 3 : 2 }, hasMore: false,
					}),
					readTraceDiagnostics: async (_session: string, after: number) => {
						if (after) { void refreshed.complete(); }
						return { diagnostics: { formatVersion: 1, captureId: 'capture', recordingStatus: 'disabled', droppedRecords: 0, events: after ? [] : [{ eventId: 'request', threadId: 'root', turnId: 'turn', sequence: 1, recordedAt: 1, event: { type: 'modelAttemptStarted', attemptId: 'attempt', requestPayload: { payloadId: 'payload-1', kind: 'coreRequest', byteLength: 1, status: 'saved', digest: 'sha256:' + '0'.repeat(64) } } }, ...(captured ? [{ eventId: 'completed', threadId: 'root', turnId: 'turn', sequence: 2, recordedAt: 2, event: { type: 'modelAttemptCompleted', attemptId: 'attempt' } }] : [])] }, cursor: captured ? 2 : 1, hasMore: false };
					},
					readTracePayload: () => { payloadReads++; void requested.complete(); return payload.p; },
					readTraceGraph: async () => { graphReads++; return graph; },
					subscribeThread: async (_session: string, _thread: string, after: number) => ({ thread: { sequence: after } }), unsubscribeThread: async () => { },
				} as unknown as IChatService);
				using pane = registerTestComponentServices(services).createInstance(AgentTraceEditor);
				pane.create(dom.window.document.body);
				await pane.setInput({ resource: createAgentTraceResource('s') }, new AbortController().signal);
				const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Export trace')!;
				button.click();
				await requested.p;
				assert.equal(button.disabled, true);
				const filter = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Filter execution events"]')!;
				filter.value = 'no visible rows';
				filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
				assert.equal(button.disabled, true);
				button.click();
				assert.equal(payloadReads, 1);
				if (scenario === 'hide') { pane.setVisible(false); }
				else if (scenario === 'close') { pane.clearInput(); }
				else if (scenario === 'replace') { await pane.setInput({ resource: createAgentTraceResource('other') }, new AbortController().signal); }
				else {
					[...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh')!.click();
					await refreshed.p;
					await Promise.resolve();
					assert.equal(dom.window.document.querySelectorAll('.ash-agent-trace-event').length, captured ? 5 : 4);
					assert.equal(button.disabled, true);
				}
				if (scenario === 'payload failure') { await payload.error(new Error('payload unavailable')); }
				else { await payload.complete({ instructions: 'saved evidence' }); }
				await Promise.resolve();
				if (['hide', 'close', 'replace'].includes(scenario)) {
					assert.equal(artifacts.length, 0);
					assert.equal(graphReads, 0);
				} else {
					await downloaded.p;
					assert.equal(artifacts.length, 1);
					const artifact = JSON.parse(await artifacts[0].text());
					assert.equal(artifact.futureField, 'retained');
					assert.deepEqual(artifact.historyPrefixes, [{ prefixId: 'saved' }]);
					assert.deepEqual(artifact.threads[0].events.map((event: { sequence: number; }) => event.sequence), captured ? [1, 2, 3] : [1, 2]);
					assert.deepEqual(Object.keys(artifact.graph.nodes), captured ? Object.keys(graph.nodes) : ['root', 'tool', 'attempt']);
					assert.deepEqual(artifact.graph.edges, captured ? graph.edges : graph.edges.slice(0, 2));
					assert.equal(artifact.graph.warnings.length > 0, !captured);
					assert.equal(artifact.diagnostics.recordingStatus, scenario === 'payload failure' ? 'incomplete' : 'disabled');
					assert.equal(button.disabled, false);
				}
			} finally { dom.window.close(); }
		});
	}

});
