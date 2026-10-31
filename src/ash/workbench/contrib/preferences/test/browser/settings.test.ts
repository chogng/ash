import '../../../advisor/browser/advisor.contribution.js';
import { IBrowserPasswordService, UnavailableBrowserPasswordService } from '../../../../../platform/browserView/common/browserPasswordService.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ScreenshotGlobalShortcutSetting } from '../../../chat/common/constants.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { resolveKeybinding } from '../../../../../base/common/keybindings.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../chat/browser/speechToText/chatSpeechToTextService.js';
import { IVoiceCodeTranscriptionClient, VoiceCodeTranscriptionClient } from '../../../chat/browser/speechToText/voiceCodeTranscriptionClient.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { TestConfigurationFiles } from '../../../../services/configuration/test/common/testServices.js';
import { HoverService, IHoverService } from '../../../../../platform/hover/browser/hoverService.js';
import { ISecretStorageStatusService } from '../../../../../platform/secrets/common/secrets.js';
import { createTestLanguageModelToolsService } from '../../../chat/test/common/tools/testLanguageModelToolsService.js';
import type { IQuickPick, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import gitMessages from '../../../../../../../extensions/git/package.nls.json' with { type: 'json' };
import snapshotMessages from '../../../../../../../extensions/snapshot/package.nls.json' with { type: 'json' };
import snapshotManifest from '../../../../../../../extensions/snapshot/package.json' with { type: 'json' };
import { localizeManifest } from '../../../../../platform/extensionManagement/common/extensionNls.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import manifest from '../../../../../../../extensions/git/package.json' with { type: 'json' };
import { readFile } from 'node:fs/promises';
import { parseExtensionManifest } from '../../../../services/extensions/common/extensionManifest.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { showConfigureHooksQuickPick } from '../../../chat/browser/promptSyntax/hookActions.js';
import { IAgentExecutionSettingsService } from '../../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { IPromptsService } from '../../../chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../chat/common/promptSyntax/service/promptsServiceImpl.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IAccountService } from '../../../../../platform/accounts/common/accountService.js';
import { IGitHubService } from '../../../../../platform/github/common/githubService.js';
import { IAccountPolicyService } from '../../../../services/policies/common/accountPolicyService.js';
import { IManagedSettingsUpdateService } from '../../../../services/policies/common/managedSettingsUpdate.js';
import { ManagedSettingsUpdateService } from '../../../../services/policies/browser/managedSettingsUpdateService.js';
import { IGitHubConnectionService } from '../../../../../workbench/services/accounts/common/gitHubConnectionService.js';
import { GitHubReviewModel, IGitHubReviewModel } from '../../../../../workbench/contrib/github/browser/githubReviewModel.js';
import { KeybindingTestServices } from '../../../../services/keybinding/test/browser/keybindingTestServices.js';
import { createTestLocaleService } from '../../../../services/localization/test/common/localizationTestUtils.js';
import '../../../chat/common/languageModelsConfiguration.js';
import '../../../terminal/common/terminalConfiguration.js';
import '../../../debug/browser/debug.contribution.js';
import '../../../chat/browser/chat.shared.contribution.js';
import { ILanguageModelsService } from '../../../../contrib/chat/common/languageModels.js';
import type { SettingsSectionReference } from '../../browser/settingsTreeModels.js';
import { IFileTextModelService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { IPreferencesService, type ISetting } from '../../../../services/preferences/common/preferences.js';
import type { IRegisteredConfiguration } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../../../platform/renderer/common/dictation.js';
import { ISpeechService } from '../../../speech/common/speechService.js';
import { SpeechService } from '../../../speech/browser/speechService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import { IAppServerHookApi, IAppServerSkillApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IExtensionManagementService } from '../../../../../platform/extensionManagement/common/extensionManagementService.js';
import { ILanguageServerService } from '../../../../../platform/language/common/languageServerService.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { createTestFileService, createTestEditorServices, createTestTextFileService } from '../../../../test/common/testEditorServices.js';
import assert from 'node:assert/strict';
import { IAgentModelsService, ModelPurpose } from '../../../../../platform/agentHost/common/agentModels.js';
import { createDisconnectedAgentModelsService } from '../../../../../platform/agentHost/browser/appServerAgentModels.js';
import { suiteTeardown, test } from 'mocha';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { JSDOM } from 'jsdom';
import { formatNlsMessage, localize, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { Separator, type IAction } from '../../../../../base/common/actions.js';
import type { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { IContextMenuService as ContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import type { IChatService } from '../../../../services/chat/common/chatService.js';
import type { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import type { RemoteAgentConnection } from '../../../../../platform/remote/common/remoteAgentApi.js';
import type { RemoteConnectionState } from '../../../../../platform/remote/common/remote.js';
import type { IWorkspaceTrustApi } from '../../../../../platform/workspace/common/workspaceTrust.js';
import type { ILanguagePackService } from '../../../../../platform/languagePacks/common/languagePacks.js';
import type {
	IDictationModelStatus,
	ILocalTranscriptionModelService as LocalTranscriptionService,
	DictationModelState as ModelState,
} from '../../../../../platform/localTranscription/common/localTranscription.js';

import { DeferredPromise } from '../../../../../base/common/async.js';
import type { HookSource } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IWorkbenchHostService } from '../../../../services/host/common/workbenchHostService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { IAccessibleViewService, AccessibleViewType, AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { URI } from '../../../../../base/common/uri.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const keybindingProfile = new KeybindingTestServices();
suiteTeardown(() => keybindingProfile.dispose());

const browserEnvironment = new JSDOM('<!doctype html><body></body>', {
	pretendToBeVisual: true,
});
Object.defineProperty(browserEnvironment.window.Element.prototype, 'scrollTo', {
	configurable: true,
	value() { },
});
Object.defineProperty(browserEnvironment.window.Element.prototype, 'scrollIntoView', {
	configurable: true,
	value() { },
});
const installedGlobals = installEditorTestDom(browserEnvironment, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent'], {
	navigator: browserEnvironment.window.navigator,
});
suiteTeardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});

const { h } = await import('../../../../../base/browser/dom.js');
const { Emitter, Event } = await import('../../../../../base/common/event.js');
const { DisposableStore, toDisposable } = await import('../../../../../base/common/lifecycle.js');
const { ConfigurationRegistry, ConfigurationScope, Extensions: ConfigurationExtensions } = await import('../../../../../platform/configuration/common/configurationRegistry.js');
const { IClipboardService: ClipboardServiceId } = await import('../../../../../platform/clipboard/common/clipboardService.js');
const { IConfigurationService: ConfigurationServiceId } = await import('../../../../../platform/configuration/common/configuration.js');
const { IContextMenuService } = await import('../../../../../platform/contextview/browser/contextView.js');
const { IContextViewService } = await import('../../../../../platform/contextview/browser/contextView.js');
const { BrowserContextViewService } = await import('../../../../../platform/contextview/browser/contextViewService.js');
const { InstantiationService } = await import('../../../../../platform/instantiation/common/instantiationService.js');
const { IExtensionService } = await import('../../../../services/extensions/common/extensionService.js');
const { TestExtensionService } = await import('../../../../test/common/testExtensionServices.js');
const { ContextKeyService, IContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
const { Registry } = await import('../../../../../platform/registry/common/platform.js');
const { darkColorTheme } = await import('../../../../../platform/theme/common/colorTheme.js');
const { AccessibilityConfiguration } = await import('../../../../../platform/accessibility/common/accessibility.js');
const { HoverConfiguration } = await import('../../../../../platform/hover/common/hoverService.js');
const { SashConfiguration } = await import('../../../sash/common/sash.js');
const { DictationConfiguration } = await import('../../../chat/common/constants.js');
const { WorkbenchConfiguration } = await import('../../../../common/configuration.js');
const { SessionsConfiguration } = await import('../../../../../sessions/common/configuration.js');
const { WorkbenchThemesRegistry } = await import('../../../../common/theme.js');
const { EditorSelectionConfiguration } = await import('../../../../common/editorSelectionConfiguration.js');
const { CodeEditorConfiguration } = await import('../../../codeEditor/common/editorConfiguration.js');
const { EDITOR_FONT_DEFAULTS } = await import('../../../../../editor/common/config/fontInfo.js');
const { ContentSearchConfiguration } = await import('../../../search/common/searchConfiguration.js');
const GitConfiguration = {
	autofetch: 'git.autofetch',
	autofetchPeriod: 'git.autofetchPeriod',
	rebaseWhenSync: 'git.rebaseWhenSync',
};
await import('../../../scm/browser/scm.contribution.js');

const { IChatService: ChatServiceId } = await import('../../../../services/chat/common/chatService.js');
await import('../../../../services/chat/common/modelCatalog.js');
const { IContentSearchConfigurationService } = await import('../../../../../platform/search/common/search.js');
const { INetworkDiagnosticsService } = await import('../../../../../platform/networkDiagnostics/common/networkDiagnosticsService.js');
const { IAgentCapabilitiesService } = await import('../../../../../platform/agentCapabilities/common/agentCapabilitiesService.js');
const { ILanguageModelToolsService } = await import('../../../chat/common/tools/languageModelToolsService.js');
const { ITraceSettingsService } = await import('../../../../../platform/trace/common/traceSettingsService.js');
const { IFileDialogService } = await import('../../../../../platform/dialogs/common/dialogs.js');
const { IAppServerRemoteAgentService: RemoteAgentServiceId } = await import('../../../../services/remote/common/appServerRemoteAgentService.js');
const { IWorkspaceTrustApi: WorkspaceTrustApiId } = await import('../../../../../platform/workspace/common/workspaceTrust.js');
const configurationRegistry = Registry.as<InstanceType<typeof ConfigurationRegistry>>(ConfigurationExtensions.Configuration);
configurationRegistry.updateConfigurations({
	add: [
		...parseExtensionManifest(
			JSON.stringify(manifest).replace(/%([^%]+)%/g, (match, key) => (gitMessages as Record<string, string>)[key] ?? match),
			{ id: 'ash.git', name: 'git', publisher: 'ash', version: '0.1.0' },
		).contributes.configuration,
	],
	remove: [],
});
configurationRegistry.updateConfigurations({
	add: [
		...parseExtensionManifest(JSON.stringify(localizeManifest(snapshotManifest, snapshotMessages)), {
			id: 'ash.snapshot',
			name: 'snapshot',
			publisher: 'ash',
			version: '0.1.0',
		}).contributes.configuration,
	],
	remove: [],
});
const { EditorPart } = await import('../../../../browser/parts/editor/editorPart.js');
const { EditorPaneRegistry, EditorPanes } = await import('../../../../browser/editor.js');
const { SettingsSearchQuery } = await import('../../browser/settingsSearch.js');
await import('../../browser/preferencesActions.js');
await import('../../../../browser/actions/layoutActions.js');
await import('../../../extensions/browser/extensions.contribution.js');
await import('../../../canvases/electron-browser/canvases.contribution.js');
const { createSettingsLayout, settingsRootNodes, SettingsCategories, SettingsLayout } = await import('../../browser/settingsLayout.js');

// The canonical module above captures English. Chinese metadata tests need the
// same NLS-before-import order used by a fresh production window.
async function loadChineseSettingsLayout(): Promise<typeof import('../../browser/settingsLayout.js')> {
	return await import(new URL('../../browser/settingsLayout.js?locale=zh-CN', import.meta.url).href);
}
const { TOCTreeModel } = await import('../../browser/tocTree.js');
const { SettingsEditorId } = await import('../../browser/settingsEditor.js');
await import('../../../chat/browser/aiCustomization/aiCustomizationManagement.contribution.js');
const { AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID } = await import('../../../chat/browser/aiCustomization/aiCustomizationManagement.js');
const { ILocalTranscriptionService, ILocalTranscriptionModelService, DictationModelState } = await import('../../../../../platform/localTranscription/common/localTranscription.js');
const { NullLocalTranscriptionService } = await import('../../../../services/localTranscription/browser/localTranscriptionService.js');
const { ModelSettingsRenderer } = await import('../../browser/modelSettingsRenderer.js');
const { LocalTranscriptionModelControls } = await import('../../browser/localTranscriptionModelControls.js');
const { SettingsTree } = await import('../../browser/settingsTree.js');
const { SettingsTreeModel } = await import('../../browser/settingsTreeModels.js');
const { PreferencesService } = await import('../../../../services/preferences/browser/preferencesService.js');
const { BrowserEditorService } = await import('../../../../services/editor/browser/browserEditorService.js');
const { ILocalizationService: LocalizationServiceId } = await import('../../../../services/localization/common/localizationService.js');
const { createSettingWidget: instantiateSettingWidget } = await import('../../browser/settingsWidgets.js');
const { DefaultSettings, SettingsEditorModel } = await import('../../../../services/preferences/common/settingsModels.js');
const { TestConfigurationService: WorkspaceService } = await import('../../../../services/configuration/test/common/testServices.js');
const { productLanguagePackCatalogs } = await import('../../../../services/localization/common/localizationCatalogs.js');
const { ILanguagePackService: LanguagePackServiceId } = await import('../../../../../platform/languagePacks/common/languagePacks.js');
const { ILocaleService, LocalizationConfiguration } = await import('../../../../services/localization/common/locale.js');
const { WorkbenchLocaleService } = await import('../../../../services/localization/browser/localeService.js');
const { WorkbenchLocalizationService } = await import('../../../../services/localization/browser/workbenchLocalizationService.js');
const { StartupEditorConfigurationKey } = await import('../../../welcomeGettingStarted/browser/startupPage.js');
await import('../../../welcomeGettingStarted/browser/gettingStarted.contribution.js');
await import('../../../../browser/workbench.contribution.js');
await import('../../../quickaccess/browser/quickAccess.contribution.js');
await import('../../../../electron-browser/desktop.contribution.js');
await import('../../../externalUriOpener/common/externalUriOpener.contribution.js');

const localizationService: ILocalizationService = {
	whenReady: Promise.resolve(),
	translate: (_bundle, _key, fallback) => fallback,
};

test('Sandbox diagnostics render Chinese readiness and preserve backend reasons as text', async () => {
	const { AgentCapabilitiesSettings } = await import('../../browser/agentCapabilitiesSettings.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	const root = h(browserEnvironment.window.document, 'div');
	using panel = new AgentCapabilitiesSettings(
		root,
		{
			isAvailable: true,
			onDidChange: Event.None,
			read: async () => ({
				localProcessSandboxConfigured: true,
				sandboxBackends: ['mxc'],
				directoryGrantsReadable: false,
				sandboxPolicy: {
					profile: '<profile>',
					fileSystem: 'readOnly',
					network: 'managed',
					hostRead: 'grantedRoots',
					managedConstraints: true,
					pathRuleCount: 2,
				},
				sandboxDiagnostics: [
					{
						backend: 'mxc',
						network: 'managed',
						readiness: { type: 'unsupported', reason: '<script>diagnostic</script>' },
					},
				],
			}),
		},
		{ onDidChangeConnectionState: Event.None } as IAppServerRemoteAgentService,
		{ onDidChangeTrust: Event.None } as IWorkspaceTrustApi,
		{
			whenReady: Promise.resolve(),
			translate: (bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters),
		},
	);
	panel.setView('sandbox');
	await nextTurn();
	assert.match(root.textContent ?? '', /mxc · 受管网络 · 不支持此策略: <script>diagnostic<\/script>/);
	assert.match(root.textContent ?? '', /当前文件策略和隔离模型/);
	assert.match(root.textContent ?? '', /当前后端命令策略：<profile>；文件：只读/);
	assert.match(root.textContent ?? '', /管理员宿主约束/);
	assert.equal(root.querySelector('script'), null);
});

test('Sandbox diagnostics refresh after runtime installation and stop reading when hidden or disposed', async () => {
	const { AgentCapabilitiesSettings } = await import('../../browser/agentCapabilitiesSettings.js');
	using changed = new Emitter<void>();
	let installed = false;
	let reads = 0;
	const root = h(browserEnvironment.window.document, 'div');
	const panel = new AgentCapabilitiesSettings(
		root,
		{
			isAvailable: true,
			onDidChange: changed.event,
			read: async () => {
				reads++;
				return {
					localProcessSandboxConfigured: true,
					sandboxBackends: [],
					directoryGrantsReadable: false,
					sandboxDiagnostics: [],
					sandboxPolicy: {
						profile: 'command-defaults',
						fileSystem: installed ? 'readOnly' : 'directoryWrite',
						network: 'denied',
						hostRead: 'host',
						managedConstraints: false,
						pathRuleCount: 0,
					},
				};
			},
		},
		{ onDidChangeConnectionState: Event.None } as IAppServerRemoteAgentService,
		{ onDidChangeTrust: Event.None } as IWorkspaceTrustApi,
		{
			whenReady: Promise.resolve(),
			translate: (_bundle, _key, fallback, parameters) => formatNlsMessage(fallback, parameters),
		},
	);
	try {
		panel.setView('sandbox');
		await nextTurn();
		assert.match(root.textContent ?? '', /files: Write in authorized directories/);
		installed = true;
		changed.fire();
		await nextTurn();
		assert.match(root.textContent ?? '', /files: Read only/);
		panel.setView(undefined);
		const before = reads;
		changed.fire();
		await nextTurn();
		assert.equal(reads, before);
		panel.dispose();
		changed.fire();
		await nextTurn();
		assert.equal(reads, before);
	} finally {
		panel.dispose();
	}
});

test('developer command opens a grouped read-only tool snapshot outside ordinary settings', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using reset = toDisposable(resetNlsResolver);
	using tools = createTestLanguageModelToolsService({
		isAvailable: true,
		read: async () => ({
			sourceGroups: [],
			tools: [
				{
					name: 'read_file',
					category: 'read',
					description: 'Read files',
					source: 'local',
					sourceDetails: ['ash-app-server'],
					exposure: 'direct',
					authority: 'directoryRead',
				},
			],
		}),
	});
	const opened: import('../../../../common/editor.js').IResourceEditorInput[] = [];
	const command = CommandsRegistry.getCommand('workbench.action.chat.showToolCatalog');
	assert.ok(command);
	await command({
		get: (id: unknown) =>
			id === ILanguageModelToolsService
				? tools
				: {
					openEditor: async (input: import('../../../../common/editor.js').IResourceEditorInput) => {
						opened.push(input);
					},
				},
	} as unknown as import('../../../../../platform/instantiation/common/instantiation.js').ServicesAccessor);
	assert.equal(opened[0].readOnly, true);
	assert.equal(opened[0].resource.scheme, 'ash-tool-catalog');
	assert.equal(opened[0].label, 'Agent 工具目录');
	assert.match(JSON.parse(opened[0].initialText!).note, /已注册工具目录的只读快照/);
	assert.equal(JSON.parse(opened[0].initialText!).categories.read[0].id, 'read_file');
	const { matchCodeEditor } = await import('../../../codeEditor/browser/codeEditorInput.js');
	const { EditorPaneMatch } = await import('../../../../browser/parts/editor/editorPane.js');
	assert.equal(matchCodeEditor(opened[0]), EditorPaneMatch.Default);
	using services = createTestEditorServices();
	using model = await services.get(IFileTextModelService).acquire(opened[0], new AbortController().signal);
	assert.equal(model.model.getText(), opened[0].initialText);

	assert.equal(
		SettingsCategories.some(category => category.id === 'tools'),
		false,
	);
});

test('Chinese indexed search settings explain engine scope in the control and accessibility help', async () => {
	using resources = new DisposableStore();
	const { SearchSettingsModel } = await import('../../../search/browser/searchSettingsModel.js');
	const { SettingsSectionRenderer } = await import('../../browser/settingsSectionRenderer.js');
	const { ContextKeyService, IContextKeyService } = await import('../../../../../platform/contextkey/browser/contextKeyService.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	resources.add(toDisposable(resetNlsResolver));
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	const services = resources.add(new InstantiationService());
	services.registerInstance(ConfigurationServiceId, resources.add(new WorkspaceService()));
	services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
	services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(root)));
	services.registerInstance(RemoteAgentServiceId, {
		onDidChangeConnectionState: Event.None,
		onDidChangeConnection: Event.None,
	} as IAppServerRemoteAgentService);
	services.registerInstance(IContentSearchConfigurationService, {
		read: async () => ({ revision: 1, engine: 'tgrep' }),
		configure: async () => { },
	});
	services.registerInstance(IAccessibleViewService, {
		show: () => true,
		getOpenAriaHint: () => undefined,
		disableHint: async () => { },
		showAccessibleViewHelp: () => { },
		dispose() { },
		[Symbol.dispose]() { },
	});
	const content = resources.add(
		services.createInstance(
			SettingsSectionRenderer,
			root,
			resources.add(services.createInstance(SearchSettingsModel)),
			AccessibleViewProviderId.ContentSearchSettings,
			AccessibilityVerbositySettingId.ContentSearchSettings,
		),
	);
	const item = content.getNodes()[0].children![0].element;
	assert.ok(item.kind === 'item' && 'rendererId' in item.value);
	root.append(content.renderItem(item.value));
	content.setVisible(true);
	await nextTurn();
	const engine = root.querySelector<HTMLElement>('[role="combobox"]')!;
	assert.equal(engine.getAttribute('aria-label'), '索引搜索引擎');
	assert.equal(engine.textContent, 'tgrep（默认）');
	assert.match(root.textContent ?? '', /tgrep 加速 Agent 和 Codebase 的索引搜索/);
	assert.match(root.textContent ?? '', /编辑器的 Current 搜索始终使用 ripgrep（rg）/);
	engine.focus();
	const help = AccessibleViewRegistry.getImplementations()
		.find(provider => provider.name.startsWith('settingsSection-') && provider.type === AccessibleViewType.Help)
		?.getProvider(services);
	assert.ok(help);
	resources.add(help);
	assert.match(help.provideContent(), /选择 ripgrep 会关闭索引并扫描当前文件/);
	assert.match(help.provideContent(), /编辑器的 Current 搜索始终使用 ripgrep/);
});

test('Search settings discard retired reads and save through the current backend revision', async () => {
	using resources = new DisposableStore();
	const { SearchSettingsModel } = await import('../../../search/browser/searchSettingsModel.js');
	const connections = resources.add(new Emitter<void>());
	const reads: DeferredPromise<{ revision: number; engine: 'tgrep' | 'ripgrep'; }>[] = [];
	const writes: [string, number][] = [];
	const model = resources.add(
		new SearchSettingsModel(
			{
				read: () => {
					const read = new DeferredPromise<{ revision: number; engine: 'tgrep' | 'ripgrep'; }>();
					reads.push(read);
					return read.p;
				},
				configure: async (engine, revision) => {
					writes.push([engine, revision]);
				},
			},
			{
				onDidChangeConnection: connections.event,
				onDidChangeConnectionState: Event.None,
			} as unknown as IAppServerRemoteAgentService,
		),
	);
	const engine = () => model.fields.find(field => field.kind === 'select')!;
	model.setVisible(true);
	connections.fire();
	await reads[1].complete({ revision: 8, engine: 'ripgrep' });
	await nextTurn();
	await reads[0].complete({ revision: 1, engine: 'tgrep' });
	await nextTurn();
	assert.equal(engine().value, 'ripgrep');
	engine().setValue('tgrep');
	await nextTurn();
	assert.deepEqual(writes, [['tgrep', 8]]);
	model.setVisible(false);
	await reads[2].complete({ revision: 9, engine: 'tgrep' });
	await nextTurn();
	assert.equal(engine().value, 'ripgrep');
	model.setVisible(true);
	model.dispose();
	await reads[3].complete({ revision: 10, engine: 'tgrep' });
	await nextTurn();
	assert.equal(engine().value, 'ripgrep');
});

test('Settings maturity filters compose with text, identifiers and modified settings without changing values', () => {
	using tree = new SettingsTreeModel<boolean>(id => id === 'test.preview');
	tree.setChildren([
		{
			element: { kind: 'group', id: 'maturity', title: 'Maturity', description: '' },
			children: [
				{
					element: {
						kind: 'item',
						id: 'test.experimental',
						title: 'Browser alpha',
						description: '',
						tags: ['experimental', 'browser'],
						value: true,
					},
				},
				{
					element: {
						kind: 'item',
						id: 'test.preview',
						title: 'Browser preview',
						description: '',
						tags: ['preview'],
						value: false,
					},
				},
				{
					element: {
						kind: 'item',
						id: 'test.stable',
						title: 'Browser stable',
						description: '',
						value: false,
					},
				},
			],
		},
	]);
	for (const [query, ids] of [
		['@tag:experimental browser', ['test.experimental']],
		['@TAG:EXPERIMENTAL @tag:browser', ['test.experimental']],
		['@tag:preview @modified @id:test.*', ['test.preview']],
		['@stable browser', ['test.stable']],
		['@stable @tag:experimental', []],
	] as const) {
		tree.setQuery(query);
		assert.deepEqual(
			tree.visibleItems.map(item => item.id),
			ids,
		);
		assert.equal(new SettingsSearchQuery(query).isEmpty, false);
	}
	tree.setQuery('');
	assert.deepEqual(
		tree.visibleItems.map(item => item.value),
		[true, false, false],
	);
});

test('Welcome illustration is discoverable in startup settings', () => {
	const defaults = new DefaultSettings();
	const setting = defaults.get('chat.welcomePage.agentsWindowGraphic');
	assert.equal(setting.valueType, 'select');
	assert.equal(setting.configuration.defaultValue, 'auto');
	assert.equal(findSettingCategory(createSettingsLayout(defaults.all), setting.id), 'startup');
});

test('DefaultSettings projects only Configuration Registry metadata', () => {
	const registry = new ConfigurationRegistry();
	const tags = ['experimental'];
	const visible = registry.registerConfiguration({
		key: 'editor.test.enabled',
		tags,
		defaultValue: true,
		parse: value => {
			if (typeof value !== 'boolean') throw new TypeError('Expected a boolean');
			return value;
		},
		setting: {
			valueType: 'boolean',
			title: 'Test setting',
			description: 'A registered test setting.',
		},
	});
	registry.registerConfiguration({
		key: 'internal.test.state',
		defaultValue: 'hidden',
		parse: value => String(value),
	});
	registry.registerConfiguration({
		key: 'editor.test.patterns',
		defaultValue: { '*.source': '${capture}.output' },
		parse: value => value as Record<string, string>,
		setting: {
			valueType: 'stringMap',
			title: 'Test patterns',
			description: 'Maps parent patterns to child patterns.',
			keyLabel: 'Parent',
			valueLabel: 'Children',
			addLabel: 'Add',
			removeLabel: 'Remove',
			incompleteMessage: 'Complete both fields.',
			duplicateMessage: 'Duplicate parent.',
		},
	});

	const defaults = new DefaultSettings(registry);
	tags.push('preview');
	assert.deepEqual(defaults.get(visible).tags, ['experimental']);
	assert.deepEqual(
		defaults.all.map(setting => setting.id),
		['editor.test.enabled', 'editor.test.patterns'],
	);
	assert.equal(defaults.get(visible).valueType, 'boolean');
	assert.equal(defaults.get('editor.test.patterns').valueType, 'stringMap');
});

test('Explicit host settings resolve registry metadata without entering the automatic Workbench catalog', () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({
		key: 'test.host.preference',
		defaultValue: false,
		parse: value => value as boolean,
		setting: {
			included: false,
			valueType: 'boolean',
			title: 'Host preference',
			description: 'Host-owned layout entry.',
		},
	});
	const defaults = new DefaultSettings(registry);
	assert.deepEqual(defaults.all, []);
	assert.equal(defaults.get('test.host.preference').title, 'Host preference');
	assert.equal(defaults.get('test.host.preference').configuration.defaultValue, false);
});

