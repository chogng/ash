import { IDiffService } from '../../../../services/diff/common/diffService.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IChatDebugService } from '../../common/chatDebugService.js';
import type { AgentTrace } from '../../common/chatDebugEvents.js';
import { ChatDebugCacheExplorerView } from '../../browser/chatDebug/chatDebugCacheExplorerView.js';

const trace: AgentTrace = {
	formatVersion: 3, sessionId: 'session', threads: [], historyPrefixes: [],
	diagnostics: {
		formatVersion: 1, captureId: 'capture', recordingStatus: 'recording', droppedRecords: 0,
		events: [1, 2].map(sequence => ({
			eventId: `event-${sequence}`, sequence, recordedAt: sequence, threadId: 'root', turnId: 'turn',
			event: { type: 'modelAttemptStarted', attemptId: `attempt-${sequence}`, requestPayload: { payloadId: `payload-${sequence}`, kind: 'coreRequest', byteLength: 1, status: 'saved', digest: `sha256:${'0'.repeat(64)}` } },
		})),
	},
};

const settled = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

suite('Chat Debug Cache Explorer', () => {
	test('retries a failed selected-payload read through the visible refresh action', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			services.registerInstance(IDiffService, { createComputationService: () => { throw new Error('Diff computation must be explicitly requested'); } });
			let attempts = 0;
			services.registerInstance(IChatDebugService, {
				readTracePayload: async (_sessionId: string, _captureId: string, payloadId: string) => {
					if (payloadId === 'payload-2' && ++attempts === 1) { throw new Error('Temporary read failure'); }
					return { input: ['recovered body'] };
				},
			} as IChatDebugService);
			using view = services.createInstance(ChatDebugCacheExplorerView, dom.window.document.body);
			view.show(trace, 'session');
			await settled();
			assert.match(view.getAccessibleContent(), /Temporary read failure/);
			[...dom.window.document.querySelectorAll('button')].find(button => button.textContent === 'Refresh')!.click();
			await settled();
			assert.equal(attempts, 2);
			assert.match(view.getAccessibleContent(), /recovered body/);
			assert.doesNotMatch(view.getAccessibleContent(), /Temporary read failure/);
		} finally { dom.window.close(); }
	});
	test('an earlier selected request cannot overwrite the current selection or a hidden view', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			services.registerInstance(IDiffService, { createComputationService: () => { throw new Error('Diff computation must be explicitly requested'); } });
			const second = new DeferredPromise<unknown>();
			let reads = 0;
			services.registerInstance(IChatDebugService, {
				readTracePayload: async (sessionId: string, captureId: string, payloadId: string) => {
					assert.equal(sessionId, 'session'); assert.equal(captureId, 'capture'); reads++;
					return payloadId === 'payload-2' ? second.p : { input: ['first body'] };
				},
			} as IChatDebugService);
			using view = services.createInstance(ChatDebugCacheExplorerView, dom.window.document.body);
			view.show(trace, 'session');
			dom.window.document.querySelector<HTMLButtonElement>('[data-request-event="event-1"]')!.click();
			await settled();
			assert.match(view.getAccessibleContent(), /first body/);
			await second.complete({ input: ['late second body'] });
			await settled();
			assert.doesNotMatch(view.getAccessibleContent(), /late second body/);
			const before = reads;
			// Refreshing an immutable selection preserves its body and avoids repeated payload reads.
			view.show({ ...trace }, 'session');
			await settled();
			assert.equal(reads, before);
			view.hide();
			view.show(trace, 'session');
			view.hide();
			const hiddenContent = view.getAccessibleContent();
			await settled();
			assert.equal(view.getAccessibleContent(), hiddenContent);
		} finally { dom.window.close(); }
	});

	test('the selected body remains readable when its predecessor is missing', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			services.registerInstance(IDiffService, { createComputationService: () => { throw new Error('Diff computation must be explicitly requested'); } });
			services.registerInstance(IChatDebugService, {
				readTracePayload: async (_sessionId: string, _captureId: string, payloadId: string) => {
					if (payloadId === 'payload-1') { throw new Error('Missing previous payload'); }
					return { input: ['selected body'] };
				},
			} as IChatDebugService);
			using view = services.createInstance(ChatDebugCacheExplorerView, dom.window.document.body);
			view.show(trace, 'session');
			await settled();
			assert.match(view.getAccessibleContent(), /earlier request is unavailable/);
			assert.match(view.getAccessibleContent(), /selected body/);
			view.clear();
			assert.equal(dom.window.document.querySelectorAll('pre').length, 0);
		} finally { dom.window.close(); }
	});
});
