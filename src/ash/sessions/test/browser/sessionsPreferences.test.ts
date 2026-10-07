import { IPromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IAgentCapabilitiesService } from '../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IDirPermissionsService } from '../../../platform/dirPermissions/common/dirPermissionsService.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { ITraceSettingsService } from '../../../platform/trace/common/traceSettingsService.js';
import { IFileDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IAccountService } from '../../../platform/accounts/common/accountService.js';
import { IGitHubService } from '../../../platform/github/common/githubService.js';
import { IGitHubConnectionService } from '../../../workbench/services/accounts/common/gitHubConnectionService.js';
import { GitHubReviewModel, IGitHubReviewModel } from '../../../workbench/contrib/github/browser/githubReviewModel.js';
import '../../contrib/library/browser/library.contribution.js';
import { ILanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../base/common/event.js';
import { IAppServerSkillApi } from '../../../platform/agentHost/common/appServerApi.js';
import { IMarketplaceService } from '../../../platform/marketplace/common/marketplaceService.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IHooksService } from '../../../platform/hooks/common/hooksService.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../workbench/services/workspaces/browser/workspaceContextService.js';
import { IRemoteAgentService } from '../../../workbench/services/remote/common/remoteAgentService.js';
import { IChatSessionNavigationService } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILocalizationService } from '../../../workbench/services/localization/common/localizationService.js';
import type { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import type { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import type { IChatService } from '../../../workbench/services/chat/common/chatService.js';

test('Sessions Models switches control the model picker visibility preference', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const { window } = browser;
	for (const [name, value] of Object.entries({ window, document: window.document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event, MouseEvent: window.MouseEvent })) {
		Object.defineProperty(globalThis, name, { configurable: true, value });
	}
	window.HTMLElement.prototype.scrollTo = function () { };
	// JSDOM has no layout; shared keyboard navigation still checks rendered visibility.
	Object.defineProperty(window.Element.prototype, 'getClientRects', {
		value: function (this: Element) { return this.isConnected && !this.closest('[hidden], [inert]') ? [{}] : []; },
	});
	window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
	window.HTMLDialogElement.prototype.close = function () {
		this.removeAttribute('open');
		this.dispatchEvent(new window.Event('close'));
	};
	await import('../../browser/activityBarAccessibility.js');
	await import('../../contrib/creator/browser/creatorEditor.contribution.js');
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
	const advisorModel = { provider: 'openai', model: 'gpt-6.1-sol' };
	let advisor: import('../../../workbench/services/chat/common/chatService.js').AdvisorConfig | null = { model: advisorModel, enabled: true, maxCalls: 5, maxOutputTokens: 4096, reasoningEffort: 'high' };
	const advisorWrites: (typeof advisor | null)[] = [];
	const chat = {
		onDidChangeModels: changed.event,
		listAdvisorModels: async () => [{ model: advisorModel, displayName: 'GPT-6.1 Sol' }, { model: otherModel, displayName: 'Claude Test' }],
		readAdvisorDefault: async () => advisor,
		saveAdvisorDefault: async (next: typeof advisor) => { advisor = next; advisorWrites.push(next); },
		listModelCatalog: async () => [{ model, displayName: 'GPT Test' }, { model: otherModel, displayName: 'Claude Test' }],
		setModelPreferences: async () => { },
		listCustomModelProviders: async () => [],
		saveCustomModelProvider: async () => { },
		testProviderModel: async () => ({ type: 'passed' }),
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
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	using transcription = new NullLocalTranscriptionService();
	const { IChatService: ChatService } = await import('../../../workbench/services/chat/common/chatService.js');
	services.registerInstance(ChatService, chat);
	services.registerInstance(ILanguageModelsService, chat as unknown as ILanguageModelsService);
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ILocalTranscriptionService, transcription);
	const { IDictationService } = await import('../../../platform/dictation/common/dictationService.js');
	const { IChatSpeechToTextService, ChatSpeechToTextService } = await import('../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js');
	services.registerInstance(IDictationService, undefined);
	using speech = services.createInstance(ChatSpeechToTextService);
	services.registerInstance(IChatSpeechToTextService, speech);
	const { INotificationService } = await import('../../../platform/notification/common/notification.js');
	const { NotificationService } = await import('../../../workbench/services/notification/common/notificationService.js');
	using notifications = new NotificationService();
	services.registerInstance(INotificationService, notifications);
	const { IClipboardService: ClipboardService } = await import('../../../platform/clipboard/common/clipboardService.js');
	const { IContextMenuService: ContextMenus } = await import('../../../platform/contextview/browser/contextView.js');
	const { IContextViewService } = await import('../../../platform/contextview/browser/contextView.js');
	const { BrowserContextViewService } = await import('../../../platform/contextview/browser/contextViewService.js');
	const { BrowserContextMenuService } = await import('../../../platform/contextview/browser/contextMenuService.js');
	const { IContextKeyService: ContextKeys } = await import('../../../platform/contextkey/browser/contextKeyService.js');
	const { IAccessibleViewService: AccessibleView } = await import('../../../platform/accessibility/browser/accessibleView.js');
	const copied: string[] = [];
	services.registerInstance(ClipboardService, {
		readText: async () => '', writeText: async text => { copied.push(text); }, readImage: async () => new Uint8Array(),
		readResources: async () => ({ resources: [], operation: 'copy' }), writeResources: async () => { }, hasResources: async () => false,
	} satisfies IClipboardService);
	services.registerInstance(IKeybindingService, {
		inChordMode: false, onDidUpdateKeybindings: Event.None, getKeybindings: () => [],
		registerSchemaContribution: () => Disposable.None,
		resolveKeybinding: () => { throw new Error('Explicit keybinding resolution is not used by this fixture'); },
		resolveUserBinding: () => undefined, lookupKeybindings: () => [], lookupKeybinding: () => undefined,
	});
	using windowContextView = new BrowserContextViewService(window.document.body);
	services.registerInstance(IContextViewService, windowContextView);
	services.registerSingleton(ContextMenus, () => services.createInstance(BrowserContextMenuService));
	services.registerInstance(ContextKeys, contextKeys);
	services.registerInstance(AccessibleView, accessibleView);
	services.registerInstance(IAppServerSkillApi, { onDidChangeSkills: Event.None, readInstructions: async () => { throw new Error("No Skill body in this test fixture"); }, list: async () => ({ generation: 0, skills: [] }), read: async () => ({ revision: 0, catalog: { generation: 0, skills: [] }, diagnostics: [] }), setEnabled: async () => { } });
	services.registerInstance(IMarketplaceService, { onDidChangeInstalled: Event.None, listInstalled: async () => [] } as unknown as IMarketplaceService);
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	services.registerInstance(IMenuService, services.createInstance(MenuService));
	services.registerInstance(IDialogService, {} as IDialogService);
	services.registerInstance(IHooksService, { onDidChange: Event.None, userConfigurationEditor: undefined, read: async () => [] });
	using workspace = new WorkspaceContextService({ id: 'sessions-preferences', folders: [] });
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IRemoteAgentService, { connectionState: 'connected', connection: { kind: 'local', generation: 1 }, onDidChangeConnectionState: Event.None, onDidChangeConnection: Event.None, reconnect: async () => ({ kind: 'alreadyConnected' }), rollbackRuntime: async () => ({ kind: 'cancelled' }) });
	services.registerInstance(ITraceSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, configured: null, recording: { type: 'disabled' } }), configure: async () => { } });
	services.registerInstance(IFileDialogService, { showOpenDialog: async () => undefined, showSaveDialog: async () => undefined, pickFileToSave: async () => undefined, showSaveConfirm: async () => 2 });
	services.registerInstance(IChatSessionNavigationService, { getActiveConversation: () => undefined, getConversations: () => [], captureActiveDraft: async () => undefined, openConversation: async () => { }, appendToActiveDraft: () => { } });
	services.registerInstance(IEditorService, {} as IEditorService);
	services.registerInstance(IFileService, {} as IFileService);
	services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, fallback) => fallback });
	const { IPreferencesService } = await import('../../../workbench/services/preferences/common/preferences.js');
	services.registerInstance(IPreferencesService, { openSettings: category => preferences.open(category) } as import('../../../workbench/services/preferences/common/preferences.js').IPreferencesService);
	services.registerInstance(IAccountService, { onDidChangeAccounts: Event.None, onDidCompleteLogin: Event.None, read: async () => ({ revision: 1n, accounts: [] }), startLogin: async () => { throw new Error('Not used'); }, cancelLogin: async () => { }, logout: async () => { } });
	services.registerInstance(IGitHubService, { listAccounts: async () => [] } as unknown as IGitHubService);
	services.registerInstance(IGitHubConnectionService, { isConnecting: false, connect: async () => { }, cancel: async () => { } });
	using githubReview = services.createInstance(GitHubReviewModel);
	services.registerInstance(IGitHubReviewModel, githubReview);
	services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
	services.registerInstance(IAgentCapabilitiesService, { isAvailable: true, read: async () => ({ toolSets: [], tools: [{ name: 'read_file', description: 'Read authorized files', source: 'local', sourceDetails: ['Ash'], exposure: 'direct', authority: 'directoryRead' }], localProcessSandboxConfigured: false, sandboxBackends: [], directoryGrantsReadable: false, sandboxDiagnostics: [] }) });
	services.registerInstance(IDirPermissionsService, { onDidChangePermissions: Event.None } as import('../../../platform/dirPermissions/common/dirPermissionsService.js').IDirPermissionsService);
	using preferences = services.createInstance(SessionsPreferences, window.document.body, () => { });
	await configuration.updateValue('sessions.activityBar.compact', true);
	const opened = preferences.open();
	await Promise.race([opened, Promise.resolve()]);
	const openCopyMenu = (category = 'Appearance', copyLabel = 'Copy Setting as JSON') => {
		const dialog = window.document.querySelector<HTMLDialogElement>('dialog')!;
		[...dialog.querySelectorAll<HTMLButtonElement>('.ash-sessions-settings-navigation-item')].find(button => button.textContent === category)!.click();
		const more = dialog.querySelector<HTMLButtonElement>('[data-settings-item-id="sessions.activityBar.compact"] .ash-setting-item-actions-trigger')!;
		more.focus();
		more.click();
		const menu = dialog.querySelector<HTMLElement>('[role="menu"]')!;
		assert.ok(menu);
		menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		const copy = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === copyLabel)!;
		assert.ok(copy);
		assert.equal(window.document.activeElement, copy);
		assert.equal(dialog.querySelectorAll('.ash-context-view').length, 1);
		return { copy, menu, more };
	};
	const firstMenu = openCopyMenu();
	firstMenu.copy.click();
	await Promise.resolve();
	assert.deepEqual(copied, ['"sessions.activityBar.compact": true']);
	assert.equal(firstMenu.menu.isConnected, false);
	assert.equal(window.document.activeElement, firstMenu.more);
	const cancelledMenu = openCopyMenu();
	cancelledMenu.menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(cancelledMenu.menu.isConnected, false);
	assert.equal(window.document.activeElement, cancelledMenu.more);
	void preferences.open('tools');
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(window.document.querySelector('[aria-current="page"]')?.textContent, 'Tools');
	assert.match(window.document.querySelector('.ash-agent-capabilities-list')?.textContent ?? '', /read_file/);
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
	await new Promise<void>(resolve => setImmediate(resolve));
	const apiInput = window.document.querySelector<HTMLInputElement>('.ash-models-settings-api-row input[type="password"]');
	assert.ok(apiInput);
	assert.equal(window.document.querySelector('.ash-models-settings-api-row button'), null);
	apiInput.value = 'test-secret';
	apiInput.dispatchEvent(new window.Event('input', { bubbles: true }));
	apiInput.dispatchEvent(new window.Event('blur'));
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(savedKeys, ['test-secret']);
	assert.equal(apiInput.value, '••••••••');
	assert.equal(window.document.body.textContent?.includes('test-secret'), false);
	apiInput.value = '';
	apiInput.dispatchEvent(new window.Event('input', { bubbles: true }));
	apiInput.dispatchEvent(new window.Event('blur'));
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(removedKeys, ['openai']);
	const modelSearch = window.document.querySelector<HTMLInputElement>('.ash-sessions-settings-search input[type="search"]');
	assert.ok(modelSearch);
	assert.equal(window.document.querySelectorAll('input[type="search"]').length, 2);
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
	modelSearch.value = '';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	const agentsButton = [...window.document.querySelectorAll<HTMLElement>('.ash-sessions-settings-navigation-item')].find(button => button.textContent === 'Agents');
	assert.ok(agentsButton);
	agentsButton.click();
	await Promise.resolve();
	await Promise.resolve();
	const advisorSwitch = window.document.querySelector<HTMLInputElement>('.ash-advisor-settings input[role="switch"]');
	assert.ok(advisorSwitch);
	assert.equal(advisorSwitch.checked, true);
	advisorSwitch.checked = false;
	advisorSwitch.dispatchEvent(new window.Event('change', { bubbles: true }));
	await Promise.resolve();
	assert.deepEqual(advisorWrites, [{ model: advisorModel, enabled: false, maxCalls: 5, maxOutputTokens: 4096, reasoningEffort: 'high' }]);
	const closingMenu = openCopyMenu();
	window.document.querySelector<HTMLDialogElement>('dialog')?.close();
	await opened;
	assert.equal(closingMenu.menu.isConnected, false);
	assert.equal(window.document.querySelector('dialog'), null);
	const { builtinLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		const reopened = preferences.open();
		const reopenedMenu = openCopyMenu('外观', '复制设置为 JSON');
		reopenedMenu.copy.click();
		await Promise.resolve();
		assert.deepEqual(copied, ['"sessions.activityBar.compact": true', '"sessions.activityBar.compact": true']);
		assert.equal(reopenedMenu.menu.isConnected, false);
		assert.equal(window.document.activeElement, reopenedMenu.more);
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