test('Sessions resolves its registered appearance metadata in the active language', async () => {
	const { SessionsConfiguration } = await import('../../../../../sessions/common/configuration.js');
	const { SESSIONS_LAYOUT_SCOPE_SETTING } = await import('../../../../../sessions/common/chatLayout.js');
	await import('../../../../../sessions/common/sessionConfig.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using reset = toDisposable(resetNlsResolver);
	const defaults = new DefaultSettings();
	assert.equal(defaults.get(SessionsConfiguration.layoutStyle).title, '布局样式');
	const scope = defaults.get(SESSIONS_LAYOUT_SCOPE_SETTING);
	assert.equal(scope.title, '布局范围');
	assert.ok(scope.valueType === 'select');
	assert.equal(scope.options.find(option => option.value === 'session-shared')!.label, '会话');
	assert.equal(
		defaults.all.some(setting => setting.id === SessionsConfiguration.layoutStyle),
		false,
	);
});

test('resource editor accessibility is addressable without appearing in IDE settings', async () => {
	await import('../../../../services/extensions/browser/resourceEditorAccessibility.js');
	const defaults = new DefaultSettings();
	assert.equal(defaults.get('accessibility.verbosity.resourceEditor').valueType, 'boolean');
	assert.equal(
		defaults.all.some(setting => setting.id === 'accessibility.verbosity.resourceEditor'),
		false,
	);
});

test('Extension settings use catalog identities and standard schemas without a product layout entry', () => {
	const registry = new ConfigurationRegistry();
	const parsed = parseExtensionManifest(
		JSON.stringify({
			name: 'sample',
			publisher: 'test',
			version: '1.0.0',
			displayName: '示例扩展',
			contributes: {
				configuration: [
					{
						id: 'preferences',
						title: 'Sample settings',
						properties: {
							'editor.sample.enabled': {
								type: 'boolean',
								default: true,
								description: 'Enable sample',
								tags: ['preview'],
							},
							'sample.count': { type: 'integer', default: 2, minimum: 1, maximum: 10 },
							'sample.mode': { type: 'string', enum: ['first', 'second'], default: 'first' },
							'sample.text': { type: 'string', default: '', markdownDescription: 'Sample text' },
							'sample.rules': { type: 'array', default: [], items: { type: 'string' } },
							'sample.hidden': { type: 'boolean', default: false, included: false },
						},
						allOf: [{ properties: { 'sample.nested': { type: 'boolean', default: false } } }],
					},
				],
			},
		}),
		{ id: 'test.sample', name: 'sample', publisher: 'test', version: '1.0.0' },
	);
	registry.updateConfigurations({ add: [...parsed.contributes.configuration], remove: [] });
	const defaults = new DefaultSettings(registry);
	assert.deepEqual(
		defaults.all.map(setting => [setting.id, setting.valueType]),
		[
			['editor.sample.enabled', 'boolean'],
			['sample.count', 'number'],
			['sample.mode', 'select'],
			['sample.text', 'text'],
			['sample.rules', 'complex'],
			['sample.nested', 'boolean'],
		],
	);
	const layout = createSettingsLayout(defaults.all);
	const extension = layout.find(category => category.id === 'extension.test.sample')!;
	using tree = new SettingsTreeModel<ISetting>();
	tree.setChildren(settingsRootNodes(layout));
	tree.setQuery('@tag:preview');
	assert.deepEqual(
		tree.visibleItems.map(item => item.id),
		['editor.sample.enabled'],
	);
	assert.equal(extension.descriptor.label, '示例扩展');
	assert.equal(findSettingCategory(layout, 'editor.sample.enabled'), extension.id, 'extension ownership wins over product key patterns');
	assert.equal(defaults.get('sample.text').description, 'Sample text');
	assert.deepEqual(defaults.get('editor.sample.enabled').tags, ['preview']);
	assert.equal(registry.getConfiguration('sample.nested')?.source?.id, 'test.sample');
	registry.updateConfigurations({ add: [], remove: [...parsed.contributes.configuration] });
	assert.equal(
		createSettingsLayout(new DefaultSettings(registry).all).some(category => category.id === extension.id),
		false,
	);
});

test('Built-in Git, Markdown and Media settings localize, persist and reset through the canonical registry', async () => {
	const registry = new ConfigurationRegistry();
	for (const name of ['git', 'markdown-language-features', 'media-preview']) {
		const manifest = JSON.parse(await readFile(`extensions/${name}/package.json`, 'utf8'));
		const messages = JSON.parse(await readFile(`extensions/${name}/package.nls.zh-CN.json`, 'utf8')) as Record<string, string>;
		const localized = JSON.stringify(manifest, (_key, value) => (typeof value === 'string' ? value.replace(/%([^%]+)%/g, (match, key) => messages[key] ?? match) : value));
		registry.updateConfigurations({
			add: [
				...parseExtensionManifest(localized, {
					id: `${manifest.publisher}.${name}`,
					name,
					publisher: manifest.publisher,
					version: manifest.version,
				}).contributes.configuration,
			],
			remove: [],
		});
	}
	const defaults = new DefaultSettings(registry);
	const layout = createSettingsLayout(defaults.all);
	assert.deepEqual(
		layout.filter(category => category.id.startsWith('extension.')).map(category => [category.id, category.groups.flatMap(group => group.settings).length]),
		[
			['extension.ash.git', 103],
			['extension.ash.markdown-language-features', 13],
			['extension.ash.media-preview', 2],
		],
	);
	assert.equal(defaults.get('mediaPreview.video.loop').title, '循环播放视频');
	assert.equal(defaults.get('markdown.validate.enabled').title, '检查链接');
	const severity = defaults.get('markdown.validate.fragmentLinks.enabled');
	assert.equal(severity.valueType, 'select');
	assert.deepEqual(severity.configuration.setting?.valueType === 'select' ? severity.configuration.setting.options.map(option => option.label) : [], ['忽略', '警告', '错误']);
	using configuration = new WorkspaceService({ registry });
	await configuration.updateValue('mediaPreview.video.loop', true);
	await configuration.updateValue('markdown.validate.enabled', false);
	await configuration.updateValue('git.untrackedChanges', 'separate');
	const document = (await configuration.read()).source;
	assert.deepEqual(JSON.parse(document), {
		'mediaPreview.video.loop': true,
		'markdown.validate.enabled': false,
		'git.untrackedChanges': 'separate',
	});
	using reopened = new WorkspaceService({ registry, source: document });
	assert.equal(reopened.getValue('git.untrackedChanges'), 'separate');
	await assert.rejects(reopened.updateValue('git.untrackedChanges', 'unsupported'), TypeError);
	await reopened.updateValue('mediaPreview.video.loop', undefined);
	assert.equal(reopened.getValue('mediaPreview.video.loop'), false);
	assert.equal(reopened.getValue('git.untrackedChanges'), 'separate');
});

for (const locale of ['en', 'zh-CN']) {
	test(`Rust numeric settings save numbers, automatic values and named modes directly (${locale})`, async () => {
		using resources = new DisposableStore();
		const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		if (locale === 'zh-CN') setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		resources.add(toDisposable(resetNlsResolver));
		const manifest = JSON.parse(await readFile('extensions/rust/package.json', 'utf8'));
		const messages = JSON.parse(await readFile(`extensions/rust/package.nls${locale === 'en' ? '' : '.zh-CN'}.json`, 'utf8'));
		const localized = JSON.stringify(manifest, (_key, value) => (typeof value === 'string' ? value.replace(/%([^%]+)%/g, (match, key) => messages[key] ?? match) : value));
		const registry = new ConfigurationRegistry();
		registry.updateConfigurations({
			add: [
				...parseExtensionManifest(localized, {
					id: `${manifest.publisher}.${manifest.name}`,
					name: manifest.name,
					publisher: manifest.publisher,
					version: manifest.version,
				}).contributes.configuration,
			],
			remove: [],
		});
		const defaults = new DefaultSettings(registry);
		for (const key of ['lru.capacity', 'numThreads', 'cachePriming.numThreads', 'procMacro.processes', 'completion.limit']) {
			assert.equal(defaults.get(`rust-analyzer.${key}`).valueType, 'numberWithOptions', key);
		}
		const configuration = resources.add(new WorkspaceService({ registry }));
		const root = h(browserEnvironment.window.document, 'div');
		browserEnvironment.window.document.body.replaceChildren(root);
		resources.add(toDisposable(() => root.remove()));
		const contextView = resources.add(new BrowserContextViewService(root));
		let actions: readonly IAction[] = [];
		const errors: string[] = [];
		const widgets = ['lru.capacity', 'numThreads'].map(key => {
			const widget = resources.add(
				createSettingWidget(resources, root, defaults.get(`rust-analyzer.${key}`), {
					configurationService: configuration,
					contextViewProvider: contextView,
					contextMenuProvider: {
						showContextMenu: delegate => {
							actions = delegate.getActions();
						},
					},
					clipboardService: {
						triggerPaste: () => undefined,
						read: async () => [],
						readText: async () => '',
						writeText: async () => { },
						readFindText: async () => '',
						writeFindText: async () => { },
						readImage: async () => new Uint8Array(),
						readResources: async () => ({ resources: [], operation: 'copy' }),
						writeResources: async () => { },
						hasResources: async () => false,
					},
					onOpenSettings: async () => {
						assert.fail('Numeric settings must not require JSON editing');
					},
					onStatus: (message, error) => {
						if (error) errors.push(message);
					},
				}),
			);
			root.append(widget.domNode);
			return widget;
		});
		const cache = widgets[0].domNode.querySelector<HTMLInputElement>('input')!;
		const change = async (input: HTMLInputElement, value: string) => {
			input.value = value;
			input.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
			await nextTurn();
		};
		assert.equal(cache.type, 'number');
		assert.equal(cache.placeholder, locale === 'zh-CN' ? '自动' : 'Automatic');
		for (const value of [32, 0]) {
			await change(cache, String(value));
			assert.equal(JSON.parse((await configuration.read()).source)['rust-analyzer.lru.capacity'], value);
		}
		for (const value of ['-1', '65536', '1.5']) {
			await change(cache, value);
			assert.equal(cache.value, '0');
			assert.equal(configuration.getValue('rust-analyzer.lru.capacity'), 0);
		}
		assert.equal(errors.length, 3);
		assert.ok(errors[0].includes(locale === 'zh-CN' ? '整数' : 'whole number'));
		await change(cache, '');
		assert.equal(configuration.getValue('rust-analyzer.lru.capacity'), null);
		assert.equal(JSON.parse((await configuration.read()).source)['rust-analyzer.lru.capacity'], undefined, 'automatic removes a redundant user override');
		await change(cache, '32');
		widgets[0].domNode.querySelector<HTMLButtonElement>('.ash-setting-item-actions-trigger')!.click();
		await actions.find(action => action.id === 'settings.resetSetting')!.run();
		await nextTurn();
		assert.deepEqual(errors.slice(3), []);
		assert.equal(JSON.parse((await configuration.read()).source)['rust-analyzer.lru.capacity'], undefined);
		assert.equal(cache.value, '');
		const threads = widgets[1].domNode.querySelector<HTMLInputElement>('input')!;
		await change(threads, '4');
		assert.equal(configuration.getValue('rust-analyzer.numThreads'), 4);
		const mode = widgets[1].domNode.querySelector<HTMLButtonElement>('[role="combobox"]')!;
		mode.click();
		const choices = root.ownerDocument.getElementById(mode.getAttribute('aria-controls')!)!;
		choices.querySelectorAll<HTMLElement>('[role="option"]')[3].click();
		await nextTurn();
		assert.equal(configuration.getValue('rust-analyzer.numThreads'), 'logical');
		assert.equal(threads.value, '');
		await change(threads, '2');
		assert.equal(configuration.getValue('rust-analyzer.numThreads'), 2);
		using reopened = new WorkspaceService({ registry, source: (await configuration.read()).source });
		assert.equal(reopened.getValue('rust-analyzer.numThreads'), 2);
		await configuration.write('{ "rust-analyzer.lru.capacity": 16, "rust-analyzer.numThreads": "physical" }');
		assert.equal(cache.value, '16');
		assert.equal(threads.placeholder, messages['numThreads.anyOf.2.enum.0']);
	});
}

test('File exclusion Settings show defaults, persist disabled rules and reset through the widget', async () => {
	using resources = new DisposableStore();
	const configuration = resources.add(new WorkspaceService());
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	let menuActions: readonly IAction[] = [];
	const errors: string[] = [];
	const widget = resources.add(
		createSettingWidget(resources, root, new DefaultSettings().get('files.exclude'), {
			configurationService: configuration,
			contextViewProvider: resources.add(new BrowserContextViewService(root)),
			contextMenuProvider: {
				showContextMenu: delegate => {
					menuActions = delegate.getActions().filter((action): action is IAction => !(action instanceof Separator));
				},
			},
			clipboardService: {
				triggerPaste: () => undefined,
				read: async () => [],
				readText: async () => '',
				writeText: async () => { },
				readFindText: async () => '',
				writeFindText: async () => { },
				readImage: async () => new Uint8Array(),
				readResources: async () => ({ resources: [], operation: 'copy' }),
				writeResources: async () => { },
				hasResources: async () => false,
			},
			onStatus: (message, error) => {
				if (error) errors.push(message);
			},
		}),
	);
	root.append(widget.domNode);
	const displayedRules = () => [...widget.domNode.querySelectorAll<HTMLElement>('.ash-pattern-row')].map(row => row.dataset.pattern);
	const defaults = ['**/.git', '**/.svn', '**/.hg', '**/.jj', '**/.DS_Store', '**/Thumbs.db'];
	const ruleRow = (pattern: string) => [...widget.domNode.querySelectorAll<HTMLElement>('.ash-pattern-row')].find(row => row.dataset.pattern === pattern)!;
	const save = async (action: () => void): Promise<void> => {
		let resolveSaved!: () => void;
		const saved = new Promise<void>(resolve => {
			resolveSaved = resolve;
		});
		using listener = configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('files.exclude')) resolveSaved();
		});
		action();
		await saved;
		await nextTurn();
	};
	assert.deepEqual(displayedRules(), defaults);
	assert.equal(widget.domNode.querySelectorAll('input').length, 0, 'rules are readable text until edited');
	assert.equal(findSettingCategory(createSettingsLayout(new DefaultSettings().all), 'files.exclude'), 'editor-files');
	await save(() => ruleRow('**/.DS_Store').querySelectorAll<HTMLButtonElement>('button')[1]!.click());
	assert.deepEqual(
		displayedRules(),
		defaults.filter(pattern => pattern !== '**/.DS_Store'),
	);
	assert.deepEqual(JSON.parse((await configuration.read()).source)['files.exclude'], { '**/.DS_Store': false }, 'only the explicit override is persisted');
	assert.equal(widget.domNode.classList.contains('is-configured'), true);
	using reopened = new WorkspaceService({ source: (await configuration.read()).source });
	assert.equal(reopened.getValue<Record<string, boolean>>('files.exclude')['**/.DS_Store'], false);
	assert.equal(reopened.getValue<Record<string, boolean>>('files.exclude')['**/.git'], true);
	const add = widget.domNode.querySelector<HTMLButtonElement>(':scope > .ash-pattern-actions button')!;
	add.click();
	let inputs = widget.domNode.querySelectorAll<HTMLInputElement>('.ash-pattern-editor input');
	inputs[0]!.value = '**/.DS_Store';
	await save(() => inputs[0]!.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
	assert.deepEqual(displayedRules(), defaults);
	assert.equal(configuration.inspect('files.exclude').userLocalValue, undefined, 'adding a default restores it without duplicating its value');
	add.click();
	inputs = widget.domNode.querySelectorAll<HTMLInputElement>('.ash-pattern-editor input');
	inputs[0]!.value = '**/*.js';
	inputs[1]!.value = '$(basename).ts';
	await save(() => widget.domNode.querySelector<HTMLButtonElement>('.ash-pattern-editor button')!.click());
	assert.deepEqual(configuration.inspect('files.exclude').userLocalValue, { '**/*.js': { when: '$(basename).ts' } });
	assert.equal(ruleRow('**/*.js').querySelector('.ash-pattern-condition')!.textContent, 'When: $(basename).ts');
	ruleRow('**/*.js').querySelector<HTMLButtonElement>('button')!.click();
	inputs = widget.domNode.querySelectorAll<HTMLInputElement>('.ash-pattern-editor input');
	inputs[0]!.value = '**/*.cjs';
	await save(() => inputs[1]!.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
	assert.deepEqual(configuration.inspect('files.exclude').userLocalValue, { '**/*.cjs': { when: '$(basename).ts' } });
	assert.equal(browserEnvironment.window.document.activeElement, ruleRow('**/*.cjs'));
	await save(() => ruleRow('**/*.cjs').dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
	assert.equal(configuration.inspect('files.exclude').userLocalValue, undefined, 'deleting a custom rule removes its key');
	add.click();
	inputs = widget.domNode.querySelectorAll<HTMLInputElement>('.ash-pattern-editor input');
	inputs[0]!.value = '**/.git';
	inputs[0]!.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.equal(inputs[0]!.getAttribute('aria-invalid'), 'true');
	assert.deepEqual(errors.splice(0), ['Each path pattern must be unique.']);
	inputs[0]!.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(widget.domNode.querySelector('.ash-pattern-editor'), null);
	assert.equal(browserEnvironment.window.document.activeElement, add);
	assert.equal(configuration.inspect('files.exclude').userLocalValue, undefined, 'cancelling a draft does not save it');
	const updateValue = configuration.updateValue.bind(configuration);
	configuration.updateValue = async () => {
		throw new Error('Settings disk unavailable');
	};
	add.click();
	inputs = widget.domNode.querySelectorAll<HTMLInputElement>('.ash-pattern-editor input');
	inputs[0]!.value = '**/unsaved';
	widget.domNode.querySelector<HTMLButtonElement>('.ash-pattern-editor button')!.click();
	await nextTurn();
	assert.equal(widget.domNode.querySelector<HTMLInputElement>('.ash-pattern-editor input')!.value, '**/unsaved');
	assert.equal(configuration.inspect('files.exclude').userLocalValue, undefined);
	assert.deepEqual(errors.splice(0), ['Settings disk unavailable']);
	configuration.updateValue = updateValue;
	inputs[0]!.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await save(() => ruleRow('**/.git').querySelectorAll<HTMLButtonElement>('button')[1]!.click());
	let resolveReset!: () => void;
	const resetSaved = new Promise<void>(resolve => {
		resolveReset = resolve;
	});
	using resetListener = configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('files.exclude') && configuration.inspect('files.exclude').userLocalValue === undefined) resolveReset();
	});
	widget.domNode.querySelector<HTMLButtonElement>('.ash-setting-item-actions-trigger')!.click();
	await menuActions.find(action => action.id === 'settings.resetSetting')!.run();
	await resetSaved;
	await nextTurn();
	assert.deepEqual(displayedRules(), defaults);
	assert.equal(configuration.inspect('files.exclude').userLocalValue, undefined);
	assert.equal(widget.domNode.classList.contains('is-configured'), false);
	assert.deepEqual(errors, []);
});

test('URL rule suggestions follow extension registration without changing saved IDs', async () => {
	using resources = new DisposableStore();
	const { updateContributedOpeners } = await import('../../../externalUriOpener/common/configuration.js');
	const configuration = resources.add(new WorkspaceService());
	await configuration.updateValue('workbench.externalUriOpeners', { '*': 'extension:test:viewer' });
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.replaceChildren(root);
	resources.add(
		toDisposable(() => {
			updateContributedOpeners([], []);
			root.remove();
		}),
	);
	const contextView = resources.add(new BrowserContextViewService(root));
	const widget = resources.add(
		createSettingWidget(resources, root, new DefaultSettings().get('workbench.externalUriOpeners'), {
			configurationService: configuration,
			contextViewProvider: contextView,
			clipboardService: {
				readText: async () => '',
				writeText: async () => { },
				triggerPaste: () => undefined,
				read: async () => [],
				readFindText: async () => '',
				writeFindText: async () => { },
				readImage: async () => new Uint8Array(),
				readResources: async () => ({ resources: [], operation: 'copy' }),
				writeResources: async () => { },
				hasResources: async () => false,
			},
			contextMenuProvider: { showContextMenu() { } },
			onStatus: () => { },
		}),
	);
	root.append(widget.domNode);
	const opener = widget.domNode.querySelector<HTMLInputElement>('[data-pattern-part="value"]')!;
	opener.focus();
	assert.equal(root.querySelectorAll('[role="option"]').length, 0);
	updateContributedOpeners(['extension:test:viewer'], ['Test website viewer']);
	opener.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('[role="option"]')?.textContent, 'extension:test:viewerTest website viewer');
	opener.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }));
	assert.equal(root.querySelector('[role="option"]')?.getAttribute('aria-selected'), 'true');
	updateContributedOpeners([], []);
	opener.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(opener.getAttribute('aria-expanded'), 'false');
	assert.equal(opener.value, 'extension:test:viewer');
	assert.deepEqual(configuration.getValue('workbench.externalUriOpeners'), { '*': 'extension:test:viewer' });
});

