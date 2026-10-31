import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId, type IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import type { AdvisorConfig, IChatService } from '../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { AdvisorSettingsModel } from '../../browser/advisorSettingsModel.js';
import { SettingsSectionRenderer } from '../../../preferences/browser/settingsSectionRenderer.js';
import { ModelPurpose } from '../../../../../platform/agentHost/common/agentModels.js';
import type { ILanguageModelsService } from '../../../chat/common/languageModels.js';

test('Advisor focuses its saved model, Disable when disabled and its saved value when the model is hidden', async () => {
	const dom = new JSDOM('<body></body>');
	dom.window.Element.prototype.scrollIntoView = () => { };
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
			model: { provider: 'custom', model: 'advisor-fixture' }, displayName: 'Custom Advisor', longContext: null, recommendedFor: [ModelPurpose.Advisor],
		};
		let saved: AdvisorConfig = { model: model.model, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
		let modelVisible = true;
		const { content, domNode } = advisorRenderer(resources, document,
			{ readAdvisorDefault: async () => saved } as IChatService,
			{ onDidChangeModels: Event.None, listModelCatalog: async () => [model, { ...model, model: { provider: 'custom', model: 'not-recommended' }, displayName: 'Unmarked', recommendedFor: [] }], isModelVisible: () => modelVisible } as unknown as ILanguageModelsService);
		const button = domNode.querySelector<HTMLButtonElement>('[aria-label="Advisor model"]')!;
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
			{ enabled: true, visible: true, label: 'Custom Advisor · Default' },
			{ enabled: false, visible: true, label: 'Disable' },
			{ enabled: true, visible: false, label: 'Custom Advisor · Default' },
		]) {
			saved = { ...saved, enabled: state.enabled };
			modelVisible = state.visible;
			const ready = advisorLoaded(content);
			content.setVisible(true);
			await ready;
			button.focus();
			button.click();
			const menu = document.querySelector<HTMLElement>('[role="listbox"]')!;
			assert.equal(document.activeElement, state.label ? [...menu.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === state.label) : menu);
			assert.equal(menu.querySelector('[aria-selected="true"]')?.textContent ?? null, state.label);
			assert.equal(menu.textContent?.includes('Unmarked'), false);
			menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			assert.equal(document.activeElement, button);
			content.setVisible(false);
		}
	} finally {
		dom.window.close();
	}
});


function advisorFixture(chat: Pick<IChatService, 'readAdvisorDefault' | 'saveAdvisorDefault'>, changes = Event.None, models: readonly ModelCatalogEntry[] = []) {
	const dom = new JSDOM('<body></body>');
	dom.window.Element.prototype.scrollIntoView = () => { };
	const resources = new DisposableStore();
	const { content, domNode } = advisorRenderer(resources, dom.window.document, chat as IChatService,
		{ onDidChangeModels: changes, listModelCatalog: async () => models, isModelVisible: () => true } as unknown as ILanguageModelsService);
	return { content, domNode, dom, dispose() { resources.dispose(); dom.window.close(); }, [Symbol.dispose]() { this.dispose(); } };
}

test('Advisor groups inheritance and Disable before models and persists each reasoning choice and inherited budgets', async () => {
	const model: ModelCatalogEntry = {
		model: { provider: 'custom', model: 'reasoning' }, displayName: 'Reasoning Advisor', longContext: null,
		recommendedFor: [ModelPurpose.Advisor], defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ effort: 'low' }, { effort: 'high' }],
	};
	let saved: AdvisorConfig | null = { model: model.model, enabled: true, reasoningEffort: 'high', maxCalls: 7, maxOutputTokens: 8192 };
	using fixture = advisorFixture({ readAdvisorDefault: async () => saved, saveAdvisorDefault: async value => { saved = value; } }, Event.None, [model]);
	const ready = advisorLoaded(fixture.content); fixture.content.setVisible(true); await ready;
	const button = fixture.domNode.querySelector<HTMLButtonElement>('[aria-label="Advisor model"]')!;
	Object.defineProperty(button, 'getClientRects', { value: () => [new fixture.dom.window.DOMRect(0, 0, 100, 20)] });
	fixture.dom.window.Element.prototype.scrollTo = () => { };
	button.click();
	const menu = fixture.dom.window.document.querySelector('[role="listbox"]')!;
	assert.deepEqual([...menu.querySelectorAll('[role="option"]')].map(option => option.textContent), [
		'Inherit from chat', 'Disable', 'Reasoning Advisor · High (Default)', 'Reasoning Advisor · Low', 'Reasoning Advisor · High',
	]);
	assert.equal(menu.querySelectorAll('.ash-select-box-option-separator-before').length, 1);
	assert.equal(menu.querySelector('.ash-select-box-option-separator-before')?.textContent, 'Reasoning Advisor · High (Default)');
	menu.dispatchEvent(new fixture.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	const choose = async (label: string): Promise<void> => {
		const savedEvent = advisorLoaded(fixture.content);
		button.click();
		[...fixture.dom.window.document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === label)!.click();
		await savedEvent;
		assert.equal(button.textContent, label);
	};
	await choose('Reasoning Advisor · Low');
	assert.deepEqual(saved, { model: model.model, enabled: true, reasoningEffort: 'low', maxCalls: 7, maxOutputTokens: 8192 });
	await choose('Reasoning Advisor · High (Default)');
	assert.equal(saved?.reasoningEffort, undefined);
	await choose('Inherit from chat');
	assert.deepEqual(saved, { model: null, enabled: true, maxCalls: 7, maxOutputTokens: 8192 });
	await choose('Disable');
	assert.deepEqual(saved, { model: null, enabled: false, maxCalls: 7, maxOutputTokens: 8192 });
	fixture.content.setVisible(false);
	const reopened = advisorLoaded(fixture.content); fixture.content.setVisible(true); await reopened;
	assert.equal(button.textContent, 'Disable');
	await choose('Inherit from chat');
});
function advisorLoaded(content: SettingsSectionRenderer): Promise<void> {
	return new Promise(resolve => { const listener = content.onDidChange(() => { if (elementOf(content).querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled === false) { listener.dispose(); resolve(); } }); });
}

