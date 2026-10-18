import { createTestLanguageModelToolsService } from '../../../src/ash/workbench/contrib/chat/test/common/tools/testLanguageModelToolsService.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { ConfigurationRegistry } from '../../../src/ash/platform/configuration/common/configurationRegistry.js';
import { parseExtensionManifest } from '../../../src/ash/workbench/services/extensions/common/extensionManifest.js';
import { DefaultSettings } from '../../../src/ash/workbench/services/preferences/common/settingsModels.js';
import { createSettingsLayout, settingsRootNodes } from '../../../src/ash/workbench/contrib/preferences/browser/settingsLayout.js';
import { SettingsRenderer } from '../../../src/ash/workbench/contrib/preferences/browser/settingsRenderers.js';
import { SettingsTreeModel, type SettingsSectionReference } from '../../../src/ash/workbench/contrib/preferences/browser/settingsTreeModels.js';
import { SettingsTree } from '../../../src/ash/workbench/contrib/preferences/browser/settingsTree.js';
import { TOCTree, TOCTreeModel } from '../../../src/ash/workbench/contrib/preferences/browser/tocTree.js';
import type { ISetting } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import '../../../src/ash/workbench/contrib/preferences/browser/media/settingsEditor.css';
import { setARIAContainer } from '../../../src/ash/base/browser/ui/aria/aria.js';
import { localize } from '../../../src/ash/nls.js';
import { ICustomizationMarketplaceService } from '../../../src/ash/platform/customizationMarketplace/common/customizationMarketplaceService.js';
import { CustomizationMarketplaceWorkbenchService } from '../../../src/ash/workbench/contrib/chat/browser/aiCustomization/customizationMarketplaceWorkbenchService.js';
import '../../../src/ash/workbench/contrib/chat/browser/aiCustomization/customizationMarketplace.contribution.js';
import chineseSettingsMessages from '../../../extensions/language-pack-zh-cn/translations/settings.json' with { type: 'json' };
import '../../../src/ash/base/browser/ui/styles.css';
import { IGlobalExtensionEnablementService } from '../../../src/ash/platform/extensionManagement/common/extensionManagement.js';
import { GlobalExtensionEnablementService } from '../../../src/ash/platform/extensionManagement/common/extensionEnablementService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { ExtensionsEditor } from '../../../src/ash/workbench/contrib/extensions/browser/extensionsEditor.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import { ExtensionsInput, ExtensionsCapabilityInput } from '../../../src/ash/workbench/contrib/extensions/common/extensionsInput.js';
import { IExtensionApi, type ExtensionResourceRequest } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { createBuiltinExtensionFixture } from './builtinExtensionsFixture.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../src/ash/platform/markdown/browser/markdownRenderer.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { bindTestColorTheme } from './themeFixture.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import '../../../src/ash/base/browser/ui/inputbox/inputbox.css';
import '../../../src/ash/base/browser/ui/list/list.css';
import { IPromptsService } from '../../../src/ash/workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../src/ash/workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import '../../../src/ash/base/browser/ui/dialog/dialog.css';
import '../../../src/ash/base/browser/ui/button/button.css';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { IConfigurationService, type IConfigurationChangeEvent } from '../../../src/ash/platform/configuration/common/configuration.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { IDialogsModel, IWorkbenchDialogHandler } from '../../../src/ash/workbench/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { ILanguageServerService } from '../../../src/ash/platform/language/common/languageServerService.js';
import type { IExtensionManagementApi } from '../../../src/ash/platform/extensionManagement/common/extensionManagementApi.js';
import { IExtensionManagementService, OPEN_EXTENSIONS_COMMAND_ID, type ExtensionsInstalledPackage, type ExtensionsOpenOptions } from '../../../src/ash/platform/extensionManagement/common/extensionManagementService.js';
import { IAppServerHookApi, IAppServerSkillApi } from '../../../src/ash/platform/agentHost/common/appServerApi.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { ILocalizationService } from '../../../src/ash/workbench/services/localization/common/localizationService.js';
import { IAppServerRemoteAgentService } from '../../../src/ash/workbench/services/remote/common/appServerRemoteAgentService.js';
import { createSettingsEditorInput } from '../../../src/ash/workbench/services/preferences/common/settingsEditorInput.js';
import { CLOSE_EDITOR_COMMAND_ID } from '../../../src/ash/workbench/browser/parts/editor/editorCommands.js';
import { AppServerExtensionManagementService } from '../../../src/ash/workbench/services/extensionManagement/browser/appServerExtensionManagementService.js';
import { ViewsRegistry } from '../../../src/ash/workbench/common/views.js';
import { ExtensionsViewPane } from '../../../src/ash/workbench/contrib/extensions/browser/extensionsViewlet.js';
import '../../../src/ash/workbench/contrib/extensions/browser/extensions.contribution.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { IPluginManagementService } from '../../../src/ash/platform/extensionManagement/common/pluginManagementService.js';
import type { IPluginManagementApi } from '../../../src/ash/platform/extensionManagement/common/pluginManagementApi.js';
import type { PluginPackageDto, PluginPackageCommandParams } from '../../../.build/protocol/typescript/index.js';
import { AppServerPluginManagementService } from '../../../src/ash/workbench/services/extensionManagement/browser/appServerPluginManagementService.js';
import { ILocalGitService } from '../../../src/ash/platform/git/common/localGitService.js';
import { canceled } from '../../../src/ash/base/common/errors.js';
import { ILogService, NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../src/ash/platform/quickinput/test/browser/testQuickInputService.js';
import { SkillsViewPane, McpServersViewPane, RecommendedExtensionsView } from '../../../src/ash/workbench/contrib/extensions/browser/extensionsViews.js';
import { IFileService, type IFileChangeEvent } from '../../../src/ash/platform/files/common/files.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { MemoryFileService } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { TestWorkspaceService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { IUriIdentityService } from '../../../src/ash/platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../src/ash/platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspaceExtensionsConfigService, WorkspaceExtensionsConfigService } from '../../../src/ash/workbench/services/extensionRecommendations/common/workspaceExtensionsConfig.js';
import { IExtensionRecommendationsService } from '../../../src/ash/workbench/services/extensionRecommendations/common/extensionRecommendations.js';
import { ExtensionRecommendationsService } from '../../../src/ash/workbench/contrib/extensions/browser/extensionRecommendationsService.js';
import { ILanguageModelToolsService } from '../../../src/ash/workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { IMcpServerStatusService, type McpServerStatus } from '../../../src/ash/platform/mcp/common/mcpServerStatusService.js';
import { createAppServerMcpServerStatusApi } from '../../../src/ash/platform/mcp/browser/mcpServerStatusApi.js';
import { AppServerMcpServerManagementService } from '../../../src/ash/platform/mcp/browser/appServerMcpServerManagementService.js';
import { IMcpServerManagementService, type McpServerConfiguration } from '../../../src/ash/platform/mcp/common/mcpServerManagementService.js';
import { AppServerRemoteError } from '../../../src/ash/platform/agentHost/common/appServerError.js';
import type { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { PaneView } from '../../../src/ash/base/browser/ui/splitview/paneview.js';
import { registerSkillActions } from '../../../src/ash/workbench/contrib/chat/browser/promptSyntax/skillActions.js';
import { LanguageServerSettingsRenderer } from '../../../src/ash/workbench/contrib/preferences/browser/languageServerSettingsRenderer.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { IAgentExecutionSettingsService, type ExecutionSettings } from '../../../src/ash/platform/agentHost/common/agentExecutionSettingsService.js';
import { SandboxSettingsModel } from '../../../src/ash/workbench/contrib/preferences/browser/sandboxSettingsModel.js';
import { SettingsSectionRenderer } from '../../../src/ash/workbench/contrib/preferences/browser/settingsSectionRenderer.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { AgentCapabilitiesSettings } from '../../../src/ash/workbench/contrib/preferences/browser/agentCapabilitiesSettings.js';
import { SettingsNavigation } from '../../../src/ash/workbench/contrib/preferences/browser/settingsLayout.js';
import type { IWorkspaceTrustApi } from '../../../src/ash/platform/workspace/common/workspaceTrust.js';
import chineseMessages from '../../../extensions/language-pack-zh-cn/translations/extensions.json' with { type: 'json' };
import chineseWorkbenchMessages from '../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };

if (new URLSearchParams(window.location.search).get('locale') === 'zh-CN') {
	const bundles: Record<string, Record<string, string>> = {};
	for (const resource of [chineseWorkbenchMessages, chineseMessages, chineseSettingsMessages]) {
		for (const [bundle, messages] of Object.entries(resource)) { bundles[bundle] = { ...bundles[bundle], ...messages }; }
	}
	setNlsMessages('zh-CN', bundles);
}

const disposables = new DisposableStore();
const services = disposables.add(new InstantiationService());
services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } });
let activeSessionId: string | undefined;
services.registerInstance(IChatSessionNavigationService, { getActiveConversation: () => activeSessionId ? { sessionId: activeSessionId, threadId: 'fixture-thread' } : undefined } as IChatSessionNavigationService);
const changed = disposables.add(new Emitter<void>());
const requests: unknown[] = [];
let offline = false;
let holdSearch = false;
let rejectSearch: ((error: Error) => void) | undefined;
let heldOpen: Promise<void> | undefined;
const configurationChanged = disposables.add(new Emitter<IConfigurationChangeEvent>());
let discoveryEnabled = true;
let installed: ExtensionsInstalledPackage[] = [];
let generation = 1;
const summary = { id: 'example/web', version: '1.0.0', packageType: 'plugin', displayName: 'Web tools', description: 'TypeScript server and review skill' };
const reference = { id: summary.id, version: summary.version, digest: 'sha256:' + 'a'.repeat(64) };
const capabilities = [
	{ kind: 'executable' as const, id: 'typescript-language-server', contractVersion: '1', permissions: ['process'], authenticationProvider: null },
	{ kind: 'skill' as const, id: 'review', contractVersion: '1', permissions: [], authenticationProvider: null },
];
const packageDetails = { package: reference, packageType: summary.packageType, displayName: summary.displayName, description: summary.description, license: 'MIT', source: 'thirdParty' as const, upstream: null, capabilities };
const mcpSummary = { id: 'catalog/docs@ash', version: '1.0.0', packageType: 'mcp', displayName: 'Docs MCP', description: 'Documentation tools' };
const mcpDetails = { ...packageDetails, ...mcpSummary, package: { ...reference, id: mcpSummary.id }, capabilities: [{ kind: 'mcp' as const, id: 'docs-server', contractVersion: '1', permissions: ['network'], authenticationProvider: null }] };
const discoveryFixture = new URLSearchParams(location.search).has('marketplace');
const partialDiscoveryFailure = new URLSearchParams(location.search).has('partialDiscoveryFailure');
const extensionSummary = { ...summary, id: 'publisher.sample@open-vsx', packageType: 'editorExtension', displayName: 'Sample editor extension' };
const extensionReference = { ...reference, id: extensionSummary.id };
const extensionCapabilities = [{ kind: 'editorExtension' as const, id: 'publisher.sample', contractVersion: '1', permissions: [], authenticationProvider: null }];
const extensionDetails = { ...packageDetails, package: extensionReference, ...extensionSummary, capabilities: extensionCapabilities };
const galleryOnly = new URLSearchParams(location.search).has('gallery');
const rustBuiltIn = new URLSearchParams(location.search).has('rustBuiltIn');
const rustLanguagePackManifest = { publisher: 'ash', name: 'language-pack-zh-cn', version: '1.0.0', displayName: '中文语言包（Rust 目录）', description: 'Rust package snapshot', contributes: { localizations: [{ languageId: 'zh-CN' }] } };
const extensionManifest = { publisher: 'Fixture publisher', name: 'sample', icon: 'icon.svg', categories: ['Programming Languages'], homepage: 'https://example.invalid/tools' };
let heldReadme: ((text: string) => void) | undefined;
let holdReadme = false;
const fixtureReadme = '# Sample editor extension\n\nTools for working with your project.\n\n## Features\n\n- Inspect and review workspace files\n- Keep your tools in the editor\n\n## Getting started\n\nInstall the extension and review its requested permissions.\n\n[Homepage](https://example.invalid/tools)\n' + (new URLSearchParams(location.search).has('unsafeReadme') ? '\n[Unsafe](command:fixture.unsafe)\n\n<script>window.fixtureUnsafe = true</script>\n' : '');
const readPackageResource = async (request: ExtensionResourceRequest): Promise<Uint8Array> => {
	requests.push(['extensionResource', request]);
	if (rustBuiltIn && request.extensionId === 'ash.language-pack-zh-cn') {
		if (request.path === 'package.json') { return new TextEncoder().encode(JSON.stringify(rustLanguagePackManifest)); }
		throw new Error('Language pack has no README or executable resources');
	}
	if (request.path === 'package.json') { return new TextEncoder().encode(JSON.stringify(extensionManifest)); }
	if (request.path === 'README.md') { if (holdReadme) { holdReadme = false; return new TextEncoder().encode(await new Promise<string>(resolve => { heldReadme = resolve; })); } return new TextEncoder().encode(fixtureReadme); }
	if (request.path === 'icon.svg') { return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="8" fill="#3355aa"/><path d="m32 40 32-16 32 16v48L64 104 32 88Z" fill="none" stroke="white" stroke-width="8"/></svg>'); }
	throw new Error('Package resource is missing');
};
const builtinPackages = createBuiltinExtensionFixture();
services.registerInstance(IExtensionApi, {
	list: async () => ({
		generation: 1, diagnostics: [], extensions: [
			...(await builtinPackages.list('cached')).extensions.filter(value => !rustBuiltIn || value.id !== 'ash.language-pack-zh-cn'),
			...galleryOnly ? [] : [{ id: 'publisher.sample', name: 'sample', publisher: 'Fixture publisher', version: '1.0.0', displayName: extensionSummary.displayName, sourceKind: 'registry' as const, manifestSha256: reference.digest, packageSha256: reference.digest, manifestJson: JSON.stringify(extensionManifest) }],
			...rustBuiltIn ? [{ id: 'ash.language-pack-zh-cn', ...rustLanguagePackManifest, sourceKind: 'builtIn' as const, manifestSha256: reference.digest, packageSha256: reference.digest, manifestJson: JSON.stringify(rustLanguagePackManifest) }] : [],
		]
	}),
	resources: new ExtensionResourceLoaderService(request => request.extensionId === 'publisher.sample' || rustBuiltIn && request.extensionId === 'ash.language-pack-zh-cn' ? readPackageResource(request) : builtinPackages.resources.readExtensionResourceBytes(request), galleryOnly ? {
		template: async () => 'https://registry.invalid/api/{publisher}/{name}/{version}/file/{path}',
		read: async request => { requests.push(['galleryResource', request]); return readPackageResource({ generation: 1, extensionId: `${request.publisher}.${request.name}`, path: request.path }); },
	} : undefined),
});
services.registerInstance(IOpenerService, { open: async (href, options) => { requests.push(['openLink', String(href), options]); return true; } } as IOpenerService);
services.registerSingleton(IMarkdownRendererService, () => services.createInstance(MarkdownRendererService));
let editorPolicyRevision = 1;
let editorEntrypoint: string | null = 'dist/extension.js';
const editorPolicies = new Map<string, { enabled: boolean; granted: boolean; }>();
function editorPolicySnapshot() {
	return {
		revision: editorPolicyRevision, extensions: installed.filter(entry => entry.capabilities.some(capability => capability.kind === 'editorExtension')).map(entry => ({
			installationId: entry.installationId, package: entry.package, entrypoint: editorEntrypoint,
			...(editorPolicies.get(entry.installationId) ?? { enabled: true, granted: false }),
		}))
	};
}
let sourceRevision = 0;
let sources = [{ id: 'ash', kind: 'ash' as const, enabled: true, productOwned: true }, { id: 'open-vsx', kind: 'openVsx' as const, enabled: true, productOwned: true }];
if (partialDiscoveryFailure) { sources.push({ id: 'offline-source', kind: 'ash', enabled: true, productOwned: false }); }
if (new URLSearchParams(location.search).has('pagedDiscovery')) { sources.push({ id: 'other', kind: 'ash', enabled: true, productOwned: false }); }
let builtInProviderEnabled = true;
let builtInProviderRunning = true;
function builtInProviders() {
	return { revision: editorPolicyRevision, providers: [{ id: 'ash.github-authentication', enabled: builtInProviderEnabled, running: builtInProviderRunning }] };
}
const api: IExtensionManagementApi = {
	searchPage: async params => {
		requests.push(['searchPage', params]);
		if (holdSearch) { holdSearch = false; await new Promise<void>((_, reject) => { rejectSearch = reject; }); }
		if (offline || params.sourceId === 'offline-source') { throw new Error('Catalog unavailable'); }
		const base = params.capabilityKind === 'mcp' ? mcpSummary : summary;
		const entries = new URLSearchParams(location.search).has('pagedDiscovery')
			? Array.from({ length: 73 }, (_, index) => ({ ...base, id: 'catalog/item-' + index + '@' + params.sourceId, displayName: 'Item ' + index })) : [base];
		const filtered = entries.filter(value => [value.id, value.displayName, value.description].some(text => text.toLowerCase().includes(params.query.toLowerCase())));
		const offset = params.cursor ? Number(params.cursor) : 0;
		const end = Math.min(offset + params.pageSize, filtered.length);
		return { packages: filtered.slice(offset, end), total: BigInt(filtered.length), nextCursor: end < filtered.length ? String(end) : null };
	},
	builtInProviders: async () => builtInProviders(),
	setBuiltInProviderEnablement: async params => {
		requests.push(['builtInPolicy', params]);
		if (params.id !== 'ash.github-authentication' || params.expectedRevision !== editorPolicyRevision) { throw new Error('Policy revision conflict'); }
		builtInProviderEnabled = params.enabled;
		builtInProviderRunning = false;
		editorPolicyRevision++;
		generation++;
		changed.fire();
		return builtInProviders();
	},
	sources: async () => ({ revision: sourceRevision, sources }),
	addSource: async params => {
		requests.push(['addSource', params]);
		if (params.expectedRevision !== sourceRevision) { throw new Error('Source revision conflict'); }
		sources = [...sources, { id: params.sourceId, kind: 'ash', enabled: true, productOwned: false }]; sourceRevision++; generation++; changed.fire();
		return { revision: sourceRevision, sources };
	},
	setSourceEnabled: async params => {
		requests.push(['setSourceEnabled', params]);
		if (params.expectedRevision !== sourceRevision) { throw new Error('Source revision conflict'); }
		sources = sources.map(source => source.id === params.sourceId ? { ...source, enabled: params.enabled } : source); sourceRevision++; generation++; changed.fire();
		return { revision: sourceRevision, sources };
	},
	editorExtensions: async () => editorPolicySnapshot(),
	setEditorExtensionPolicy: async params => {
		requests.push(['editorPolicy', params]);
		const entry = installed.find(entry => entry.installationId === params.installationId && entry.package.digest === params.packageDigest);
		if (!entry || params.expectedRevision !== editorPolicyRevision) throw new Error('Policy revision conflict');
		const state = editorPolicies.get(entry.installationId) ?? { enabled: true, granted: false };
		if (params.action === 'enable' || params.action === 'disable') state.enabled = params.action === 'enable';
		if (params.action === 'grant' || params.action === 'revoke') state.granted = params.action === 'grant';
		editorPolicies.set(entry.installationId, state);
		editorPolicyRevision++;
		generation++;
		changed.fire();
		return editorPolicySnapshot();
	},
	search: async params => {
		requests.push(['search', params]);
		if (holdSearch) { holdSearch = false; await new Promise<void>((_, reject) => { rejectSearch = reject; }); }
		if (offline) { throw new Error('Catalog unavailable'); }
		if (discoveryFixture && (params.capabilityKind === 'skill' || params.capabilityKind === 'mcp')) {
			const entry = params.capabilityKind === 'skill' ? summary : mcpSummary;
			return { packages: [entry].filter(value => [value.id, value.displayName, value.description].some(text => text.toLowerCase().includes(params.query.toLowerCase()))), unavailableSources: partialDiscoveryFailure ? ['offline-source'] : [] };
		}
		return { packages: [params.capabilityKind === 'editorExtension' || params.query === 'publisher.sample' ? extensionSummary : summary], unavailableSources: [] };
	},
	get: async params => { requests.push(['get', params]); if (offline) { throw new Error('Catalog unavailable'); } const details = params.packageId === extensionSummary.id ? extensionDetails : params.packageId === mcpSummary.id ? mcpDetails : packageDetails; return { ...details, package: { ...details.package, version: params.version ?? '2.0.0' } }; },
	listInstalled: async () => ({ instanceId: 'fixture', generation, packages: installed.map(entry => ({ ...entry, capabilities: entry.capabilities.map(capability => ({ ...capability, permissions: [...capability.permissions] })) })) }),
	download: async () => { throw new Error('Install owns downloading'); },
	install: async params => {
		requests.push(['install', params]);
		const details = params.packageId === extensionSummary.id ? extensionDetails : params.packageId === mcpSummary.id ? mcpDetails : packageDetails;
		const entry = { installationId: 'version-one', package: { ...details.package, version: params.version! }, state: 'installed' as const, capabilities: details.capabilities.map(capability => ({ ...capability, permissions: [...capability.permissions], reference: { id: `cap:${capability.id}` } })) };
		installed.push(entry); generation++; changed.fire(); return entry;
	},
	update: async params => {
		requests.push(['update', params]);
		const index = installed.findIndex(entry => entry.installationId === params.installationId);
		installed[index] = { ...installed[index]!, installationId: 'updated-installation', package: { ...reference, version: params.version! } }; generation++; changed.fire(); return { ...installed[index]!, capabilities: installed[index]!.capabilities.map(capability => ({ ...capability, permissions: [...capability.permissions] })) };
	},
	uninstall: async params => { requests.push(['uninstall', params]); installed = installed.filter(entry => entry.installationId !== params.installationId); generation++; changed.fire(); },
	acquireCapability: async () => { throw new Error('unused'); }, releaseCapability: async () => { }, openResource: async () => { throw new Error('unused'); },
};
services.registerInstance(IExtensionManagementService, disposables.add(new AppServerExtensionManagementService(api, { subscribe: listener => changed.event(() => listener({ method: 'extensions/changed', params: { instanceId: 'fixture', generation } })) })));
services.registerInstance(IConfigurationService, {
	getValue: (key: string) => key === 'chat.customizations.marketplace.enabled' ? discoveryEnabled : true,
	onDidChangeConfiguration: configurationChanged.event,
} as unknown as IConfigurationService);
services.registerSingleton(ICustomizationMarketplaceService, () => services.createInstance(CustomizationMarketplaceWorkbenchService));
const dialogs = disposables.add(new DialogService());
services.registerInstance(IDialogService, dialogs);
services.registerInstance(IDialogsModel, dialogs.model);
services.registerInstance(IWorkbenchDialogHandler, new BrowserDialogHandler(document.body));
services.registerInstance(ICommandService, { executeCommand: async (id: string, options: ExtensionsOpenOptions) => { requests.push(['command', id, options]); if (id === CLOSE_EDITOR_COMMAND_ID) { return; } if (id === 'ash.extensions.installed') { await plugins.open({ ...options, mode: 'installed' }); } else if (id === OPEN_EXTENSIONS_COMMAND_ID) { await commands.executeCommand(id, options); } else { await commands.executeCommand(id, options); } } } as unknown as ICommandService);
let instructionSignal: AbortSignal | undefined;
let holdInstructions = false;
let completeInstructions: ((text: string) => void) | undefined;
let revision = 3;
let enabled = true;
const skillId = { source: 'marketplace:example/web', name: 'review' };
services.registerInstance(IAppServerSkillApi, {
	onDidChangeSkills: Event.None,
	readTextResource: async (_reference, _path, signal) => { instructionSignal = signal; if (holdInstructions) { return new Promise<string>(resolve => { completeInstructions = resolve; }); } return '---\r\nname: review\r\ndescription: Review changes\r\n---\r\n# Review\r\nReview changes carefully.'; },
	list: async () => ({ generation: 1, skills: [] }),
	read: async () => ({ revision, catalog: { generation: 1, skills: [{ id: skillId, description: 'Review changes', enabled, compatible: true, contentDigest: 'digest' }] }, diagnostics: [{ source: 'workspace', subject: 'bad-skill', message: 'Invalid metadata' }] }),
	setEnabled: async (id, value, expectedRevision, sessionId) => { requests.push(sessionId ? ['skill', id, value, expectedRevision, sessionId] : ['skill', id, value, expectedRevision]); if (expectedRevision !== revision) { throw new Error('Configuration changed. Refresh before saving.'); } enabled = value; revision++; },
});
services.registerInstance(ILanguageServerService, {
	read: async () => ({ revision, configurations: {}, servers: [{ id: 'typescript-language-server', languageIds: ['typescriptreact'] }] }),
	configure: async (id, config, expectedRevision) => { requests.push(['configure', id, config, expectedRevision]); if (expectedRevision !== revision) { throw new Error('Configuration changed. Refresh before saving.'); } revision++; },
	removeConfiguration: async () => { },
});
services.registerInstance(IContextKeyService, disposables.add(new ContextKeyService()));
services.registerInstance(IQuickInputService, disposables.add(new TestQuickInputService({ instantiationService: services, container: document.body, contextKeyService: services.get(IContextKeyService) })));
let pluginRevision = 0;
let localPackages: PluginPackageDto[] = [];
let commandCompletion: Promise<unknown> | undefined;
const mutatePlugin = async (action: string, params: PluginPackageCommandParams) => {
	requests.push([action, params]);
	if (params.expectedRevision !== pluginRevision) { throw new Error('Plugin revision conflict'); }
	localPackages = action === 'pluginUninstall' ? [] : localPackages.map(plugin => ({
		...plugin,
		enabled: action === 'pluginEnable' ? true : action === 'pluginDisable' ? false : plugin.enabled,
		granted: action === 'pluginGrant' ? true : action === 'pluginRevoke' ? false : plugin.granted,
	}));
	pluginRevision++;
	return { revision: pluginRevision, activationGeneration: pluginRevision, disposition: 'updated' as const };
};
const pluginApi: IPluginManagementApi = {
	list: async () => ({ revision: pluginRevision, activationGeneration: pluginRevision, packages: structuredClone(localPackages) }),
	installLocal: async params => {
		requests.push(['pluginInstall', params]);
		if (params.expectedRevision !== pluginRevision) { throw new Error('Plugin revision conflict'); }
		const plugin: PluginPackageDto = { id: 'acme/sdk', version: '1.0.0', digest: 'sha256:' + 'b'.repeat(64), displayName: 'SDK fixture', permissions: [{ type: 'directory', access: 'read' }], hasEditorExtensions: true, enabled: false, granted: false, effective: false, revoked: false };
		localPackages = [plugin];
		pluginRevision++;
		return { id: plugin.id, version: plugin.version, digest: plugin.digest, command: { revision: pluginRevision, activationGeneration: 0, disposition: 'updated' } };
	},
	enable: params => mutatePlugin('pluginEnable', params),
	disable: params => mutatePlugin('pluginDisable', params),
	grant: params => mutatePlugin('pluginGrant', params),
	revokeGrant: params => mutatePlugin('pluginRevoke', params),
	uninstall: params => mutatePlugin('pluginUninstall', params),
};
let cancelHeldGitClone: (() => void) | undefined;
services.registerInstance(ILocalGitService, {
	_serviceBrand: undefined,
	readRepositoryContexts: async () => [],
	clone: async (operationId, url, targetPath, reference) => {
		if (!new URLSearchParams(location.search).has('holdGitClone')) { throw new Error('Unexpected Git clone in the local installation fixture'); }
		requests.push(['gitClone', { operationId, url, targetPath, reference }]);
		await new Promise<void>((_resolve, reject) => { cancelHeldGitClone = () => reject(canceled()); });
	},
	cancel: async operationId => { requests.push(['gitCancel', operationId]); cancelHeldGitClone?.(); },
});
services.registerInstance(ILogService, new NullLoggerService());
services.registerSingleton(IPluginManagementService, () => disposables.add(services.createInstance(AppServerPluginManagementService, pluginApi, { subscribe: () => ({ dispose() { } }) })));
services.registerInstance(IContextViewService, disposables.add(new BrowserContextViewService(document.body)));
services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (bundle, key, text, parameters) => localize({ bundle, key }, text, ...Object.keys(parameters ?? {}).sort().map(key => parameters![key]!)) });
services.registerInstance(IAppServerRemoteAgentService, { onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None } as IAppServerRemoteAgentService);
services.registerInstance(IAccessibleViewService, { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } });
services.registerInstance(ICodeEditorService, { getActiveCodeEditor: () => ({ getModel: () => ({ getLanguageId: () => 'typescriptreact' }) }) } as unknown as ICodeEditorService);
const themeName = new URLSearchParams(location.search).get('theme');
const themeService = disposables.add(new TestThemeService(themeName === 'light' ? lightColorTheme : themeName === 'hc' ? highContrastDarkColorTheme : darkColorTheme));
services.registerInstance(IThemeService, themeService);
disposables.add(bindTestColorTheme(themeService, document.body));
services.registerInstance(IStorageService, disposables.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'extensions-fixture', backend: window.localStorage, flushInterval: 0 })));
services.registerInstance(IGlobalExtensionEnablementService, disposables.add(services.createInstance(GlobalExtensionEnablementService)));
let pane: ExtensionsEditor | undefined;
let editorAbort = new AbortController();
disposables.add(toDisposable(() => { editorAbort.abort(); pane?.dispose(); }));
services.registerInstance(IEditorService, {
	onDidActiveEditorChange: Event.None,
	focusActiveEditor: () => pane?.focus(),
	openEditor: async (input, options) => {
		if (!(input instanceof ExtensionsInput) && !(input instanceof ExtensionsCapabilityInput)) { requests.push(['document', input], ['documentOptions', options]); return; }
		disposables.add(input); editorAbort.abort(); editorAbort = new AbortController();
		const descriptor = EditorPanes.getEditorPane(input);
		if (!descriptor || descriptor.id !== 'ash.extensions.editor') { throw new Error('Details must resolve to the registered Extensions editor'); }
		requests.push(['editorPane', descriptor.id]);
		if (!pane) {
			const editor = await descriptor.create({ input, instantiationService: services });
			if (!(editor instanceof ExtensionsEditor)) { throw new Error('Incorrect Extensions editor implementation'); }
			pane = editor; pane.create(document.getElementById('details')!);
		}
		await pane.setInput(input, editorAbort.signal);
	},
} as IEditorService);
const workspace = disposables.add(new TestWorkspaceService({ id: 'fixture', uri: URI.file('/project') }));
services.registerInstance(IWorkspaceContextService, workspace);
const recommendationsResource = URI.file('/project/.ash/extensions.json');
const files = disposables.add(new FileService());
const recommendationChanges = disposables.add(new Emitter<IFileChangeEvent>());
const recommendationFiles = new class extends MemoryFileService { public override readonly onDidChangeFiles = recommendationChanges.event; }([[recommendationsResource, '{ "recommendations": ["example/web", "publisher.sample", "excluded/tool"], "unwantedRecommendations": ["excluded/tool"] }']]);
disposables.add(files.registerProvider('file', recommendationFiles));
services.registerInstance(IFileService, files);
services.registerInstance(IUriIdentityService, disposables.add(new UriIdentityService(files)));
services.registerInstance(IWorkspaceExtensionsConfigService, disposables.add(services.createInstance(WorkspaceExtensionsConfigService)));
services.registerInstance(IExtensionRecommendationsService, services.createInstance(ExtensionRecommendationsService));
let mcpServers: readonly McpServerStatus[] = [{ id: 'marketplace:example/web:mcp:fixture-server', displayName: 'fixture-server', httpOrigin: 'https://example.com', state: { status: 'connected' }, catalogGeneration: 1, connectionGeneration: 1, toolCount: 1 }];
let mcpStatusFailure = false;
let mcpToolsFailure = false;
let holdMcpStatus = false;
let completeMcpStatus: (() => void) | undefined;
setARIAContainer(document.body);
const mcpCapabilities = { mcp: true, mcpOAuth: false };
let finishMcpLogin: ((value: { state: string; code: string; issuer?: string; }) => void) | undefined;
let rejectMcpLogin: ((error: Error) => void) | undefined;
let mcpRevision = 1;
let mcpConfigured: Record<string, McpServerConfiguration> = {};
let failMcpConnect = false;
let deferMcpConnect = false;
const mcpChanged = disposables.add(new Emitter<{ method: string; }>());
const mcpConnection = {
	capabilities: mcpCapabilities,
	onNotification: mcpChanged.event, onStateChange: Event.None,
	request: async (definition: { method: string; }, params: unknown) => {
		requests.push([definition.method, params]);
		if (definition.method === 'config/read') { return { revision: mcpRevision, mcpServers: structuredClone(mcpConfigured) }; }
		if (definition.method === 'mcp/oauth/start') { return { flowId: 'synthetic-flow', authorizationUrl: 'https://issuer.test/authorize' }; }
		if (definition.method === 'mcp/oauth/cancel') { return null; }
		if (definition.method === 'mcp/oauth/complete' || definition.method === 'mcp/oauth/logout') {
			mcpServers = mcpServers.map(server => ({ ...server, state: { status: definition.method === 'mcp/oauth/complete' ? 'connected' : 'disconnected' } }));
			return { serverId: 'user:mcp:oauth' };
		}
		if (definition.method !== 'mcp/server/status') {
			const input = params as { expectedRevision: number; serverId: string; server: McpServerConfiguration; enablement: 'enabled' | 'disabled'; };
			if (['mcp/server/upsert', 'mcp/server/remove', 'mcp/server/enablement/set'].includes(definition.method)) {
				if (input.expectedRevision !== mcpRevision) { throw new AppServerRemoteError(-32031, 'Conflict', { kind: 'ConfigRevisionConflict' }); }
				if (definition.method === 'mcp/server/upsert') {
					mcpConfigured[input.server.id] = structuredClone(input.server);
				} else if (definition.method === 'mcp/server/remove') {
					delete mcpConfigured[input.serverId];
					mcpServers = mcpServers.filter(server => server.id !== input.serverId);
				} else {
					mcpConfigured[input.serverId] = { ...mcpConfigured[input.serverId], enablement: input.enablement };
				}
				const server = mcpConfigured[input.server?.id ?? input.serverId];
				if (server) {
					mcpServers = [...mcpServers.filter(entry => entry.id !== server.id), {
						id: server.id, displayName: server.displayName,
						httpOrigin: server.transport.type === 'streamableHttp' ? new URL(server.transport.url).origin : null,
						state: { status: server.enablement === 'disabled' ? 'disabled' : 'disconnected' },
						catalogGeneration: 1, connectionGeneration: null, toolCount: 0,
					}];
				}
				mcpRevision++;
				mcpChanged.fire({ method: 'config/changed' });
				return { revision: mcpRevision };
			}
			if (!['mcp/server/connect', 'mcp/server/disconnect'].includes(definition.method)) { throw new Error('Unexpected MCP request'); }
			mcpServers = mcpServers.map(server => server.id !== input.serverId ? server : {
				...server,
				state: failMcpConnect
					? { status: 'unavailable', reason: 'Connection refused' }
					: { status: definition.method === 'mcp/server/connect' && !deferMcpConnect ? 'connected' : 'disconnected' },
			});
			if (failMcpConnect) { throw new AppServerRemoteError(-32090, 'Runtime unavailable', { kind: 'McpRuntimeUnavailable' }); }
			return { serverId: input.serverId, intent: definition.method === 'mcp/server/connect' ? 'connect' : 'disconnect' };
		}
		if (mcpStatusFailure) { throw new Error('Status connection lost'); }
		const result = { catalogGeneration: 1, servers: structuredClone(mcpServers) };
		if (holdMcpStatus) {
			holdMcpStatus = false;
			await new Promise<void>(resolve => { completeMcpStatus = resolve; });
		}
		return result;
	},
} as unknown as AppServerProtocolClient;
services.registerInstance(IMcpServerStatusService, createAppServerMcpServerStatusApi(mcpConnection));
services.registerInstance(IMcpServerManagementService, disposables.add(new AppServerMcpServerManagementService(mcpConnection, {
	externalOpener: { openExternal: async target => { requests.push(['oauth/openBrowser', target]); return true; } },
	clipboardService: {} as never,
	callbackHost: {
		listen: async () => ({ id: 'synthetic-callback', redirectUri: 'http://127.0.0.1:3333/callback' }),
		wait: () => new Promise((resolve, reject) => { finishMcpLogin = resolve; rejectMcpLogin = reject; }),
		close: async () => { rejectMcpLogin?.(new Error('Sign-in cancelled')); finishMcpLogin = undefined; rejectMcpLogin = undefined; },
	},
})));
services.registerSingleton(ILanguageModelToolsService, () => createTestLanguageModelToolsService({
	isAvailable: true,
	read: async () => {
		if (mcpToolsFailure) { throw new Error('Tool catalog unavailable'); }
		return { sourceGroups: [{ id: 'mcp:fixture-server', source: 'mcp' as const, sourceId: 'marketplace:example/web:mcp:fixture-server', tools: ['fixture_search'] }], tools: [{ name: 'fixture_search', description: 'Search fixture records', source: 'mcp' as const, sourceDetails: ['marketplace:example/web:mcp:fixture-server'], exposure: 'direct' as const, authority: 'providerDefined' as const }], toolSets: [{ id: 'fixture-set', source: 'mcp' as const, sourceId: 'marketplace:example/web:mcp:fixture-server', tools: ['fixture_search'] }] };
	},
}));
const host = document.getElementById('extensions')!;
const paneLayout = new URLSearchParams(location.search).has('paneLayout');
const previewHeight = new URLSearchParams(location.search).has('preview') ? 780 : 650;
if (new URLSearchParams(location.search).has('preview')) { document.getElementById('lsp')!.hidden = true; document.getElementById('details')!.style.width = '850px'; document.getElementById('details')!.style.height = `${previewHeight}px`; }
host.style.width = paneLayout ? '280px' : '360px'; host.style.height = paneLayout ? '260px' : `${previewHeight}px`;
const panes = disposables.add(new PaneView(host));
// Use the localized product descriptors shared by IDE and Agents.
const contributions = disposables.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }));
contributions.advance(WorkbenchPhase.BlockStartup);
const extensionManagement = disposables.add(services.createInstance(ExtensionsViewPane, host, ViewsRegistry.getView('ash.extensions.view')!));
const plugins = disposables.add(services.createInstance(ExtensionsViewPane, host, ViewsRegistry.getView('ash.extensions.plugins')!));
const skills = disposables.add(services.createInstance(SkillsViewPane, host, ViewsRegistry.getView('ash.extensions.skills')!));
const mcp = disposables.add(services.createInstance(McpServersViewPane, host, ViewsRegistry.getView('ash.extensions.mcp')!));
const recommended = disposables.add(services.createInstance(RecommendedExtensionsView, host, ViewsRegistry.getView('ash.extensions.recommended')!));
for (const pane of [extensionManagement, plugins, skills, mcp, recommended]) { panes.addPane(pane, 350); pane.setVisible(true); }
// Installation scenarios explicitly browse the fixture registry. Opening the product command
// without filters is tested separately and shows installed packages, including built-ins.
void extensionManagement.open({ mode: 'browse' });
panes.layout(paneLayout ? 260 : previewHeight, paneLayout ? 280 : 360);
services.registerInstance(IViewsService, {
	openView: (id: string) => {
		const pane = [extensionManagement, plugins, skills, mcp, recommended].find(pane => pane.id === id)!;
		pane.setExpanded(true); pane.focus(); return pane;
	}
} as unknown as IViewsService);
registerSkillActions();
const commands = disposables.add(new CommandService(services));
const lsp = disposables.add(services.createInstance(LanguageServerSettingsRenderer, document.getElementById('lsp')!));
document.getElementById('lsp')!.append(lsp.domNode);
lsp.setInput(createSettingsEditorInput());
lsp.setVisible(true);