test('Configured markers follow explicit local user overrides and expose one accessible row description', async () => {
	using resources = new DisposableStore();
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({
		key: 'status.flag',
		defaultValue: true,
		parse: value => value as boolean,
		scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
		setting: { valueType: 'boolean', title: 'Flag', description: '' },
	});
	registry.registerConfiguration({
		key: 'status.object',
		defaultValue: {},
		parse: value => value as Record<string, unknown>,
		setting: {
			valueType: 'stringMap',
			title: 'Object',
			description: '',
			structuredValues: true,
			keyLabel: 'Key',
			valueLabel: 'Value',
			addLabel: 'Add',
			removeLabel: 'Remove',
			incompleteMessage: 'Incomplete',
			duplicateMessage: 'Duplicate',
		},
	});
	const configuration = resources.add(new WorkspaceService({ registry }));
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.replaceChildren(root);
	resources.add(toDisposable(() => root.remove()));
	const contextView = resources.add(new BrowserContextViewService(root));
	const widgets = new DefaultSettings(registry).all.map(setting => {
		const widget = resources.add(
			createSettingWidget(resources, root, setting, {
				configurationService: configuration,
				contextViewProvider: contextView,
				contextMenuProvider: { showContextMenu() { } },
				clipboardService: {
					triggerPaste: () => undefined,
					read: async () => [],
					readText: async () => '',
					writeText: async () => { },
					readFindText: async () => '',
					writeFindText: async () => { },
					readImage: async () => new Uint8Array(),
					readResources: async () => ({ resources: [], operation: 'copy' }),
					writeResources: async () => { },
					hasResources: async () => false,
				},
				onStatus: () => { },
			}),
		);
		root.append(widget.domNode);
		return widget;
	});
	const assertStatus = (configured: boolean): void => {
		for (const widget of widgets) {
			const indicator = widget.domNode.querySelector<HTMLElement>('.ash-settings-configured-description')!;
			const marker = widget.domNode.querySelector<HTMLElement>('.ash-settings-configured-marker')!;
			assert.equal(widget.domNode.classList.contains('is-configured'), configured);
			assert.equal(marker.hidden, !configured);
			assert.equal(marker.getAttribute('aria-hidden'), 'true');
			assert.equal(marker.hasAttribute('tabindex'), false);
			assert.equal(widget.domNode.getAttribute('role'), 'group');
			assert.equal(widget.domNode.getAttribute('aria-describedby'), configured ? indicator.id : null);
			assert.equal(indicator.textContent, 'Configured in local user settings.');
			assert.equal(indicator.hidden, !configured);
			assert.equal(widget.domNode.querySelector('input')?.hasAttribute('aria-describedby') ?? false, false, 'controls do not repeat the row status');
		}
	};
	assertStatus(false);
	await configuration.write('{ "status.flag": true, "status.object": {} }');
	assertStatus(true);
	assert.notEqual(widgets[0]!.domNode.getAttribute('aria-describedby'), widgets[1]!.domNode.getAttribute('aria-describedby'));
	await configuration.write('{ "[typescript]": { "status.flag": false } }');
	assertStatus(false);
	const first = new DefaultSettings(registry).get('status.flag');
	widgets[0]!.update({ ...first, tags: ['experimental'] });
	const maturity = widgets[0]!.domNode.querySelector<HTMLElement>('.ash-settings-maturity')!;
	assert.equal(maturity.textContent, 'Experimental');
	assert.equal(maturity.hidden, false);
	assert.equal(widgets[0]!.domNode.getAttribute('aria-describedby'), maturity.id);
	widgets[0]!.update({ ...first, tags: ['preview'] });
	assert.equal(maturity.textContent, 'Preview');
	widgets[0]!.update(first);
	assert.equal(maturity.hidden, true);
	assert.equal(widgets[0]!.domNode.hasAttribute('aria-describedby'), false);
});

for (const locale of ['en', 'zh-CN']) {
	test(`Policy controls show managed values and preserve overrides through equal-value policy changes (${locale})`, async () => {
		using resources = new DisposableStore();
		const { AbstractPolicyService } = await import('../../../../../platform/policy/common/policy.js');
		const { BrowserClipboardService } = await import('../../../../../platform/clipboard/browser/clipboardService.js');
		const { configurationSettingBinding } = await import('../../../../services/preferences/common/settingsModels.js');
		const registry = new ConfigurationRegistry();
		registry.registerConfiguration({ key: 'policy.flag', defaultValue: false, parse: value => value as boolean, policy: { name: 'ManagedFlag' }, setting: { valueType: 'boolean', title: 'Flag', description: '' } });
		registry.registerConfiguration({ key: 'policy.count', defaultValue: 0, parse: value => value as number, policy: { name: 'ManagedCount' }, setting: { valueType: 'number', title: 'Count', description: '', minimum: 0, maximum: 10 } });
		registry.registerConfiguration({ key: 'policy.text', defaultValue: '', parse: value => value as string, policy: { name: 'ManagedText' }, setting: { valueType: 'text', title: 'Text', description: '', placeholder: '' } });
		registry.registerConfiguration({ key: 'policy.channel', defaultValue: 'stable', parse: value => value as string, policy: { name: 'ManagedChannel' }, setting: { valueType: 'select', title: 'Channel', description: '', options: [{ value: 'stable', label: 'Stable' }, { value: 'latest', label: 'Latest' }] } });
		const source = '{ "policy.flag": false, "policy.count": 0, "policy.text": "", "policy.channel": "stable" }';
		const configuration = resources.add(new WorkspaceService({ registry, source }));
		class Policies extends AbstractPolicyService {
			set(managed: boolean): void { this.accept(managed ? { ManagedFlag: false, ManagedCount: 0, ManagedText: '', ManagedChannel: 'stable' } : {}); }
			protected async refresh(): Promise<void> { }
		}
		const policies = resources.add(new Policies());
		await configuration.initialize(configuration.fileService, policies);
		const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		if (locale === 'zh-CN') setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		try {
			const root = h(browserEnvironment.window.document, 'div');
			browserEnvironment.window.document.body.replaceChildren(root);
			resources.add(toDisposable(() => root.remove()));
			const contextView = resources.add(new BrowserContextViewService(root));
			const clipboard = resources.add(new BrowserClipboardService(undefined));
			let actions: readonly IAction[] = [];
			const widgets = new DefaultSettings(registry).all.map(setting => {
				// Host-specific bindings, such as Desktop updates, still honor configuration policy.
				if (setting.valueType === 'text') setting = { ...setting, binding: configurationSettingBinding(configuration, setting.configuration) };
				const widget = resources.add(createSettingWidget(resources, root, setting, {
					configurationService: configuration, contextViewProvider: contextView, clipboardService: clipboard,
					contextMenuProvider: { showContextMenu: delegate => { actions = delegate.getActions(); delegate.onHide?.(false); } },
					onStatus: message => assert.equal(message, ''),
				}));
				root.append(widget.domNode);
				return widget;
			});
			for (const managed of [true, false]) {
				policies.set(managed);
				for (const widget of widgets) {
					const control = widget.domNode.querySelector<HTMLInputElement | HTMLButtonElement>('input[data-configuration-key], [data-configuration-key] button')!;
					assert.equal(control.disabled, managed);
					assert.equal(control.hasAttribute('aria-busy'), false, 'policy management does not mean a save is pending');
					const description = widget.domNode.querySelector<HTMLElement>('.ash-settings-policy')!;
					assert.equal(description.hidden, !managed);
					assert.equal(description.textContent, locale === 'zh-CN' ? '由管理员策略管理，无法在此更改。' : 'Managed by administrator policy. This value cannot be changed here.');
					assert.equal(widget.domNode.getAttribute('aria-describedby')?.split(' ').includes(description.id) ?? false, managed);
					widget.domNode.querySelector<HTMLButtonElement>('.ash-setting-item-actions-trigger')!.click();
					assert.equal(actions.find(action => action.id === 'settings.resetSetting')!.enabled, !managed);
				}
				assert.equal((await configuration.read()).source, source);
			}
			for (const widget of widgets) widget.dispose();
			policies.set(true);
			assert.equal(root.querySelectorAll('.ash-configuration-setting').length, 0);
		} finally { resetNlsResolver(); }
	});
}

test('Copy Setting as JSON reads the latest local user values and preserves falsy and structured values', async () => {
	using resources = new DisposableStore();
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({
		key: 'copy.boolean',
		defaultValue: true,
		parse: value => value as boolean,
		scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
		setting: { valueType: 'boolean', title: 'Boolean', description: '' },
	});
	registry.registerConfiguration({
		key: 'copy.number',
		defaultValue: 1,
		parse: value => value as number,
		setting: { valueType: 'number', title: 'Number', description: '', minimum: 0, maximum: 10 },
	});
	registry.registerConfiguration({
		key: 'copy.text',
		defaultValue: 'Default',
		parse: value => value as string,
		setting: { valueType: 'text', title: 'Text', description: '', placeholder: '' },
	});
	registry.registerConfiguration({
		key: 'copy.structured',
		defaultValue: {},
		parse: value => value as Record<string, unknown>,
		setting: {
			valueType: 'stringMap',
			title: 'Object',
			description: '',
			structuredValues: true,
			keyLabel: 'Key',
			valueLabel: 'Value',
			addLabel: 'Add',
			removeLabel: 'Remove',
			incompleteMessage: 'Incomplete',
			duplicateMessage: 'Duplicate',
		},
	});
	const configuration = resources.add(new WorkspaceService({ registry }));
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.replaceChildren(root);
	resources.add(toDisposable(() => root.remove()));
	const contextView = resources.add(new BrowserContextViewService(root));
	let actions: readonly IAction[] = [];
	const copied: string[] = [];
	const errors: string[] = [];
	const widgets = new Map<string, import('../../browser/settingsWidgets.js').SettingWidget>();
	for (const setting of new DefaultSettings(registry).all) {
		const widget = resources.add(
			createSettingWidget(resources, root, setting, {
				configurationService: configuration,
				contextViewProvider: contextView,
				contextMenuProvider: {
					showContextMenu: delegate => {
						actions = delegate.getActions();
						delegate.onHide?.(false);
					},
				},
				clipboardService: {
					triggerPaste: () => undefined,
					read: async () => [],
					readText: async () => '',
					writeText: async value => {
						copied.push(value);
					},
					readFindText: async () => '',
					writeFindText: async () => { },
					readImage: async () => new Uint8Array(),
					readResources: async () => ({ resources: [], operation: 'copy' }),
					writeResources: async () => { },
					hasResources: async () => false,
				},
				onStatus: (message, isError) => {
					if (isError) errors.push(message);
				},
			}),
		);
		root.append(widget.domNode);
		widgets.set(setting.id, widget);
	}
	const copy = async (key: string): Promise<void> => {
		widgets.get(key)!.domNode.querySelector<HTMLButtonElement>('.ash-setting-item-actions-trigger')!.click();
		await actions.find(action => action.id === 'settings.copySettingAsJSON')!.run();
	};
	await copy('copy.boolean');
	// A menu can stay open while another window saves a new value.
	await configuration.write('{ "copy.boolean": false, "copy.number": 0, "copy.text": "", "[typescript]": { "copy.boolean": true } }');
	await actions.find(action => action.id === 'settings.copySettingAsJSON')!.run();
	await copy('copy.number');
	await copy('copy.text');
	await copy('copy.structured');
	const structured = { 'quoted"key': ['back\\slash', 'line\nbreak', '中文', false, 0, null], nested: { empty: '' } };
	await configuration.updateValue('copy.structured', structured);
	await copy('copy.structured');
	await configuration.updateValue('copy.text', 'quote" and back\\slash\n中文');
	await copy('copy.text');
	assert.deepEqual(
		copied.map(fragment => JSON.parse(`{${fragment}}`)),
		[
			{ 'copy.boolean': true },
			{ 'copy.boolean': false },
			{ 'copy.number': 0 },
			{ 'copy.text': '' },
			{ 'copy.structured': {} },
			{ 'copy.structured': structured },
			{ 'copy.text': 'quote" and back\\slash\n中文' },
		],
	);
	assert.equal(copied[5], `"copy.structured": ${JSON.stringify(structured, null, 2)}`);
	assert.deepEqual(errors, []);
});

test('Copy Setting as JSON uses the current window default and reports clipboard failures in Chinese', async () => {
	using resources = new DisposableStore();
	const { testConfigurationService } = await import('../../../../services/configuration/test/common/testServices.js');
	const { ConfigurationService: SessionsConfigurationService } = await import('../../../../../sessions/services/configuration/browser/configurationService.js');
	const ConfigurationService = testConfigurationService(SessionsConfigurationService);
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({
		key: 'copy.window',
		defaultValue: true,
		parse: value => value as boolean,
		agentsWindow: { default: false },
		setting: { valueType: 'boolean', title: 'Window default', description: '' },
	});
	const configuration = resources.add(new ConfigurationService({ registry }));
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.replaceChildren(root);
	resources.add(toDisposable(() => root.remove()));
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	resources.add(toDisposable(resetNlsResolver));
	const contextView = resources.add(new BrowserContextViewService(root));
	let actions: readonly IAction[] = [];
	let copied = '';
	let revealed = '';
	let fail = false;
	const reported = new DeferredPromise<{ message: string; isError: boolean; }>();
	const widget = resources.add(
		createSettingWidget(resources, root, new DefaultSettings(registry).get('copy.window'), {
			configurationService: configuration,
			contextViewProvider: contextView,
			contextMenuProvider: {
				showContextMenu: delegate => {
					actions = delegate.getActions();
					delegate.onHide?.(false);
				},
			},
			clipboardService: {
				triggerPaste: () => undefined,
				read: async () => [],
				readText: async () => '',
				writeText: async value => {
					if (fail) throw undefined;
					copied = value;
				},
				readFindText: async () => '',
				writeFindText: async () => { },
				readImage: async () => new Uint8Array(),
				readResources: async () => ({ resources: [], operation: 'copy' }),
				writeResources: async () => { },
				hasResources: async () => false,
			},
			onOpenSettings: async key => {
				revealed = key;
			},
			onStatus: (message, isError) => {
				void reported.complete({ message, isError });
			},
		}),
	);
	root.append(widget.domNode);
	widget.domNode.querySelector<HTMLButtonElement>('.ash-setting-item-actions-trigger')!.click();
	const action = actions.find(action => action.id === 'settings.copySettingAsJSON')!;
	assert.equal(action.label, '复制设置为 JSON');
	await action.run();
	assert.equal(copied, '"copy.window": false');
	const edit = actions.find(action => action.id === 'settings.editInJSON')!;
	assert.equal(edit.label, '在 JSON 中编辑');
	await edit.run();
	await nextTurn();
	assert.equal(revealed, 'copy.window');
	assert.equal(configuration.inspect('copy.window').userLocalValue, undefined);
	fail = true;
	await action.run();
	assert.deepEqual(await reported.p, { message: '无法执行设置操作。', isError: true });
	assert.equal((await configuration.read()).source, '{}\n');
	assert.equal(widget.domNode.querySelector<HTMLElement>('.ash-settings-configured-marker')!.hidden, true, 'the Sessions default does not count as a user override');
	await configuration.updateValue('copy.window', false);
	assert.equal(widget.domNode.querySelector('.ash-settings-configured-description')!.textContent, '已在本地用户设置中配置。');
	await configuration.updateValue('copy.window', undefined);
	assert.equal(widget.domNode.querySelector<HTMLElement>('.ash-settings-configured-marker')!.hidden, true);
});

test('Chinese setting actions, search filters and pending saves expose translated labels', async () => {
	using resources = new DisposableStore();
	const { SettingsSearchWidget } = await import('../../browser/settingsWidgets.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	resources.add(toDisposable(resetNlsResolver));
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.replaceChildren(root);
	resources.add(toDisposable(() => root.remove()));
	const configuration = resources.add(new WorkspaceService());
	const contextView = resources.add(new BrowserContextViewService(root));
	let actions: readonly IAction[] = [];
	const contextMenuProvider = {
		showContextMenu: (delegate: import('../../../../../base/browser/contextmenu.js').IContextMenuDelegate) => {
			actions = delegate.getActions();
			delegate.onHide?.(false);
		},
	};
	const pending = new DeferredPromise<void>();
	let current = 1;
	let status = '';
	const registered = configurationRegistry.getConfiguration('editor.fontSize') as IRegisteredConfiguration<number> | undefined;
	assert.ok(registered);
	const widget = resources.add(
		createSettingWidget(
			resources,
			root,
			{
				id: registered.key,
				title: '字号',
				description: '',
				valueType: 'number',
				configuration: registered,
				minimum: 1,
				maximum: 10,
				binding: {
					id: registered.key,
					defaultValue: 1,
					getValue: () => current,
					updateValue: async value => {
						await pending.p;
						current = value;
					},
					resetValue: async () => {
						current = 1;
					},
				},
			},
			{
				configurationService: configuration,
				contextViewProvider: contextView,
				contextMenuProvider,
				clipboardService: {
					triggerPaste: () => undefined,
					read: async () => [],
					readText: async () => '',
					writeText: async () => { },
					readFindText: async () => '',
					writeFindText: async () => { },
					readImage: async () => new Uint8Array(),
					readResources: async () => ({ resources: [], operation: 'copy' }),
					writeResources: async () => { },
					hasResources: async () => false,
				},
				onOpenSettings: async () => {
					throw new Error('Domain bindings have no settings.json entry');
				},
				onStatus: message => {
					status = message;
				},
			},
		),
	);
	root.append(widget.domNode);
	assert.equal(widget.domNode.querySelector<HTMLElement>('.ash-settings-configured-marker')!.hidden, true, 'domain bindings do not expose local user configuration markers');
	const more = widget.domNode.querySelector<HTMLButtonElement>('.ash-setting-item-actions-trigger')!;
	assert.equal(more.getAttribute('aria-label'), '字号 的更多操作');
	more.click();
	assert.deepEqual(
		actions.map(action => [action.label, action.enabled]),
		[
			['重置设置', false],
			['复制设置 ID', true],
		],
	);
	const input = widget.domNode.querySelector<HTMLInputElement>('input')!;
	input.value = '2';
	input.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	const indicator = widget.domNode.querySelector<HTMLElement>('.ash-settings-indicators')!;
	assert.deepEqual([indicator.hidden, indicator.textContent, indicator.getAttribute('aria-label'), input.disabled], [false, '正在保存…', '正在保存设置', true]);
	await pending.complete();
	await nextTurn();
	assert.deepEqual([indicator.hidden, indicator.textContent, indicator.getAttribute('aria-label'), input.disabled], [true, '', '', false]);
	assert.equal(widget.domNode.classList.contains('is-configured'), false);
	more.click();
	await actions.find(action => action.id === 'settings.resetSetting')!.run();
	assert.equal(input.value, '1');
	input.value = '11';
	input.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	assert.equal(status, '字号 必须介于 1 和 10 之间。');

	const search = resources.add(new SettingsSearchWidget(root, { ariaControls: 'settings-results', contextMenuProvider, localizationService }));
	const filter = search.domNode.querySelector<HTMLButtonElement>('.ash-settings-search-filter')!;
	assert.equal(filter.getAttribute('aria-label'), '筛选设置');
	search.value = '@id:editor.fontSize';
	filter.click();
	assert.deepEqual(
		actions.filter(action => action.id !== Separator.ID).map(action => action.label),
		['已修改', '设置 ID…', '实验性', '预览', '稳定', '清除筛选条件'],
	);
	search.value = 'font @MODIFIED @id:editor.fontSize';
	filter.click();
	await actions.find(action => action.id === 'settings.search.modified')!.run();
	assert.equal(search.value, 'font @id:editor.fontSize @modified');
	assert.equal(browserEnvironment.window.document.activeElement, search.domNode.querySelector('input'));
	await actions.find(action => action.id === 'settings.search.clearFilters')!.run();
	assert.equal(search.value, 'font');
	filter.click();
	await actions.find(action => action.id === 'settings.search.experimental')!.run();
	assert.equal(search.value, 'font @tag:experimental');
	filter.click();
	await actions.find(action => action.id === 'settings.search.stable')!.run();
	assert.equal(search.value, 'font @stable');
});

test('Workspace permission banner registration participates in the complete Settings layout', () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({
		key: 'security.workspace.trust.banner',
		defaultValue: 'untilDismissed',
		parse: value => String(value),
		setting: {
			valueType: 'select',
			title: 'Workspace permissions banner',
			description: 'Controls the workspace permissions banner.',
			options: [{ value: 'untilDismissed', label: 'Until dismissed' }],
		},
	});
	const defaults = new DefaultSettings(registry);
	const setting = defaults.get('security.workspace.trust.banner');
	assert.equal(setting.valueType, 'select');
	assert.equal(findSettingCategory(createSettingsLayout(defaults.all), setting.id), 'layout');
});

test('Activity Bar badges expose a translated profile setting with strict boolean validation', () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const defaults = new DefaultSettings();
		const setting = defaults.get(WorkbenchConfiguration.activityBarBadges);
		assert.equal(setting.title, '活动栏徽章');
		assert.equal(setting.description, '在活动栏图标上显示徽章。关闭后会保留每个图标的“显示徽章”或“隐藏徽章”选择。');
		assert.equal(setting.valueType, 'boolean');
		assert.equal(findSettingCategory(createSettingsLayout(defaults.all), setting.id), 'layout');
		const definition = configurationRegistry.getConfiguration(setting.id)!;
		assert.equal(definition.defaultValue, true);
		assert.equal(definition.scope, ConfigurationScope.APPLICATION);
		assert.deepEqual(definition.schema, { type: 'boolean' });
		assert.equal(definition.parse(false), false);
		assert.equal(definition.serialize(false), false);
		assert.throws(() => definition.parse('false'), /活动栏徽章必须为 true 或 false/);
	} finally {
		resetNlsResolver();
	}
});

test('view header action visibility exposes a window setting with translated metadata', () => {
	const key = 'workbench.view.alwaysShowHeaderActions';
	const definition = configurationRegistry.getConfiguration(key)!;
	assert.equal(definition.defaultValue, false);
	assert.equal(definition.scope, ConfigurationScope.WINDOW);
	assert.equal(definition.parse(true), true);
	assert.equal(definition.serialize(false), false);
	assert.throws(() => definition.parse('true'), /true or false/);
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const setting = new DefaultSettings().get(key);
		assert.equal(setting.valueType, 'boolean');
		assert.equal(setting.title, '视图：始终显示标题操作');
		assert.match(setting.description, /视图展开时始终显示标题操作/);
		assert.equal(findSettingCategory(createSettingsLayout(new DefaultSettings().all), key), 'layout');
		assert.throws(() => definition.parse('false'), /视图标题操作可见性必须为 true 或 false/);
	} finally {
		resetNlsResolver();
	}
});

test('empty-editor tips expose translated settings metadata', () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const defaults = new DefaultSettings();
		const tips = defaults.get('workbench.tips.enabled');
		assert.equal(tips.title, '空编辑器提示');
		assert.equal(tips.description, '没有打开编辑器时显示命令快捷键提示。');
	} finally {
		resetNlsResolver();
	}
});

test('Settings Editor belongs to Workbench and localizes the shared default editor preference', async () => {
	const { SettingsNavigation } = await import('../../browser/settingsLayout.js');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const defaults = new DefaultSettings();
		const setting = defaults.get(WorkbenchConfiguration.settingsEditor);
		assert.equal(setting.title, '默认设置编辑器');
		assert.equal(setting.valueType, 'select');
		if (setting.valueType === 'select') {
			assert.deepEqual(
				setting.options.map(option => [option.value, option.label]),
				[
					['ui', 'UI'],
					['json', 'JSON'],
				],
			);
		}
		const layout = createSettingsLayout(defaults.all);
		assert.equal(findSettingCategory(layout, setting.id), 'settings-editor');
		const category = layout.find(category => category.id === 'settings-editor')!;
		assert.equal(category.descriptor.label, 'Settings Editor');
		assert.equal(chinese.bundles['ash.settings']?.['categories.settings-editor.label'], '设置编辑器');
		assert.ok(SettingsNavigation.find(group => group.id === 'workbench')?.categories.some(item => item.id === category.id));
		assert.deepEqual(
			category.groups.flatMap(group => group.settings.map(item => item.id)),
			[setting.id],
		);
		assert.equal(layout.flatMap(category => category.groups.flatMap(group => group.settings)).filter(item => item.id === setting.id).length, 1);
	} finally {
		resetNlsResolver();
	}
});

test('Files belongs to Editor and owns file behavior exactly once', async () => {
	const { SettingsNavigation } = await import('../../browser/settingsLayout.js');
	const defaults = new DefaultSettings();
	const layout = createSettingsLayout(defaults.all);
	const files = layout.find(category => category.id === 'editor-files')!;
	assert.equal(files.descriptor.label, 'Files');
	assert.ok(SettingsNavigation.find(group => group.id === 'editor')?.categories.some(category => category.id === files.id));
	const opening = ['workbench.editor.openErrorDialog', 'workbench.editor.defaultBinaryEditor', 'workbench.editorLargeFileConfirmation', EditorSelectionConfiguration.defaultNewDocumentEditor];
	const expected = defaults.all.filter(
		setting =>
			!setting.configuration.source &&
			(setting.id.startsWith('files.') || setting.id.startsWith('workbench.localHistory.') || setting.id === 'debug.saveBeforeStart' || opening.includes(setting.id)),
	);
	assert.deepEqual(new Set(files.groups.flatMap(group => group.settings.map(setting => setting.id))), new Set(expected.map(setting => setting.id)));
	for (const setting of expected) {
		assert.equal(findSettingCategory(layout, setting.id), 'editor-files', setting.id);
		assert.equal(layout.flatMap(category => category.groups.flatMap(group => group.settings)).filter(item => item.id === setting.id).length, 1, setting.id);
	}
	assert.equal(findSettingCategory(layout, 'workbench.editor.showTabs'), 'editor-opening');
	assert.equal(findSettingCategory(layout, 'explorer.autoRevealExclude'), 'explorer');
	assert.equal(findSettingCategory(layout, 'search.exclude'), 'search');
});

