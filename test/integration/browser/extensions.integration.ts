import '../../../src/ash/base/browser/ui/styles.css';
import { IGlobalExtensionEnablementService } from '../../../src/ash/platform/extensionManagement/common/extensionManagement.js';
import { GlobalExtensionEnablementService } from '../../../src/ash/platform/extensionManagement/common/extensionEnablementService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { ExtensionsEditor } from '../../../src/ash/workbench/contrib/extensions/browser/extensionsEditor.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import { ExtensionsInput, ExtensionsCapabilityInput } from '../../../src/ash/workbench/contrib/extensions/common/extensionsInput.js';
import { IExtensionApi, type ExtensionResourceRequest } from '../../../src/ash/platform/extensions/common/extensionApi.js';
import { createBrowserExtensionApi, withBuiltInExtensions } from '../../../src/ash/platform/extensions/browser/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
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
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
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
import { IAppServerSkillApi } from '../../../src/ash/platform/agentHost/common/appServerApi.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { ILocalizationService } from '../../../src/ash/workbench/services/localization/common/localizationService.js';
import { IAppServerRemoteAgentService } from '../../../src/ash/workbench/services/remote/common/appServerRemoteAgentService.js';
import { createSettingsEditorInput } from '../../../src/ash/workbench/services/preferences/common/settingsEditorInput.js';
import { CLOSE_EDITOR_COMMAND_ID } from '../../../src/ash/workbench/browser/parts/editor/editorCommands.js';
import { AppServerExtensionManagementService } from '../../../src/ash/workbench/services/extensionManagement/browser/appServerExtensionManagementService.js';
import { ExtensionsViewPane } from '../../../src/ash/workbench/contrib/extensions/browser/extensionsViewlet.js';
import '../../../src/ash/workbench/contrib/extensions/browser/extensions.contribution.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { IPluginManagementService } from '../../../src/ash/platform/extensionManagement/common/pluginManagementService.js';
import type { IPluginManagementApi } from '../../../src/ash/platform/extensionManagement/common/pluginManagementApi.js';
import type { PluginPackageDto, PluginPackageCommandParams } from '../../../.build/protocol/typescript/index.js';
import { AppServerPluginManagementService } from '../../../src/ash/workbench/services/extensionManagement/browser/appServerPluginManagementService.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { WorkbenchQuickInputService } from '../../../src/ash/workbench/services/quickinput/browser/quickInputService.js';
import { SkillsViewPane, McpServersViewPane, RecommendedExtensionsView } from '../../../src/ash/workbench/contrib/extensions/browser/extensionsViews.js';
import { IFileService, type IFileChangeEvent } from '../../../src/ash/platform/files/common/files.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { MemoryFileService } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { IUriIdentityService } from '../../../src/ash/platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../src/ash/platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspaceExtensionsConfigService, WorkspaceExtensionsConfigService } from '../../../src/ash/workbench/services/extensionRecommendations/common/workspaceExtensionsConfig.js';
import { IExtensionRecommendationsService } from '../../../src/ash/workbench/services/extensionRecommendations/common/extensionRecommendations.js';
import { ExtensionRecommendationsService } from '../../../src/ash/workbench/contrib/extensions/browser/extensionRecommendationsService.js';
import { IAgentCapabilitiesService } from '../../../src/ash/platform/agentCapabilities/common/agentCapabilitiesService.js';
import { PaneView } from '../../../src/ash/base/browser/ui/splitview/paneview.js';
import { registerSkillActions } from '../../../src/ash/workbench/contrib/chat/browser/promptSyntax/skillActions.js';
import { LanguageServerSettingsContent } from '../../../src/ash/workbench/contrib/language/browser/languageServerSettingsContent.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import chineseMessages from '../../../extensions/language-pack-zh-cn/translations/extensions.json' with { type: 'json' };

if (new URLSearchParams(window.location.search).get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', chineseMessages);
}

