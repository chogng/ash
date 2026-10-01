import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../base/common/event.js';
import type { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import type { IContextMenuProvider } from '../../../base/browser/contextmenu.js';
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
	const chat = {
		onDidChangeModels: changed.event,
		listModelCatalog: async () => [{ model, displayName: 'GPT Test' }, { model: otherModel, displayName: 'Claude Test' }],
		listModelProviders: async () => [{ connection: 'openai', provider: 'openai', displayName: 'OpenAI API', access: 'apiKey', active: true, configured: true, ready: false, apiKeyPolicy: 'required', apiKeyConfigured: savedKeys.length > 0 }],
		isModelVisible: () => visible,
		setModelProviderApiKey: async (_connection: string, key: string) => { savedKeys.push(key); },
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
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ILocalTranscriptionService, transcription);
	using preferences = services.createInstance(SessionsPreferences, window.document.body, configuration, {} as IClipboardService, {} as IContextMenuProvider, contextKeys, accessibleView, chat);
	const opened = preferences.open();
	const modelsButton = [...window.document.querySelectorAll<HTMLElement>('.ash-sessions-settings-navigation-item')].find(button => button.textContent?.includes('Models'));
	assert.ok(modelsButton);
	modelsButton.click();
	assert.ok(window.document.querySelector('.ash-local-transcription-model-controls'));
	await Promise.resolve();
	assert.equal(window.document.querySelector('.ash-sessions-settings-voice-list [data-configuration-key="dictation.localModel"]') !== null, true);
	assert.match(window.document.querySelector('.ash-sessions-settings-cloud-models')?.textContent ?? '', /gpt-live-transcribe.*grok-voice-transcribe-2\.0/);
	const apiInput = window.document.querySelector<HTMLInputElement>('.ash-sessions-settings-api-row input[type="password"]');
	assert.ok(apiInput);
	const saveKey = window.document.querySelector<HTMLButtonElement>('.ash-sessions-settings-api-row button');
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
	const modelSearch = window.document.querySelector<HTMLInputElement>('.ash-sessions-settings-model-search input[type="search"]');
	assert.ok(modelSearch);
	const rows = [...window.document.querySelectorAll<HTMLElement>('.ash-sessions-settings-model-row')];
	assert.equal(rows.length, 2);
	modelSearch.value = 'anthropic/claude';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	assert.deepEqual(rows.map(row => row.hidden), [true, false]);
	modelSearch.value = 'missing';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	assert.equal(window.document.querySelector('.ash-sessions-settings-empty')?.textContent, 'No matching models or APIs.');
	modelSearch.value = 'gpt-live-transcribe';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	assert.equal(window.document.querySelector<HTMLElement>('.ash-sessions-settings-model-group')?.hidden, false);
	modelSearch.value = 'OpenAI API';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	assert.equal(window.document.querySelector<HTMLElement>('.ash-sessions-settings-api-list')?.parentElement?.hidden, false);
	modelSearch.value = 'GPT';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	assert.deepEqual(rows.map(row => row.hidden), [false, true]);
	const switchInput = window.document.querySelector<HTMLInputElement>('.ash-sessions-settings-model-row input[role="switch"]');
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
	changed.dispose();
	browser.window.close();
});
