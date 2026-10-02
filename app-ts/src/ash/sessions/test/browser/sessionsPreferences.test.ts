import assert from 'node:assert/strict';
import { registerTestDictationServices } from '../../../workbench/test/common/testDictationServices.js';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../base/common/event.js';
import type { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import type { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import type { IChatService } from '../../../workbench/services/chat/common/chatService.js';

test('Sessions Models switches control the model picker visibility preference', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const { window } = browser;
	for (const [name, value] of Object.entries({ window, document: window.document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event, MouseEvent: window.MouseEvent })) {
		Object.defineProperty(globalThis, name, { configurable: true, value });
	}
	window.HTMLElement.prototype.scrollTo = function () {};
	window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
	window.HTMLDialogElement.prototype.close = function () {
		this.removeAttribute('open');
		this.dispatchEvent(new window.Event('close'));
	};
	await import('../../browser/activityBarAccessibility.js');
	await import('../../contrib/design/browser/design.contribution.js');
	const [{ SessionsPreferences }, { WorkbenchConfigurationService }, { ContextKeyService }] = await Promise.all([
		import('../../contrib/preferences/browser/sessionsPreferences.js'),
		import('../../../workbench/services/configuration/browser/configurationService.js'),
		import('../../../platform/contextkey/browser/contextKeyService.js'),
	]);
	const model = { provider: 'openai', model: 'gpt-test' };
	const otherModel = { provider: 'anthropic', model: 'claude-test' };
	const changed = new Emitter<void>();
	let visible = true;
	const writes: boolean[] = [];
	const savedKeys: string[] = [];
	const removedKeys: string[] = [];
	const chat = {
		onDidChangeModels: changed.event,
		listModelCatalog: async () => [{ model, displayName: 'GPT Test' }, { model: otherModel, displayName: 'Claude Test' }],
		listModelProviders: async () => [{ connection: 'openai', provider: 'openai', displayName: 'OpenAI API', access: 'apiKey', active: true, configured: true, ready: false, apiKeyPolicy: 'required', apiKeyConfigured: savedKeys.length > 0 }],
		isModelVisible: () => visible,
		setModelProviderApiKey: async (_connection: string, key: string) => { savedKeys.push(key); },
		removeModelProviderApiKey: async (connection: string) => { removedKeys.push(connection); },
		refreshModels: async () => [{ model, displayName: 'GPT Test' }, { model: otherModel, displayName: 'Claude Test' }],
		setModelVisible: async (_model: typeof model, next: boolean) => {
			writes.push(next);
			visible = next;
			changed.fire();
		},
	} as unknown as IChatService;
	const accessibleView = { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService;
	using configuration = new WorkbenchConfigurationService();
	using contextKeys = new ContextKeyService();
	const { InstantiationService } = await import('../../../platform/instantiation/common/instantiationService.js');
	const { IConfigurationService } = await import('../../../platform/configuration/common/configuration.js');
	const { ILocalTranscriptionService } = await import('../../../platform/localTranscription/common/localTranscription.js');
	const { NullLocalTranscriptionService } = await import('../../../workbench/services/localTranscription/browser/localTranscriptionService.js');
	using services = new InstantiationService();
	using transcription = new NullLocalTranscriptionService();
	const { IChatService: ChatService } = await import('../../../workbench/services/chat/common/chatService.js');
	services.registerInstance(ChatService, chat);
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ILocalTranscriptionService, transcription);
	registerTestDictationServices(services, undefined);
	const { IClipboardService: ClipboardService } = await import('../../../platform/clipboard/common/clipboardService.js');
	const { IContextMenuService: ContextMenus } = await import('../../../platform/contextview/browser/contextView.js');
	const { IContextKeyService: ContextKeys } = await import('../../../platform/contextkey/browser/contextKeyService.js');
	const { IAccessibleViewService: AccessibleView } = await import('../../../platform/accessibility/browser/accessibleView.js');
	services.registerInstance(ClipboardService, {} as IClipboardService);
	services.registerInstance(ContextMenus, {} as import('../../../platform/contextview/browser/contextView.js').IContextMenuService);
	services.registerInstance(ContextKeys, contextKeys);
	services.registerInstance(AccessibleView, accessibleView);
	const { IPreferencesService } = await import('../../../workbench/services/preferences/common/preferences.js');
	services.registerInstance(IPreferencesService, { openSettings: category => preferences.open(category) } as import('../../../workbench/services/preferences/common/preferences.js').IPreferencesService);
	using preferences = services.createInstance(SessionsPreferences, window.document.body);
	const opened = preferences.open();
	const designButton = [...window.document.querySelectorAll<HTMLElement>('.ash-sessions-settings-navigation-item')].find(button => button.textContent === 'Design');
	assert.ok(designButton);
	designButton.click();
	const pointerSwitch = window.document.querySelector<HTMLInputElement>('input[data-configuration-key="sessions.design.usePointerCursor"][role="switch"]');
	assert.ok(pointerSwitch);
	assert.equal(pointerSwitch.getAttribute('aria-label'), 'Use pointer cursor on the canvas');
	assert.equal(pointerSwitch.checked, true);
	pointerSwitch.checked = false;
	pointerSwitch.dispatchEvent(new window.Event('change', { bubbles: true }));
	await Promise.resolve();
	assert.equal(configuration.getValue('sessions.design.usePointerCursor'), false);
	assert.ok(window.document.querySelector('[data-configuration-key="accessibility.verbosity.designCanvas"]'));
	const modelsButton = [...window.document.querySelectorAll<HTMLElement>('.ash-sessions-settings-navigation-item')].find(button => button.textContent?.includes('Models'));
	assert.ok(modelsButton);
	modelsButton.click();
	assert.equal(window.document.querySelector('.ash-local-transcription-model-controls'), null);
	await Promise.resolve();
	const voiceButton = [...window.document.querySelectorAll<HTMLElement>('.ash-sessions-settings-navigation-item')].find(button => button.textContent === 'General');
	assert.ok(voiceButton);
	voiceButton.click();
	assert.equal(window.document.querySelector('[data-configuration-key="dictation.localModel"]'), null);
	assert.ok(window.document.querySelector('[role="grid"][aria-label="Local dictation models"]'));
	assert.ok(window.document.querySelector('.ash-local-transcription-model-controls'));
	assert.equal(window.document.querySelector('[data-configuration-key="dictation.cloudProvider"]'), null);
	await configuration.updateValue('dictation.backend', 'cloud');
	assert.ok(window.document.querySelector('[data-configuration-key="dictation.cloudProvider"]'));
	assert.equal(window.document.querySelector('.ash-local-transcription-model-controls'), null);
	modelsButton.click();
	await Promise.resolve();
	const apiInput = window.document.querySelector<HTMLInputElement>('.ash-models-settings-api-row input[type="password"]');
	assert.ok(apiInput);
	const saveKey = window.document.querySelector<HTMLButtonElement>('.ash-models-settings-api-row button');
	assert.ok(saveKey);
	apiInput.value = 'test-secret';
	apiInput.dispatchEvent(new window.Event('input', { bubbles: true }));
	assert.equal(saveKey.disabled, false);
	saveKey.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(savedKeys, ['test-secret']);
	assert.equal(apiInput.value, '');
	assert.equal(window.document.body.textContent?.includes('test-secret'), false);
	const removeKey = [...window.document.querySelectorAll<HTMLButtonElement>('.ash-models-settings-api-row button')].find(button => button.textContent === 'Remove API key')!;
	removeKey.click();
	assert.deepEqual(removedKeys, []);
	assert.match(window.document.body.textContent ?? '', /shared by chat and dictation/);
	removeKey.click();
	await Promise.resolve();
	assert.deepEqual(removedKeys, ['openai']);
	const modelSearch = window.document.querySelector<HTMLInputElement>('.ash-sessions-settings-search input[type="search"]');
	assert.ok(modelSearch);
	assert.equal(window.document.querySelectorAll('input[type="search"]').length, 1);
	const rows = [...window.document.querySelectorAll<HTMLElement>('.ash-models-settings-model-row')];
	assert.equal(rows.length, 2);
	modelSearch.value = 'anthropic/claude';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	assert.deepEqual(rows.map(row => row.isConnected), [false, true]);
	modelSearch.value = 'missing';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	assert.equal(window.document.querySelector('.ash-models-settings-model-row'), null);
	assert.equal(window.document.querySelector<HTMLElement>('.ash-sessions-settings-empty')?.hidden, false);
	modelSearch.value = 'Cloud connection';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	assert.ok(window.document.querySelector('[data-settings-item-id="dictation.connection"]'));
	modelSearch.value = 'OpenAI API';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	assert.ok(window.document.querySelector('.ash-models-settings-api-row'));
	modelSearch.value = 'GPT';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	assert.deepEqual(rows.map(row => row.isConnected), [true, false]);
	const switchInput = window.document.querySelector<HTMLInputElement>('.ash-models-settings-model-row input[role="switch"]');
	assert.ok(switchInput);
	assert.equal(switchInput.getAttribute('aria-label'), 'Show GPT Test in model picker');
	assert.equal(switchInput.getAttribute('aria-checked'), 'true');
	switchInput.checked = false;
	switchInput.dispatchEvent(new window.Event('change', { bubbles: true }));
	await Promise.resolve();
	assert.deepEqual(writes, [false]);
	assert.equal(switchInput.getAttribute('aria-checked'), 'false');
	window.document.querySelector<HTMLDialogElement>('dialog')?.close();
	await opened;
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		const reopened = preferences.open();
		const translatedDesign = [...window.document.querySelectorAll<HTMLElement>('.ash-sessions-settings-navigation-item')].find(button => button.textContent === '设计');
		assert.ok(translatedDesign);
		translatedDesign.click();
		const restoredSwitch = window.document.querySelector<HTMLInputElement>('input[data-configuration-key="sessions.design.usePointerCursor"][role="switch"]');
		assert.ok(restoredSwitch);
		assert.equal(restoredSwitch.getAttribute('aria-label'), '在画布中使用指针光标');
		assert.equal(restoredSwitch.checked, false);
		await assert.rejects(configuration.updateValue('sessions.design.usePointerCursor', 'false'), /必须是布尔值/u);
		window.document.querySelector<HTMLDialogElement>('dialog')?.close();
		await reopened;
	} finally {
		resetNlsResolver();
	}
	changed.dispose();
	browser.window.close();
});