const disposables = new DisposableStore();
const services = disposables.add(new InstantiationService());
services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
let activeSessionId: string | undefined;
services.registerInstance(IChatSessionNavigationService, { getActiveConversation: () => activeSessionId ? { sessionId: activeSessionId, threadId: 'fixture-thread' } : undefined } as IChatSessionNavigationService);
const changed = disposables.add(new Emitter<void>());
const requests: unknown[] = [];
let offline = false;
let holdSearch = false;
let rejectSearch: ((error: Error) => void) | undefined;
let heldOpen: Promise<void> | undefined;
let installed: ExtensionsInstalledPackage[] = [];
let generation = 1;
const summary = { id: 'example/web', version: '1.0.0', packageType: 'plugin', displayName: 'Web tools', description: 'TypeScript server and review skill' };
const reference = { id: summary.id, version: summary.version, digest: 'sha256:' + 'a'.repeat(64) };
const capabilities = [
	{ kind: 'executable' as const, id: 'typescript-language-server', contractVersion: '1', permissions: ['process'], authenticationProvider: null },
	{ kind: 'skill' as const, id: 'review', contractVersion: '1', permissions: [], authenticationProvider: null },
];
const packageDetails = { package: reference, packageType: summary.packageType, displayName: summary.displayName, description: summary.description, license: 'MIT', source: 'thirdParty' as const, upstream: null, capabilities };
const extensionSummary = { ...summary, id: 'publisher.sample@open-vsx', packageType: 'editorExtension', displayName: 'Sample editor extension' };
const extensionReference = { ...reference, id: extensionSummary.id };
const extensionCapabilities = [{ kind: 'editorExtension' as const, id: 'publisher.sample', contractVersion: '1', permissions: [], authenticationProvider: null }];
const extensionDetails = { ...packageDetails, package: extensionReference, ...extensionSummary, capabilities: extensionCapabilities };
const galleryOnly = new URLSearchParams(location.search).has('gallery');
const extensionManifest = { publisher: 'Fixture publisher', name: 'sample', icon: 'icon.svg', categories: ['Programming Languages'], homepage: 'https://example.invalid/tools' };
let heldReadme: ((text: string) => void) | undefined;
let holdReadme = false;
const fixtureReadme = '# Sample editor extension\n\nTools for working with your project.\n\n## Features\n\n- Inspect and review workspace files\n- Keep your tools in the editor\n\n## Getting started\n\nInstall the extension and review its requested permissions.\n\n[Homepage](https://example.invalid/tools)\n' + (new URLSearchParams(location.search).has('unsafeReadme') ? '\n[Unsafe](command:fixture.unsafe)\n\n<script>window.fixtureUnsafe = true</script>\n' : '');
const readPackageResource = async (request: ExtensionResourceRequest): Promise<Uint8Array> => {
	requests.push(['extensionResource', request]);
	if (request.path === 'package.json') { return new TextEncoder().encode(JSON.stringify(extensionManifest)); }
	if (request.path === 'README.md') { if (holdReadme) { holdReadme = false; return new TextEncoder().encode(await new Promise<string>(resolve => { heldReadme = resolve; })); } return new TextEncoder().encode(fixtureReadme); }
	if (request.path === 'icon.svg') { return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="8" fill="#3355aa"/><path d="m32 40 32-16 32 16v48L64 104 32 88Z" fill="none" stroke="white" stroke-width="8"/></svg>'); }
	throw new Error('Package resource is missing');
};
services.registerInstance(IExtensionApi, withBuiltInExtensions({
	list: async () => ({ generation: 1, diagnostics: [], extensions: galleryOnly ? [] : [{ id: 'publisher.sample', name: 'sample', publisher: 'Fixture publisher', version: '1.0.0', displayName: extensionSummary.displayName, sourceKind: 'registry', manifestSha256: reference.digest, packageSha256: reference.digest, manifestJson: JSON.stringify(extensionManifest) }] }),
	resources: new ExtensionResourceLoaderService(readPackageResource, galleryOnly ? {
		template: async () => 'https://registry.invalid/api/{publisher}/{name}/{version}/file/{path}',
		read: async request => { requests.push(['galleryResource', request]); return readPackageResource({ generation: 1, extensionId: `${request.publisher}.${request.name}`, path: request.path }); },
	} : undefined),
}, createBrowserExtensionApi()));
services.registerInstance(IOpenerService, { open: async (href, options) => { requests.push(['openLink', String(href), options]); return true; } } as IOpenerService);
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
let builtInProviderEnabled = true;
let builtInProviderRunning = true;
function builtInProviders() {
	return { revision: editorPolicyRevision, providers: [{ id: 'ash.github-authentication', enabled: builtInProviderEnabled, running: builtInProviderRunning }] };
}
const api: IExtensionManagementApi = {
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
		return { packages: [params.capabilityKind === 'editorExtension' || params.query === 'publisher.sample' ? extensionSummary : summary], unavailableSources: [] };
	},
	get: async params => { requests.push(['get', params]); if (offline) { throw new Error('Catalog unavailable'); } const details = params.packageId === extensionSummary.id ? extensionDetails : packageDetails; return { ...details, package: { ...details.package, version: params.version ?? '2.0.0' } }; },
	listInstalled: async () => ({ instanceId: 'fixture', generation, packages: installed.map(entry => ({ ...entry, capabilities: entry.capabilities.map(capability => ({ ...capability, permissions: [...capability.permissions] })) })) }),
	download: async () => { throw new Error('Install owns downloading'); },
	install: async params => {
		requests.push(['install', params]);
		const details = params.packageId === extensionSummary.id ? extensionDetails : packageDetails;
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
services.registerInstance(IConfigurationService, { getValue: () => true } as unknown as IConfigurationService);
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
	readInstructions: async (_reference, signal) => { instructionSignal = signal; if (holdInstructions) { return new Promise<string>(resolve => { completeInstructions = resolve; }); } return '# Review\nReview changes carefully.'; },
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
services.registerInstance(IQuickInputService, disposables.add(new WorkbenchQuickInputService({ container: document.body, contextKeyService: services.get(IContextKeyService) })));
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
services.registerInstance(IPluginManagementService, disposables.add(new AppServerPluginManagementService(pluginApi, { subscribe: () => ({ dispose() { } }) })));
services.registerInstance(IContextViewService, disposables.add(new BrowserContextViewService(document.body)));
services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, text, parameters) => text.replace(/\{(\d+)\}/gu, (match, index: string) => String(parameters?.[index] ?? match)) });
services.registerInstance(IAppServerRemoteAgentService, { onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None } as IAppServerRemoteAgentService);
services.registerInstance(IAccessibleViewService, { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } });
services.registerInstance(ICodeEditorService, { getActiveCodeEditor: () => ({ getModel: () => ({ getLanguageId: () => 'typescriptreact' }) }) } as unknown as ICodeEditorService);
const themeName = new URLSearchParams(location.search).get('theme');
const themeService = disposables.add(new TestThemeService(themeName === 'light' ? lightColorTheme : themeName === 'hc' ? highContrastDarkColorTheme : darkColorTheme));
services.registerInstance(IThemeService, themeService);
disposables.add(bindColorTheme(themeService, document.body));
services.registerInstance(IStorageService, disposables.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'extensions-fixture', backend: window.localStorage, flushInterval: 0 })));
services.registerInstance(IGlobalExtensionEnablementService, disposables.add(services.createInstance(GlobalExtensionEnablementService)));
let pane: ExtensionsEditor | undefined;
let editorAbort = new AbortController();
disposables.add(toDisposable(() => { editorAbort.abort(); pane?.dispose(); }));
services.registerInstance(IEditorService, {
	onDidActiveEditorChange: Event.None,
	openEditor: async input => {
		if (!(input instanceof ExtensionsInput) && !(input instanceof ExtensionsCapabilityInput)) { requests.push(['document', input]); return; }
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
const workspace = disposables.add(new WorkspaceContextService({ id: 'fixture', uri: URI.file('/project') }));
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
services.registerInstance(IAgentCapabilitiesService, {
	isAvailable: true,
	read: async () => ({ tools: [{ name: 'fixture_search', description: 'Search fixture records', source: 'mcp', sourceDetails: ['marketplace:example/web:mcp:fixture-server'], exposure: 'direct', authority: 'providerDefined' }], toolSets: [{ id: 'fixture-set', source: 'mcp', sourceId: 'marketplace:example/web:mcp:fixture-server', tools: ['fixture_search'] }], localProcessSandboxConfigured: false, sandboxBackends: [], sandboxDiagnostics: [], directoryGrantsReadable: false }),
});
const host = document.getElementById('extensions')!;
const paneLayout = new URLSearchParams(location.search).has('paneLayout');
const previewHeight = new URLSearchParams(location.search).has('preview') ? 780 : 650;
if (new URLSearchParams(location.search).has('preview')) { document.getElementById('lsp')!.hidden = true; document.getElementById('details')!.style.width = '850px'; document.getElementById('details')!.style.height = `${previewHeight}px`; }
host.style.width = paneLayout ? '280px' : '360px'; host.style.height = paneLayout ? '260px' : `${previewHeight}px`;
const panes = disposables.add(new PaneView(host));
const extensionManagement = disposables.add(services.createInstance(ExtensionsViewPane, host, { id: 'ash.extensions.view', title: 'Extensions' }));
const plugins = disposables.add(services.createInstance(ExtensionsViewPane, host, { id: 'ash.extensions.plugins', title: new URLSearchParams(location.search).get('locale') === 'zh-CN' ? '插件' : 'Plugins', collapsed: true }));
const skills = disposables.add(services.createInstance(SkillsViewPane, host, { id: 'ash.extensions.skills', title: new URLSearchParams(location.search).get('locale') === 'zh-CN' ? '技能' : 'Skills', collapsed: true }));
const mcp = disposables.add(services.createInstance(McpServersViewPane, host, { id: 'ash.extensions.mcp', title: 'MCP Servers', collapsed: true }));
const recommended = disposables.add(services.createInstance(RecommendedExtensionsView, host, { id: 'ash.extensions.recommended', title: new URLSearchParams(location.search).get('locale') === 'zh-CN' ? '推荐' : 'Recommended', collapsed: true }));
for (const pane of [extensionManagement, plugins, skills, mcp, recommended]) { panes.addPane(pane, 350); pane.setVisible(true); }
panes.layout(paneLayout ? 260 : previewHeight, paneLayout ? 280 : 360);
services.registerInstance(IViewsService, {
	openView: (id: string) => {
		const pane = [extensionManagement, plugins, skills, mcp, recommended].find(pane => pane.id === id)!;
		pane.setExpanded(true); pane.focus(); return pane;
	}
} as unknown as IViewsService);
registerSkillActions();
const contributions = disposables.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }));
contributions.advance(WorkbenchPhase.BlockStartup);
const commands = disposables.add(new CommandService(services));
const lsp = disposables.add(services.createInstance(LanguageServerSettingsContent, document.getElementById('lsp')!));
document.getElementById('lsp')!.append(lsp.domNode);
lsp.setInput(createSettingsEditorInput());
lsp.setVisible(true);

