import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setup, suite, teardown, test } from 'mocha';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { getContextInputBudget, type ChatContextUsage } from '../../../../services/chat/common/chatService.js';
import { ChatContextUsageWidget } from '../../browser/widgetHosts/viewPane/chatContextUsageWidget.js';

suite('Chat context budget', () => {
	let environment: JSDOM;
	let contextViews: BrowserContextViewService;
	let widget: ChatContextUsageWidget;
	let installedGlobals: IDisposable;

	setup(() => {
		environment = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
		// jsdom does not implement scrolling used when context views restore focus.
		environment.window.HTMLElement.prototype.scrollTo = () => {};
		installedGlobals = installEditorTestDom(environment, [
			'Node',
			'Element',
			'HTMLElement',
			'Event',
			'KeyboardEvent',
		]);
		initializeTestLocalization('en');
		contextViews = new BrowserContextViewService(environment.window.document.body);
		widget = new ChatContextUsageWidget(environment.window.document, contextViews);
		environment.window.document.body.append(widget.domNode);
		// jsdom has no layout; the focus-restoration guard needs a rendered anchor.
		Object.defineProperty(widget.domNode, 'getClientRects', {
			value: () => [new environment.window.DOMRect(0, 0, 16, 16)],
		});
	});

	teardown(() => {
		widget.dispose();
		contextViews.dispose();
		resetNlsResolver();
		installedGlobals.dispose();
		environment.window.close();
	});

	const usage = (): ChatContextUsage => ({
		estimatedTokens: 450_000,
		contextWindow: 475_000,
		autoCompactAt: 450_000,
		categories: [{ category: 'conversation', tokens: 450_000 }],
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`a reserved empty meter does not invent usage and becomes available with a snapshot (${locale})`, () => {
			initializeTestLocalization(locale);
			widget.update(undefined, true);
			assert.equal(widget.domNode.hidden, false);
			assert.equal(widget.domNode.disabled, true);
			assert.equal(
				widget.domNode.getAttribute('aria-label'),
				locale === 'en' ? 'Context usage is not available yet' : '暂无上下文用量数据',
			);
			assert.equal(widget.showDetails(), false);
			widget.update(usage(), true);
			assert.equal(widget.domNode.disabled, false);
			assert.equal(widget.showDetails(), true);
			widget.update(undefined, true);
			assert.equal(widget.domNode.hidden, false);
			assert.equal(widget.domNode.disabled, true);
			assert.equal(environment.window.document.querySelector('.ash-chat-context-details'), null);
		});

		test(`the meter and details reach 100% at Core's compaction boundary (${locale})`, () => {
			initializeTestLocalization(locale);
			widget.update(usage());
			assert.match(widget.domNode.getAttribute('aria-label')!, /100%/u);
			assert.equal(
				widget.domNode.querySelector('.ash-chat-context-usage-value')?.getAttribute('stroke-dasharray'),
				'100 0',
			);
			widget.domNode.click();
			const details = environment.window.document.querySelector<HTMLElement>('.ash-chat-context-details')!;
			assert.equal(widget.domNode.getAttribute('aria-expanded'), 'true');
			assert.match(details.querySelector('.ash-chat-context-details-summary')!.textContent!, /100%/u);
			assert.match(
				details.textContent!,
				locale === 'en' ? /Model context capacity: 475,000/u : /模型上下文容量：475,000/u,
			);
			assert.match(details.textContent!, locale === 'en' ? /Remaining input budget0/u : /剩余输入预算0/u);
			details.dispatchEvent(new environment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			assert.equal(widget.domNode.getAttribute('aria-expanded'), 'false');
			assert.equal(environment.window.document.activeElement, widget.domNode);
		});
	}

	test('unknown input capacity omits percentages and disables the ring when no usage exists', () => {
		const unknown: ChatContextUsage = { estimatedTokens: 40, categories: [] };
		assert.equal(getContextInputBudget(unknown), undefined);
		widget.update(unknown);
		assert.doesNotMatch(widget.domNode.getAttribute('aria-label')!, /%/u);
		assert.equal(getContextInputBudget({ ...unknown, contextWindow: 1_000 }), 1_000);
		widget.update(undefined);
		assert.equal(widget.domNode.hidden, true);
	});
});