test('Advisor hide and reopen discard a late load and keep the newer backend preference', async () => {
	const old = new DeferredPromise<AdvisorConfig | null>();
	let reads = 0;
	const saved: AdvisorConfig = { model: { provider: 'openai', model: 'new-model' }, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
	using fixture = advisorFixture({ readAdvisorDefault: () => ++reads === 1 ? old.p : Promise.resolve(saved), saveAdvisorDefault: async () => { } });
	fixture.content.setVisible(true); fixture.content.setVisible(false);
	const ready = advisorLoaded(fixture.content); fixture.content.setVisible(true); await ready;
	await old.complete(null); await Promise.resolve(); await Promise.resolve();
	assert.equal(fixture.domNode.querySelector('[aria-label="Advisor model"]')?.textContent, 'openai/new-model · Default');
	assert.equal(fixture.domNode.querySelector('[role="switch"]'), null);
});

test('Advisor failed writes restore the saved model and turning it off preserves the model', async () => {
	let saved: AdvisorConfig | null = { model: { provider: 'openai', model: 'saved-model' }, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
	let fail = true; let reads = 0;
	using fixture = advisorFixture({ readAdvisorDefault: async () => { reads++; return saved; }, saveAdvisorDefault: async value => { if (fail) throw new Error('write rejected'); saved = value; } });
	const ready = advisorLoaded(fixture.content); fixture.content.setVisible(true); await ready;
	const button = fixture.domNode.querySelector<HTMLButtonElement>('[aria-label="Advisor model"]')!;
	Object.defineProperty(button, 'getClientRects', { value: () => [new fixture.dom.window.DOMRect(0, 0, 100, 20)] });
	fixture.dom.window.Element.prototype.scrollTo = () => { };
	const turnOff = (): void => {
		button.click();
		fixture.dom.window.document.querySelector<HTMLElement>('[role="option"][data-index="1"]')!.click();
	};
	turnOff();
	await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
	assert.equal(button.textContent, 'openai/saved-model · Default');
	assert.match(fixture.domNode.textContent ?? '', /write rejected/);
	fail = false;
	const savedEvent = advisorLoaded(fixture.content); turnOff(); await savedEvent;
	assert.equal(button.textContent, 'Disable');
	assert.deepEqual(saved?.model, { provider: 'openai', model: 'saved-model' });
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
		const listener = fixture.content.onDidChange(() => { if (fixture.domNode.querySelector('[aria-label="Advisor model"]')?.textContent === 'openai/new-default · Default') { listener.dispose(); resolve(); } });
	});
	fixture.content.setVisible(true); changes.fire(); await old.complete(null); await refreshed;
	assert.equal(reads, 2);
});

function elementOf(content: SettingsSectionRenderer): HTMLElement {
	const node = content.getNodes()[0].element;
	assert.equal(node.kind, 'item');
	if (node.kind !== 'item') { throw new Error('Expected Advisor section'); }
	return content.renderItem(node.value);
}

function advisorRenderer(resources: DisposableStore, document: Document, chat: IChatService, models: ILanguageModelsService) {
	const model = resources.add(new AdvisorSettingsModel(chat, models));
	const content = resources.add(new SettingsSectionRenderer(document.body, model,
		AccessibleViewProviderId.ChatModelConfiguration, AccessibilityVerbositySettingId.ChatModelConfiguration,
		resources.add(new BrowserContextViewService(document.body)),
		resources.add(new InMemoryConfigurationService()), resources.add(new ContextKeyService()),
		{ getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService));
	const domNode = elementOf(content);
	document.body.append(domNode);
	return { content, domNode };
}