window.ashExtensionsIntegration = {
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
	startHeldCommand: async () => { holdSearch = true; await commands.executeCommand(OPEN_EXTENSIONS_COMMAND_ID, 'held query'); },
	executeCommand: id => commands.executeCommand(id),
	failHeldSearch: async () => { rejectSearch!(new Error('Old request failed')); await heldOpen; },
	addOtherPackage: () => { installed.unshift({ ...installed[0]!, installationId: 'other-package', package: { ...reference, id: 'other@example' } }); },
	addSecondVersion: () => { installed.push({ ...installed[0]!, installationId: 'version-two', package: { ...reference, version: '2.0.0' } }); },
	dispose: () => disposables.dispose(),
};
declare global {
	interface Window {
		ashExtensionsIntegration: { openEditorExtension(): Promise<void>; holdReadme(): void; readmeStarted(): boolean; completeReadme(): void; setRecommendations(content: string): Promise<void>; leaveWorkspace(): void; holdInstructions(): void; instructionsStarted(): boolean; instructionsAborted(): boolean; completeInstructions(): void; setSession(id: string): void; addMcpPackage(): void; addSkillOnlyPlugin(): void; requests: unknown[]; startCommand(id: string): void; waitCommand(): Promise<void>; changePluginRevision(): void; removeEditorEntrypoint(): void; localPackages(): PluginPackageDto[]; open(options: ExtensionsOpenOptions): Promise<void>; setOffline(): void; changeRevision(): void; startHeldSearch(): void; startHeldCommand(): Promise<void>; executeCommand(id: string): Promise<void>; failHeldSearch(): Promise<void>; addOtherPackage(): void; addSecondVersion(): void; dispose(): void; };
	}
}