let settingsConfiguration: WorkbenchConfigurationService | undefined;
function prepareSettings(): void {
	for (const element of document.querySelectorAll('body > main')) (element as HTMLElement).style.display = 'none';
	const host = document.createElement('div');
	host.id = 'extension-settings';
	host.className = 'ash-settings-editor';
	host.style.width = '1000px';
	const layoutElement = document.createElement('div');
	layoutElement.className = 'ash-settings-layout';
	const navigation = document.createElement('nav');
	navigation.className = 'ash-settings-sidebar';
	const content = document.createElement('main');
	content.className = 'ash-settings-page';
	layoutElement.append(navigation, content);
	host.append(layoutElement);
	document.body.append(host);
	disposables.add(toDisposable(() => host.remove()));
	const registry = new ConfigurationRegistry();
	registry.updateConfigurations({
		add: [...parseExtensionManifest(JSON.stringify({
			name: 'sample', publisher: 'test', version: '1.0.0', displayName: 'Sample extension',
			contributes: {
				configuration: {
					properties: {
						'sample.enabled': { type: 'boolean', default: false },
						'sample.count': { type: 'integer', default: 2, minimum: 1, maximum: 10 },
						'sample.text': { type: 'string', default: 'original' },
						'sample.mode': { type: 'string', enum: ['first', 'second'], default: 'first' },
						'sample.rules': { type: 'array', default: [], items: { type: 'string' } },
					}
				}
			},
		}), { id: 'test.sample', name: 'sample', publisher: 'test', version: '1.0.0' }).contributes.configuration], remove: []
	});
	settingsConfiguration = disposables.add(new WorkbenchConfigurationService({ registry }));
	const settingServices = new InstantiationService();
	settingServices.registerInstance(IConfigurationService, settingsConfiguration);
	settingServices.registerInstance(IContextViewService, services.get(IContextViewService));
	settingServices.registerInstance(IClipboardService, disposables.add(new BrowserClipboardService(navigator.clipboard)));
	settingServices.registerInstance(IContextMenuService, { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => { }, hideContextMenu: () => { } });
	const layout = createSettingsLayout(new DefaultSettings(registry).all).filter(entry => entry.id.startsWith('extension.'));
	const model = disposables.add(new SettingsTreeModel<ISetting | SettingsSectionReference>());
	model.setChildren(settingsRootNodes(layout));
	model.setNavigationTarget('extension.test.sample');
	const renderer = disposables.add(settingServices.createInstance(SettingsRenderer, content, {
		onStatus: (message: string) => { requests.push(['settingsStatus', message]); },
		onOpenSettings: async (key: string) => { requests.push(['settingsJson', key]); },
	}));
	disposables.add(new SettingsTree(content, {
		model, rootClassName: 'ash-settings-content-tree', groupClassName: 'ash-configuration-settings-group',
		groupDescriptionClassName: 'ash-configuration-settings-group-description', itemsClassName: 'ash-configuration-settings-list',
		renderGroupHeader: header => renderer.render(header),
		renderItem: item => renderer.render(item.value),
		updateItem: item => { if (!('rendererId' in item.value)) renderer.update(item.value); }, disposeItem: item => renderer.disposeSetting(item.id),
	}));
	const toc = disposables.add(new TOCTree(navigation, new TOCTreeModel(model, () => [{
		id: 'extensions', label: localize({ bundle: 'ash.settings', key: 'groups.extensions.label' }, 'Extensions'), description: '', categories: layout.map(entry => entry.descriptor),
	}]), {
		ariaLabel: 'Settings categories', categoryLabel: category => category.label, categoryDescription: category => category.description,
		groupLabel: group => group.label, groupDescription: group => group.description,
	}));
	disposables.add(toc.onDidOpen(entry => model.setNavigationTarget(entry.category.id)));
	toc.domFocus();
}