test('file opening preferences have a translated group and correctly typed controls', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const defaults = new DefaultSettings();
		const layout = await loadChineseSettingsLayout();
		const category = layout.createSettingsLayout(defaults.all).find(category => category.id === 'editor-files');
		assert.equal(category?.descriptor.label, '文件');
		const group = category?.groups.find(group => group.id === 'file-opening');
		assert.equal(group?.title, '文件打开');
		assert.equal(group?.settings.length, 4);
		assert.equal(group?.settings.find(setting => setting.id === EditorSelectionConfiguration.defaultNewDocumentEditor)?.valueType, 'select');
		assert.deepEqual(
			group?.settings
				.filter(setting => setting.id !== EditorSelectionConfiguration.defaultNewDocumentEditor)
				.map(setting => ({ id: setting.id, title: setting.title, valueType: setting.valueType })),
			[
				{ id: 'workbench.editor.openErrorDialog', title: '文件打开错误弹窗', valueType: 'boolean' },
				{ id: 'workbench.editor.defaultBinaryEditor', title: '默认二进制编辑器', valueType: 'select' },
				{ id: 'workbench.editorLargeFileConfirmation', title: '大文件打开确认（MiB）', valueType: 'number' },
			],
		);
		const binary = defaults.get('workbench.editor.defaultBinaryEditor');
		assert.equal(binary.valueType === 'select' && binary.options[0]?.label, '默认');
		assert.match(defaults.get('workbench.editor.openErrorDialog').description, /自动恢复文件时不显示错误弹窗/);
		assert.throws(() => configurationRegistry.getConfiguration('workbench.editor.openErrorDialog')?.parse('false'), /文件打开错误弹窗必须为 true 或 false/);
	} finally {
		resetNlsResolver();
	}
});

test('editor line height displays pixels and preserves automatic settings until edited', async () => {
	using resources = new DisposableStore();
	const configuration = resources.add(new WorkspaceService());
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	let actions: readonly IAction[] = [];
	const errors: string[] = [];
	const widget = resources.add(createSettingWidget(resources, root, new DefaultSettings().get('editor.lineHeight'), {
		configurationService: configuration,
		contextViewProvider: resources.add(new BrowserContextViewService(root)),
		contextMenuProvider: { showContextMenu: delegate => { actions = delegate.getActions(); } },
		clipboardService: {
			triggerPaste: () => undefined,
			read: async () => [],
			readText: async () => '',
			writeText: async () => { },
			readFindText: async () => '',
			writeFindText: async () => { },
			readImage: async () => new Uint8Array(),
			readResources: async () => ({ resources: [], operation: 'copy' }),
			writeResources: async () => { },
			hasResources: async () => false,
		},
		onStatus: (message, error) => { if (error) errors.push(message); },
	}));
	root.append(widget.domNode);
	const input = widget.domNode.querySelector<HTMLInputElement>('input')!;
	const { isMacintosh } = await import('../../../../../base/common/platform.js');
	assert.ok(input.valueAsNumber >= 8);
	assert.equal(configuration.inspect('editor.lineHeight').userLocalValue, undefined);
	assert.equal(widget.domNode.classList.contains('is-configured'), false);
	assert.equal(input.getAttribute('aria-label'), 'Line height');
	assert.equal(input.min, '8');
	await configuration.write('{ "editor.fontSize": 20, "editor.lineHeight": 0 }');
	assert.equal(input.value, isMacintosh ? '30' : '27');
	assert.equal(configuration.getValue('editor.lineHeight'), 0);
	assert.equal(widget.domNode.classList.contains('is-configured'), true);
	await configuration.write('{ "editor.fontSize": 20, "editor.lineHeight": 2 }');
	assert.equal(input.value, '40');
	input.value = '24';
	await configuration.updateValue('editor.fontSize', 21);
	assert.equal(input.value, '24', 'font size changes preserve an uncommitted line height edit');
	const change = async (value: string) => {
		input.value = value;
		input.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
		await nextTurn();
	};
	await change('24');
	assert.equal(configuration.getValue('editor.lineHeight'), 24);
	await configuration.updateValue('editor.fontSize', 30);
	assert.equal(input.value, '24');
	for (const invalid of ['0', '7', '81', '']) {
		await change(invalid);
		assert.equal(input.value, '24');
		assert.equal(configuration.getValue('editor.lineHeight'), 24);
	}
	assert.equal(errors.length, 4);
	widget.domNode.querySelector<HTMLButtonElement>('.ash-setting-item-actions-trigger')!.click();
	await actions.find(action => action.id === 'settings.resetSetting')!.run();
	await nextTurn();
	assert.equal(input.value, isMacintosh ? '45' : '41');
	assert.equal(configuration.inspect('editor.lineHeight').userLocalValue, undefined);
	assert.equal(widget.domNode.classList.contains('is-configured'), false);
	await configuration.updateValue('editor.fontSize', 20);
	assert.equal(input.value, isMacintosh ? '30' : '27');
});

test('font preferences show translated labels and the actual platform defaults', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const defaults = new DefaultSettings();
		const layout = await loadChineseSettingsLayout();
		const fonts = layout.createSettingsLayout(defaults.all).find(category => category.id === 'editor-fonts')!;
		assert.equal(fonts.groups[0]?.title, '字体');
		assert.deepEqual(
			fonts.groups.flatMap(group => group.settings.map(setting => ({ id: setting.id, title: setting.title, type: setting.valueType }))),
			[
				{ id: 'editor.fontFamily', title: '字体', type: 'text' },
				{ id: 'editor.fontSize', title: '字号', type: 'number' },
				{ id: 'editor.lineHeight', title: '行高', type: 'number' },
				{ id: 'editor.fontLigatures', title: '字体连字', type: 'boolean' },
			],
		);
		const family = defaults.get('editor.fontFamily');
		assert.equal(family.valueType === 'text' && family.placeholder, '系统默认');
		assert.ok(family.description.includes(EDITOR_FONT_DEFAULTS.fontFamily));
		assert.ok(defaults.get('editor.fontSize').description.includes(String(EDITOR_FONT_DEFAULTS.fontSize)));
		assert.equal(defaults.get('editor.lineHeight').description, '编辑器每行的高度（像素）。');
		const input = layout.createSettingsLayout(defaults.all).find(category => category.id === 'chat-input')!;
		assert.equal(input.groups[0]?.title, '消息输入');
		assert.deepEqual(
			input.groups.flatMap(group => group.settings.map(setting => [setting.id, setting.title, setting.configuration.defaultValue])),
			[
				['chat.input.fontFamily', '字体', ''],
				['chat.input.fontSize', '字号', 13],
				['chat.input.lineHeight', '行高', 20],
			],
		);
		const inputFamily = defaults.get('chat.input.fontFamily');
		assert.equal(inputFamily.valueType === 'text' && inputFamily.placeholder, '系统默认');
		const blocks = layout.createSettingsLayout(defaults.all).find(category => category.id === 'chat-code-blocks')!;
		assert.equal(blocks.groups[0]?.title, '代码块');
		assert.deepEqual(
			blocks.groups.flatMap(group => group.settings.map(setting => [setting.id, setting.title, setting.configuration.defaultValue])),
			[
				['chat.editor.fontFamily', '字体', ''],
				['chat.editor.fontSize', '字号', 0],
				['chat.editor.lineHeight', '行高', 0],
				['chat.editor.wordWrap', '自动换行', 'off'],
			],
		);
		const blocksFamily = defaults.get('chat.editor.fontFamily');
		assert.equal(blocksFamily.valueType === 'text' && blocksFamily.placeholder, '跟随编辑器');
	} finally {
		resetNlsResolver();
	}
});

test('settingsLayout is the single projection from registered settings to categories', () => {
	const defaults = new DefaultSettings();
	const layout = createSettingsLayout(defaults.all);
	const model = new SettingsEditorModel(defaults.all);

	assert.deepEqual(
		SettingsCategories.map(category => category.id),
		[
			'general',
			'github',
			'network',
			'appearance',
			'layout',
			'debugging',
			'settings-editor',
			'startup',
			'browser',
			'editor-fonts',
			'editor-display',
			'editor-editing',
			'editor-suggestions',
			'editor-language',
			'editor-search',
			'editor-diff',
			'editor-files',
			'editor-opening',
			'accessibilitySignals',
			'accessibility',
			'explorer',
			'search',
			'source-control',
			'terminal',
			'voice-input',
			'chat-input',
			'chat-code-blocks',
			'agents',
			'teams',
			'agent-defaults',
			'models',
			'rules',
			'sandbox',
			'execution-trace',
			'hooks',
		],
	);
	assert.deepEqual(
		model.settings.map(setting => setting.id),
		defaults.all.map(setting => setting.id),
	);
	assert.equal(findSettingCategory(layout, AccessibilityConfiguration.underlineLinks), 'accessibility');
	for (const id of ['editor.accessibilitySupport', 'workbench.reduceMotion', 'workbench.reduceTransparency']) {
		assert.equal(findSettingCategory(layout, id), 'accessibility');
	}
	const accessibilitySettings = defaults.all.filter(setting => !setting.configuration.source && setting.id.startsWith('accessibility.'));
	assert.ok(accessibilitySettings.some(setting => setting.id.startsWith('accessibility.signals.')));
	assert.ok(accessibilitySettings.some(setting => setting.id.startsWith('accessibility.verbosity.')));
	assert.ok(accessibilitySettings.some(setting => setting.id === 'accessibility.signalOptions.volume'));
	for (const setting of accessibilitySettings) {
		assert.equal(findSettingCategory(layout, setting.id), setting.id.startsWith('accessibility.signal') ? 'accessibilitySignals' : 'accessibility', setting.id);
		assert.equal(layout.flatMap(category => category.groups.flatMap(group => group.settings)).filter(item => item.id === setting.id).length, 1, setting.id);
	}
	using tree = new SettingsTreeModel<ISetting | SettingsSectionReference>();
	tree.setChildren(settingsRootNodes(layout));
	const features = new TOCTreeModel(tree).children.find(node => node.element.id === 'group.features');
	assert.ok(features);
	assert.deepEqual(
		[...features.children!].slice(0, 2).map(node => node.element.id),
		['accessibilitySignals', 'accessibility'],
	);
	assert.equal(findSettingCategory(layout, LocalizationConfiguration.locale), 'general');
	assert.equal(findSettingCategory(layout, 'workbench.commandPalette.history'), 'general');
	for (const key of ['extensions.ignoreRecommendations', 'extensions.showRecommendationsOnlyOnDemand']) {
		assert.equal(findSettingCategory(layout, key), 'general');
	}
	assert.equal(findSettingCategory(layout, 'workbench.externalUriOpeners'), 'browser');
	assert.equal(defaults.get('workbench.externalUriOpeners').valueType, 'stringMap');
	assert.equal(findSettingCategory(layout, HoverConfiguration.delay), 'general');
	assert.equal(findSettingCategory(layout, SashConfiguration.size), 'general');
	assert.equal(findSettingCategory(layout, DictationConfiguration.backend), 'voice-input');
	assert.equal(findSettingCategory(layout, DictationConfiguration.model), 'voice-input');
	assert.equal(findSettingCategory(layout, 'chat.defaultModel'), undefined);
	assert.equal(findSettingCategory(layout, 'chat.editing.autoAcceptDelay'), 'agent-defaults');
	assert.equal(findSettingCategory(layout, 'chat.canvases.enabled'), 'agent-defaults');
	assert.equal(defaults.get('chat.editing.autoAcceptDelay').valueType, 'number');
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.colorTheme), 'appearance');
	assert.equal(findSettingCategory(layout, 'workbench.tips.enabled'), 'appearance');
	assert.equal(defaults.get('workbench.tips.enabled').valueType, 'boolean');
	assert.equal(configurationRegistry.getConfiguration('workbench.tips.enabled')?.defaultValue, true);
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.layoutStyle), 'layout');
	assert.equal(findSettingCategory(layout, StartupEditorConfigurationKey), 'startup');
	assert.equal(findSettingCategory(layout, 'window.startupWindow'), 'startup');
	const startupWindow = defaults.get('window.startupWindow');
	assert.equal(startupWindow.valueType, 'select');
	assert.equal(startupWindow.configuration.defaultValue, 'default');
	assert.equal(startupWindow.configuration.scope, ConfigurationScope.APPLICATION);
	if (startupWindow.valueType === 'select') {
		assert.deepEqual(
			startupWindow.options.map(option => option.value),
			['default', 'ide', 'agents'],
		);
	}
	assert.throws(() => startupWindow.configuration.parse('unknown'), /Unknown startup window/);
	assert.equal(findSettingCategory(layout, 'window.restoreWindows'), 'startup');
	assert.equal(findSettingCategory(layout, 'window.newWindowDimensions'), 'startup');
	assert.equal(findSettingCategory(layout, 'window.restoreFullscreen'), 'startup');
	assert.equal(findSettingCategory(layout, 'workbench.editor.restoreEditors'), 'startup');
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
	assert.equal(chinese?.bundles['ash.settings']?.['categories.startup.label'], '启动');
	assert.equal(chinese?.bundles.ash?.['settings.workbench.startup.group.label'], '启动时的编辑器');
	assert.equal(chinese?.bundles.ash?.['window.restoreWindows.all'], '全部窗口');
	assert.equal(chinese?.bundles.ash?.['window.startupWindow.title'], '启动时打开');
	assert.equal(chinese?.bundles.ash?.['window.startupWindow.default'], '沿用上次（默认）');
	assert.equal(chinese?.bundles.ash?.['window.startupWindow.agents'], 'Agent 窗口');
	assert.equal(chinese?.bundles.ash?.['window.newWindowDimensions.title'], '新窗口尺寸');
	assert.equal(chinese?.bundles.ash?.['window.restoreFullscreen.title'], '恢复全屏');
	assert.equal(chinese?.bundles.ash?.['workbench.editor.restoreEditors.title'], '恢复编辑器');
	assert.equal(chinese?.bundles.ash?.['workbench.tips.enabled.title'], '空编辑器提示');
	assert.equal(chinese?.bundles.ash?.['settings.dictation.group'], '语音输入');
	assert.equal(chinese?.bundles.ash?.['dictation.cloudModel.title'], '转写模型');
	assert.equal(chinese?.bundles.ash?.['dictation.subscription.title'], 'Codex 订阅听写');
	assert.equal(chinese?.bundles.ash?.['dictation.subscription.manage'], '管理 Codex 账号');
	assert.equal(
		defaults.all.some(setting => Object.values(SessionsConfiguration).includes(setting.id)),
		false,
	);
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.activityBarLocation), 'layout');
	const iconThemeSetting = defaults.get(WorkbenchConfiguration.iconTheme);
	assert.equal(iconThemeSetting.valueType, 'select');
	if (iconThemeSetting.valueType === 'select') {
		assert.equal(
			iconThemeSetting.options.some(option => option.value === iconThemeSetting.configuration.defaultValue),
			true,
		);
	}
	assert.equal(findSettingCategory(layout, EditorSelectionConfiguration.defaultNewDocumentEditor), 'editor-files');
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.modernUIEditorTabStyle), 'editor-opening');
	const tabStyleSetting = defaults.get(WorkbenchConfiguration.modernUIEditorTabStyle);
	assert.equal(tabStyleSetting.valueType, 'select');
	if (tabStyleSetting.valueType === 'select') {
		assert.equal(tabStyleSetting.configuration.defaultValue, 'standard');
		assert.deepEqual(
			tabStyleSetting.options.map(option => option.value),
			['standard', 'connected', 'pill'],
		);
	}
	assert.equal(findSettingCategory(layout, 'breadcrumbs.filePath'), 'editor-display');
	assert.equal(findSettingCategory(layout, 'breadcrumbs.symbolPath'), 'editor-display');
	assert.equal(findSettingCategory(layout, 'workbench.editorLargeFileConfirmation'), 'editor-files');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.fontFamily), 'editor-fonts');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.renderWhitespace), 'editor-display');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.renderControlCharacters), 'editor-display');
	assert.equal(findSettingCategory(layout, ContentSearchConfiguration.maxResults), 'search');
	assert.equal(findSettingCategory(layout, 'scm.diffDecorationsIgnoreTrimWhitespace'), 'source-control');
	assert.deepEqual(
		layout
			.find(category => category.id === 'terminal')
			?.groups.flatMap(group => group.settings.map(setting => setting.id))
			.sort(),
		[
			'terminal.integrated.cursorBlinking',
			'terminal.integrated.cursorStyle',
			'terminal.integrated.cursorStyleInactive',
			'terminal.integrated.cursorWidth',
			'terminal.integrated.fontFamily',
			'terminal.integrated.fontSize',
			'terminal.integrated.letterSpacing',
			'terminal.integrated.lineHeight',
			'terminal.integrated.minimumContrastRatio',
			'terminal.integrated.scrollback',
			'terminal.integrated.shellIntegration.history',
		],
	);
	assert.equal(findSettingCategory(layout, DictationConfiguration.backend), 'voice-input');
	assert.equal(findSettingCategory(layout, DictationConfiguration.cloudProvider), 'voice-input');
	assert.equal(findSettingCategory(layout, DictationConfiguration.model), 'voice-input');
	assert.equal(
		defaults.all.some(setting => setting.id === GitConfiguration.autofetch),
		true,
	);
	assert.equal(findSettingCategory(layout, GitConfiguration.autofetch), 'extension.ash.git');
	assert.equal(configurationRegistry.getConfiguration(GitConfiguration.autofetch)?.defaultValue, false);
	assert.equal(configurationRegistry.getConfiguration(GitConfiguration.autofetchPeriod)?.defaultValue, 180);
	assert.equal(findSettingCategory(layout, GitConfiguration.rebaseWhenSync), 'extension.ash.git');
	assert.equal(configurationRegistry.getConfiguration(GitConfiguration.rebaseWhenSync)?.defaultValue, false);
	assert.equal(defaults.get(GitConfiguration.rebaseWhenSync).valueType, 'boolean');
	assert.equal(
		defaults.all.every(setting => ['boolean', 'number', 'numberWithOptions', 'select', 'text', 'stringMap', 'complex'].includes(setting.valueType)),
		true,
	);
	assert.equal(defaults.get('git.ignoredRepositories').valueType, 'complex');
	const themeSetting = defaults.get(WorkbenchConfiguration.colorTheme);
	assert.equal(themeSetting.valueType, 'select');
	if (themeSetting.valueType === 'select') {
		using contributedTheme = WorkbenchThemesRegistry.registerColorTheme({
			...darkColorTheme,
			id: 'test-preferences-dynamic-theme',
			label: 'Dynamic test theme',
		});
		assert.equal(
			themeSetting.options.some(option => option.value === 'test-preferences-dynamic-theme'),
			true,
		);
	}
	const layoutStyleSetting = defaults.get(WorkbenchConfiguration.layoutStyle);
	assert.equal(layoutStyleSetting.valueType, 'select');
	if (layoutStyleSetting.valueType === 'select') {
		assert.deepEqual(layoutStyleSetting.options, [
			{ value: 'modern', label: 'Modern' },
			{ value: 'flat', label: 'Flat' },
		]);
	}
	assert.throws(() => configurationRegistry.getConfiguration(SessionsConfiguration.layoutStyle)?.parse('other'), /Unknown Sessions layout style/);

	model.dispose();
});

test('Settings layout matching preserves literal dots, wildcard groups and input order across rebuilds', () => {
	const defaults = new DefaultSettings();
	const first = { ...defaults.get('editor.minimap.enabled'), id: 'editor.minimap.first' };
	const second = { ...first, id: 'editor.minimap.second[preview]' };
	const locale = defaults.get(LocalizationConfiguration.locale);
	const projected = (settings: readonly ISetting[]) => createSettingsLayout(settings).flatMap(category => category.groups.flatMap(group => group.settings.map(setting => [category.id, setting.id, setting.title])));
	assert.deepEqual(projected([second, locale, first]), [
		['general', locale.id, locale.title],
		['editor-display', second.id, second.title],
		['editor-display', first.id, first.title],
	]);
	assert.deepEqual(projected([{ ...first, title: 'Updated metadata' }]), [['editor-display', first.id, 'Updated metadata']]);
	assert.throws(() => createSettingsLayout([{ ...locale, id: 'workbenchXlocale' }]), /missing from settingsLayout/u);
});

test('feature settings navigation and groups capture the language initialized before module loading', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const layout = await loadChineseSettingsLayout();
		const category = layout.SettingsCategories.find(category => category.id === 'terminal');
		assert.ok(category);
		assert.equal(category.label, '终端');
		assert.equal(category.description, '设置终端字体、光标外观、对比度和回滚行数。');
		const group = layout.createSettingsLayout(new DefaultSettings().all).find(category => category.id === 'terminal')?.groups[0];
		assert.equal(group?.title, '终端');
		assert.equal(group?.description, category.description);
		for (const [id, title, description] of [
			['accessibilitySignals', '辅助功能信号', '设置工作台事件的声音提示和播报。'],
			['accessibility', '辅助功能', '设置屏幕阅读器支持、辅助功能帮助、动态效果、透明度和链接可见性。'],
		]) {
			const feature = layout.createSettingsLayout(new DefaultSettings().all).find(category => category.id === id)!;
			assert.equal(feature.descriptor.label, title);
			assert.equal(feature.descriptor.description, description);
			assert.equal(feature.groups[0]?.title, title);
			assert.equal(feature.groups[0]?.description, description);
		}
		resetNlsResolver();
		assert.equal(category.label, '终端', 'loaded navigation retains its startup language');
	} finally {
		resetNlsResolver();
	}
});

test('SettingsLayout validates stable configuration identities', () => {
	const fontFamily = new DefaultSettings().get(CodeEditorConfiguration.fontFamily);
	const layout = new SettingsLayout('editor', [
		{
			id: 'typography',
			title: 'Typography',
			description: 'Editor typography.',
			settings: [fontFamily],
		},
	]);

	assert.equal(layout.nodes[0]?.element.id, 'editor.group.typography');
	assert.equal(layout.nodes[0]?.children?.[0]?.element.id, CodeEditorConfiguration.fontFamily);
	assert.deepEqual(layout.nodes[0]?.children?.[0]?.element.keywords, [CodeEditorConfiguration.fontFamily]);
	assert.throws(
		() =>
			new SettingsLayout('editor', [
				{
					id: 'typography',
					title: 'Typography',
					description: '',
					settings: [fontFamily, fontFamily],
				},
			]),
		/Duplicate Settings setting ID/,
	);
	assert.throws(() => new SettingsLayout('', []), /TOC ID must not be empty/);
	assert.throws(
		() =>
			new SettingsLayout('editor', [
				{
					id: 'typography',
					title: 'Typography',
					description: '',
					settings: [{ ...fontFamily, id: 'editor.font\0Family' }],
				},
			]),
		/must not contain control characters/,
	);
});

test('Settings search normalizes pasted setting syntax and matches complete metadata terms', () => {
	const query = new SettingsSearchQuery('  "Editor.Font: Family"  ');

	assert.equal(query.text, 'editor.font family');
	assert.equal(
		query.matches({
			title: 'Font family',
			description: 'Configure the editor font.',
			keywords: ['editor.fontFamily'],
		}),
		true,
	);
	assert.equal(
		query.matches({
			title: 'Font size',
			description: 'Configure the editor font size.',
		}),
		false,
	);
});

test('Settings ordinary search matches IDs and combines them with metadata words', () => {
	const metadata = { id: 'editor.fontFamily', title: 'Font family', description: 'Editor typography.' };
	assert.deepEqual(
		['editor.fontFamily', 'EDITOR.FONT', 'editor.font typography', 'font missing'].map(query => new SettingsSearchQuery(query).matches(metadata)),
		[true, true, true, false],
	);
	assert.equal(new SettingsSearchQuery('typography').matches({ title: 'Font family', description: 'Editor typography.' }), true);
});

test('Settings search composes setting ID and text filters', () => {
	const query = new SettingsSearchQuery('@id:editor.font* editor');

	assert.equal(query.matches({ id: 'editor.fontFamily', title: 'Font family', description: 'Editor typography.' }), true);
	assert.equal(query.matches({ id: 'editor.fontSize', title: 'Font size', description: 'Editor typography.' }), true);
	assert.equal(query.matches({ id: 'workbench.fontFamily', title: 'Font family', description: 'Workbench typography.' }), false);
});

test('Settings search recognizes modified filters without treating them as text', () => {
	for (const value of ['@modified font', 'font @MODIFIED', 'font @modified @id:editor.font*']) {
		const query = new SettingsSearchQuery(value);
		assert.equal(query.text, 'font');
		assert.equal(query.isEmpty, false);
		assert.equal(query.matches({ id: 'editor.fontFamily', title: 'Font family', description: '' }), true);
		assert.notEqual(query.key, new SettingsSearchQuery(value.replace(/@modified/giu, '')).key);
	}
	assert.equal(new SettingsSearchQuery('@modified').text, '');
	assert.equal(new SettingsSearchQuery('@modified').isEmpty, false);
	assert.equal(new SettingsSearchQuery('@modifiedExtra').text, '@modifiedextra');
});

test('Settings search matches complete setting IDs without selecting prefixed IDs', () => {
	const query = new SettingsSearchQuery('@id:EDITOR.fontSize');
	const metadata = { title: 'Font size', description: 'Editor typography.' };

	assert.equal(query.matches({ ...metadata, id: 'editor.fontSize' }), true);
	assert.equal(query.matches({ ...metadata, id: 'chat.editor.fontSize' }), false);
	assert.equal(query.matches({ ...metadata, id: 'editor.fontSizeExtra' }), false);
	assert.equal(query.matches(metadata), false);
});

