import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../../test/fixtures/browser/chatTranscript.page.js';
import { expect } from '@playwright/test';
import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../../../../editor/browser/services/codeEditorService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import { ChatFindWidget, findMatchRangesInDom, type IChatFindHost } from '../../../browser/widget/chatFind/chatFindWidget.js';
import { ChatFindCommandId } from '../../../browser/widget/chatFind/chatFindCommandIds.js';

suite('ChatFindWidget', () => {
	function fixture(resources: DisposableStore) {
		const dom = new JSDOM('<!doctype html><body><button id="before">Before</button><main></main></body>');
		resources.add(toDisposable(() => dom.window.close()));
		const services = resources.add(new InstantiationService());
		services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
		services.registerInstance(ICodeEditorService, { listCodeEditors: () => [] } as unknown as ICodeEditorService);
		services.registerInstance(IAccessibilityService, { isScreenReaderOptimized: () => false } as IAccessibilityService);
		services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		const changed = resources.add(new Emitter<void>());
		const document = dom.window.document;
		const root = document.querySelector('main')!;
		const before = document.querySelector<HTMLButtonElement>('#before')!;
		let items: readonly IChatListItem[] = [];
		let history: { loading: boolean; error?: string; } | undefined;
		let load = async (): Promise<void> => { history = undefined; };
		let visible = true;
		const revealed: string[] = [];
		const rows = new Map<string, HTMLElement>();
		const host: IChatFindHost = {
			element: root, onDidChange: changed.event,
			getItems: () => items,
			getRowElement: id => rows.get(id),
			getViewportAnchorItemId: () => undefined,
			reveal: id => { revealed.push(id); },
			focus: () => before.focus(), isVisible: () => visible, setFindVisible: () => { },
			getHistoryState: () => history, loadOlderHistory: () => load(),
		};
		const widget = resources.add(services.createInstance(ChatFindWidget, host));
		const render = (values: readonly IChatListItem[]): void => {
			items = values;
			for (const element of rows.values()) { element.remove(); }
			rows.clear();
			for (const item of items) {
				const row = document.createElement('article');
				const text = document.createElement('pre');
				text.textContent = item.text;
				row.append(text); root.prepend(row); rows.set(item.id, row);
			}
			changed.fire();
		};
		const waitForStatus = async (expected: string): Promise<void> => {
			if (root.querySelector('.ash-chat-find-status')?.textContent === expected) { return; }
			await new Promise<void>((resolve, reject) => {
				const observer = new dom.window.MutationObserver(() => {
					if (root.querySelector('.ash-chat-find-status')?.textContent !== expected) { return; }
					cleanup();
					resolve();
				});
				const timer = setTimeout(() => { cleanup(); reject(new Error(`Find did not report: ${expected}`)); }, 2000);
				const cleanup = (): void => { observer.disconnect(); clearTimeout(timer); };
				resources.add(toDisposable(cleanup));
				observer.observe(root, { childList: true, subtree: true, characterData: true });
			});
		};
		return {
			widget, root, before, revealed, document, render, waitForStatus,
			input: () => root.querySelector<HTMLInputElement>('.ash-chat-find input')!,
			status: () => root.querySelector('.ash-chat-find-status')!.textContent,
			history: (value: typeof history, operation: typeof load) => { history = value; load = operation; },
			setHistory: (value: typeof history) => { history = value; },
			hideHost: () => { visible = false; widget.hide(); },
		};
	}
	const item = (id: string, text: string): IChatListItem => ({ id, type: 'userMessage', text, transient: false });

	test('navigates, reports options and regex errors, and restores the invoking focus without touching messages', () => {
		using resources = new DisposableStore();
		const f = fixture(resources);
		f.render([item('first', 'Term term terms'), item('last', 'term')]);
		f.before.focus();
		f.widget.show('term');
		assert.equal(f.document.activeElement, f.input());
		assert.equal(f.status(), '1 of 4 matches');
		f.widget.toggleWholeWord();
		assert.equal(f.status(), '1 of 3 matches');
		f.widget.toggleCaseSensitive();
		assert.equal(f.status(), '1 of 2 matches');
		f.widget.previous();
		assert.equal(f.status(), '2 of 2 matches');
		assert.equal(f.revealed.at(-1), 'last');
		f.widget.toggleRegex();
		f.input().value = '[';
		f.input().dispatchEvent(new f.document.defaultView!.Event('input', { bubbles: true }));
		assert.equal(f.input().getAttribute('aria-invalid'), 'true');
		assert.equal(f.status(), 'Invalid regular expression');
		f.widget.hide();
		assert.equal(f.document.activeElement, f.before);
		assert.equal(f.root.querySelector('article pre')!.textContent, 'term');
	});

	test('streamed text updates results and closed Find releases highlights and ignores further updates', async () => {
		using resources = new DisposableStore();
		const f = fixture(resources);
		f.render([item('stream', 'needle')]);
		f.widget.show('needle');
		f.render([item('stream', 'needle needle')]);
		await f.waitForStatus('1 of 2 matches');
		f.widget.hide();
		assert.equal(f.root.querySelectorAll('.ash-chat-find-active').length, 0);
		f.render([item('stream', 'no match')]);
		assert.equal(f.widget.visible, false);
		f.widget.show();
		assert.equal(f.status(), 'No results');
	});

	test('existing history loader brings older matches into the same model', async () => {
		using resources = new DisposableStore();
		const f = fixture(resources);
		f.render([item('recent', 'recent')]);
		let loads = 0;
		f.history({ loading: false }, async () => {
			loads++;
			f.render([item('old', 'older needle'), item('recent', 'recent')]);
			f.setHistory(undefined);
		});
		f.widget.show('needle');
		await f.waitForStatus('1 of 1 matches');
		assert.equal(loads, 1);
		assert.equal(f.status(), '1 of 1 matches');
		assert.equal(f.revealed.at(-1), 'old');
	});

	test('a failed history page is reported and the continuation retries the existing owner', async () => {
		using resources = new DisposableStore();
		const f = fixture(resources);
		let loads = 0;
		f.history({ loading: false }, async () => {
			loads++;
			if (loads === 1) { throw new Error('synthetic history failure'); }
			f.render([item('old', 'older needle')]);
			f.setHistory(undefined);
		});
		f.widget.show('needle');
		await f.waitForStatus('No results · Earlier history could not be searched: synthetic history failure');
		const retry = [...f.root.querySelectorAll('button')].find(button => button.textContent === 'Search earlier messages')!;
		assert.equal(retry.hidden, false);
		retry.click();
		await f.waitForStatus('1 of 1 matches');
		assert.equal(loads, 2);
	});

	test('large history scans yield to an explicit continuation after a bounded admission', async () => {
		using resources = new DisposableStore();
		const f = fixture(resources);
		const boundary = new DeferredPromise<void>();
		let loads = 0;
		f.history({ loading: false }, async () => {
			loads++;
			if (loads === 32) { await boundary.complete(); }
			if (loads === 33) { f.setHistory(undefined); }
		});
		f.widget.show('needle');
		await boundary.p;
		await f.waitForStatus('No results · More history available');
		assert.equal(loads, 32);
		[...f.root.querySelectorAll('button')].find(button => button.textContent === 'Search earlier messages')!.click();
		await f.waitForStatus('No results');
		assert.equal(loads, 33);
	});

	test('closing Find during a page read stops further pages and never steals focus from another control', async () => {
		using resources = new DisposableStore();
		const f = fixture(resources);
		const page = new DeferredPromise<void>();
		const started = new DeferredPromise<void>();
		let loads = 0;
		f.history({ loading: false }, async () => { loads++; await started.complete(); await page.p; });
		f.widget.show('needle');
		await started.p;
		assert.equal(loads, 1);
		f.before.focus();
		f.hideHost();
		await page.complete();
		assert.equal(loads, 1);
		assert.equal(f.document.activeElement, f.before);
		assert.equal(f.widget.visible, false);
	});

	test('DOM highlights span inline formatting and line breaks without indexing controls or code editor chrome', () => {
		const dom = new JSDOM('<main><p>hello <strong>world</strong><br>next</p><p>hello world</p><button>hello world</button><div class="ash-chat-code-block">hello world</div></main>');
		try {
			const root = dom.window.document.querySelector('main')!;
			const ranges = findMatchRangesInDom(root, /hello world/gu, 100);
			assert.deepEqual(ranges.map(range => range.toString()), ['hello world', 'hello world']);
			const original = root.innerHTML;
			assert.equal(findMatchRangesInDom(root, /world\nnext/gu, 100).length, 1);
			assert.equal(root.innerHTML, original);
		} finally { dom.window.close(); }
	});
});


