import { AgentWireLogCaptureUnavailableError } from '../../../../../platform/agentHost/common/agentService.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { AgentWireLogFrame, AgentWireLogPage } from '../../../../../platform/agentHost/common/agent.js';
import { IChatDebugService } from '../../common/chatDebugService.js';
import { ChatDebugWireLogView } from '../../browser/chatDebug/chatDebugWireLogView.js';

const settled = async () => { for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 0)); } };
function frame(sequence: number, extra: Partial<AgentWireLogFrame> = {}): AgentWireLogFrame {
	return { sequence, timestampMs: 1, direction: 'clientToServer', kind: 'request', requestId: String(sequence), method: 'session/read', requestSequence: null, elapsedMs: null, isError: false, byteLength: 2, truncated: false, raw: '{}', ...extra };
}
function page(frames: readonly AgentWireLogFrame[], recording = false): AgentWireLogPage {
	return { captureId: 'capture', connectionId: '7', recording, frames, cursor: frames.at(-1)?.sequence ?? 0, hasMore: false, droppedFrames: 0 };
}
function button(dom: JSDOM, label: string): HTMLButtonElement { return [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === label)!; }

suite('Chat Debug Wire Log', () => {
	test('hiding while start is pending actually stops the backend resource after start completes', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			const started = new DeferredPromise<void>();
			const stops: string[] = [];
			services.registerInstance(IChatDebugService, {
				startWireLog: () => started.p,
				stopWireLog: async (sessionId: string, id: string) => { stops.push(`${sessionId}:${id}`); },
				readWireLog: async () => { throw new Error('Hidden view must not read'); },
			} as unknown as IChatDebugService);
			using view = services.createInstance(ChatDebugWireLogView, dom.window.document.body);
			view.show('session'); button(dom, 'Start New Capture').click(); view.hide();
			assert.deepEqual(stops, []);
			await started.complete(); await settled();
			assert.equal(stops.length, 1);
			assert.match(stops[0]!, /^session:/);
			view.clear(); await settled(); assert.equal(stops.length, 1);
		} finally { dom.window.close(); }
	});

	test('shows backend pairing and exact raw prefixes, supports filtering, and never captures imports', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			let starts = 0;
			const request = frame(1, { raw: '{ "id":1, "method":"session/read" }' });
			const response = frame(2, { kind: 'response', direction: 'serverToClient', requestSequence: 1, elapsedMs: 12, isError: true, truncated: true, raw: '{"error":', byteLength: 100000 });
			services.registerInstance(IChatDebugService, {
				startWireLog: async () => { starts++; }, stopWireLog: async () => { },
				readWireLog: async () => page([request, response, frame(3, { method: 'host/call', direction: 'serverToClient' })]),
			} as unknown as IChatDebugService);
			using view = services.createInstance(ChatDebugWireLogView, dom.window.document.body);
			view.show(undefined); assert.equal(button(dom, 'Start New Capture').disabled, true);
			view.show('session'); button(dom, 'Start New Capture').click(); await settled();
			assert.equal(starts, 1);
			assert.equal(dom.window.document.querySelectorAll('[data-wire-sequence]').length, 2);
			assert.match(view.getAccessibleContent(), /12 ms.*Error/);
			assert.match(view.getAccessibleContent(), /not a complete JSON/);
			assert.equal(dom.window.document.querySelector('pre')?.textContent, request.raw);
			const raw = dom.window.document.querySelector('pre')!; raw.focus();
			button(dom, 'Refresh Frames').click(); await settled();
			assert.equal(dom.window.document.querySelector('pre'), raw, 'refresh preserves a frame being read');
			assert.equal(dom.window.document.activeElement, raw);
			button(dom, 'Server → Client').click();
			assert.equal(dom.window.document.querySelectorAll('[data-wire-sequence]').length, 1);
			assert.match(view.getAccessibleContent(), /host\/call/);
			view.show(undefined); assert.equal(button(dom, 'Start New Capture').disabled, true);
			assert.equal(dom.window.document.querySelectorAll('pre').length, 0);
		} finally { dom.window.close(); }
	});

	test('a released backend capture can be replaced after reconnect', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			let reads = 0;
			services.registerInstance(IChatDebugService, {
				startWireLog: async () => { }, stopWireLog: async () => { },
				readWireLog: async () => { if (++reads === 1) { throw new AgentWireLogCaptureUnavailableError(); } return page([]); },
			} as unknown as IChatDebugService);
			using view = services.createInstance(ChatDebugWireLogView, dom.window.document.body);
			view.show('session'); button(dom, 'Start New Capture').click(); await settled();
			assert.match(view.getAccessibleContent(), /no longer available/);
			assert.equal(button(dom, 'Start New Capture').disabled, false);
			button(dom, 'Start New Capture').click(); await settled();
			assert.equal(reads, 2);
			assert.match(view.getAccessibleContent(), /Capture stopped/);
		} finally { dom.window.close(); }
	});

	test('ignores a late read after switching session and exposes all matching calls to Accessible View', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			const pending = new DeferredPromise<AgentWireLogPage>();
			let reads = 0;
			services.registerInstance(IChatDebugService, {
				startWireLog: async () => { }, stopWireLog: async () => { },
				readWireLog: async () => ++reads === 1 ? pending.p : page(Array.from({ length: 150 }, (_, index) => frame(index + 1, { method: `method-${index + 1}` }))),
			} as unknown as IChatDebugService);
			using view = services.createInstance(ChatDebugWireLogView, dom.window.document.body);
			view.show('first'); button(dom, 'Start New Capture').click(); await settled();
			view.show('second'); button(dom, 'Start New Capture').click(); await settled();
			await pending.complete(page([frame(999, { method: 'obsolete' })])); await settled();
			assert.doesNotMatch(view.getAccessibleContent(), /obsolete/);
			assert.equal(dom.window.document.querySelectorAll('[data-wire-sequence]').length, 100);
			assert.match(view.getAccessibleContent(), /method-150/);
			button(dom, 'Show More Frames').click();
			assert.equal(dom.window.document.querySelectorAll('[data-wire-sequence]').length, 150);
		} finally { dom.window.close(); }
	});
});