test('Modified Settings derives membership from accepted local overrides through reset, failure and reload', async () => {
	using resources = new DisposableStore();
	const registry = new ConfigurationRegistry();
	for (const [key, defaultValue] of [
		['modified.boolean', true],
		['modified.number', 1],
		['modified.text', 'Default'],
		['modified.default', true],
		['modified.language', true],
	] as const) {
		registry.registerConfiguration({
			key,
			defaultValue,
			parse: value => value,
			scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
		});
	}
	const pending = new DeferredPromise<void>();
	let blockWrites = false;
	using api = new (class extends TestConfigurationFiles {
		override async writeFile(...args: Parameters<TestConfigurationFiles['writeFile']>): ReturnType<TestConfigurationFiles['writeFile']> {
			if (blockWrites) await pending.p;
			return super.writeFile(...args);
		}
	})();
	const configuration = resources.add(new WorkspaceService({ registry, files: api }));
	const tree = resources.add(new SettingsTreeModel<string>(id => registry.getConfiguration(id) !== undefined && configuration.inspect(id).userLocalValue !== undefined));
	tree.setChildren(
		[...registry.getConfigurations(), 'service.status'].map(id => ({
			element: { kind: 'item', id, title: 'Preference', description: '', value: id },
		})),
	);
	tree.setQuery('@modified');
	resources.add(configuration.onDidChangeConfiguration(() => tree.refilter()));
	const visible = () => tree.visibleItems.map(item => item.id);
	assert.deepEqual(visible(), []);
	await configuration.write('{ "modified.boolean": false, "modified.number": 0, "modified.text": "", "modified.default": true, "[typescript]": { "modified.language": false } }');
	const configured = ['modified.boolean', 'modified.number', 'modified.text', 'modified.default'];
	assert.deepEqual(visible(), configured, 'presence includes explicit defaults and falsy values, without language-only or service state');
	tree.setQuery('preference @modified @id:modified.text');
	assert.deepEqual(visible(), ['modified.text']);
	tree.setQuery('@modified');
	blockWrites = true;
	const failedReset = configuration.updateValue('modified.default', undefined);
	const failure = assert.rejects(failedReset, /blocked save/);
	await Promise.resolve();
	assert.deepEqual(visible(), configured, 'pending writes do not change membership');
	await pending.error(new Error('blocked save'));
	await failure;
	assert.deepEqual(visible(), configured, 'failed writes retain the accepted state');
	blockWrites = false;
	await configuration.updateValue('modified.default', undefined);
	assert.deepEqual(visible(), configured.slice(0, -1));
	using restored = new WorkspaceService({ registry, files: api });
	await restored.reloadConfiguration();
	assert.deepEqual(
		[...registry.getConfigurations()].filter(id => restored.inspect(id).userLocalValue !== undefined),
		configured.slice(0, -1),
	);
});

test('Settings table of contents follows modified result counts through reset', async () => {
	using configuration = new WorkspaceService();
	using tree = new SettingsTreeModel<ISetting | SettingsSectionReference>(id => configurationRegistry.getConfiguration(id) !== undefined && configuration.inspect(id).userLocalValue !== undefined);
	tree.setChildren(settingsRootNodes(createSettingsLayout(new DefaultSettings().all)));
	using listener = configuration.onDidChangeConfiguration(() => tree.refilter());
	const toc = new TOCTreeModel(tree);
	const categories = () => toc.children.flatMap(node => node.children ?? [node]).map(node => node.element.id);
	tree.setQuery('@modified');
	assert.deepEqual(categories(), []);
	assert.equal(tree.countVisibleItems(), 0);
	const fontDefault = configuration.inspect(CodeEditorConfiguration.fontSize).defaultValue;
	await configuration.write(JSON.stringify({ [CodeEditorConfiguration.fontSize]: fontDefault }));
	assert.deepEqual(categories(), ['editor-fonts']);
	assert.equal(tree.countVisibleItems(), 1);
	tree.setQuery('@modified font');
	assert.deepEqual(categories(), ['editor-fonts']);
	await configuration.updateValue(CodeEditorConfiguration.fontSize, undefined);
	assert.deepEqual(categories(), []);
	assert.equal(tree.countVisibleItems(), 0);
	tree.setQuery('');
	assert.ok(categories().includes('editor-fonts'), 'clearing the query restores the browsing directory');
});

test('Settings search categories follow matched settings for text and ID filters', () => {
	using tree = new SettingsTreeModel<ISetting | SettingsSectionReference>();
	tree.setChildren(settingsRootNodes(createSettingsLayout(new DefaultSettings().all)));
	const toc = new TOCTreeModel(tree);
	const categories = () => toc.children.flatMap(node => node.children ?? [node]).map(node => node.element.id);
	tree.setQuery('@id:editor.wordWrap');
	assert.equal(tree.isSearching, true);
	assert.deepEqual(categories(), ['editor-display']);
	assert.equal(tree.countVisibleItems(), 1);
	tree.setQuery('word wrap');
	assert.ok(categories().includes('editor-display'));
	tree.setQuery('@id:ash.nonexistent.setting');
	assert.deepEqual(categories(), []);
	tree.setQuery('@id:editor.fontSize');
	assert.deepEqual(categories(), ['editor-fonts']);
	tree.setQuery('');
	assert.equal(tree.isSearching, false);
	assert.ok(categories().includes('general'));
});

test('Models Settings requires a separately registered secret storage status service', () => {
	using services = new InstantiationService();
	services.registerInstance(ILanguageModelsService, {} as ILanguageModelsService);
	assert.throws(() => services.createInstance(ModelSettingsRenderer, h(browserEnvironment.window.document, 'div')), /Unknown service: secretStorageStatusService/);
});

test('Models Settings keeps loading API connections when the model catalog changes', async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const root = h(ownerDocument, 'div');
	ownerDocument.body.append(root);
	const configuration = disposables.add(new WorkspaceService());
	const contextView = disposables.add(new BrowserContextViewService(root));
	const changed = disposables.add(new Emitter<void>());
	const model = { provider: 'openai', model: 'gpt-test' };
	let catalog = [{ model, displayName: 'GPT Test' }];
	let resolveProviders!: (
		providers: readonly {
			connection: string;
			provider: string;
			displayName: string;
			apiKeyPolicy: 'required';
			apiKeyConfigured: boolean;
		}[],
	) => void;
	const providers = new Promise<
		readonly {
			connection: string;
			provider: string;
			displayName: string;
			apiKeyPolicy: 'required';
			apiKeyConfigured: boolean;
		}[]
	>(resolve => {
		resolveProviders = resolve;
	});
	const chat = {
		onDidChangeModels: changed.event,
		listModelCatalog: async () => catalog,
		listModelProviders: () => providers,
		setModelPreferences: async () => { },
		listCustomModelProviders: async () => [],
		isModelVisible: () => true,
	} as unknown as IChatService;
	const services = disposables.add(new InstantiationService());
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, {
		onDidChangeHooks: Event.None,
		list: async () => {
			throw new Error('Unexpected Hook read in Skill fixture');
		},
	});
	const localTranscription = disposables.add(new NullLocalTranscriptionService());
	services.registerInstance(ILocalTranscriptionModelService, localTranscription);
	services.registerInstance(ILocalTranscriptionService, localTranscription);
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(ChatServiceId, chat);
	services.registerInstance(INotificationService, disposables.add(new TestNotificationService()));
	services.registerInstance(ILanguageModelsService, chat as unknown as ILanguageModelsService);
	services.registerInstance(IDialogService, {} as IDialogService);
	services.registerInstance(ISecretStorageStatusService, {
		readState: async () => ({ status: 'available' }),
		authorizeAccess: async () => ({ status: 'available' }),
		setStorageMode: async mode => ({ status: 'available', mode }),
	});
	services.registerInstance(IAgentExecutionSettingsService, {
		onDidChange: Event.None,
		read: async () => ({
			revision: 1,
			settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' },
		}),
		configure: async () => { },
	});
	services.registerInstance(IContextViewService, disposables.add(new BrowserContextViewService(root)));
	services.registerInstance(IAccessibleViewService, {
		show: () => true,
		getOpenAriaHint: () => undefined,
		disableHint: async () => { },
		showAccessibleViewHelp: () => { },
		dispose() { },
		[Symbol.dispose]() { },
	});
	services.registerSingleton(ICommandService, () => new CommandService(services));
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerInstance(IContextMenuService, { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => { }, hideContextMenu: () => { } });
	const panel = disposables.add(services.createInstance(ModelSettingsRenderer, root));
	const modelTree = disposables.add(new SettingsTreeModel<SettingsSectionReference>());
	disposables.add(
		new SettingsTree(root, {
			model: modelTree,
			rootClassName: 'ash-models-settings',
			groupClassName: 'ash-settings-content-group',
			groupDescriptionClassName: 'ash-settings-group-description',
			itemsClassName: 'ash-settings-list',
			renderGroupHeader: header => panel.renderItem(header),
			renderItem: item => panel.renderItem(item.value),
		}),
	);
	disposables.add(panel.onDidChange(() => modelTree.setChildren(panel.getNodes())));
	panel.setVisible(true);
	modelTree.setNavigationTarget('models.catalog');
	await nextTurn();
	assert.equal(root.querySelector('.ash-models-settings-model-copy > span')?.textContent, 'GPT Test');
	const retainedModel = root.querySelector('.ash-models-settings-model-row');
	modelTree.setNavigationTarget(undefined);
	catalog = [{ model, displayName: 'GPT Test Updated' }];
	changed.fire();
	resolveProviders([
		{
			connection: 'openai',
			provider: 'openai',
			displayName: 'OpenAI API',
			apiKeyPolicy: 'required',
			apiKeyConfigured: false,
		},
	]);
	await nextTurn();
	assert.equal(root.querySelector('.ash-models-settings-api-row h5')?.textContent, 'OpenAI API');
	assert.equal(root.querySelector('.ash-models-settings-model-row'), retainedModel);
	assert.equal(root.querySelector('.ash-models-settings-model-copy > span')?.textContent, 'GPT Test Updated');
});

test('Models Settings orders enabled models by catalog position and restores disabled positions', async () => {
	using resources = new DisposableStore();
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	const catalog = [
		{ model: { provider: 'first', model: 'newest' }, displayName: 'First newest', longContext: null },
		{ model: { provider: 'first', model: 'older' }, displayName: 'First older', longContext: null },
		{ model: { provider: 'second', model: 'newest' }, displayName: 'Second', longContext: null },
		{ model: { provider: 'third', model: 'newest' }, displayName: 'Third', longContext: null },
	];
	const enabled = new Set<string>();
	const changed = resources.add(new Emitter<void>());
	const models: ILanguageModelsService = {
		readApprovalReviewModel: async () => ({ type: 'automatic' }),
		setApprovalReviewModel: async () => { },
		setModelPreferences: async () => { },
		onDidChangeModels: changed.event,
		listModels: async () => catalog.filter(entry => enabled.has(entry.displayName)),
		getDefaultNewChatModel: () => undefined,
		rememberSelectedModel: async () => { },
		readModelDefaults: async () => ({ codeReviewModel: null, commitMessageModel: null, commitMessageEnabled: false, revision: 1, model: null, reasoningEffort: null }),
		saveReasoningEffort: async () => { },
		listModelCatalog: async () => catalog,
		listCustomModelProviders: async () => [],
		removeCustomModelProvider: async () => { },
		saveCustomModelProvider: async () => { },
		testProviderModel: async () => ({ type: 'passed' }),
		listModelProviders: async () => [],
		setModelProviderApiKey: async () => { },
		removeModelProviderApiKey: async () => { },
		listAdvisorModels: async () => [],
		refreshModels: async () => catalog,
		isModelVisible: model => catalog.some(entry => entry.model.provider === model.provider && entry.model.model === model.model && enabled.has(entry.displayName)),
		setModelVisible: async (model, visible) => {
			const entry = catalog.find(entry => entry.model.provider === model.provider && entry.model.model === model.model)!;
			if (visible) {
				enabled.add(entry.displayName);
			} else {
				enabled.delete(entry.displayName);
			}
			changed.fire();
		},
		discoverProviderModels: async () => catalog,
	};
	const services = resources.add(new InstantiationService());
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, {
		onDidChangeHooks: Event.None,
		list: async () => {
			throw new Error('Unexpected Hook read in Skill fixture');
		},
	});
	services.registerInstance(ILanguageModelsService, models);
	services.registerInstance(IDialogService, {} as IDialogService);
	services.registerInstance(ISecretStorageStatusService, {
		readState: async () => ({ status: 'available' }),
		authorizeAccess: async () => ({ status: 'available' }),
		setStorageMode: async mode => ({ status: 'available', mode }),
	});
	services.registerInstance(IAgentExecutionSettingsService, {
		onDidChange: Event.None,
		read: async () => ({
			revision: 1,
			settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' },
		}),
		configure: async () => { },
	});
	services.registerInstance(ConfigurationServiceId, resources.add(new WorkspaceService()));
	services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
	services.registerInstance(IAccessibleViewService, {
		show: () => true,
		getOpenAriaHint: () => undefined,
		disableHint: async () => { },
		showAccessibleViewHelp: () => { },
		dispose() { },
		[Symbol.dispose]() { },
	});
	services.registerSingleton(ICommandService, () => new CommandService(services));
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerInstance(IContextMenuService, { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => { }, hideContextMenu: () => { } });
	const content = resources.add(services.createInstance(ModelSettingsRenderer, root));
	const tree = resources.add(new SettingsTreeModel<SettingsSectionReference>());
	resources.add(
		new SettingsTree(root, {
			model: tree,
			rootClassName: 'ash-models-settings',
			groupClassName: 'ash-settings-content-group',
			groupDescriptionClassName: 'ash-settings-group-description',
			itemsClassName: 'ash-settings-list',
			renderGroupHeader: header => content.renderItem(header),
			renderItem: item => content.renderItem(item.value),
		}),
	);
	resources.add(content.onDidChange(() => tree.setChildren(content.getNodes())));
	content.setVisible(true);
	await nextTurn();
	const names = (query?: InstanceType<typeof SettingsSearchQuery>): string[] => {
		content.getNodes(query);
		return [...root.querySelectorAll('.ash-models-settings-model-copy > span')].map(row => row.textContent!);
	};
	assert.deepEqual(names(), ['First newest', 'Second', 'Third']);
	// Enable in reverse order so activation order cannot masquerade as catalog order.
	await models.setModelVisible(catalog[3].model, true);
	await models.setModelVisible(catalog[2].model, true);
	assert.deepEqual(names(), ['Second', 'Third', 'First newest']);
	await models.setModelVisible(catalog[2].model, false);
	assert.deepEqual(names(), ['Third', 'First newest', 'Second']);
	await models.setModelVisible(catalog[3].model, false);
	assert.deepEqual(names(), ['First newest', 'Second', 'Third']);
	await models.setModelVisible(catalog[1].model, true);
	const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
	search.value = 'first';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.deepEqual(names(), ['First older', 'First newest']);
	await models.setModelVisible(catalog[1].model, false);
	assert.deepEqual(names(), ['First newest', 'First older']);
	search.value = '';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.deepEqual(names(new SettingsSearchQuery('older')), ['First older']);
});

test('Settings tree preserves item identity while filtering and updating', () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const model = disposables.add(new SettingsTreeModel<string>());
	model.setChildren([
		{
			element: {
				kind: 'group',
				id: 'appearance.colors',
				title: 'Colors',
				description: 'Choose the active color scheme.',
			},
			children: [
				{
					element: {
						kind: 'item',
						id: 'appearance.colors.theme',
						title: 'Theme',
						description: 'Choose a theme.',
						value: 'Theme',
					},
				},
				{
					element: {
						kind: 'item',
						id: 'appearance.colors.font',
						title: 'Font family',
						description: 'Choose a UI font.',
						value: 'Font',
					},
				},
			],
		},
	]);
	const disposedItems: string[] = [];
	const renderer = disposables.add(
		new SettingsTree(ownerDocument.body, {
			model,
			rootClassName: 'test-settings-tree',
			groupClassName: 'test-settings-group',
			groupDescriptionClassName: 'test-settings-group-description',
			itemsClassName: 'test-settings-items',
			renderItem: item => {
				const element = h(ownerDocument, 'article');
				element.textContent = item.value;
				return element;
			},
			updateItem: (item, element) => {
				element.textContent = item.value;
			},
			disposeItem: item => disposedItems.push(item.id),
		}),
	);

	const themeElement = renderer.getItemElement('appearance.colors.theme');
	assert.ok(themeElement);
	model.setQuery('font family');
	assert.deepEqual(
		model.visibleItems.map(item => item.id),
		['appearance.colors.font'],
	);
	model.setQuery('');
	assert.equal(renderer.getItemElement('appearance.colors.theme'), themeElement);
	model.setNodeChildren('appearance.colors', [
		{
			element: {
				kind: 'item',
				id: 'appearance.colors.theme',
				title: 'Theme',
				description: 'Choose a theme.',
				value: 'Updated Theme',
			},
		},
	]);
	assert.equal(themeElement.textContent, 'Updated Theme');
	assert.deepEqual(disposedItems, ['appearance.colors.font']);
	assert.throws(
		() =>
			model.setChildren([
				{ element: { kind: 'item', id: 'duplicate', title: 'One', description: '', value: 'one' } },
				{ element: { kind: 'item', id: 'duplicate', title: 'Two', description: '', value: 'two' } },
			]),
		/Duplicate tree node ID/,
	);
});

