import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId, type IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ContextMenuHandler } from '../../../../../platform/contextview/browser/contextMenuHandler.js';
import type { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import type { AdvisorConfig, IChatService } from '../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { AdvisorSettingsModel } from '../../browser/advisorSettingsModel.js';
import { SettingsSectionRenderer } from '../../../preferences/browser/settingsSectionRenderer.js';
import { ModelPurpose } from '../../../../../platform/models/common/agentModels.js';
import type { ILanguageModelsService } from '../../../chat/common/languageModels.js';

test('Advisor marks its saved model, Disable when disabled and its saved value when the model is hidden', async () => {
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
		const button = domNode.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
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
			{ enabled: true, visible: true, label: 'Custom Advisor' },
			{ enabled: false, visible: true, label: 'Disable' },
			{ enabled: true, visible: false, label: 'Custom Advisor' },
		]) {
			saved = { ...saved, enabled: state.enabled };
			modelVisible = state.visible;
			const ready = advisorLoaded(content);
			content.setVisible(true);
			await ready;
			button.focus();
			button.click();
			const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
			assert.equal(menu.querySelector('[aria-checked="true"]')?.textContent, state.label);
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

test('Advisor shows the saved or catalog effort on the model row and only offers supported levels', async () => {
	const model: ModelCatalogEntry = {
		model: { provider: 'custom', model: 'reasoning' }, displayName: 'Reasoning Advisor', longContext: null,
		recommendedFor: [ModelPurpose.Advisor], defaultReasoningEffort: 'low', effectiveReasoningEffort: 'high', supportedReasoningEfforts: [{ effort: 'low' }, { effort: 'high' }],
	};
	let saved: AdvisorConfig | null = { model: model.model, enabled: true, maxCalls: 7, maxOutputTokens: 8192 };
	using fixture = advisorFixture({ readAdvisorDefault: async () => saved, saveAdvisorDefault: async value => { saved = value; } }, Event.None, [model]);
	const ready = advisorLoaded(fixture.content); fixture.content.setVisible(true); await ready;
	const button = fixture.domNode.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
	Object.defineProperty(button, 'getClientRects', { value: () => [new fixture.dom.window.DOMRect(0, 0, 100, 20)] });
	fixture.dom.window.Element.prototype.scrollTo = () => { };
	const document = fixture.dom.window.document;
	const key = (target: Element, key: string): void => {
		target.dispatchEvent(new fixture.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
	};
	const open = (): HTMLElement => {
		button.focus();
		button.click();
		return document.querySelector<HTMLElement>('[role="menu"]')!;
	};
	const options = (menu: HTMLElement): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>('button[role^="menuitem"]')];
	const openEfforts = (menu: HTMLElement): HTMLElement => {
		const modelRow = options(menu).find(row => row.getAttribute('aria-haspopup') === 'menu')!;
		modelRow.focus();
		key(modelRow, 'ArrowRight');
		assert.equal(modelRow.getAttribute('aria-expanded'), 'true');
		return [...document.querySelectorAll<HTMLElement>('[role="menu"]')].find(candidate => candidate !== menu)!;
	};
	const menu = open();
	assert.deepEqual(options(menu).map(option => option.getAttribute('aria-label')), ['Inherit from chat', 'Disable', 'Reasoning Advisor Low']);
	const separator = menu.querySelector('[role="separator"]')!;
	assert.equal(separator.nextElementSibling?.querySelector('.ash-button-label')?.textContent, 'Reasoning Advisor');
	const efforts = openEfforts(menu);
	assert.deepEqual(options(efforts).map(option => option.textContent), ['Low', 'High']);
	assert.equal(efforts.querySelector('[aria-checked="true"]')?.textContent, 'Low');
	key(document.activeElement!, 'ArrowLeft');
	assert.equal(document.activeElement?.getAttribute('aria-label'), 'Reasoning Advisor Low');
	key(document.activeElement!, 'Escape');
	assert.equal(document.activeElement, button);
	assert.equal(document.querySelector('[role="menu"]'), null);
	const choose = async (label: string, selectedLabel = label): Promise<void> => {
		const savedEvent = advisorLoaded(fixture.content);
		const menu = open();
		const target = selectedLabel === label ? menu : openEfforts(menu);
		const choice = options(target).find(option => option.textContent === label)!;
		choice.focus();
		key(choice, 'Enter');
		await savedEvent;
		assert.equal(button.getAttribute('aria-label'), `Advisor model: ${selectedLabel}`);
		assert.equal(document.querySelector('[role="menu"]'), null);
	};
	assert.equal(saved?.reasoningEffort, undefined);
	await choose('High', 'Reasoning Advisor High');
	assert.deepEqual(saved, { model: model.model, enabled: true, reasoningEffort: 'high', maxCalls: 7, maxOutputTokens: 8192 });
	const updatedMenu = open();
	assert.equal(options(updatedMenu).at(-1)?.getAttribute('aria-label'), 'Reasoning Advisor High');
	assert.equal(openEfforts(updatedMenu).querySelector('[aria-checked="true"]')?.textContent, 'High');
	key(document.activeElement!, 'ArrowLeft');
	key(document.activeElement!, 'Escape');
	await choose('Low', 'Reasoning Advisor Low');
	assert.equal(saved?.reasoningEffort, 'low');
	await choose('Inherit from chat');
	assert.deepEqual(saved, { model: null, enabled: true, maxCalls: 7, maxOutputTokens: 8192 });
	const inheritedMenu = open();
	assert.equal(inheritedMenu.querySelector('[aria-checked="true"]')?.textContent, 'Inherit from chat');
	assert.equal(inheritedMenu.querySelector('.ash-icon-label-description')?.textContent, 'Low');
	assert.equal(openEfforts(inheritedMenu).querySelector('[aria-checked="true"]')?.textContent, 'Low');
	key(document.activeElement!, 'ArrowLeft');
	key(document.activeElement!, 'Escape');
	await choose('Disable');
	assert.deepEqual(saved, { model: null, enabled: false, maxCalls: 7, maxOutputTokens: 8192 });
	fixture.content.setVisible(false);
	const reopened = advisorLoaded(fixture.content); fixture.content.setVisible(true); await reopened;
	assert.equal(button.textContent, 'Disable');
	await choose('Inherit from chat');
});
function advisorLoaded(content: SettingsSectionRenderer): Promise<void> {
	return new Promise(resolve => { const listener = content.onDidChange(() => { if (elementOf(content).querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.disabled === false) { listener.dispose(); resolve(); } }); });
}

test('Advisor hide and reopen discard a late load and keep the newer backend preference', async () => {
	const old = new DeferredPromise<AdvisorConfig | null>();
	let reads = 0;
	const saved: AdvisorConfig = { model: { provider: 'openai', model: 'new-model' }, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
	using fixture = advisorFixture({ readAdvisorDefault: () => ++reads === 1 ? old.p : Promise.resolve(saved), saveAdvisorDefault: async () => { } });
	fixture.content.setVisible(true); fixture.content.setVisible(false);
	const ready = advisorLoaded(fixture.content); fixture.content.setVisible(true); await ready;
	await old.complete(null); await Promise.resolve(); await Promise.resolve();
	assert.equal(fixture.domNode.querySelector('button[aria-haspopup="menu"]')?.textContent, 'openai/new-model');
	assert.equal(fixture.domNode.querySelector('[role="switch"]'), null);
});

test('Advisor failed writes restore the saved model and turning it off preserves the model', async () => {
	let saved: AdvisorConfig | null = { model: { provider: 'openai', model: 'saved-model' }, enabled: true, maxCalls: 3, maxOutputTokens: 2048 };
	let fail = true; let reads = 0;
	using fixture = advisorFixture({ readAdvisorDefault: async () => { reads++; return saved; }, saveAdvisorDefault: async value => { if (fail) throw new Error('write rejected'); saved = value; } });
	const ready = advisorLoaded(fixture.content); fixture.content.setVisible(true); await ready;
	const button = fixture.domNode.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
	Object.defineProperty(button, 'getClientRects', { value: () => [new fixture.dom.window.DOMRect(0, 0, 100, 20)] });
	fixture.dom.window.Element.prototype.scrollTo = () => { };
	const turnOff = (): void => {
		button.click();
		[...fixture.dom.window.document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(option => option.textContent === 'Disable')!.click();
	};
	turnOff();
	await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
	assert.equal(button.textContent, 'openai/saved-model');
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
		const listener = fixture.content.onDidChange(() => { if (fixture.domNode.querySelector('button[aria-haspopup="menu"]')?.textContent === 'openai/new-default') { listener.dispose(); resolve(); } });
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
	const views = resources.add(new BrowserContextViewService(document.body));
	const handler = resources.add(new ContextMenuHandler(views, { lookupKeybinding: () => undefined } as unknown as IKeybindingService,
		{ error: (message: string) => assert.fail(message) } as unknown as INotificationService));
	const menus = {
		contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
		showContextMenu: delegate => { if ('getAnchor' in delegate && delegate.getActions) handler.showContextMenu({ ...delegate, getActions: delegate.getActions }); },
		hideContextMenu: () => handler.hideContextMenu(),
	} satisfies IContextMenuService;
	const content = resources.add(new SettingsSectionRenderer(document.body, model,
		AccessibleViewProviderId.ChatModelConfiguration, AccessibilityVerbositySettingId.ChatModelConfiguration,
		views, menus,
		resources.add(new InMemoryConfigurationService()), resources.add(new ContextKeyService()),
		{ getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService));
	const domNode = elementOf(content);
	document.body.append(domNode);
	return { content, domNode };
}