window.ashExtensionsIntegration = {
	enableMcpOAuth: () => { mcpCapabilities.mcpOAuth = true; },
	completeMcpLogin: () => { finishMcpLogin?.({ state: 'synthetic-state', code: 'synthetic-code', issuer: 'https://issuer.test' }); },
	mcpLoginWaiting: () => !!finishMcpLogin,
	setMcpServers: servers => { mcpServers = servers; },
	changeMcpRevision: () => { mcpRevision++; },
	setMcpConnectFailure: () => { failMcpConnect = true; },
	deferMcpConnection: () => { deferMcpConnect = true; },
	configureMcp: server => {
		mcpConfigured[server.id] = server;
		mcpServers = [...mcpServers, { id: server.id, displayName: server.displayName, httpOrigin: null, state: { status: 'disconnected' }, catalogGeneration: 1, connectionGeneration: null, toolCount: 0 }];
	},
	failMcpStatus: () => { mcpStatusFailure = true; },
	failMcpTools: () => { mcpToolsFailure = true; },
	setMcpSupported: supported => { mcpCapabilities.mcp = supported; },
	refreshMcp: () => mcp.refresh(),
	holdMcpStatus: () => { holdMcpStatus = true; completeMcpStatus = undefined; },
	mcpStatusStarted: () => !!completeMcpStatus,
	completeMcpStatus: () => { completeMcpStatus?.(); completeMcpStatus = undefined; },
	prepareSettings,
	readSetting: (key: string) => settingsConfiguration!.getValue(key),
	requests,
	setRecommendations: async (content: string) => { await files.writeFile({ resource: recommendationsResource, content }); recommendationChanges.fire({ resources: [recommendationsResource] }); },
	leaveWorkspace: () => workspace.updateWorkspace({ id: 'empty', folders: [] }),
	startCommand: id => { commandCompletion = commands.executeCommand(id).catch((error: unknown) => requests.push(['commandError', String(error)])); },
	waitCommand: async () => { await commandCompletion; },
	changePluginRevision: () => { pluginRevision++; },
	removeEditorEntrypoint: () => { editorEntrypoint = null; },
	localPackages: () => structuredClone(localPackages),
	open: options => extensionManagement.open(options),
	openEditorExtension: () => services.get(IEditorService).openEditor(new ExtensionsInput(extensionSummary)),
	holdReadme: () => { holdReadme = true; },
	readmeStarted: () => !!heldReadme,
	completeReadme: () => { heldReadme?.('# Retired README'); },
	holdInstructions: () => { holdInstructions = true; },
	instructionsStarted: () => !!instructionSignal,
	instructionsAborted: () => !!instructionSignal?.aborted,
	completeInstructions: () => { completeInstructions?.('# Retired instructions'); },
	setSession: (id: string) => { activeSessionId = id; },
	addMcpPackage: () => { installed.push({ installationId: 'fixture-mcp-installation', package: reference, state: 'installed', capabilities: [{ kind: 'mcp', id: 'fixture-server', reference: { id: 'fixture-mcp-capability' }, contractVersion: '1', permissions: ['network'], authenticationProvider: null }] }); generation++; changed.fire(); },
	addSkillOnlyPlugin: () => { localPackages.push({ id: 'acme/skills', version: '1.0.0', digest: 'sha256:' + 'c'.repeat(64), displayName: 'Skill-only plugin', permissions: [], hasEditorExtensions: false, enabled: false, granted: false, effective: false, revoked: false }); },
	setOffline: () => { offline = true; },
	changeRevision: () => { revision++; },
	startHeldSearch: () => { holdSearch = true; heldOpen = extensionManagement.open({ query: 'old query' }); },
	holdDiscoverySearch: () => { holdSearch = true; },
	discoverySearchStarted: () => !!rejectSearch,
	setDiscoveryEnabled: value => {
		discoveryEnabled = value;
		configurationChanged.fire({ source: 1, affectedKeys: new Set(['chat.customizations.marketplace.enabled']), change: { keys: ['chat.customizations.marketplace.enabled'], overrides: [] }, affectsConfiguration: key => key === 'chat.customizations.marketplace.enabled' });
	},
	startHeldCommand: async () => { holdSearch = true; await commands.executeCommand(OPEN_EXTENSIONS_COMMAND_ID, 'held query'); },
	executeCommand: id => commands.executeCommand(id),
	failHeldSearch: async () => { rejectSearch!(new Error('Old request failed')); await heldOpen; },
	addOtherPackage: () => { installed.unshift({ ...installed[0]!, installationId: 'other-package', package: { ...reference, id: 'other@example' } }); },
	addSecondVersion: () => { installed.push({ ...installed[0]!, installationId: 'version-two', package: { ...reference, version: '2.0.0' } }); },
	dispose: () => disposables.dispose(),
};
declare global {
	interface Window {

		ashExtensionsIntegration: { enableMcpOAuth(): void; completeMcpLogin(): void; mcpLoginWaiting(): boolean; holdDiscoverySearch(): void; discoverySearchStarted(): boolean; setDiscoveryEnabled(value: boolean): void; changeMcpRevision(): void; setMcpConnectFailure(): void; deferMcpConnection(): void; configureMcp(server: McpServerConfiguration): void; setMcpServers(servers: readonly McpServerStatus[]): void; failMcpStatus(): void; failMcpTools(): void; setMcpSupported(supported: boolean): void; refreshMcp(): Promise<void>; holdMcpStatus(): void; mcpStatusStarted(): boolean; completeMcpStatus(): void; prepareSettings(): void; readSetting(key: string): unknown; openEditorExtension(): Promise<void>; holdReadme(): void; readmeStarted(): boolean; completeReadme(): void; setRecommendations(content: string): Promise<void>; leaveWorkspace(): void; holdInstructions(): void; instructionsStarted(): boolean; instructionsAborted(): boolean; completeInstructions(): void; setSession(id: string): void; addMcpPackage(): void; addSkillOnlyPlugin(): void; requests: unknown[]; startCommand(id: string): void; waitCommand(): Promise<void>; changePluginRevision(): void; removeEditorEntrypoint(): void; localPackages(): PluginPackageDto[]; open(options: ExtensionsOpenOptions): Promise<void>; setOffline(): void; changeRevision(): void; startHeldSearch(): void; startHeldCommand(): Promise<void>; executeCommand(id: string): Promise<void>; failHeldSearch(): Promise<void>; addOtherPackage(): void; addSecondVersion(): void; dispose(): void; };
	}
}