test('SettingsEditor opens directly and updates registry-backed settings', async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const root = h(ownerDocument, 'div');
	const trigger = h(ownerDocument, 'button');
	trigger.textContent = 'Open Settings';
	root.append(trigger);
	ownerDocument.body.append(root);
	trigger.focus();

	const copied: string[] = [];
	let menuActions: readonly IAction[] = [];
	let hideMenu: ((didCancel: boolean) => void) | undefined;
	const clipboardService: IClipboardService = {
		readText: async () => '',
		triggerPaste: () => undefined,
		read: async () => [],
		readFindText: async () => '',
		writeFindText: async () => { },
		readImage: async () => new Uint8Array(),
		readResources: async () => ({ resources: [], operation: 'copy' }),
		writeResources: async () => { },
		hasResources: async () => false,
		writeText: value => {
			copied.push(value);
			return Promise.resolve();
		},
	};
	const contextMenuProvider: ContextMenuService = {
		contextMenuStyle: 'custom' as const,
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu: options => {
			menuActions = options.getActions?.() ?? [];
			hideMenu = 'onHide' in options ? options.onHide : undefined;
		},
		hideContextMenu() { },
	};
	const configuration = disposables.add(new WorkspaceService());
	const languagePacksChanged = disposables.add(new Emitter<void>());
	const catalogs = [...productLanguagePackCatalogs];
	const languagePacks: ILanguagePackService = {
		onDidChange: languagePacksChanged.event,
		getBuiltInExtensionTranslationsUri: async () => undefined,
		whenReady: Promise.resolve(),
		catalogs,
		getInstalledLanguages: async () => catalogs.map(catalog => ({ id: catalog.locale, label: catalog.localizedLanguageName })),
		refresh: async () => { },
	};
	const locale = disposables.add(createTestLocaleService(configuration, languagePacks));
	await locale.whenReady;
	const workbenchLocalization = disposables.add(new WorkbenchLocalizationService());
	disposables.add(toDisposable(() => resetNlsResolver()));
	const autoFetchChanged = disposables.add(new Emitter<void>());
	let autoFetch: false | true | 'all' = false;
	let autoFetchPeriod = 180;
	let rebaseWhenSync = false;
	const gitService = {
		onDidChangeAutoFetch: autoFetchChanged.event,
		get autoFetch() {
			return autoFetch;
		},
		get autoFetchPeriod() {
			return autoFetchPeriod;
		},
		setAutoFetch: async (value: false | true | 'all') => {
			autoFetch = value;
			autoFetchChanged.fire();
		},
		setAutoFetchPeriod: async (value: number) => {
			autoFetchPeriod = value;
			autoFetchChanged.fire();
		},
		setRebaseWhenSync: async (value: boolean) => {
			rebaseWhenSync = value;
			autoFetchChanged.fire();
		},
	};
	const model = { provider: 'openai', model: 'gpt-test' };
	const modelsChanged = disposables.add(new Emitter<void>());
	let modelVisible = true;
	const modelWrites: boolean[] = [];
	const savedKeys: string[] = [];
	const advisorModel = { provider: 'openai', model: 'gpt-6.1-sol' };
	const otherAdvisorModel = { provider: 'meta', model: 'muse-spark-1.3' };
	const hiddenAdvisors = new Set<string>();
	let advisor: import('../../../../services/chat/common/chatService.js').AdvisorConfig | null = {
		model: advisorModel,
		enabled: true,
		maxCalls: 5,
		maxOutputTokens: 4096,
		reasoningEffort: 'high',
	};
	const advisorWrites: (typeof advisor | null)[] = [];
	let rejectAdvisorSave = false;
	const chatService = {
		onDidChangeModels: modelsChanged.event,
		readAdvisorDefault: async () => advisor,
		saveAdvisorDefault: async (next: typeof advisor) => {
			if (rejectAdvisorSave) {
				throw new Error('Preference write failed');
			}
			advisor = next;
			advisorWrites.push(next);
		},
		listModelCatalog: async () => [
			{ model, displayName: 'GPT Test' },
			{ model: advisorModel, displayName: 'GPT-6.1 Sol', recommendedFor: [ModelPurpose.Advisor] },
			{
				model: otherAdvisorModel,
				displayName: 'Muse Spark 1.3',
				recommendedFor: [ModelPurpose.Advisor],
				supportedReasoningEfforts: [{ effort: 'high' }],
			},
		],
		setModelPreferences: async () => { },
		listCustomModelProviders: async () => [],
		listModelProviders: async () => [
			{
				connection: 'openai',
				provider: 'openai',
				displayName: 'OpenAI API',
				apiKeyPolicy: 'required',
				apiKeyConfigured: savedKeys.length > 0,
			},
		],
		isModelVisible: (entry: typeof model) => (entry.model === model.model ? modelVisible : !hiddenAdvisors.has(entry.model)),
		setModelVisible: async (_model: typeof model, visible: boolean) => {
			modelWrites.push(visible);
			modelVisible = visible;
			modelsChanged.fire();
		},
		setModelProviderApiKey: async (_connection: string, key: string) => {
			savedKeys.push(key);
		},
		refreshModels: async () => [{ model, displayName: 'GPT Test' }],
	} as unknown as IChatService;
	const contextView = disposables.add(new BrowserContextViewService(root));
	let hookReads = 0;
	let hooksFailure = false;
	let openUserToml = 0;
	let sources: readonly HookSource[] = [
		{
			namespace: 'user',
			configPath: '/profile/config.toml',
			hooks: [
				{
					id: 'user:hook:check',
					event: 'preToolUse',
					enabled: false,
					toolNames: ['shell-command'],
					program: '/program with spaces',
					args: ['two words', '"quote"'],
				},
			],
		},
	];
	const hooksChanged = disposables.add(new Emitter<void>());
	const firstHookRead = new DeferredPromise<void>();
	let nextHooksRead: Promise<readonly HookSource[]> | undefined;
	const hooksBackend: IAppServerHookApi = {
		onDidChangeHooks: hooksChanged.event,
		list: async sessionId => {
			hookReads++;
			void firstHookRead.complete();
			assert.equal(sessionId, 'session-hooks');
			if (hooksFailure) throw new Error('Invalid TOML');
			const pending = nextHooksRead;
			nextHooksRead = undefined;
			return pending ?? sources;
		},
	};
	const services = new InstantiationService();
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, hooksBackend);
	services.registerInstance(INotificationService, disposables.add(new TestNotificationService()));
	services.registerInstance(IVoiceCodeTranscriptionBackendService, undefined);
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(IContextKeyService, disposables.add(new ContextKeyService()));
	services.registerInstance(IExtensionService, disposables.add(new TestExtensionService()));
	services.registerInstance(ISpeechService, disposables.add(services.createInstance(SpeechService)));
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	services.registerSingleton(IVoiceCodeTranscriptionClient, () => services.createInstance(VoiceCodeTranscriptionClient));
	services.registerInstance(ITelemetryService, NullTelemetryService);
	const skillsChanged = disposables.add(new Emitter<void>());
	let skillEnabled = true;
	const skillScopes: (string | undefined)[] = [];
	const skillMutations: unknown[][] = [];
	const skillId = { source: 'directory:skill-source:test', name: 'review' };
	services.registerInstance(IAppServerSkillApi, {
		onDidChangeSkills: skillsChanged.event,
		readTextResource: async () => {
			throw new Error('No Skill body in this test fixture');
		},
		list: async () => ({ generation: 0, skills: [] }),
		read: async sessionId => {
			skillScopes.push(sessionId);
			return {
				revision: 7,
				catalog: {
					generation: 1,
					skills: [
						{
							id: skillId,
							description: 'Review changes',
							contentDigest: 'sha256:review',
							enabled: skillEnabled,
							compatible: true,
						},
					],
				},
				diagnostics: [],
			};
		},
		registerSource: async () => {
			throw new Error('Unexpected skill source registration');
		},
		setEnabled: async (...args) => {
			skillMutations.push(args);
			skillEnabled = args[1];
		},
	});
	services.registerInstance(IExtensionManagementService, {
		onDidChangeInstalled: Event.None,
	} as IExtensionManagementService);
	services.registerInstance(ILanguageServerService, {
		control: async () => { },
		read: async () => ({ revision: 0, configurations: {}, servers: [] }),
		configure: async () => { },
		removeConfiguration: async () => { },
	});
	services.registerInstance(ICodeEditorService, { getActiveCodeEditor: () => null } as ICodeEditorService);
	services.registerInstance(IDialogService, disposables.add(new DialogService()));
	services.registerInstance(ClipboardServiceId, clipboardService);
	services.registerInstance(IContextMenuService, contextMenuProvider);
	services.registerInstance(IContextViewService, contextView);
	services.registerInstance(IHoverService, disposables.add(new HoverService(configuration, contextView, contextMenuProvider)));
	services.registerInstance(LocalizationServiceId, workbenchLocalization);
	disposables.add(CommandsRegistry.register('git.readSettings', () => ({ autoFetch, autoFetchPeriod, rebaseWhenSync })));
	disposables.add(CommandsRegistry.register('git.updateAutoFetch', async (_accessor, value) => gitService.setAutoFetch(value as false | true | 'all')));
	disposables.add(CommandsRegistry.register('git.updateAutoFetchPeriod', async (_accessor, value) => gitService.setAutoFetchPeriod(value as number)));
	disposables.add(CommandsRegistry.register('git.updateRebaseWhenSync', async (_accessor, value) => gitService.setRebaseWhenSync(value as boolean)));
	services.registerInstance(IServerEventApi, {
		subscribe: listener => autoFetchChanged.event(() => listener({ method: 'config/changed', params: { revision: 1, generation: 1 } })),
	});
	services.registerInstance(ChatServiceId, chatService);
	services.registerInstance(IAgentModelsService, {
		...createDisconnectedAgentModelsService(async operation => { throw new Error(`Unexpected ${operation}`); }),
		readDefaults: () => (chatService as unknown as ILanguageModelsService).readModelDefaults(),
	});
	services.registerInstance(ILanguageModelsService, chatService as unknown as ILanguageModelsService);
	services.registerInstance(IBrowserPasswordService, UnavailableBrowserPasswordService);
	services.registerInstance(ISecretStorageStatusService, {
		readState: async () => ({ status: 'available' }),
		authorizeAccess: async () => ({ status: 'available' }),
		setStorageMode: async mode => ({ status: 'available', mode }),
	});
	services.registerInstance(IAgentExecutionSettingsService, {
		onDidChange: Event.None,
		read: async () => ({
			revision: 1,
			settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' },
		}),
		configure: async () => { },
	});
	const localTranscription = disposables.add(new NullLocalTranscriptionService());
	services.registerInstance(ILocalTranscriptionModelService, localTranscription);
	services.registerInstance(ILocalTranscriptionService, localTranscription);
	const descriptor = EditorPanes.getEditorPanes().find(candidate => candidate.id === SettingsEditorId);
	assert.ok(descriptor);
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: localeService/);
	services.registerInstance(ILocaleService, locale);
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: languagePackService/);
	services.registerInstance(LanguagePackServiceId, languagePacks);
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: agentCapabilitiesService/);
	let capabilityReads = 0;
	services.registerInstance(IAgentCapabilitiesService, {
		isAvailable: true,
		onDidChange: Event.None,
		read: async () => {
			capabilityReads++;
			return {
				localProcessSandboxConfigured: true,
				sandboxBackends: ['mxc'],
				sandboxDiagnostics: [
					{
						backend: 'mxc',
						network: 'managed',
						readiness: { type: 'unsupported', reason: '<script>diagnostic</script>' },
					},
				],
				directoryGrantsReadable: true,
			};
		},
	});
	services.registerSingleton(ILanguageModelToolsService, () =>
		createTestLanguageModelToolsService({
			isAvailable: true,
			read: async () => {
				capabilityReads++;
				return {
					sourceGroups: [],
					tools: [
						{
							name: 'read_file',
							category: 'read',
							description: 'Read a file.',
							source: 'local',
							sourceDetails: ['ash-app-server'],
							exposure: 'direct',
							authority: 'directoryRead',
						},
					],
				};
			},
		}),
	);
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: appServerRemoteAgentService/);
	const connectionChanged = disposables.add(new Emitter<RemoteConnectionState>());
	const connectionIdentityChanged = disposables.add(new Emitter<RemoteAgentConnection>());
	let connectionIdentity: RemoteAgentConnection = { kind: 'local', generation: 1 };
	services.registerInstance(ITraceSettingsService, {
		onDidChange: Event.None,
		read: async () => ({ revision: 1, configured: null, recording: { type: 'disabled' } }),
		configure: async () => { },
	});
	services.registerInstance(IFileDialogService, {
		pickFolderAndOpen: async () => {
			throw new Error('Unexpected folder open');
		},
		pickWorkspaceAndOpen: async () => {
			throw new Error('Unexpected workspace open');
		},
		showOpenDialog: async () => undefined,
		showSaveDialog: async () => undefined,
		pickFileToSave: async () => undefined,
		showSaveConfirm: async () => 2,
	});
	services.registerInstance(RemoteAgentServiceId, {
		onDidChangeConnectionState: connectionChanged.event,
		onDidChangeConnection: connectionIdentityChanged.event,
		connectionState: 'connected',
		get connection() {
			return connectionIdentity;
		},
		reconnect: async () => ({ kind: 'alreadyConnected' }),
		rollbackRuntime: async () => ({ kind: 'cancelled' }),
	});
	services.registerInstance(WorkspaceTrustApiId, {
		onDidChangeTrust: Event.None,
		listDirectories: async () => ({
			revision: 1,
			entries: [{ dir: 'dir-1', path: '/workspace', permissions: ['readFiles'] }],
		}),
	} as unknown as IWorkspaceTrustApi);
	let searchSnapshot: import('../../../../../platform/search/common/search.js').ContentSearchConfiguration = {
		revision: 4,
		engine: 'tgrep',
	};
	let rejectSearchSave = false;
	let nextSearchRead: Promise<typeof searchSnapshot> | undefined;
	const searchWrites: { engine: string; expectedRevision: number; }[] = [];
	services.registerInstance(IContentSearchConfigurationService, {
		read: async () => {
			const pending = nextSearchRead;
			nextSearchRead = undefined;
			return pending ?? searchSnapshot;
		},
		configure: async (engine, expectedRevision) => {
			searchWrites.push({ engine, expectedRevision });
			if (rejectSearchSave) {
				throw new Error('Revision conflict');
			}
			searchSnapshot = { engine, revision: expectedRevision + 1 };
		},
	});
	services.registerInstance(INetworkDiagnosticsService, {
		read: async () => ({ revision: 0, httpMode: 'http2', targets: [] }),
		configureHttp: async () => { },
		run: async () => ({ network: { revision: 0, httpMode: 'http2', targets: [] }, checks: [] }),
	});
	const prompts: string[] = [];
	services.registerInstance(IChatSessionNavigationService, {
		revision: 0,
		getActiveConversation: () => ({ sessionId: 'session-hooks', threadId: 'thread-hooks' }),
		getConversations: () => [],
		captureActiveDraft: async () => undefined,
		openConversation: async () => { },
		startVoiceConversation: async () => {
			throw new Error('Unexpected voice start');
		},
		appendToActiveDraft: text => {
			prompts.push(text);
		},
	});
	services.registerInstance(IAccessibleViewService, {
		show: () => true,
		getOpenAriaHint: () => undefined,
		disableHint: async () => { },
		showAccessibleViewHelp: () => { },
		dispose() { },
		[Symbol.dispose]() { },
	});
	const hooksFolder = await mkdtemp(join(tmpdir(), 'ash-settings-hooks-'));
	await using hooksFolderCleanup = {
		[Symbol.asyncDispose]: async () => {
			await rm(hooksFolder, { recursive: true, force: true });
		},
	};
	services.registerSingleton(IFileService, () => createTestFileService(disposables.add(new DiskFileSystemProvider([URI.file(hooksFolder)]))));
	services.registerSingleton(ITextFileService, () => disposables.add(createTestTextFileService(services.get(IFileService), configuration)));
	const editorPanes = new EditorPaneRegistry();
	disposables.add(editorPanes.registerEditorPane(descriptor));
	const managementDescriptor = EditorPanes.getEditorPanes().find(candidate => candidate.id === AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID)!;
	disposables.add(editorPanes.registerEditorPane(managementDescriptor));
	const editorServices = disposables.add(createTestEditorServices(undefined, services));
	const editor = disposables.add(editorServices.createInstance(EditorPart, root, { registry: editorPanes }));
	editorServices.registerInstance(IEditorPart, editor);
	editorServices.registerInstance(ICommandService, disposables.add(new CommandService(editorServices)));
	editorServices.registerSingleton(IMenuService, () => editorServices.createInstance(MenuService));
	editorServices.registerInstance(IEditorService, disposables.add(new BrowserEditorService(editor)));
	const preferences = disposables.add(
		new PreferencesService(
			editorServices.get(IEditorService),
			editorServices.get(IFileTextModelService),
			keybindingProfile.files,
			keybindingProfile.profiles,
			editorServices,
			configuration,
			configuration,
			editorServices.get(IEditorService) as InstanceType<typeof BrowserEditorService>,
		),
	);
	services.registerInstance(IPreferencesService, preferences);
	services.registerInstance(IOpenerService, { open: async () => true } as unknown as IOpenerService);
	services.registerInstance(IAccountService, {
		onDidChangeAccounts: Event.None,
		onDidCompleteLogin: Event.None,
		read: async () => ({ revision: 1n, accounts: [] }),
		startLogin: async () => {
			throw new Error('Not used');
		},
		cancelLogin: async () => { },
		logout: async () => { },
	});
	services.registerInstance(IGitHubService, { listAccounts: async () => [] } as unknown as IGitHubService);
	services.registerInstance(IAccountPolicyService, {
		state: { phase: 'idle' },
		onDidChangeState: Event.None,
		refresh: async () => { },
	});
	services.registerSingleton(IManagedSettingsUpdateService, () => services.createInstance(ManagedSettingsUpdateService));
	services.registerInstance(IGitHubConnectionService, {
		isConnecting: false,
		connect: async () => { },
		cancel: async () => { },
	});
	services.registerInstance(IGitHubReviewModel, disposables.add(services.createInstance(GitHubReviewModel)));
	services.registerInstance(IWorkbenchHostService, {
		downloadText: () => assert.fail('Unexpected download'),
		editUserConfiguration: async () => {
			openUserToml++;
		},
	});

	services.registerInstance(IKeybindingService, {
		inChordMode: false,
		onDidUpdateKeybindings: Event.None,
		getKeybindings: () => [],
		enableKeybindingHoldMode: () => undefined,
		registerSchemaContribution: () => toDisposable(() => { }),
		resolveKeybinding,
		resolveUserBinding: () => undefined,
		lookupKeybindings: () => [],
		lookupKeybinding: () => undefined,
	});
	services.registerInstance(IHostService, {
		getWindows: async () => [],
		reload: async () => {
			throw new Error('Unexpected reload in this fixture');
		},
		hasFocus: true,
		onDidChangeFocus: Event.None,
		openWindow: async () => { },
		restart: async () => { },
		getScreenshot: async () => undefined,
	});

	await preferences.openSettings();
	const host = root.querySelector<HTMLElement>('.ash-modal-editor-host');
	assert.ok(host);
	assert.equal(host.hidden, false);
	assert.equal(root.querySelector('.ash-modal-editor')?.getAttribute('role'), 'dialog');
	assert.deepEqual(
		[...root.querySelectorAll<HTMLElement>('[data-settings-category-id]')].map(element => element.dataset.settingsCategoryId),
		['general', 'github', 'network'],
	);
	const workbenchGroup = root.querySelector<HTMLElement>('[data-settings-group-id="workbench"]');
	assert.ok(workbenchGroup);
	assert.equal(workbenchGroup.closest('.ash-tree-row')?.getAttribute('aria-expanded'), 'false');
	workbenchGroup.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.deepEqual(
		[...root.querySelectorAll<HTMLElement>('[data-settings-category-id]')].map(element => element.dataset.settingsCategoryId),
		['general', 'github', 'network', 'appearance', 'layout', 'debugging', 'settings-editor', 'startup', 'browser'],
	);
	assert.equal(root.querySelector('[data-settings-category-id="general"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-category-id="appearance"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-category-id="layout"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-category-id="startup"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-target-id="appearance.group.theme"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="layout.group.layout"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="startup.group.startup-windows"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="startup.group.startup-editor"]'), null);
	const agentsGroup = root.querySelector<HTMLElement>('[data-settings-group-id="agents"]');
	assert.ok(agentsGroup);
	assert.equal(agentsGroup.textContent, 'Chat');
	assert.equal(agentsGroup.closest('.ash-tree-row')?.getAttribute('aria-expanded'), 'false');
	assert.equal(root.querySelector('[data-settings-category-id="models"]'), null);
	await nextTurn();
	await configuration.updateValue(AccessibilityVerbositySettingId.ChatScreenshot, false);
	await preferences.openSettings({ section: 'extension.ash.snapshot' });
	await nextTurn();
	assert.equal(root.querySelector('[data-settings-item-id="screenshot.section"]'), null);
	assert.equal(root.querySelector('[data-settings-category-id="screenshot"]'), null);
	assert.equal(root.querySelector('[data-settings-category-id="extension.ash.snapshot"]')?.textContent, 'Snapshot');
	const screenSettings = root.querySelector<HTMLElement>('[data-settings-tree-group-id="extension.ash.snapshot.group.screen"]')!;
	const codeSettings = root.querySelector<HTMLElement>('[data-settings-tree-group-id="extension.ash.snapshot.group.code"]')!;
	assert.ok(screenSettings);
	assert.ok(codeSettings);
	assert.ok(screenSettings.querySelector('[data-settings-item-id="snapshot.screen.shortcut"]')?.textContent?.includes('Not set'));
	assert.ok(codeSettings.querySelector('[data-settings-item-id="snapshot.code.shortcut"]')?.textContent?.includes('Not set'));
	assert.ok(codeSettings.textContent?.includes('Resolution scale'));
	assert.equal(screenSettings.querySelector('[data-configuration-key="snapshot.code.padding"]'), null);
	const globalScreenshot = root.querySelector<HTMLElement>(`[data-configuration-key="${ScreenshotGlobalShortcutSetting}"]`)!;
	assert.ok(globalScreenshot);
	assert.equal(globalScreenshot.getAttribute('aria-checked'), 'false');
	globalScreenshot.click();
	await nextTurn();
	assert.equal(configuration.getValue(ScreenshotGlobalShortcutSetting), true);
	const screenshotHints = root.querySelector<HTMLElement>(`[data-configuration-key="${AccessibilityVerbositySettingId.ChatScreenshot}"]`)!;
	assert.ok(screenshotHints);
	assert.equal(screenshotHints.getAttribute('aria-checked'), 'false');
	screenshotHints.click();
	await nextTurn();
	assert.equal(configuration.getValue(AccessibilityVerbositySettingId.ChatScreenshot), true);
	await preferences.openSettings({ section: 'accessibilitySignals' });
	assert.equal(root.querySelector('[data-settings-category-id="accessibilitySignals"]')?.textContent, 'Accessibility Signals');
	assert.ok(root.querySelector('[data-settings-item-id="accessibility.signalOptions.volume"]'));
	assert.ok(root.querySelector('[data-settings-item-id^="accessibility.signals."]'));
	assert.equal(root.querySelector('[data-settings-item-id^="accessibility.verbosity."]'), null);
	await preferences.openSettings({ section: 'accessibility' });
	assert.equal(root.querySelector('[data-settings-category-id="accessibility"]')?.textContent, 'Accessibility');
	assert.ok(root.querySelector('[data-settings-item-id="editor.accessibilitySupport"]'));
	assert.ok(root.querySelector('[data-settings-item-id="workbench.reduceMotion"]'));
	assert.ok(root.querySelector(`[data-settings-item-id="${AccessibilityConfiguration.underlineLinks}"]`));
	assert.ok(root.querySelector('[data-settings-item-id^="accessibility.verbosity."]'));
	assert.equal(root.querySelector(`[data-settings-item-id="${AccessibilityVerbositySettingId.ChatScreenshot}"]`), null);
	assert.equal(root.querySelector('[data-settings-item-id^="accessibility.signal"]'), null);
	await preferences.openSettings({ section: 'terminal' });
	assert.equal(root.querySelector('[data-settings-category-id="terminal"]')?.textContent, 'Terminal');
	assert.equal(root.querySelectorAll('[data-settings-item-id^="terminal.integrated."]').length, 11);
	await preferences.openSettings({ section: 'search' });
	const searchEngine = root.querySelector<HTMLElement>('[data-settings-item-id="grep.backend"] [role="combobox"]');
	assert.equal(searchEngine?.textContent, 'tgrep (default)');
	assert.throws(() => configuration.inspect('grep.backend'), /Unknown configuration key/);
	assert.ok(searchEngine);
	const searchRow = root.querySelector<HTMLElement>('[data-settings-item-id="grep.backend"]')!;
	searchEngine.click();
	const searchList = ownerDocument.getElementById(searchEngine.getAttribute('aria-controls')!)!;
	searchList.querySelectorAll<HTMLElement>('[role="option"]')[1].click();
	await nextTurn();
	assert.equal(searchEngine.textContent, 'ripgrep');
	assert.equal(searchRow.querySelector('[role="status"]')?.textContent, 'Search engine saved.');
	assert.deepEqual(searchWrites, [{ engine: 'ripgrep', expectedRevision: 4 }]);
	rejectSearchSave = true;
	searchEngine.click();
	searchList.querySelectorAll<HTMLElement>('[role="option"]')[0].click();
	await nextTurn();
	assert.equal((searchEngine as HTMLButtonElement).disabled, true);
	assert.equal(searchRow.querySelector('[role="status"]')?.textContent, 'Could not save search engine. Refresh the configuration before trying again.');
	rejectSearchSave = false;
	searchRow.querySelector<HTMLButtonElement>('button:not([role="combobox"])')!.click();
	await nextTurn();
	assert.equal(searchEngine.textContent, 'ripgrep');
	assert.equal((searchEngine as HTMLButtonElement).disabled, false);
	const pendingSearch = new DeferredPromise<typeof searchSnapshot>();
	nextSearchRead = pendingSearch.p;
	searchRow.querySelector<HTMLButtonElement>('button:not([role="combobox"])')!.click();
	connectionChanged.fire('disconnected');
	await pendingSearch.complete({ revision: 1, engine: 'tgrep' });
	await nextTurn();
	assert.equal((searchEngine as HTMLButtonElement).disabled, true);
	assert.equal(searchRow.querySelector('[role="status"]')?.textContent, 'App Server is disconnected.');
	connectionChanged.fire('connected');
	await nextTurn();
	assert.equal(searchEngine.textContent, 'ripgrep');
	assert.equal((searchEngine as HTMLButtonElement).disabled, false);
	await preferences.openSettings({ section: 'general' });
	assert.equal(root.querySelector(`[data-settings-item-id="${AccessibilityConfiguration.underlineLinks}"]`), null);
	assert.ok(root.querySelector(`[data-settings-item-id="${HoverConfiguration.delay}"]`));
	const languageControl = root.querySelector<HTMLElement>('[data-configuration-key="workbench.locale"] [role="combobox"]');
	assert.ok(languageControl);
	assert.equal(languageControl.textContent, 'English');
	catalogs.push({
		...productLanguagePackCatalogs[0],
		locale: 'fr',
		languageName: 'French',
		localizedLanguageName: 'Français',
	});
	languagePacksChanged.fire();
	languageControl.click();
	const languageListId = languageControl.getAttribute('aria-controls')!;
	const languageOptions = [...ownerDocument.getElementById(languageListId)!.querySelectorAll<HTMLElement>('[role="option"]')];
	assert.deepEqual(
		languageOptions.map(option => option.textContent),
		['English', 'Français', '简体中文'],
	);
	languageOptions.find(option => option.textContent === 'Français')!.click();
	await nextTurn();
	assert.equal(configuration.getValue(LocalizationConfiguration.locale), 'fr');
	assert.equal(languageControl.textContent, 'Français');
	catalogs.pop();
	languagePacksChanged.fire();
	assert.equal(languageControl.textContent, 'fr');
	assert.equal(configuration.getValue(LocalizationConfiguration.locale), 'fr');
	await configuration.updateValue(LocalizationConfiguration.locale, 'zh-CN');
	assert.equal(languageControl.textContent, '简体中文');
	assert.equal(languageControl.getAttribute('aria-label'), 'Interface language');
	root.querySelector<HTMLButtonElement>('[data-settings-item-id="workbench.locale"] .ash-setting-item-actions-trigger')!.click();
	let resolveSaved!: () => void;
	const resetSaved = new Promise<void>(resolve => {
		resolveSaved = resolve;
	});
	using savedListener = configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(LocalizationConfiguration.locale)) resolveSaved();
	});
	await menuActions.find(action => action.id === 'settings.resetSetting')!.run();
	await resetSaved;
	hideMenu?.(false);
	assert.equal(languageControl.textContent, 'English');
	assert.equal(configuration.inspect(LocalizationConfiguration.locale).userValue, undefined);
	await preferences.openSettings({ section: 'extension.ash.git' });
	const autofetchControl = root.querySelector<HTMLElement>(`[data-configuration-key="${GitConfiguration.autofetch}"]`);
	assert.ok(autofetchControl);
	const autofetchButton = autofetchControl.querySelector<HTMLButtonElement>('[role="combobox"]');
	assert.equal(autofetchButton?.getAttribute('aria-label'), 'Auto Fetch');
	const autofetchListId = autofetchButton?.getAttribute('aria-controls');
	assert.ok(autofetchListId);
	autofetchButton?.click();
	ownerDocument.getElementById(autofetchListId)?.querySelectorAll<HTMLElement>('[role="option"]')[1]?.click();
	await nextTurn();
	assert.equal(autoFetch, true);
	autofetchButton?.click();
	ownerDocument.getElementById(autofetchListId)?.querySelectorAll<HTMLElement>('[role="option"]')[2]?.click();
	await nextTurn();
	assert.equal(autoFetch, 'all');

	const rebaseControl = root.querySelector<HTMLElement>(`[data-configuration-key="${GitConfiguration.rebaseWhenSync}"]`);
	assert.ok(rebaseControl);
	assert.equal(rebaseControl.getAttribute('role'), 'switch');
	assert.equal(rebaseControl.getAttribute('aria-label'), 'Rebase When Sync');
	assert.equal(rebaseControl.getAttribute('aria-checked'), 'false');
	rebaseControl.click();
	await nextTurn();
	assert.equal(rebaseWhenSync, true);
	assert.equal(rebaseControl.getAttribute('aria-checked'), 'true');
	assert.equal(configuration.inspect(GitConfiguration.rebaseWhenSync).userLocalValue, undefined);
	root.querySelector<HTMLButtonElement>(`[data-settings-item-id="${GitConfiguration.rebaseWhenSync}"] .ash-setting-item-actions-trigger`)!.click();
	await menuActions.find(action => action.id === 'settings.resetSetting')!.run();
	hideMenu?.(false);
	assert.equal(rebaseWhenSync, false);
	assert.equal(rebaseControl.getAttribute('aria-checked'), 'false');
	assert.equal(autoFetch, 'all');

	const extensionNodes = [
		...parseExtensionManifest(
			JSON.stringify({
				name: 'live',
				publisher: 'test',
				version: '1.0.0',
				displayName: 'Live extension',
				contributes: {
					configuration: {
						properties: {
							'live.enabled': { type: 'boolean', default: false, description: 'Enable live extension' },
						},
					},
				},
			}),
			{ id: 'test.live', name: 'live', publisher: 'test', version: '1.0.0' },
		).contributes.configuration,
	];
	configurationRegistry.updateConfigurations({ add: extensionNodes, remove: [] });
	try {
		await preferences.openSettings({ section: 'extension.test.live' });
		assert.equal(root.querySelector('[data-settings-group-id="extensions"]')?.textContent, 'Extensions');
		assert.equal(root.querySelector('.ash-settings-page h3')?.textContent, 'Live extension');
		const enabled = root.querySelector<HTMLInputElement>('[data-configuration-key="live.enabled"]')!;
		enabled.click();
		await nextTurn();
		assert.equal(configuration.getValue('live.enabled'), true);
		await preferences.openSettings({ query: '@modified @id:live.enabled' });
		assert.equal(root.querySelector('[data-settings-category-id="extension.test.live"]')?.textContent, 'Live extension');
		assert.ok(root.querySelector('[data-settings-item-id="live.enabled"]'));
		await preferences.openSettings({ section: 'extension.test.live' });
		configurationRegistry.updateConfigurations({ add: [], remove: extensionNodes });
		assert.equal(root.querySelector('[data-settings-category-id="extension.test.live"]'), null);
		assert.equal(root.querySelector('[data-settings-item-id="live.enabled"]'), null);
		assert.equal(root.querySelector('.ash-settings-page h3')?.textContent, 'Application');
		assert.equal(JSON.parse((await configuration.read()).source)['live.enabled'], true, 'withdrawal preserves saved extension values');
	} finally {
		configurationRegistry.updateConfigurations({ add: [], remove: extensionNodes });
	}

	await preferences.openSettings({ section: 'accessibility' });
	const underline = root.querySelector<HTMLInputElement>(`[data-configuration-key="${AccessibilityConfiguration.underlineLinks}"]`);
	assert.ok(underline);
	assert.equal(underline.getAttribute('role'), 'switch');
	assert.equal(underline.getAttribute('aria-checked'), 'false');
	underline.click();
	await nextTurn();
	assert.equal(configuration.getValue(AccessibilityConfiguration.underlineLinks), true);
	assert.equal(underline.getAttribute('aria-checked'), 'true');
	const underlineIndicator = root.querySelector<HTMLElement>(`[data-settings-item-id="${AccessibilityConfiguration.underlineLinks}"] .ash-settings-indicators`);
	assert.equal(underlineIndicator?.hidden, true);
	assert.equal(underlineIndicator?.textContent, '');

	await preferences.openSettings({ section: 'general' });
	const hoverDelay = root.querySelector<HTMLInputElement>(`[data-configuration-key="${HoverConfiguration.delay}"]`);
	assert.ok(hoverDelay);
	hoverDelay.value = '750';
	hoverDelay.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	assert.equal(configuration.getValue(HoverConfiguration.delay), 750);
	for (let attempt = 0; hoverDelay.disabled && attempt < 100; attempt++) await nextTurn();
	assert.equal(hoverDelay.disabled, false);

	root.querySelector<HTMLButtonElement>(`[data-settings-item-id="${HoverConfiguration.delay}"] .ash-setting-item-actions-trigger`)?.click();
	const copyAction = menuActions.find(action => action.id === 'settings.copySettingId');
	const resetAction = menuActions.find(action => action.id === 'settings.resetSetting');
	assert.ok(copyAction);
	assert.ok(resetAction);
	await copyAction.run();
	assert.deepEqual(copied, [HoverConfiguration.delay]);
	let resolveHoverReset!: () => void;
	const hoverReset = new Promise<void>(resolve => {
		resolveHoverReset = resolve;
	});
	using hoverResetListener = configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(HoverConfiguration.delay)) resolveHoverReset();
	});
	await resetAction.run();
	await hoverReset;
	assert.equal(configuration.getValue(HoverConfiguration.delay), configurationRegistry.getConfiguration(HoverConfiguration.delay)?.defaultValue);

	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.equal(root.querySelector('[data-tree-id="group.agents"]')?.getAttribute('aria-expanded'), 'true');
	assert.deepEqual(
		['agents', 'teams', 'agent-defaults', 'models', 'rules', 'sandbox', 'execution-trace', 'hooks'].map(
			categoryId => root.querySelector<HTMLElement>(`[data-settings-category-id="${categoryId}"]`)?.textContent,
		),
		['Agents', 'Teams', 'Defaults', 'Models', 'Rules', 'Sandbox', 'Execution trace', 'Hooks'],
	);
	assert.equal(root.querySelector('[data-tree-id="general"]')?.getAttribute('aria-selected'), 'true');
	assert.equal(root.querySelector('[data-settings-category-id="skills"]'), null);
	assert.deepEqual(skillScopes, []);
	assert.deepEqual(skillMutations, []);
	root.querySelector<HTMLElement>('[data-settings-category-id="agents"]')?.click();
	await nextTurn();
	assert.equal(root.querySelector('.ash-settings-page h3')?.textContent, 'Agents');
	assert.equal(root.querySelector('.ash-settings-section[data-settings-item-id="chat.advisor"] [role="switch"]'), null);
	const selectAdvisor = (label: string): void => {
		root.querySelector<HTMLElement>('.ash-settings-section[data-settings-item-id="chat.advisor"] [role="combobox"]')!.click();
		const option = [...root.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === label);
		assert.ok(option);
		option.click();
	};
	selectAdvisor('Off');
	await nextTurn();
	assert.deepEqual(advisorWrites, [{ model: advisorModel, enabled: false, maxCalls: 5, maxOutputTokens: 4096, reasoningEffort: 'high' }]);
	selectAdvisor('Muse Spark 1.3');
	await nextTurn();
	assert.deepEqual(advisorWrites[1], {
		model: otherAdvisorModel,
		enabled: true,
		maxCalls: 5,
		maxOutputTokens: 4096,
		reasoningEffort: 'high',
	});
	rejectAdvisorSave = true;
	selectAdvisor('Off');
	await nextTurn();
	assert.equal(root.querySelector('.ash-settings-section[data-settings-item-id="chat.advisor"] [role="combobox"]')?.textContent, 'Muse Spark 1.3');
	assert.match(root.querySelector('.ash-settings-section[data-settings-item-id="chat.advisor"] [role="status"]')?.textContent ?? '', /Preference write failed/u);
	rejectAdvisorSave = false;
	selectAdvisor('Off');
	await nextTurn();
	assert.deepEqual(advisorWrites[2], {
		model: otherAdvisorModel,
		enabled: false,
		maxCalls: 5,
		maxOutputTokens: 4096,
		reasoningEffort: 'high',
	});
	assert.equal(root.querySelector('.ash-settings-section[data-settings-item-id="chat.advisor"] [role="combobox"]')?.textContent, 'Off');
	selectAdvisor('Muse Spark 1.3');
	await nextTurn();
	hiddenAdvisors.add(otherAdvisorModel.model);
	modelsChanged.fire();
	await nextTurn();
	assert.equal(root.querySelector('.ash-settings-section[data-settings-item-id="chat.advisor"] [role="combobox"]')?.textContent, 'Muse Spark 1.3');
	root.querySelector<HTMLElement>('.ash-settings-section[data-settings-item-id="chat.advisor"] [role="combobox"]')?.click();
	assert.deepEqual(
		[...root.querySelectorAll('[role="option"]')].map(option => option.textContent),
		['Off', 'GPT-6.1 Sol', 'Muse Spark 1.3'],
	);
	assert.equal(advisorWrites.length, 4, 'Hiding a model must not change the saved preference');
	assert.equal(root.querySelector('.ash-settings-section[data-settings-item-id="chat.advisor"] > .ash-settings-card-title')?.textContent, 'Advisor');
	assert.ok(root.querySelector('.ash-settings-section[data-settings-item-id="chat.advisor"] > .ash-settings-card'));
	assert.equal(root.querySelector('.ash-settings-section[data-settings-item-id="chat.advisor"]')?.textContent?.includes('Refresh'), false);
	assert.equal(root.querySelector('[data-settings-category-id="tools"]'), null);
	root.querySelector<HTMLElement>('[data-settings-category-id="sandbox"]')?.click();
	await nextTurn();
	assert.match(root.querySelector('.ash-agent-capabilities-settings')?.textContent ?? '', /\/workspace/);
	const sandboxPanel = root.querySelector('.ash-agent-capabilities-settings')!;
	assert.match(sandboxPanel.textContent ?? '', /Policy unsupported/);
	assert.match(sandboxPanel.textContent ?? '', /<script>diagnostic<\/script>/);
	assert.equal(sandboxPanel.querySelector('script'), null);
	assert.equal(capabilityReads, 1);
	connectionChanged.fire('disconnected');
	assert.equal(root.querySelector('.ash-agent-capabilities-status')?.textContent, 'App Server is disconnected.');
	assert.equal(root.querySelector('.ash-agent-capabilities-list'), null);
	connectionChanged.fire('connected');
	await nextTurn();
	assert.equal(capabilityReads, 2);
	assert.match(root.querySelector('.ash-agent-capabilities-settings')?.textContent ?? '', /Policy unsupported/);
	root.querySelector<HTMLElement>('[data-settings-category-id="hooks"]')?.click();
	await nextTurn();
	assert.equal(hookReads, 0, 'Settings only links to the Chat-owned editor');
	const managementOpened = new DeferredPromise<void>();
	using managementListener = editorServices.get(IEditorService).onDidActiveEditorChange(() => {
		if (editor.activePane?.id === AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID) void managementOpened.complete();
	});
	const manageHooks = [...root.querySelectorAll<HTMLButtonElement>('.ash-settings-section button')].find(button => button.textContent === 'Manage Hooks');
	assert.ok(manageHooks, [...root.querySelectorAll<HTMLButtonElement>('.ash-settings-section button')].map(button => button.textContent).join(', '));
	manageHooks.click();
	await managementOpened.p;
	await firstHookRead.p;
	await nextTurn();
	const managementPane = editor.activePane!;
	const hooksRoot = root.querySelector<HTMLElement>('.ash-ai-customization-management');
	assert.ok(hooksRoot && !hooksRoot.hidden);
	for (let attempt = 0; attempt < 20 && hooksRoot.getAttribute('aria-busy') !== 'false'; attempt++) {
		await nextTurn();
	}
	assert.equal(hooksRoot.getAttribute('aria-busy'), 'false');
	assert.equal(hooksRoot.querySelectorAll('[data-hook-event]').length, 33, hooksRoot.outerHTML);
	assert.equal(hooksRoot.querySelector('[data-hook-event="preToolUse"] > summary')?.textContent, 'PreToolUse · 1 configured');
	assert.equal(root.querySelectorAll('input[type="search"]').length, 1);
	await configuration.updateValue(LocalizationConfiguration.locale, 'zh-CN');
	assert.equal(hooksRoot.querySelector('[data-hook-action="edit-scope"]')?.textContent, 'Edit TOML');
	await configuration.updateValue(LocalizationConfiguration.locale, 'en');
	assert.match(hooksRoot.querySelector('[data-hook-id="user:hook:check"]')?.textContent ?? '', /Disabled.*Source file.*\/profile\/config.toml.*two words/s);
	const hookSearch = hooksRoot.querySelector<HTMLInputElement>('input[type="search"]');
	assert.ok(hookSearch);
	hookSearch.value = 'two words';
	hookSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.deepEqual(
		[...hooksRoot.querySelectorAll<HTMLElement>('.ash-hooks-event')].filter(row => !row.hidden).map(row => row.dataset.hookEvent),
		['preToolUse'],
	);
	hooksRoot.querySelector<HTMLElement>('summary')?.focus();
	const contentProvider = AccessibleViewRegistry.getImplementations()
		.find(provider => provider.name.startsWith('aiCustomizationManagement-') && provider.type === AccessibleViewType.View)
		?.getProvider(editorServices);
	assert.ok(contentProvider);
	assert.match(contentProvider.provideContent(), /user:hook:check/);
	contentProvider.dispose();
	hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="edit-scope"]')?.click();
	await nextTurn();
	assert.equal(openUserToml, 1);
	hookSearch.value = '';
	hookSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	sources = [{ namespace: 'user', configPath: '/profile/config.toml', hooks: [] }];
	hooksChanged.fire();
	await nextTurn();
	assert.equal(hookReads, 2);
	assert.equal(hooksRoot.querySelectorAll('.ash-hooks-declaration').length, 0);
	const pendingHooks = new DeferredPromise<readonly HookSource[]>();
	nextHooksRead = pendingHooks.p;
	hooksChanged.fire();
	managementPane.setVisible(false);
	await pendingHooks.complete([{ namespace: 'user', configPath: '/stale/config.toml', hooks: [] }]);
	await nextTurn();
	assert.equal(hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="edit-scope"]')?.title, '/profile/config.toml');
	managementPane.setVisible(true);
	await nextTurn();
	assert.equal(hookReads, 4);
	assert.doesNotMatch(hooksRoot.textContent ?? '', /\/stale\/config.toml/);
	hooksFailure = true;
	hooksChanged.fire();
	await nextTurn();
	assert.match(hooksRoot.querySelector('[role="status"]')?.textContent ?? '', /Invalid TOML/);
	const userTomlButton = hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="edit-scope"]');
	assert.ok(userTomlButton && !userTomlButton.disabled);
	userTomlButton.click();
	await nextTurn();
	assert.equal(openUserToml, 2);
	hooksFailure = false;
	connectionIdentity = { kind: 'ssh', host: 'test-server', authority: 'ssh+test-server', generation: 2 };
	connectionIdentityChanged.fire(connectionIdentity);
	await nextTurn();
	assert.equal(userTomlButton.disabled, true);
	connectionIdentity = { kind: 'local', generation: 3 };
	connectionIdentityChanged.fire(connectionIdentity);
	await nextTurn();
	assert.equal(userTomlButton.disabled, false);

	const quickInput = disposables.add(new TestQuickInputService({ container: root }));
	const hooksServices = disposables.add(editorServices.createChild());
	hooksServices.registerInstance(IQuickInputService, quickInput);
	const slowDiscovery = new DeferredPromise<readonly HookSource[]>();
	nextHooksRead = slowDiscovery.p;
	const configureHooks = hooksServices.invokeFunction(showConfigureHooksQuickPick);
	const pickerInput = root.querySelector<HTMLInputElement>('.ash-quick-pick input')!;
	assert.ok(pickerInput);
	pickerInput.value = 'PreToolUse';
	pickerInput.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	pickerInput.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	await nextTurn();
	assert.equal((quickInput.currentQuickInput as IQuickPick<IQuickPickItem> | undefined)?.busy, true);
	let pickerReleased = false;
	void configureHooks.then(() => {
		pickerReleased = true;
	});
	pickerInput.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	await nextTurn();
	assert.equal(pickerReleased, true, 'dismissal must release the picker before discovery completes');
	await configureHooks;
	assert.equal(quickInput.currentQuickInput, undefined);
	assert.equal(root.querySelector('.ash-quick-pick'), null);
	await slowDiscovery.complete(sources);
	await nextTurn();
	assert.equal(root.querySelector('.ash-quick-pick'), null, 'late discovery cannot reopen a dismissed picker');

	hookSearch.value = '';
	hookSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="ask-scope"]')?.click();
	await nextTurn();
	assert.equal(host.hidden, true);
	assert.match(prompts[0] ?? '', /\/profile\/config.toml.*namespace \(user\)/);
	trigger.focus();
	await preferences.openSettings();
	await preferences.openSettings({ section: 'dictation' });
	assert.equal(root.querySelector('[data-settings-container]')?.getAttribute('data-active-settings-category'), 'voice-input');
	assert.equal(root.querySelector('[data-tree-id="voice-input"]')?.getAttribute('aria-selected'), 'true');
	assert.equal(root.querySelector('[data-settings-category-id="dictation"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id]'), null);
	assert.equal(root.querySelector('[data-settings-tree-group-id="dictation"] .ash-settings-tree-group-title')?.textContent, 'Voice input');
	await configuration.updateValue(LocalizationConfiguration.locale, 'zh-CN');
	assert.equal(root.querySelector('[data-settings-tree-group-id="dictation"] .ash-settings-tree-group-title')?.textContent, 'Voice input');
	const dictationSearch = root.querySelector<HTMLInputElement>('.ash-settings-search input')!;
	dictationSearch.value = 'dictation';
	dictationSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.ok(root.querySelector('[role="grid"][aria-label="Local dictation models"]'));
	assert.ok(root.querySelector('[data-settings-category-id="voice-input"]'));
	dictationSearch.value = '';
	dictationSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	await configuration.updateValue(LocalizationConfiguration.locale, 'en');
	assert.equal(root.querySelector('[data-configuration-key="dictation.model"]'), null);
	assert.ok(root.querySelector('[role="grid"][aria-label="Local dictation models"]'));
	await configuration.updateValue('dictation.backend', 'codex');
	const subscription = root.querySelector('[data-settings-item-id="dictation.subscription"]');
	assert.match(subscription?.textContent ?? '', /Codex subscription dictation/);
	assert.match(subscription?.textContent ?? '', /Use your Codex login from Models/);
	assert.match(subscription?.textContent ?? '', /stop to transcribe and insert the text/);
	assert.equal(subscription?.querySelector('button')?.textContent, 'Manage Codex account');
	assert.equal(root.querySelector('[data-settings-item-id="dictation.cloudModel"]'), null);
	assert.equal(subscription?.getAttribute('role'), 'group');
	assert.equal(ownerDocument.getElementById(subscription?.getAttribute('aria-labelledby') ?? '')?.textContent, 'Codex subscription dictation');
	assert.match(ownerDocument.getElementById(subscription?.getAttribute('aria-describedby') ?? '')?.textContent ?? '', /Codex login from Models/);
	await configuration.updateValue('dictation.backend', 'cloud');
	assert.match(root.querySelector('[data-settings-item-id="dictation.cloudModel"]')?.textContent ?? '', /gpt-live-transcribe/);
	await configuration.updateValue('dictation.cloudProvider', 'xai');
	assert.match(root.querySelector('[data-settings-item-id="dictation.cloudModel"]')?.textContent ?? '', /grok-voice-transcribe-2\.0/);
	assert.equal(root.querySelector('[data-configuration-key="dictation.subscription"]'), null);
	await configuration.updateValue('dictation.backend', 'local');
	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.click();
	root.querySelector<HTMLElement>('[data-settings-category-id="models"]')?.click();
	await nextTurn();
	assert.equal(root.querySelector('[data-settings-container]')?.getAttribute('data-active-settings-category'), 'models');
	assert.equal(root.querySelector('[data-configuration-key="dictation.model"]'), null);
	const modelSwitch = root.querySelector<HTMLInputElement>('.ash-models-settings-model-row input[aria-label="Show GPT Test in model picker"]');
	assert.ok(modelSwitch);
	assert.equal(modelSwitch.getAttribute('aria-label'), 'Show GPT Test in model picker');
	modelSwitch.click();
	await nextTurn();
	assert.deepEqual(modelWrites, [false]);
	assert.equal(modelSwitch.getAttribute('aria-checked'), 'false');
	const modelSearch = root.querySelector<HTMLInputElement>('.ash-settings-search input');
	assert.ok(modelSearch);
	modelSearch.value = 'missing';
	modelSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('.ash-models-settings-model-row'), null);
	modelSearch.value = '';
	modelSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	const apiInput = root.querySelector<HTMLInputElement>('.ash-models-settings-api-controls input[type="password"]');
	assert.ok(apiInput);
	assert.equal(apiInput.closest('.ash-models-settings-api-controls')?.querySelector('button'), null);
	apiInput.value = 'test-secret';
	apiInput.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	apiInput.dispatchEvent(new browserEnvironment.window.Event('blur'));
	await nextTurn();
	assert.deepEqual(savedKeys, ['test-secret']);
	assert.equal(root.textContent?.includes('test-secret'), false);
	root.querySelector<HTMLElement>('[data-settings-category-id="teams"]')?.click();
	assert.equal(root.querySelector<HTMLElement>('[data-settings-container]')?.dataset.activeSettingsCategory, 'teams');
	assert.equal(root.querySelector('.ash-settings-page h3')?.textContent, 'Teams');
	assert.equal(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length, 0);
	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.equal(root.querySelector('[data-tree-id="group.agents"]')?.getAttribute('aria-selected'), 'true');
	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.equal(root.querySelector('[data-tree-id="teams"]')?.getAttribute('aria-selected'), 'true');

	const search = root.querySelector<HTMLInputElement>('.ash-settings-search input');
	assert.ok(search);
	const searchFor = (query: string) => {
		search.value = query;
		search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	};
	searchFor('@id:editor.wordWrap');
	assert.equal(root.querySelector('.ash-settings-page h3')?.textContent, 'Search results');
	assert.ok(root.querySelector('[data-settings-item-id="editor.wordWrap"]'));
	assert.equal(root.querySelector<HTMLElement>('.ash-settings-content-empty')?.hidden, true);
	assert.equal(root.querySelector('[data-settings-tree-group-id="editor-display"] > h4')?.textContent, 'Display');
	assert.equal(root.querySelector('[data-settings-category-id="teams"]'), null);
	searchFor('@id:ash.nonexistent.setting');
	assert.equal(root.querySelector<HTMLElement>('.ash-settings-content-empty')?.hidden, false);
	assert.equal(root.querySelector('.ash-settings-content-empty')?.textContent, 'No settings found.');
	searchFor('@id:editor.fontSize');
	assert.ok(root.querySelector('[data-settings-item-id="editor.fontSize"]'));
	assert.equal(root.querySelector<HTMLElement>('.ash-settings-content-empty')?.hidden, true);
	searchFor('');
	assert.equal(root.querySelector('.ash-settings-page h3')?.textContent, 'Teams');
	search.value = 'advisor';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('[data-settings-category-id="agents"]')?.textContent, 'Agents');
	assert.equal(root.querySelector('[data-settings-category-id="teams"]'), null);
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
	assert.equal(search.value, '');
	search.value = 'workbench.colorTheme';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('[data-settings-category-id="appearance"]')?.textContent, 'Appearance');
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));

	root.querySelector<HTMLElement>('[data-settings-group-id="editor"]')?.click();
	root.querySelector<HTMLElement>('[data-settings-category-id="editor-fonts"]')?.click();
	assert.equal(root.querySelector<HTMLElement>('[data-settings-container]')?.dataset.activeSettingsCategory, 'editor-fonts');
	assert.ok(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`));
	assert.equal(root.querySelector(`[data-configuration-key="${EditorSelectionConfiguration.defaultNewDocumentEditor}"]`), null);
	assert.equal(root.querySelector('[data-settings-item-id^="models.item."]'), null);
	const fontFamily = root.querySelector<HTMLInputElement>(`[data-configuration-key="${CodeEditorConfiguration.fontFamily}"]`);
	assert.ok(fontFamily);
	fontFamily.value = 'Fira Code';
	fontFamily.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	assert.equal(configuration.getValue(CodeEditorConfiguration.fontFamily), 'Fira Code');
	search.value = '@modified @id:editor.font*';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.ok(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`));
	assert.equal(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontSize}"]`), null);
	fontFamily.focus();
	await configuration.updateValue(CodeEditorConfiguration.fontFamily, 'Iosevka');
	assert.equal(ownerDocument.activeElement, fontFamily, 'accepted writes retain focus on rows that still match');
	await configuration.updateValue(CodeEditorConfiguration.fontFamily, undefined);
	assert.equal(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`), null);
	assert.equal(root.querySelector<HTMLElement>('.ash-settings-content-empty')?.hidden, false);
	await configuration.updateValue(CodeEditorConfiguration.fontFamily, 'Fira Code');
	assert.equal(root.querySelector(`[data-configuration-key="${CodeEditorConfiguration.fontFamily}"]`), fontFamily);
	search.value = '';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	root.querySelector<HTMLButtonElement>('.ash-settings-search-filter')?.click();
	assert.deepEqual(
		menuActions.filter(action => action.label).map(action => action.label),
		['Modified', 'Setting ID…', 'Experimental', 'Preview', 'Stable', 'Clear Filters'],
	);
	const idFilter = menuActions.find(action => action.id === 'settings.search.id');
	assert.ok(idFilter);
	await idFilter.run();
	hideMenu?.(false);
	assert.equal(search.value, '@id:');
	search.value = '@id:editor.fontFamily';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.ok(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`));
	assert.equal(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontSize}"]`), null);
	root.querySelector<HTMLButtonElement>('.ash-settings-search-filter')?.click();
	const clearFilters = menuActions.find(action => action.id === 'settings.search.clearFilters');
	assert.ok(clearFilters);
	assert.equal(clearFilters.enabled, true);
	await clearFilters.run();
	hideMenu?.(false);
	assert.equal(search.value, '');
	await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'missing-theme');
	search.value = '@stable @id:workbench.colorTheme';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.match(root.querySelector('[data-configuration-key="workbench.colorTheme"]')?.textContent ?? '', /Unavailable \(missing-theme\)/);
	assert.equal(configuration.getValue(WorkbenchConfiguration.colorTheme), 'missing-theme');
	await configuration.updateValue(WorkbenchConfiguration.colorTheme, undefined);

	search.value = 'font family';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length, 4);
	assert.ok(root.querySelector('[data-settings-item-id="terminal.integrated.fontFamily"]'));
	assert.ok(root.querySelector('[data-settings-item-id="chat.input.fontFamily"]'));
	assert.ok(root.querySelector('[data-settings-item-id="chat.editor.fontFamily"]'));
	assert.ok(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`));
	assert.equal(root.querySelector(`[data-configuration-key="${CodeEditorConfiguration.fontFamily}"]`), fontFamily);
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }));
	assert.equal(root.querySelector('.ash-settings-navigation-tree')?.contains(ownerDocument.activeElement), true);
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
	assert.equal(search.value, '');
	assert.ok(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length > 1);
	const commands = editorServices.get(ICommandService);
	await commands.executeCommand('workbench.action.configureEditor');
	assert.equal(search.value, 'workbench.editor');
	assert.equal(ownerDocument.activeElement, search);
	const editorSettings = [...root.querySelectorAll<HTMLElement>('.ash-settings-content-tree [data-settings-item-id]')];
	assert.ok(editorSettings.length > 0);
	assert.ok(editorSettings.every(row => row.dataset.settingsItemId?.startsWith('workbench.editor')));
	await commands.executeCommand('workbench.action.openSettings', 'editor.fontFamily');
	assert.equal(root.querySelector('.ash-settings-search input'), search, 'query opening reuses the search owner');
	assert.equal(search.value, 'editor.fontFamily');
	assert.equal(ownerDocument.activeElement, search);
	assert.deepEqual([...root.querySelectorAll<HTMLElement>('.ash-settings-content-tree [data-settings-item-id]')].map(row => row.dataset.settingsItemId).sort(), [
		'chat.editor.fontFamily',
		'editor.fontFamily',
	]);
	assert.equal(root.querySelector(`[data-configuration-key="${CodeEditorConfiguration.fontFamily}"]`), fontFamily);
	await commands.executeCommand('workbench.action.openSettings', { query: '@id:editor.fontSize' });
	assert.equal(search.value, '@id:editor.fontSize');
	assert.equal(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length, 1);
	const focusedSize = root.querySelector<HTMLInputElement>('[data-configuration-key="editor.fontSize"]')!;
	focusedSize.focus();
	await commands.executeCommand('workbench.action.openSettings', {
		query: '@id:editor.fontSize',
		focusSearch: false,
	});
	assert.equal(ownerDocument.activeElement, focusedSize, 'opening options can retain focus on the current control');
	await preferences.openSettings({ focusSearch: true });
	assert.equal(ownerDocument.activeElement, search);
	await assert.rejects(commands.executeCommand('workbench.action.openSettings', { query: 'changed', target: 5 }));
	assert.equal(search.value, '@id:editor.fontSize');
	await preferences.openSettings();
	assert.equal(search.value, '@id:editor.fontSize', 'an opening request without query preserves the current filter');
	await commands.executeCommand('workbench.action.openSettings', { query: '' });
	assert.equal(search.value, '');
	assert.equal(ownerDocument.activeElement, search);
	assert.ok(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length > 1);
	await preferences.openSettings({ section: 'models' });
	assert.equal(root.querySelector<HTMLElement>('[data-settings-container]')?.dataset.activeSettingsCategory, 'models');
	await preferences.openSettings({ section: 'models', query: '', sectionQuery: '@provider:openai @capability:vision', focusSearch: true });
	const scopedSearch = root.querySelector<HTMLInputElement>('.ash-chat-models-catalog [role="combobox"]')!;
	assert.equal(scopedSearch.value, '@provider:openai @capability:vision');
	assert.equal(search.value, '');
	assert.equal(ownerDocument.activeElement, scopedSearch);
	await preferences.openSettings({ section: 'models', sectionQuery: '', focusSearch: false });
	assert.equal(ownerDocument.activeElement, scopedSearch);
	await assert.rejects(preferences.openSettings({ section: 'general', sectionQuery: 'unsupported' }), /does not provide its own search/);


	using language = editorServices.get(ILanguageService).registerLanguage({ id: 'settings-test-language' });
	await commands.executeCommand('workbench.action.openSettings', {
		query: '@lang:settings-test-language @id:editor.fontSize',
	});
	const languageSize = root.querySelector<HTMLInputElement>('[data-configuration-key="editor.fontSize"]');
	assert.ok(languageSize, 'language search shows language-overridable settings');
	languageSize.value = '29';
	languageSize.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	assert.equal(configuration.inspect<number>('editor.fontSize', { overrideIdentifier: 'settings-test-language' }).userLocal?.override, 29);
	assert.equal(configuration.inspect('editor.fontSize').userLocalValue, undefined, 'language editing leaves the base user setting absent');
	await preferences.openSettings({ query: '@lang:settings-test-language @modified @id:editor.fontSize' });
	assert.ok(root.querySelector('[data-settings-item-id="editor.fontSize"]'));
	await preferences.openSettings({ query: '@lang:settings-test-language @id:window.title' });
	assert.equal(root.querySelector('[data-settings-item-id="window.title"]'), null, 'non-overridable settings are excluded');
	await preferences.openSettings({ query: '@lang:unregistered @id:editor.fontSize' });
	assert.equal(root.querySelector('[data-settings-item-id="editor.fontSize"]'), null);
	await preferences.openSettings({ query: '@modified @id:editor.fontSize' });
	assert.equal(root.querySelector('[data-settings-item-id="editor.fontSize"]'), null, 'base modified filter excludes a language-only override');
	await preferences.openSettings({ query: '@id:editor.fontSize' });
	assert.notEqual(root.querySelector<HTMLInputElement>('[data-configuration-key="editor.fontSize"]')?.value, '29');

	root.querySelector<HTMLButtonElement>('.ash-modal-editor-close button')?.click();
	await nextTurn();
	assert.equal(host.hidden, true);
	assert.equal(ownerDocument.activeElement, trigger);
	await configuration.updateValue(CodeEditorConfiguration.fontFamily, 'After close');
	assert.equal(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`), null);
	const firstGroup = editor.activeGroup;
	await commands.executeCommand('workbench.action.openSettings', {
		groupId: firstGroup.id,
		query: '@id:editor.fontFamily',
	});
	const firstSearch = firstGroup.domNode.querySelector<HTMLInputElement>('.ash-settings-search input')!;
	const firstPane = firstGroup.activePane!;
	assert.equal(firstPane.group, firstGroup);
	assert.equal(firstSearch.value, '@id:editor.fontFamily');
	await commands.executeCommand('workbench.action.openSettings', {
		openToSide: true,
		groupId: firstGroup.id,
		query: '@id:editor.fontSize',
	});
	const secondGroup = editor.activeGroup;
	const secondSearch = secondGroup.domNode.querySelector<HTMLInputElement>('.ash-settings-search input')!;
	assert.notEqual(secondGroup, firstGroup, 'side opening takes precedence over an explicit group');
	assert.equal(firstGroup.activePane, firstPane);
	assert.notEqual(secondGroup.activePane, firstPane);
	assert.equal(firstSearch.value, '@id:editor.fontFamily');
	assert.equal(secondSearch.value, '@id:editor.fontSize');
	assert.equal(ownerDocument.activeElement, secondSearch);
	await commands.executeCommand('workbench.action.openSettings', {
		groupId: firstGroup.id,
		query: '@modified',
		preserveFocus: true,
	});
	assert.equal(firstSearch.value, '@modified');
	assert.equal(secondSearch.value, '@id:editor.fontSize');
	assert.equal(editor.activeGroup, secondGroup);
	assert.equal(ownerDocument.activeElement, secondSearch);
	await commands.executeCommand('workbench.action.openSettings', {
		groupId: firstGroup.id,
		query: '@id:editor.fontSize',
	});
	assert.equal(ownerDocument.activeElement, firstSearch);
	assert.equal(firstGroup.activePane, firstPane, 'reopening a group reuses its pane');
	await secondGroup.closeEditor(secondGroup.activeInput!);
	await nextTurn();
	assert.equal(firstGroup.activePane, firstPane, 'closing the other pane does not retire this pane');
	await commands.executeCommand('workbench.action.openSettings', {
		openToSide: true,
		query: '@id:editor.fontFamily',
	});
	assert.notEqual(editor.activeGroup, firstGroup);
	assert.equal(firstSearch.value, '@id:editor.fontSize');
	assert.equal(editor.activeGroup.domNode.querySelector<HTMLInputElement>('.ash-settings-search input')?.value, '@id:editor.fontFamily');
});

