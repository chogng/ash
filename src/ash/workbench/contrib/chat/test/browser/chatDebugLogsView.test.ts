import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ChatDebugLogsView } from '../../browser/chatDebug/chatDebugLogsView.js';
import { ChatDebugFilterState } from '../../browser/chatDebug/chatDebugFilters.js';
import { AgentTraceViewModel } from '../../browser/chatDebug/agentTraceModel.js';

suite('Chat Debug Logs view', () => {
	test('keeps event identity and tree expansion across list mode and copies the selected saved record', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using services = new InstantiationService();
			const copied: string[] = [];
			services.registerInstance(IClipboardService, { writeText: async (value: string) => { copied.push(value); } } as IClipboardService);
			using filters = new ChatDebugFilterState();
			const model = new AgentTraceViewModel();
			model.update({
				formatVersion: 3, sessionId: 'saved', historyPrefixes: [], threads: [{
					threadId: 'root', events: [
						{ sequence: 1, eventId: 'created', recordedAt: 1, event: { type: 'threadCreated', threadId: 'root', title: 'Saved root' } },
						{ sequence: 2, eventId: 'complete', recordedAt: 2, event: { type: 'turnCompleted', threadId: 'root', turnId: 'turn' } },
					]
				}]
			});
			model.filter(filters);
			using view = services.createInstance(ChatDebugLogsView, dom.window.document.body);
			view.refreshList(model, true);
			const event = model.findEvent('root', 'turn', 'complete')!;
			view.tree.expandTo(event.id); view.tree.setSelection([event.id]); view.tree.setFocus(event.id);
			const click = (label: string) => [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === label)!.click();
			click('List View');
			assert.ok(view.tree.getVisibleElements().every(entry => entry.kind === 'event'));
			assert.equal(view.tree.selection[0]?.id, event.id);
			click('Copy Selected Row'); await Promise.resolve();
			assert.match(copied[0]!, /1970-01-01T00:00:00.002Z/);
			assert.match(copied[0]!, /"eventId": "complete"/);
			click('Tree View'); click('Collapse All');
			assert.equal(view.tree.getVisibleElements().length, 1);
			click('List View'); click('Tree View');
			assert.equal(view.tree.getVisibleElements().length, 1, 'returning to tree preserves collapse state');
			click('Expand All');
			assert.ok(view.tree.getVisibleElements().some(entry => entry.id === event.id));
		} finally { dom.window.close(); }
	});
});