let sandboxDefaults: ExecutionSettings = { approvalMode: 'auto', commandFileAccess: 'readOnly', commandNetworkAccess: 'denied' };
let sandboxRevision = 1;
const sandboxChanged = disposables.add(new Emitter<void>());
window.ashSandboxIntegration = {
	open() {
		for (const element of document.querySelectorAll('body > main')) (element as HTMLElement).hidden = true;
		const host = document.createElement('section'); host.id = 'sandbox-settings'; document.body.append(host);
		const child = disposables.add(services.createChild());
		child.registerInstance(IAgentExecutionSettingsService, {
			onDidChange: sandboxChanged.event,
			read: async () => ({ revision: sandboxRevision, settings: { ...sandboxDefaults } }),
			configure: async (settings, revision) => {
				if (revision !== sandboxRevision) throw new Error('revision conflict');
				sandboxDefaults = { ...settings }; sandboxRevision++; sandboxChanged.fire();
			},
		});
		child.registerInstance(IAppServerRemoteAgentService, { connectionState: 'connected', onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None } as IAppServerRemoteAgentService);
		const model = disposables.add(child.createInstance(SandboxSettingsModel));
		const renderer = disposables.add(child.createInstance(SettingsSectionRenderer, host, model, AccessibleViewProviderId.SandboxSettings, AccessibilityVerbositySettingId.SandboxSettings));
		for (const group of renderer.getNodes()) for (const node of group.children ?? []) {
			if (node.element.kind === 'item' && 'rendererId' in node.element.value) host.append(renderer.renderItem(node.element.value));
		}
		renderer.setVisible(true);
		const diagnostics = disposables.add(new AgentCapabilitiesSettings(host, { isAvailable: true, onDidChange: Event.None, read: async () => ({ localProcessSandboxConfigured: true, sandboxBackends: ['windows'], directoryGrantsReadable: false, sandboxDiagnostics: [], sandboxPolicy: { profile: ':readOnly', fileSystem: 'readOnly', network: 'denied', hostRead: 'grantedRoots', managedConstraints: true, pathRuleCount: 1 } }) }, child.get(IAppServerRemoteAgentService), { onDidChangeTrust: Event.None } as IWorkspaceTrustApi, { whenReady: Promise.resolve(), translate: (bundle, key, fallback, parameters) => localize({ bundle, key }, fallback, ...Object.values(parameters ?? {})) }, child.get(IAgentExecutionSettingsService)));
		diagnostics.setView('sandbox');
	},
	snapshot: () => ({ revision: sandboxRevision, settings: { ...sandboxDefaults } }),
	location: () => SettingsNavigation.filter(group => 'categories' in group && group.categories.some(category => category.id === 'sandbox')).map(group => group.id),
};

declare global {
	interface Window {
		ashSandboxIntegration: { open(): void; snapshot(): { revision: number; settings: ExecutionSettings; }; location(): readonly string[]; };
	}
}