suite('Chat Find browser presentation', () => {
	const browserTests = useBrowserTests();

	test('opening Find on whitespace preserves its previous query and returns focus to the search input', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => {
			window.ashChatTranscriptIntegration.renderItems([
				{ id: 'query-source', type: 'agentMessage', text: 'needle    other', transient: false },
			]);
			window.ashChatTranscriptIntegration.showFind('needle');
		});
		await page.locator('.ash-chat-find input').press('Escape');
		await page.locator('[data-item-id="query-source"] p').evaluate(element => {
			const range = element.ownerDocument.createRange();
			range.setStart(element.firstChild!, 6);
			range.setEnd(element.firstChild!, 10);
			const selection = element.ownerDocument.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
		});
		await page.evaluate(command => window.ashChatTranscriptIntegration.runNavigationCommand(command), ChatFindCommandId.Find);
		await expect(page.locator('.ash-chat-find input')).toHaveValue('needle');
		await expect(page.locator('.ash-chat-find input')).toBeFocused();
	});

	test('highlights rendered text across formatting, excludes link destinations and preserves message DOM', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => {
			window.ashChatTranscriptIntegration.renderItems([
				{ id: 'request', type: 'userMessage', text: 'Needle question', transient: false },
				{ id: 'reply', type: 'agentMessage', text: '**needle** [visible](https://needle.invalid) and needle', transient: false },
			]);
		});
		const strong = await page.locator('[data-item-id="reply"] strong').elementHandle();
		await page.evaluate(() => window.ashChatTranscriptIntegration.showFind('needle'));
		const status = page.locator('.ash-chat-find-status');
		await expect(status).toHaveText('1 of 3 matches');
		expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, Set<Range>>; }).highlights.get('ash-chat-find-match')?.size)).toBe(3);
		expect(await strong!.evaluate(element => element.isConnected)).toBe(true);
		const controls = await page.locator('.ash-chat-find').boundingBox();
		const first = await page.locator('[data-item-id="request"] pre').boundingBox();
		expect(first!.y).toBeGreaterThanOrEqual(controls!.y + controls!.height);

		await page.locator('.ash-chat-find input').press('Enter');
		await expect(status).toHaveText('2 of 3 matches');
		await page.locator('.ash-chat-find input').fill('needle.invalid');
		await expect(status).toHaveText('No results');
		await page.locator('.ash-chat-find input').press('Escape');
		await expect(page.locator('.ash-chat-find')).toBeHidden();
		expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, Set<Range>>; }).highlights.has('ash-chat-find-match'))).toBe(false);
		expect(await page.locator('.ash-chat-transcript').evaluate(element => element.style.paddingTop)).toBe('');
	});

	test('finds an unmounted code line and reveals it without retaining every response editor model', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html');
		await page.evaluate(() => {
			const oldCode = Array.from({ length: 80 }, (_, index) => index === 69 ? 'const old_code_needle = 42;' : `const line${index} = ${index};`).join('\n');
			window.ashChatTranscriptIntegration.renderItems([
				{ id: 'old-code', type: 'agentMessage', text: '```ts\n' + oldCode + '\n```', transient: false },
				...Array.from({ length: 24 }, (_, index) => ({ id: `later-${index}`, type: 'agentMessage' as const, text: '```ts\n' + 'const ordinary = 1;\n'.repeat(60) + '```', transient: false })),
			]);
		});
		await page.evaluate(() => window.ashChatTranscriptIntegration.showFind('old_code_needle'));
		await expect(page.locator('.ash-chat-find-status')).toHaveText('1 of 1 matches');
		await expect(page.locator('[data-item-id="old-code"] .ash-chat-find-code-current')).toBeVisible();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().codeModelCount)).toBeLessThan(12);
		const match = await page.locator('[data-item-id="old-code"] .ash-chat-find-code-current').boundingBox();
		const viewport = await page.locator('.ash-chat-transcript-scrollable > .ash-scrollbar-viewport').boundingBox();
		expect(match).toBeTruthy();
		expect(viewport).toBeTruthy();
		if (viewport) {
			expect(match!.y).toBeGreaterThanOrEqual(viewport.y);
			expect(match!.y + match!.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
		}
		await page.screenshot({ path: browserTests.info.outputPath('chat-find-code.png') });
	});

	test('Find controls, match counts and errors are localized in Simplified Chinese', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?locale=zh-CN');
		await page.evaluate(() => {
			window.ashChatTranscriptIntegration.renderItems([{ id: 'message', type: 'userMessage', text: '中文测试 中文', transient: false }]);
			window.ashChatTranscriptIntegration.showFind('中文');
		});
		const find = page.getByRole('search', { name: '在聊天中查找', exact: true });
		const query = find.getByRole('textbox', { name: '在对话中查找', exact: true });
		await expect(query).toBeFocused();
		await expect(find.getByRole('status')).toHaveText('第 1 个，共 2 个匹配');
		await find.getByRole('button', { name: '正则表达式', exact: true }).click();
		await query.fill('[');
		await expect(find.getByRole('status')).toHaveText('正则表达式无效');
		await page.screenshot({ path: browserTests.info.outputPath('chat-find-zh-CN.png') });
	});

	for (const theme of ['light', 'dark', 'hc', 'hcLight'] as const) {
		test(`query controls fit and keep visible focus in ${theme}`, async () => {
			const { page } = browserTests;
			await page.goto('/chatTranscript.html');
			await page.evaluate(theme => {
				window.ashChatTranscriptIntegration.setTheme(theme);
				window.ashChatTranscriptIntegration.renderItems([{ id: 'message', type: 'userMessage', text: 'needle', transient: false }]);
				window.ashChatTranscriptIntegration.showFind('needle');
			}, theme);
			const find = page.locator('.ash-chat-find');
			await expect(find.locator('input')).toBeFocused();
			await expect(find.getByRole('button', { name: 'Search earlier messages' })).toBeHidden();
			const box = await find.boundingBox();
			expect(box!.width).toBeLessThanOrEqual(584);
			for (const button of await find.getByRole('button').all()) {
				const rect = await button.boundingBox();
				if (!rect) { continue; }
				expect(rect.x).toBeGreaterThanOrEqual(box!.x);
				expect(rect.x + rect.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
			}
			const style = await find.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderTopWidth }));
			expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
			expect(style.border).toBe('1px');
			await page.screenshot({ path: browserTests.info.outputPath(`chat-find-${theme}.png`) });
		});
	}
});
