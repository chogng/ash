import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { ISecretStorageStatusService } from '../../../platform/secrets/common/secrets.js';
import { createTestLanguageModelToolsService } from '../../../workbench/contrib/chat/test/common/tools/testLanguageModelToolsService.js';
import '../../../workbench/contrib/chat/browser/chat.shared.contribution.js';
import { quickInputServiceTestControls } from '../../../platform/quickinput/test/browser/testQuickInputService.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensionService.js';
import { TestExtensionService } from '../../../workbench/test/common/testExtensionServices.js';
import { IAgentExecutionSettingsService } from '../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IPromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { errorHandler } from '../../../base/common/errors.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { IGlobalExtensionEnablementService } from '../../../platform/extensionManagement/common/extensionManagement.js';
import { IPluginManagementService } from '../../../platform/extensionManagement/common/pluginManagementService.js';
import { IAgentCapabilitiesService } from '../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IWorkspaceTrustApi } from '../../../platform/workspace/common/workspaceTrust.js';
import { ILanguageModelToolsService } from '../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
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
import { IAppServerHookApi, IAppServerSkillApi } from '../../../platform/agentHost/common/appServerApi.js';
import { IExtensionManagementService } from '../../../platform/extensionManagement/common/extensionManagementService.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../workbench/services/workspaces/browser/workspaceContextService.js';
import { IAppServerRemoteAgentService } from '../../../workbench/services/remote/common/appServerRemoteAgentService.js';
import { IChatSessionNavigationService } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILocalizationService } from '../../../workbench/services/localization/common/localizationService.js';
import type { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import type { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import type { IChatService } from '../../../workbench/services/chat/common/chatService.js';

test('Sessions modified filtering excludes window defaults, fixed values and language-only overrides', async () => {
	const [{ testConfigurationService }, { ConfigurationRegistry, ConfigurationScope }, { SettingsTreeModel }] = await Promise.all([
		import('../../../workbench/services/configuration/test/common/testServices.js'),
		import('../../../platform/configuration/common/configurationRegistry.js'),
		import('../../../workbench/contrib/preferences/browser/settingsTreeModels.js'),
	]);

	const { ConfigurationService: SessionsConfigurationService } = await import('../../services/configuration/browser/configurationService.js');
	const ConfigurationService = testConfigurationService(SessionsConfigurationService); const registry = new ConfigurationRegistry();
	for (const [key, readOnly] of [['sessions.editable', false], ['sessions.fixed', true], ['sessions.language', false]] as const) {
		registry.registerConfiguration({ key, defaultValue: true, agentsWindow: { default: false, readOnly }, scope: ConfigurationScope.LANGUAGE_OVERRIDABLE, parse: value => value as boolean });
	}
	using configuration = new ConfigurationService({ registry });
	using tree = new SettingsTreeModel<string>(id => registry.getConfiguration(id) !== undefined && configuration.inspect(id).userLocalValue !== undefined);
	tree.setChildren([...registry.getConfigurations()].map(id => ({ element: { kind: 'item', id, title: id, description: '', value: id } })));
	tree.setQuery('@modified');
	using listener = configuration.onDidChangeConfiguration(() => tree.refilter());
	assert.deepEqual(tree.visibleItems.map(item => item.id), []);
	await configuration.write('{ "sessions.editable": false, "sessions.fixed": true, "[typescript]": { "sessions.language": true } }');
	assert.deepEqual(tree.visibleItems.map(item => item.id), ['sessions.editable'], 'an explicit Sessions default counts, while fixed Workbench and language values do not');
	await configuration.updateValue('sessions.editable', undefined);
	assert.deepEqual(tree.visibleItems.map(item => item.id), []);
});

test('Sessions preferences reuses Workbench owners and preserves navigation, search, models and localization', async () => {
	const unexpectedErrors: unknown[] = [];
	const previousErrorHandler = errorHandler.getUnexpectedErrorHandler();
	errorHandler.setUnexpectedErrorHandler(error => unexpectedErrors.push(error));
	using restoreErrorHandler = toDisposable(() => errorHandler.setUnexpectedErrorHandler(previousErrorHandler));
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
	const [{ SessionsPreferences }, { testConfigurationService }, { ContextKeyService }] = await Promise.all([
		import('../../contrib/preferences/browser/sessionsPreferences.js'),
		import('../../../workbench/services/configuration/test/common/testServices.js'),
		import('../../../platform/contextkey/browser/contextKeyService.js'),
	]);

	const { ConfigurationService: SessionsConfigurationService } = await import('../../services/configuration/browser/configurationService.js');
	const ConfigurationService = testConfigurationService(SessionsConfigurationService); const model = { provider: 'openai', model: 'gpt-test' };
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
	using configuration = new ConfigurationService();
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
	services.registerInstance(ISecretStorageStatusService, { readState: async () => ({ status: 'available' }), authorizeAccess: async () => ({ status: 'available' }), setStorageMode: async mode => ({ status: 'available', mode }) });
	services.registerInstance(IAgentExecutionSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' } }), configure: async () => { } });
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ILocalTranscriptionService, transcription);
	const { IDictationBackendService } = await import('../../../platform/renderer/common/dictation.js');
	const { ISpeechService } = await import('../../../workbench/contrib/speech/common/speechService.js');
	const { SpeechService } = await import('../../../workbench/contrib/speech/browser/speechService.js');
	services.registerInstance(IDictationBackendService, undefined);
	const { IContextKeyService: ContextKeys } = await import('../../../platform/contextkey/browser/contextKeyService.js');
	services.registerInstance(ContextKeys, contextKeys);
	services.registerSingleton(IExtensionService, () => new TestExtensionService());
	using speech = services.createInstance(SpeechService);
	services.registerInstance(ISpeechService, speech);
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	const { INotificationService } = await import('../../../platform/notification/common/notification.js');
	const { NotificationService } = await import('../../../workbench/services/notification/common/notificationService.js');
	using notifications = new NotificationService();
	services.registerInstance(INotificationService, notifications);
	const { IClipboardService: ClipboardService } = await import('../../../platform/clipboard/common/clipboardService.js');
	const { IContextMenuService: ContextMenus } = await import('../../../platform/contextview/browser/contextView.js');
	const { IContextViewService } = await import('../../../platform/contextview/browser/contextView.js');
	const { BrowserContextViewService } = await import('../../../platform/contextview/browser/contextViewService.js');
	const { BrowserContextMenuService } = await import('../../../platform/contextview/browser/contextMenuService.js');
	const { IAccessibleViewService: AccessibleView } = await import('../../../platform/accessibility/browser/accessibleView.js');
	const copied: string[] = [];
	services.registerInstance(ClipboardService, {
		triggerPaste: () => undefined,
		read: async () => [],
		readText: async () => '', writeText: async text => { copied.push(text); }, readFindText: async () => '',
		writeFindText: async () => { },
		readImage: async () => new Uint8Array(),
		readResources: async () => ({ resources: [], operation: 'copy' }), writeResources: async () => { }, hasResources: async () => false,
	} satisfies IClipboardService);
	services.registerInstance(IKeybindingService, {
		inChordMode: false, onDidUpdateKeybindings: Event.None, getKeybindings: () => [],
		enableKeybindingHoldMode: () => undefined,
		registerSchemaContribution: () => Disposable.None,
		resolveKeybinding: () => { throw new Error('Explicit keybinding resolution is not used by this fixture'); },
		resolveUserBinding: () => undefined, lookupKeybindings: () => [], lookupKeybinding: () => undefined,
	});
	using windowContextView = new BrowserContextViewService(window.document.body);
	services.registerInstance(IContextViewService, windowContextView);
	services.registerSingleton(ContextMenus, () => services.createInstance(BrowserContextMenuService));
	services.registerInstance(AccessibleView, accessibleView);
	services.registerInstance(IAppServerSkillApi, { onDidChangeSkills: Event.None, readTextResource: async () => { throw new Error("No Skill body in this test fixture"); }, list: async () => ({ generation: 0, skills: [] }), read: async () => ({ revision: 0, catalog: { generation: 0, skills: [] }, diagnostics: [] }), setEnabled: async () => { } });
	services.registerInstance(IExtensionManagementService, { onDidChangeInstalled: Event.None, listInstalled: async () => [], listEditorExtensions: async () => ({ extensions: [] }) } as unknown as IExtensionManagementService);
	// Search renders Customize as well as Models; its required services belong to this dialog fixture.
	const unsupportedExtensionAction = async (): Promise<never> => { throw new Error('Extension mutation is outside this Preferences test'); };
	services.registerInstance(IQuickInputService, {
		...quickInputServiceTestControls,

		createQuickPick: () => { throw new Error('Extension filter selection is outside this Preferences test'); },
		input: unsupportedExtensionAction,
	});
	services.registerInstance(IGlobalExtensionEnablementService, {
		onDidChangeEnablement: Event.None, getDisabledExtensions: () => [],
		enableExtension: unsupportedExtensionAction, disableExtension: unsupportedExtensionAction,
	});
	services.registerInstance(IPluginManagementService, {
		onDidChange: Event.None, list: async () => ({ revision: 0, activationGeneration: 0, packages: [] }),
		installLocal: unsupportedExtensionAction, installFromGit: unsupportedExtensionAction, enable: unsupportedExtensionAction, disable: unsupportedExtensionAction,
		grant: unsupportedExtensionAction, revokeGrant: unsupportedExtensionAction, uninstall: unsupportedExtensionAction,
	});
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	services.registerInstance(IMenuService, services.createInstance(MenuService));
	services.registerInstance(IDialogService, {} as IDialogService);
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => [] });
	using workspace = new WorkspaceContextService({ id: 'sessions-preferences', folders: [] });
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IAppServerRemoteAgentService, { connectionState: 'connected', connection: { kind: 'local', generation: 1 }, onDidChangeConnectionState: Event.None, onDidChangeConnection: Event.None, reconnect: async () => ({ kind: 'alreadyConnected' }), rollbackRuntime: async () => ({ kind: 'cancelled' }) });
	services.registerInstance(ITraceSettingsService, { onDidChange: Event.None, read: async () => ({ revision: 1, configured: null, recording: { type: 'disabled' } }), configure: async () => { } });
	services.registerInstance(IFileDialogService, { showOpenDialog: async () => undefined, showSaveDialog: async () => undefined, pickFileToSave: async () => undefined, showSaveConfirm: async () => 2 });
	services.registerInstance(IChatSessionNavigationService, { getActiveConversation: () => undefined, getConversations: () => [], captureActiveDraft: async () => undefined, openConversation: async () => { }, startVoiceConversation: async () => { throw new Error("Unexpected voice start"); }, appendToActiveDraft: () => { } });
	const editorOpens: { resource: string; target: unknown; }[] = [];
	services.registerInstance(IEditorService, {
		openEditor: async (input, _options, target) => {
			assert.equal(window.document.querySelector('dialog[open]'), null, 'the modal is closed before editor ownership changes');
			editorOpens.push({ resource: input.resource.toString(), target });
			return undefined;
		}
	} as IEditorService);
	services.registerInstance(IFileService, {} as IFileService);
	services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, fallback) => fallback });
	const { IPreferencesService } = await import('../../../workbench/services/preferences/common/preferences.js');
	const preferenceOpens: unknown[] = [];
	let rejectShortcut = false;
	let pendingShortcut: Promise<void> | undefined;
	services.registerInstance(IPreferencesService, {
		openSettings: options => preferences.open(options),
		openUserSettings: async options => { preferenceOpens.push({ user: options }); },
		openGlobalKeybindingSettings: async textual => {
			assert.equal(window.document.querySelector('dialog[open]'), null);
			if (pendingShortcut) await pendingShortcut;
			if (rejectShortcut) throw new Error('shortcut editor unavailable');
			preferenceOpens.push({ keybindings: textual });
		},
	});
	services.registerInstance(IAccountService, { onDidChangeAccounts: Event.None, onDidCompleteLogin: Event.None, read: async () => ({ revision: 1n, accounts: [] }), startLogin: async () => { throw new Error('Not used'); }, cancelLogin: async () => { }, logout: async () => { } });
	services.registerInstance(IGitHubService, { listAccounts: async () => [] } as unknown as IGitHubService);
	services.registerInstance(IGitHubConnectionService, { isConnecting: false, connect: async () => { }, cancel: async () => { } });
	using githubReview = services.createInstance(GitHubReviewModel);
	services.registerInstance(IGitHubReviewModel, githubReview);
	services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
	services.registerInstance(IAgentCapabilitiesService, { isAvailable: true, onDidChange: Event.None, read: async () => ({ localProcessSandboxConfigured: false, sandboxBackends: [], directoryGrantsReadable: false, sandboxDiagnostics: [] }) });
	services.registerSingleton(ILanguageModelToolsService, () => createTestLanguageModelToolsService({ isAvailable: true, read: async () => ({ sourceGroups: [], tools: [{ name: 'read_file', description: 'Read authorized files', source: 'local', sourceDetails: ['Ash'], exposure: 'direct', authority: 'directoryRead' }] }) }));
	services.registerInstance(IWorkspaceTrustApi, { onDidChangeTrust: Event.None } as import('../../../platform/workspace/common/workspaceTrust.js').IWorkspaceTrustApi);
	let editorReveals = 0;
	using preferences = services.createInstance(SessionsPreferences, window.document.body, () => { editorReveals++; });
	await configuration.updateValue('sessions.activityBar.compact', true);
	const opened = preferences.open();
	await Promise.race([opened, Promise.resolve()]);
	await preferences.open({ query: 'Preferences: Open User Settings (JSON)' });
	assert.ok(window.document.querySelector('.ash-sessions-customize'), 'global search discovers lazily created Settings actions');
	await preferences.open({ section: 'general' });
	const aiToggle = window.document.querySelector<HTMLInputElement>('input[data-configuration-key="chat.disableAIFeatures"]');
	assert.ok(aiToggle, 'General exposes the registered AI preference so disabled Chat can be restored');
	assert.equal(aiToggle.getAttribute('aria-label'), 'Disable AI features');
	const aiChanged = new Promise<void>(resolve => {
		const listener = configuration.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration('chat.disableAIFeatures')) return;
			listener.dispose();
			resolve();
		});
	});
	aiToggle.click();
	await aiChanged;
	assert.equal(configuration.getValue('chat.disableAIFeatures'), true);
	await configuration.updateValue('chat.disableAIFeatures', undefined);
	const categoryButton = (id: string): HTMLButtonElement => window.document.querySelector<HTMLButtonElement>(`[data-settings-category-id="${id}"]`)!;
	assert.equal(categoryButton('worktree'), null, 'unsupported worktree management is not offered as an empty page');
	assert.equal(categoryButton('archived-chats'), null);
	for (const id of ['execution-trace', 'appearance', 'browser', 'tab', 'code-intelligence', 'environment', 'keyboard-shortcuts', 'account', 'library', 'design', 'customize', 'general']) {
		await preferences.open({ section: id });
		assert.equal(categoryButton(id).getAttribute('aria-current'), 'page', `reopening navigates to ${id}`);
		assert.equal(categoryButton(id).getAttribute('aria-controls'), 'ash-sessions-settings-content');
	}
	await preferences.open({ section: 'dictation' });
	assert.equal(categoryButton('general').getAttribute('aria-current'), 'page');
	await preferences.open({ section: 'unavailable' });
	assert.equal(categoryButton('general').getAttribute('aria-current'), 'page');
	await preferences.open({ section: 'hooks' });
	assert.equal(window.document.querySelector('[role="tab"][aria-selected="true"]')?.textContent, 'Hooks');
	const settingsSearch = window.document.querySelector<HTMLInputElement>('.ash-sessions-settings-search input')!;
	settingsSearch.value = 'compact';
	settingsSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	settingsSearch.focus();
	settingsSearch.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	assert.equal(settingsSearch.value, '');
	assert.equal(window.document.activeElement, settingsSearch);
	assert.ok(window.document.querySelector('dialog[open]'), 'clearing a search must not dismiss Settings');
	categoryButton('general').focus();
	categoryButton('general').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
	assert.equal(window.document.activeElement, categoryButton('keyboard-shortcuts'));
	assert.equal(categoryButton('keyboard-shortcuts').getAttribute('aria-current'), 'page');
	categoryButton('keyboard-shortcuts').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
	assert.equal(window.document.activeElement, categoryButton('general'));
	await preferences.open({ section: 'general' });
	const openCopyMenu = (category = 'Appearance', copyLabel = 'Copy Setting as JSON') => {
		const dialog = window.document.querySelector<HTMLDialogElement>('dialog')!;
		[...dialog.querySelectorAll<HTMLButtonElement>('.ash-sessions-settings-navigation-item')].find(button => button.textContent === category)!.click();
		const more = dialog.querySelector<HTMLButtonElement>('[data-settings-item-id="sessions.activityBar.compact"] .ash-setting-item-actions-trigger')!;
		more.focus();
		more.click();
		const menu = dialog.querySelector<HTMLElement>('[role="menu"]')!;
		assert.ok(menu);
		menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		assert.equal(window.document.activeElement?.textContent, category === '外观' ? '在 JSON 中编辑' : 'Edit in settings.json', 'the JSON editor action is reachable from the configuration owner');
		menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
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
	assert.equal([...window.document.querySelectorAll<HTMLElement>('.ash-sessions-settings-navigation-item')].some(button => button.textContent === 'Tools'), false);
	const designButton = [...window.document.querySelectorAll<HTMLElement>('.ash-sessions-settings-navigation-item')].find(button => button.textContent === 'Design');
	assert.ok(designButton);
	designButton.click();
	const pointerSwitch = window.document.querySelector<HTMLInputElement>('input[data-configuration-key="sessions.design.usePointerCursor"][role="switch"]');
	assert.ok(pointerSwitch);
	assert.equal(pointerSwitch.getAttribute('aria-label'), 'Use pointer cursor on the canvas');
	assert.equal(pointerSwitch.checked, true);
	let resolveSaved!: () => void;
	const pointerSaved = new Promise<void>(resolve => { resolveSaved = resolve; });
	using savedListener = configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('sessions.design.usePointerCursor')) resolveSaved();
	});
	pointerSwitch.checked = false;
	pointerSwitch.dispatchEvent(new window.Event('change', { bubbles: true }));
	await pointerSaved;
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
	await import('../../../workbench/contrib/preferences/browser/preferencesActions.js');
	await commands.executeCommand('workbench.action.openSettings', 'sessions.activityBar.compact');
	assert.equal(window.document.querySelector('.ash-sessions-settings-search input[type="search"]'), modelSearch);
	assert.equal(modelSearch.value, 'sessions.activityBar.compact');
	assert.equal(window.document.activeElement, modelSearch);
	assert.equal(window.document.querySelectorAll('.ash-sessions-settings-content-tree [data-settings-item-id]').length, 1);
	await assert.rejects(commands.executeCommand('workbench.action.openSettings', { query: 'changed', target: 5 }));
	assert.equal(modelSearch.value, 'sessions.activityBar.compact');
	await commands.executeCommand('workbench.action.openSettings', { query: '' });
	assert.equal(modelSearch.value, '');
	assert.equal(window.document.activeElement, modelSearch);
	modelSearch.value = '@id:sessions.activityBar.compact';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
	const filter = window.document.querySelector<HTMLButtonElement>('.ash-sessions-settings-search .ash-settings-search-filter');
	assert.ok(filter);
	assert.equal(filter.getAttribute('aria-label'), 'Filter Settings');
	filter.click();
	const filterMenu = window.document.querySelector<HTMLDialogElement>('dialog')!.querySelector<HTMLElement>('[role="menu"]');
	assert.ok(filterMenu);
	const modified = [...filterMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === 'Modified');
	assert.ok(modified);
	modified.click();
	assert.equal(filterMenu.isConnected, false);
	assert.equal(modelSearch.value, '@id:sessions.activityBar.compact @modified');
	assert.equal(window.document.activeElement, modelSearch);
	assert.ok(window.document.querySelector('[data-settings-item-id="sessions.activityBar.compact"]'));
	assert.equal(window.document.querySelector('.ash-models-settings-model-row'), null);
	modelSearch.focus();
	await configuration.updateValue('sessions.activityBar.compact', undefined);
	assert.deepEqual(unexpectedErrors, [], 'configuration changes must refresh Preferences without listener errors');
	assert.equal(window.document.querySelector('[data-settings-item-id="sessions.activityBar.compact"]'), null);
	assert.equal(window.document.querySelector<HTMLElement>('.ash-sessions-settings-empty')?.hidden, false);
	assert.equal(window.document.activeElement, modelSearch);
	await configuration.updateValue('sessions.activityBar.compact', true);
	assert.ok(window.document.querySelector('[data-settings-item-id="sessions.activityBar.compact"]'));
	modelSearch.value = '';
	modelSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
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
	await configuration.updateValue('sessions.activityBar.compact', false);
	assert.equal(window.document.querySelector('dialog'), null);
	await configuration.updateValue('sessions.activityBar.compact', true);
	const { productLanguagePackCatalogs } = await import('../../../workbench/services/localization/common/localizationCatalogs.js');
	const { formatNlsMessage, setNlsResolver, resetNlsResolver } = await import('../../../nls.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		const reopened = preferences.open({ query: 'sessions.activityBar.compact' });
		const reopenedSearch = window.document.querySelector<HTMLInputElement>('.ash-sessions-settings-search input[type="search"]')!;
		assert.equal(reopenedSearch.value, 'sessions.activityBar.compact');
		assert.equal(window.document.activeElement, reopenedSearch);
		await assert.rejects(commands.executeCommand('workbench.action.openSettings', { query: 1 }), /设置查询必须是字符串/u);
		await assert.rejects(commands.executeCommand('workbench.action.openSettings', { target: 5 }), /此设置编辑器仅支持本地用户设置/u);
		assert.equal(reopenedSearch.value, 'sessions.activityBar.compact');
		assert.equal(window.document.querySelector('.ash-settings-search-filter')?.getAttribute('aria-label'), '筛选设置');
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
		await preferences.open({ section: 'keyboard-shortcuts' });
		assert.ok([...window.document.querySelectorAll<HTMLButtonElement>('.ash-sessions-settings-page button')].some(button => button.textContent === '快捷键'));
		assert.ok(window.document.querySelector('.ash-sessions-settings-page')?.textContent?.includes('搜索命令和快捷键、查看默认绑定、录制按键'));
		await preferences.open({ section: 'customize' });
		assert.ok([...window.document.querySelectorAll<HTMLButtonElement>('.ash-sessions-settings-page button')].some(button => button.textContent === '打开工作台设置'));

		window.document.querySelector<HTMLDialogElement>('dialog')?.close();
		await reopened;
	} finally {
		resetNlsResolver();
	}
	const retiringOpen = preferences.open({ section: 'general' });
	window.document.querySelector<HTMLDialogElement>('dialog')!.close();
	const replacementOpen = preferences.open({ section: 'keyboard-shortcuts' });
	await Promise.race([replacementOpen, Promise.resolve()]);
	const replacementDialog = window.document.querySelector<HTMLDialogElement>('dialog[open]');
	await retiringOpen;
	assert.equal(replacementDialog?.open, true, 'the retired opening cannot dispose a replacement dialog');
	assert.equal(categoryButton('keyboard-shortcuts').getAttribute('aria-current'), 'page');
	replacementDialog!.close();
	await replacementOpen;
	const openCategoryAction = async (section: string, label: string): Promise<void> => {
		const opening = preferences.open({ section });
		const button = [...window.document.querySelectorAll<HTMLButtonElement>('.ash-sessions-settings-page button')].find(button => button.textContent === label);
		assert.ok(button, `${section} offers ${label}`);
		button.click();
		await opening;
		await Promise.resolve();
	};
	await openCategoryAction('keyboard-shortcuts', 'Keyboard Shortcuts');
	await openCategoryAction('keyboard-shortcuts', 'Preferences: Open Keyboard Shortcuts (JSON)');
	await openCategoryAction('customize', 'Preferences: Open User Settings (JSON)');
	assert.deepEqual(preferenceOpens, [{ keybindings: false }, { keybindings: true }, { user: {} }]);
	await openCategoryAction('customize', 'Open Workbench Settings');
	await openCategoryAction('browser', 'Open Browser settings');
	await openCategoryAction('tab', 'Open Tab settings');
	await openCategoryAction('code-intelligence', 'Language servers');
	await openCategoryAction('environment', 'Open Environment settings');
	assert.deepEqual(editorOpens.map(open => ({ section: new URL(open.resource).searchParams.get('target'), target: open.target })), [
		{ section: null, target: 'modalGroup' }, { section: 'browser', target: 'modalGroup' },
		{ section: 'editor-opening', target: 'modalGroup' }, { section: 'editor-language', target: 'modalGroup' }, { section: 'terminal', target: 'modalGroup' },
	]);
	assert.equal(editorReveals, 3);
	let accountOpens = 0;
	using manageAccounts = CommandsRegistry.register('workbench.action.manageAccounts', () => {
		assert.equal(window.document.querySelector('dialog[open]'), null);
		accountOpens++;
	});
	await openCategoryAction('account', 'Manage Accounts');
	assert.equal(accountOpens, 1, 'Account delegates to the existing account command');
	assert.equal(editorReveals, 3, 'account management preserves the current Sessions entry');
	const editSettingOpen = preferences.open({ section: 'appearance' });
	const editSettingMenu = openCopyMenu();
	const editSetting = [...editSettingMenu.menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === 'Edit in settings.json');
	assert.ok(editSetting);
	editSetting.click();
	await editSettingOpen;
	await Promise.resolve();
	assert.deepEqual(preferenceOpens.at(-1), { user: { revealSetting: { key: 'sessions.activityBar.compact', edit: true } } }, 'Edit JSON reveals this setting in the same profile document');
	assert.equal(editorReveals, 4);
	const cancelledOpen = preferences.open({ section: 'keyboard-shortcuts' });
	const callsBeforeCancel = preferenceOpens.length;
	window.document.querySelector<HTMLDialogElement>('dialog')!.dispatchEvent(new window.Event('cancel', { cancelable: true }));
	await cancelledOpen;
	assert.equal(window.document.querySelector('dialog'), null);
	assert.equal(preferenceOpens.length, callsBeforeCancel, 'cancelling Settings cannot open or edit a profile resource');
	rejectShortcut = true;
	await openCategoryAction('keyboard-shortcuts', 'Keyboard Shortcuts');
	assert.equal(notifications.getNotifications().at(-1)?.message, 'Could not open preferences: Error: shortcut editor unavailable');
	assert.equal(editorReveals, 4, 'a failed open cannot reveal an unrelated editor');
	const notificationsBeforeShutdown = notifications.getNotifications().length;
	let rejectLateOpen!: (error: Error) => void;
	pendingShortcut = new Promise<void>((_resolve, reject) => { rejectLateOpen = reject; });
	await openCategoryAction('keyboard-shortcuts', 'Keyboard Shortcuts');
	preferences.dispose();
	rejectLateOpen(new Error('window closed while opening shortcuts'));
	await pendingShortcut.catch(() => { });
	await Promise.resolve();
	assert.equal(notifications.getNotifications().length, notificationsBeforeShutdown, 'late opens cannot notify a retired window');
	assert.equal(editorReveals, 4);
	changed.dispose();
	browser.window.close();
	assert.deepEqual(unexpectedErrors, [], 'Preferences interactions must not leave a stale UI after a listener error');
});