function findSettingCategory(layout: ReturnType<typeof createSettingsLayout>, settingId: string): string | undefined {
	return layout.find(category => category.groups.some(group => group.settings.some(setting => setting.id === settingId)))?.id;
}

async function nextTurn(): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, 0));
}

test('Local model controls share translated snapshots and keep preparation running when hidden', async () => {
	using resources = new DisposableStore();
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	resources.add(toDisposable(resetNlsResolver));
	const configuration = resources.add(new WorkspaceService());
	await configuration.updateValue(DictationConfiguration.model, 'imported-model');
	const services = resources.add(new InstantiationService());
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, {
		onDidChangeHooks: Event.None,
		list: async () => {
			throw new Error('Unexpected Hook read in Skill fixture');
		},
	});
	services.registerInstance(ConfigurationServiceId, configuration);
	const changed = resources.add(new Emitter<void>());
	let modelStatus: IDictationModelStatus | undefined;
	const progress = (status: IDictationModelStatus): void => {
		modelStatus = status;
		changed.fire();
	};
	let finish!: (state: ModelState.Cancelled) => void;
	let cancellations = 0;
	const imported: unknown[] = [];
	services.registerInstance(ILocalTranscriptionModelService, {
		isSupported: true,
		getModel: async (model: string) => ({ model, available: false, sizeBytes: 0, status: modelStatus }),
		listModels: async () => [],
		onDidChangeModels: changed.event,
		cancelModel: async () => {
			cancellations++;
			progress({ state: DictationModelState.Cancelled });
			finish(DictationModelState.Cancelled);
		},
		importPackage: (options: unknown, onProgress: typeof progress) => {
			imported.push(options);
			progress({ state: DictationModelState.Checking });
			return {
				completed: new Promise<ModelState.Cancelled>(resolve => {
					finish = resolve;
				}),
				cancel: async () => {
					cancellations++;
					progress({ state: DictationModelState.Cancelled });
					finish(DictationModelState.Cancelled);
				},
				dispose() { },
			};
		},
	} as unknown as LocalTranscriptionService);
	const root = h(browserEnvironment.window.document, 'div');
	const controls = resources.add(services.createInstance(LocalTranscriptionModelControls, root));
	controls.setVisible(true);
	await nextTurn();
	const status = root.querySelector<HTMLElement>('[role="status"]')!;
	assert.equal(status.textContent, '模型包尚未安装：imported-model');
	const source = root.querySelector<HTMLInputElement>('input')!;
	assert.equal(source.getAttribute('aria-label'), '已准备好的 Paraformer 模型目录');
	assert.equal(root.querySelector('label')?.htmlFor, source.id);
	source.value = 'C:\\prepared-model';
	source.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
	const importButton = buttons.find(button => button.textContent === '导入模型')!;
	assert.equal(importButton.disabled, false);
	importButton.click();
	assert.deepEqual(imported, [{ model: 'imported-model', sourcePath: 'C:\\prepared-model' }]);
	assert.equal(importButton.disabled, true);
	progress({ state: DictationModelState.Downloading, file: 'encoder.onnx', downloadedBytes: 2 * 1024 * 1024 });
	await nextTurn();
	assert.equal(status.textContent, '正在下载 encoder.onnx：2.0 MiB');
	assert.equal(status.getAttribute('aria-atomic'), 'true');
	controls.setVisible(false);
	await nextTurn();
	assert.equal(cancellations, 0);
	controls.setVisible(true);
	await nextTurn();
	assert.equal(root.querySelector<HTMLProgressElement>('progress')?.hasAttribute('value'), false);
	buttons.find(button => button.textContent === '取消')!.click();
	await nextTurn();
	assert.equal(cancellations, 1);
	assert.equal(importButton.disabled, false);
	assert.equal(buttons.find(button => button.textContent === '取消')?.classList.contains('hidden'), true);
});

