import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import type { AdvisorConfig, IChatService } from '../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import type { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import { AdvisorSettingsRenderer } from '../../browser/advisorSettingsRenderer.js';
import type { ILanguageModelsService } from '../../../chat/common/languageModels.js';

test('Advisor focuses its saved model, Disable when disabled and the menu when the saved model is hidden', async () => {
	const dom = new JSDOM('<body></body>');
	Object.defineProperty(dom.window.Element.prototype, 'scrollTo', {
		configurable: true,
		value(this: Element, options: ScrollToOptions): void {
			this.scrollLeft = options.left ?? this.scrollLeft;
			this.scrollTop = options.top ?? this.scrollTop;
		},
	});
	try {
		using resources = new DisposableStore();
		const document = dom.window.document;
		const model: ModelCatalogEntry = {
			model: { provider: 'openai', model: 'gpt-6.1-sol' }, displayName: 'GPT-6.1 Sol', longContext: null,
		};
		let saved: AdvisorConfig = { model: model.model, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
		let modelVisible = true;
		const content = resources.add(new AdvisorSettingsRenderer(document.body,
			{ readAdvisorDefault: async () => saved } as IChatService,
			{ onDidChangeModels: Event.None, listAdvisorModels: async () => [model], isModelVisible: () => modelVisible } as unknown as ILanguageModelsService,
			resources.add(new BrowserContextViewService(document.body)),
			resources.add(new ContextKeyService()),
			{ getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService,
			resources.add(new InMemoryConfigurationService()),
			{} as ILocalizationService,
		));
		document.body.append(content.domNode);
		const button = content.domNode.querySelector<HTMLButtonElement>('[aria-label="Advisor model"]')!;
		// jsdom has no layout; model the painted trigger without making hidden or detached targets visible.
		Object.defineProperty(button, 'getClientRects', {
			value(this: Element): readonly DOMRect[] {
				if (!this.isConnected || this.closest('[hidden]')) return [];
				for (let element: Element | null = this; element; element = element.parentElement) {
					if (dom.window.getComputedStyle(element).display === 'none') return [];
				}
				return [new dom.window.DOMRect(0, 0, 100, 20)];
			},
		});
		for (const state of [
			{ enabled: true, visible: true, label: 'GPT-6.1 Sol' },
			{ enabled: false, visible: true, label: 'Disable' },
			{ enabled: true, visible: false, label: null },
		]) {
			saved = { ...saved, enabled: state.enabled };
			modelVisible = state.visible;
			let loaded!: () => void;
			const ready = new Promise<void>(resolve => { loaded = resolve; });
			const listener = resources.add(content.onDidChange(loaded));
			content.setVisible(true);
			await ready;
			listener.dispose();
			button.focus();
			button.click();
			const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
			assert.equal(document.activeElement, state.label ? menu.querySelector(`[aria-label="${state.label}"]`) : menu);
			assert.equal(menu.querySelector('[aria-checked="true"]')?.getAttribute('aria-label') ?? null, state.label);
			menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			assert.equal(document.activeElement, button);
			content.setVisible(false);
		}
	} finally {
		dom.window.close();
	}
});


function advisorFixture(chat: Pick<IChatService, 'readAdvisorDefault' | 'saveAdvisorDefault'>, changes = Event.None) {
	const dom = new JSDOM('<body></body>');
	const resources = new DisposableStore();
	const content = resources.add(new AdvisorSettingsRenderer(dom.window.document.body, chat as IChatService,
		{ onDidChangeModels: changes, listAdvisorModels: async () => [], isModelVisible: () => true } as unknown as ILanguageModelsService,
		resources.add(new BrowserContextViewService(dom.window.document.body)), resources.add(new ContextKeyService()),
		{ getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService, resources.add(new InMemoryConfigurationService()), {} as ILocalizationService));
	dom.window.document.body.append(content.domNode);
	return { content, dom, dispose() { resources.dispose(); dom.window.close(); }, [Symbol.dispose]() { this.dispose(); } };
}
function advisorLoaded(content: AdvisorSettingsRenderer): Promise<void> {
	return new Promise(resolve => { const listener = content.onDidChange(() => { listener.dispose(); resolve(); }); });
}

test('Advisor hide and reopen discard a late load and keep the newer backend preference', async () => {
	const old = new DeferredPromise<AdvisorConfig | null>();
	let reads = 0;
	const saved: AdvisorConfig = { model: { provider: 'openai', model: 'new-model' }, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
	using fixture = advisorFixture({ readAdvisorDefault: () => ++reads === 1 ? old.p : Promise.resolve(saved), saveAdvisorDefault: async () => { } });
	fixture.content.setVisible(true); fixture.content.setVisible(false);
	const ready = advisorLoaded(fixture.content); fixture.content.setVisible(true); await ready;
	await old.complete(null); await Promise.resolve(); await Promise.resolve();
	assert.equal(fixture.content.domNode.querySelector('[aria-label="Advisor model"]')?.textContent, 'openai/new-model');
	assert.equal(fixture.content.domNode.querySelector<HTMLInputElement>('input')?.checked, true);
});

test('Advisor failed writes restore the saved switch and successful writes read the backend back', async () => {
	let saved: AdvisorConfig | null = { model: { provider: 'openai', model: 'saved-model' }, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
	let fail = true; let reads = 0;
	using fixture = advisorFixture({ readAdvisorDefault: async () => { reads++; return saved; }, saveAdvisorDefault: async value => { if (fail) throw new Error('write rejected'); saved = value; } });
	const ready = advisorLoaded(fixture.content); fixture.content.setVisible(true); await ready;
	const input = fixture.content.domNode.querySelector<HTMLInputElement>('input')!;
	input.click();
	await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
	assert.equal(input.checked, true);
	assert.match(fixture.content.domNode.textContent ?? '', /write rejected/);
	fail = false;
	const savedEvent = advisorLoaded(fixture.content); input.click(); await savedEvent;
	assert.equal(input.checked, false);
	assert.equal(saved?.enabled, false);
	assert.equal(reads, 2);
});


test('Advisor rechecks a backend update received while its first read is still pending', async () => {
	using changes = new Emitter<void>();
	const old = new DeferredPromise<AdvisorConfig | null>();
	let reads = 0;
	const saved: AdvisorConfig = { model: { provider: 'openai', model: 'new-default' }, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
	using fixture = advisorFixture({ readAdvisorDefault: () => ++reads === 1 ? old.p : Promise.resolve(saved), saveAdvisorDefault: async () => { } }, changes.event);
	const refreshed = new Promise<void>(resolve => {
		const listener = fixture.content.onDidChange(() => { if (fixture.content.domNode.querySelector('[aria-label="Advisor model"]')?.textContent === 'openai/new-default') { listener.dispose(); resolve(); } });
	});
	fixture.content.setVisible(true); changes.fire(); await old.complete(null); await refreshed;
	assert.equal(reads, 2);
});
