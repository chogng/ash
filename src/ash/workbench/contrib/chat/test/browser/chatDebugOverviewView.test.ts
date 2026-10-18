import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { ChatDebugOverviewView } from '../../browser/chatDebug/chatDebugOverviewView.js';
import { ChatDebugFilterState } from '../../browser/chatDebug/chatDebugFilters.js';
import type { AgentTrace } from '../../common/chatDebugEvents.js';

test('Chat Debug distinguishes unknown from zero and explains coverage using the shipped Chinese catalog', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const catalog = productLanguagePackCatalogs.find(value => value.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
	try {
		using view = new ChatDebugOverviewView(dom.window.document.body);
		const unknown = { reported: null, reportedCalls: 0, missingCalls: 1 };
		const trace: AgentTrace = {
			formatVersion: 3, sessionId: 'session', historyPrefixes: [], threads: [{ threadId: 'root', events: [] }], overview: {
				formatVersion: 1, threadCursors: { root: 0 }, eventCount: 0, modelCalls: 1, toolCalls: 0, failedModelCalls: 0, cancelledModelCalls: 0, excludedModelCalls: 0,
				inputTokens: { reported: '0', reportedCalls: 1, missingCalls: 0 }, outputTokens: unknown, cachedInputTokens: unknown, totalTokens: unknown,
			}
		};
		view.render(trace);
		assert.match(view.getAccessibleContent(), /输入 token\n0\n已纳入调用中的 1\/1 次已上报/);
		assert.match(view.getAccessibleContent(), /输出 token\n未知\n已纳入调用中的 0\/1 次已上报/);
		using filters = new ChatDebugFilterState();
		filters.setTextFilter('after:2026-02-30');
		assert.match(filters.error!, /Trace 筛选无效/);
		view.render({ ...trace, overview: undefined });
		assert.match(view.getAccessibleContent(), /此捕获记录没有匹配的后端概览/);
	} finally { resetNlsResolver(); dom.window.close(); }
});