test('Models Settings collapses by provider and saves keys and custom models on blur', async () => {
	using disposables = new DisposableStore();
	const document = browserEnvironment.window.document;
	document.body.replaceChildren();
	const root = h(document, 'div');
	document.body.append(root);
	const saved: import('../../../../../platform/agentHost/common/agentModels.js').CustomModelProvider[] = [];
	const keys: string[] = [];
	let removed = 0;
	let failed = false;
	let rejectKey = false;
	const model = { provider: 'openai', model: 'newest' };
	const chat = {
		onDidChangeModels: Event.None,
		listModelCatalog: async () => [
			{ model, displayName: 'Newest OpenAI' },
			{ model: { provider: 'openai', model: 'older' }, displayName: 'Older OpenAI' },
			{ model: { provider: 'anthropic', model: 'opus' }, displayName: 'Opus' },
		],
		listModelProviders: async () =>
			['openai', 'openai-compatible'].map(connection => ({
				connection,
				provider: connection,
				displayName: connection,
				apiKeyPolicy: 'required',
				apiKeyConfigured: true,
			})),
		setModelPreferences: async () => { },
		listCustomModelProviders: async () => [],
		isModelVisible: () => true,
		removeCustomModelProvider: async () => { },
		saveCustomModelProvider: async (provider: (typeof saved)[number]) => {
			saved.push(provider);
		},
		setModelProviderApiKey: async (_id: string, key: string) => {
			if (rejectKey) throw new Error('Key write rejected');
			keys.push(key);
		},
		removeModelProviderApiKey: async () => {
			removed++;
		},
		refreshModels: async () => [],
		testProviderModel: async () => (failed ? { type: 'failed', message: 'Endpoint rejected this model' } : { type: 'passed' }),
	} as unknown as IChatService;
	const configuration = disposables.add(new WorkspaceService());
	const services = disposables.add(new InstantiationService());
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IAppServerHookApi, {
		onDidChangeHooks: Event.None,
		list: async () => {
			throw new Error('Unexpected Hook read in Skill fixture');
		},
	});
	services.registerInstance(ChatServiceId, chat);
	services.registerInstance(INotificationService, disposables.add(new TestNotificationService()));
	services.registerInstance(ILanguageModelsService, chat as unknown as ILanguageModelsService);
	services.registerInstance(IDialogService, {} as IDialogService);
	services.registerInstance(ISecretStorageStatusService, {
		readState: async () => ({ status: 'available' }),
		authorizeAccess: async () => ({ status: 'available' }),
		setStorageMode: async mode => ({ status: 'available', mode }),
	});
	services.registerInstance(IAgentExecutionSettingsService, {
		onDidChange: Event.None,
		read: async () => ({
			revision: 1,
			settings: { approvalMode: 'manual', commandFileAccess: 'directoryWrite', commandNetworkAccess: 'denied' },
		}),
		configure: async () => { },
	});
	services.registerInstance(IContextViewService, disposables.add(new BrowserContextViewService(root)));
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(IAccessibleViewService, {
		show: () => true,
		getOpenAriaHint: () => undefined,
		disableHint: async () => { },
		showAccessibleViewHelp: () => { },
		dispose() { },
		[Symbol.dispose]() { },
	});
	services.registerSingleton(ICommandService, () => new CommandService(services));
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerInstance(IContextMenuService, { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => { }, hideContextMenu: () => { } });
	const content = disposables.add(services.createInstance(ModelSettingsRenderer, root));
	const modelTree = disposables.add(new SettingsTreeModel<SettingsSectionReference>());
	disposables.add(
		new SettingsTree(root, {
			model: modelTree,
			rootClassName: 'ash-models-settings',
			groupClassName: 'ash-settings-content-group',
			groupDescriptionClassName: 'ash-settings-group-description',
			itemsClassName: 'ash-settings-list',
			renderGroupHeader: header => content.renderItem(header),
			renderItem: item => content.renderItem(item.value),
		}),
	);
	disposables.add(
		content.onDidChange(() =>
			modelTree.setChildren([
				{
					element: { kind: 'group', id: 'models', title: 'Models', description: '' },
					children: content.getNodes(),
				},
			]),
		),
	);
	content.setVisible(true);
	await nextTurn();
	assert.deepEqual(
		[...root.querySelectorAll('.ash-models-settings-model-copy > span')].map(row => row.textContent),
		['Newest OpenAI', 'Opus'],
	);
	const expand = root.querySelector<HTMLButtonElement>('.ash-models-settings-expand button')!;
	expand.click();
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 3);
	assert.equal(expand.getAttribute('aria-expanded'), 'true');
	assert.equal(root.querySelectorAll('.ash-chat-models-provider').length, 2);
	assert.equal(root.querySelector<HTMLDetailsElement>('.ash-chat-models-filters')!.hidden, false);
	[...root.querySelectorAll<HTMLButtonElement>('.ash-chat-models-catalog > button')].find(button => button.textContent === 'Collapse All')!.click();
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 0);
	expand.click();
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 2);
	assert.equal(root.querySelectorAll('.ash-chat-models-provider').length, 0);
	assert.equal(
		content
			.getNodes(new SettingsSearchQuery('Older'))
			.flatMap(node => node.children ?? [])
			.some(node => node.element.kind === 'item' && node.element.description.includes('Older OpenAI')),
		true,
	);
	assert.deepEqual(
		[...root.querySelectorAll('.ash-models-settings-model-copy > span')].map(row => row.textContent),
		['Older OpenAI'],
	);
	content.getNodes();
	const search = root.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
	const searchModels = (value: string): void => {
		search.value = value;
		search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	};
	search.focus();
	searchModels('OPENAI/OLDER');
	assert.deepEqual(
		[...root.querySelectorAll('.ash-models-settings-model-copy > span')].map(row => row.textContent),
		['Older OpenAI'],
	);
	assert.equal(document.activeElement, search);
	assert.equal(root.querySelectorAll('.ash-models-settings-api-row').length, 1);
	searchModels('missing model');
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 0);
	assert.match(root.textContent ?? '', /No models found/);
	assert.equal(document.activeElement, search);
	searchModels('');
	assert.deepEqual(
		[...root.querySelectorAll('.ash-models-settings-model-copy > span')].map(row => row.textContent),
		['Newest OpenAI', 'Opus'],
	);
	assert.equal(root.querySelectorAll('.ash-models-settings-api-row').length, 1);
	const input = root.querySelector<HTMLInputElement>('.ash-models-settings-api-row input')!;
	const edit = (field: HTMLInputElement, value: string): void => {
		field.value = value;
		field.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
		field.dispatchEvent(new browserEnvironment.window.Event('blur'));
	};
	input.dispatchEvent(new browserEnvironment.window.Event('blur'));
	await nextTurn();
	assert.deepEqual(keys, []);
	assert.equal(removed, 0, 'An untouched masked key must not be removed');
	edit(input, 'new-test-key');
	await nextTurn();
	assert.deepEqual(keys, ['new-test-key']);
	assert.equal(input.value, '••••••••');
	edit(input, '');
	await nextTurn();
	assert.equal(removed, 1);
	rejectKey = true;
	edit(input, 'retry-test-key');
	await nextTurn();
	assert.equal(input.getAttribute('aria-invalid'), 'true');
	assert.equal(input.value, 'retry-test-key');
	rejectKey = false;
	input.dispatchEvent(new browserEnvironment.window.Event('blur'));
	await nextTurn();
	assert.equal(input.value, '••••••••');
	assert.equal(input.hasAttribute('aria-invalid'), false);
	root.querySelector<HTMLButtonElement>('.ash-models-settings-provider-title button')!.click();
	const card = root.querySelector<HTMLElement>('.ash-chat-models-widget')!;
	assert.equal(document.activeElement, card.querySelector('input'));
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Provider name"]')!, 'Gateway');
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!, 'https://example.test/v1');
	await nextTurn();
	const button = (label: string): HTMLButtonElement => [...card.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === label)!;
	button('Add model').click();
	const first = card.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')!;
	edit(first, 'first-private-model');
	card.querySelector<HTMLInputElement>('input[role="switch"][aria-label="1M context"]')!.click();
	button('Save model').click();
	await nextTurn();
	button('Add model').click();
	edit(first, 'second-private-model');
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Context window (tokens)"]')!, '128000');
	button('Save model').click();
	await nextTurn();
	assert.deepEqual(saved.at(-1)?.models, [
		{ id: 'first-private-model', contextWindow: 1_000_000 },
		{ id: 'second-private-model', contextWindow: 128_000 },
	]);
	const testButton = button('Test models');
	testButton.click();
	await nextTurn();
	assert.equal(card.querySelector('.ash-chat-models-test-status')?.classList.contains('passed'), true);
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!, 'https://another.test/v1');
	await nextTurn();
	assert.equal(card.querySelector('.ash-chat-models-test-status')?.classList.contains('passed'), false);
	failed = true;
	testButton.click();
	await nextTurn();
	assert.match(card.textContent ?? '', /Endpoint rejected this model/);
	button('Add model').click();
	first.focus();
	const help = AccessibleViewRegistry.getImplementations()
		.find(provider => provider.name.startsWith('models-settings-'))
		?.getProvider(services);
	assert.match(help?.provideContent() ?? '', /clear the field to remove a key/);
	help?.dispose();
});

test('Custom provider fields and test states use the Chinese catalog', () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		assert.equal(localize('models.catalog.search', 'Search models'), '搜索模型');
		assert.equal(localize('models.provider.name', 'Provider name'), '供应商名称');
		assert.equal(localize('models.provider.context', '1M context'), '1M 上下文');
		assert.equal(localize('models.provider.passed', 'Model test passed'), '模型测试通过');
		assert.equal(localize('models.discovery.unsupported', 'This endpoint does not provide a model list. Add model IDs manually.'), '此端点不提供模型列表，请手动添加模型 ID。');
		assert.equal(localize('models.provider.contextWindow', 'Context window (tokens)'), '上下文长度（tokens）');
	} finally {
		resetNlsResolver();
	}
});

function createSettingWidget(
	resources: import('../../../../../base/common/lifecycle.js').DisposableStore,
	container: HTMLElement,
	setting: ISetting,
	options: import('../../browser/settingsWidgets.js').SettingWidgetOptions & {
		clipboardService: IClipboardService;
		configurationService: import('../../../../../platform/configuration/common/configuration.js').IConfigurationService;
		contextMenuProvider: import('../../../../../base/browser/contextmenu.js').IContextMenuProvider;
		contextViewProvider: import('../../../../../platform/contextview/browser/contextView.js').IContextViewService;
	},
): import('../../browser/settingsWidgets.js').SettingWidget {
	const services = resources.add(new InstantiationService());
	services.registerInstance(ClipboardServiceId, options.clipboardService);
	services.registerInstance(ConfigurationServiceId, options.configurationService);
	services.registerInstance(IContextViewService, options.contextViewProvider);
	services.registerInstance(IContextMenuService, {
		contextMenuStyle: 'custom' as const,
		...options.contextMenuProvider,
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		hideContextMenu() { },
	});
	services.registerInstance(IHoverService, resources.add(new HoverService(options.configurationService, options.contextViewProvider, services.get(IContextMenuService))));
	return instantiateSettingWidget(container, setting, { onStatus: options.onStatus, onOpenSettings: options.onOpenSettings }, services);
}

test('Settings widgets require their scoped clipboard registration and clean up when creation fails', async () => {
	using resources = new DisposableStore();
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	const services = resources.add(new InstantiationService());
	const configuration = resources.add(new WorkspaceService());
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(root)));
	services.registerInstance(IContextMenuService, {
		contextMenuStyle: 'custom' as const,
		showContextMenu() { },
		hideContextMenu() { },
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
	});
	assert.throws(() => instantiateSettingWidget(root, new DefaultSettings().get('editor.lineNumbers'), { onStatus() { } }, services), /clipboardService/);
	assert.equal(root.querySelector('.ash-configuration-setting'), null);
});

test('Models Settings keeps checks silent and requires explicit authorization and confirmed file migration', async () => {
	using resources = new DisposableStore();
	const root = h(browserEnvironment.window.document, 'div');
	browserEnvironment.window.document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	const services = resources.add(new InstantiationService());
	services.registerInstance(ConfigurationServiceId, resources.add(new WorkspaceService()));
	services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
	services.registerInstance(IAccessibleViewService, {
		show: () => true,
		getOpenAriaHint: () => undefined,
		disableHint: async () => { },
		showAccessibleViewHelp: () => { },
		dispose() { },
		[Symbol.dispose]() { },
	});
	services.registerInstance(ILanguageModelsService, {
		onDidChangeModels: Event.None,
		listModelCatalog: async () => [],
		listModelProviders: async () => [],
		listCustomModelProviders: async () => [],
	} as unknown as ILanguageModelsService);
	let state: { status: 'accessDenied' | 'available'; mode: 'encrypted' | 'file'; } = {
		status: 'accessDenied',
		mode: 'encrypted',
	};
	const mutations: string[] = [];
	services.registerInstance(ISecretStorageStatusService, {
		readState: async () => state,
		authorizeAccess: async () => {
			mutations.push('authorize');
			state = { status: 'available', mode: 'encrypted' };
			return state;
		},
		setStorageMode: async mode => {
			mutations.push(mode);
			state = { status: 'available', mode };
			return state;
		},
	});
	let confirmed = false;
	let confirmations = 0;
	services.registerInstance(IDialogService, {
		confirm: async () => {
			confirmations++;
			return { confirmed };
		},
	} as unknown as IDialogService);
	services.registerSingleton(ICommandService, () => new CommandService(services));
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerInstance(IContextMenuService, { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => { }, hideContextMenu: () => { } });
	const content = resources.add(services.createInstance(ModelSettingsRenderer, root));
	content.setVisible(true);
	await nextTurn();
	const node = content
		.getNodes()
		.flatMap(group => group.children ?? [])
		.find(node => node.element.id === 'models.credentials.storage')!;
	assert.equal(node.element.kind, 'item');
	if (node.element.kind !== 'item') throw new Error('Expected credential storage item');
	root.append(content.renderItem(node.element.value));
	const button = (label: string): HTMLButtonElement => [...root.querySelectorAll('button')].find(button => button.textContent === label)!;
	assert.deepEqual(mutations, []);
	button('Retry credential storage').click();
	await nextTurn();
	assert.deepEqual(mutations, []);
	button('Authorize system keyring').click();
	await nextTurn();
	assert.deepEqual(mutations, ['authorize']);
	button('Use file storage').click();
	await nextTurn();
	assert.equal(confirmations, 1);
	assert.deepEqual(mutations, ['authorize']);
	confirmed = true;
	button('Use file storage').click();
	await nextTurn();
	assert.deepEqual(mutations, ['authorize', 'file']);
	assert.match(root.textContent!, /without encryption/);
	button('Use encrypted storage').click();
	await nextTurn();
	assert.deepEqual(mutations, ['authorize', 'file', 'encrypted']);
	assert.equal(confirmations, 2);
});
