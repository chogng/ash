import '../../../src/ash/base/browser/ui/dialog/dialog.css';
import '../../../src/ash/base/browser/ui/button/button.css';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
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
import type { IMarketplaceApi } from '../../../src/ash/platform/marketplace/common/marketplaceApi.js';
import { IMarketplaceService, OPEN_MARKETPLACE_COMMAND_ID, type MarketplaceInstalledPackage, type MarketplaceOpenOptions } from '../../../src/ash/platform/marketplace/common/marketplaceService.js';
import { ISkillService } from '../../../src/ash/platform/skills/common/skillService.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { ILocalizationService } from '../../../src/ash/workbench/services/localization/common/localizationService.js';
import { IRemoteAgentService } from '../../../src/ash/workbench/services/remote/common/remoteAgentService.js';
import { createSettingsEditorInput } from '../../../src/ash/workbench/services/preferences/common/settingsEditorInput.js';
import { CLOSE_EDITOR_COMMAND_ID } from '../../../src/ash/workbench/browser/parts/editor/editorCommands.js';
import { AppServerMarketplaceService } from '../../../src/ash/workbench/services/marketplace/browser/appServerMarketplaceService.js';
import { MarketplaceViewPane } from '../../../src/ash/workbench/contrib/marketplace/browser/marketplaceViewPane.js';
import '../../../src/ash/workbench/contrib/marketplace/browser/marketplace.contribution.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../src/ash/workbench/common/contributions.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { IPluginService } from '../../../src/ash/platform/plugins/common/pluginService.js';
import type { IPluginApi } from '../../../src/ash/platform/plugins/common/pluginApi.js';
import type { PluginPackageDto, PluginPackageCommandParams } from '../../../crates/app-server-protocol/schema/typescript/index.js';
import { AppServerPluginService } from '../../../src/ash/workbench/services/plugins/browser/appServerPluginService.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { WorkbenchQuickInputService } from '../../../src/ash/workbench/services/quickinput/browser/quickInputService.js';
import { SkillsSettingsContent } from '../../../src/ash/workbench/contrib/skills/browser/skillsSettingsContent.js';
import { LanguageServerSettingsContent } from '../../../src/ash/workbench/contrib/language/browser/languageServerSettingsContent.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import chineseMessages from '../../../localization/zh-CN/marketplace.json' with { type: 'json' };

if (new URLSearchParams(window.location.search).get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', chineseMessages);
}

const disposables = new DisposableStore();
const services = disposables.add(new InstantiationService());
const changed = disposables.add(new Emitter<void>());
const requests: unknown[] = [];
let offline = false;
let holdSearch = false;
let rejectSearch: ((error: Error) => void) | undefined;
let heldOpen: Promise<void> | undefined;
let installed: MarketplaceInstalledPackage[] = [];
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
let editorPolicyRevision = 1;
let editorEntrypoint: string | null = 'dist/extension.js';
const editorPolicies = new Map<string, { enabled: boolean; granted: boolean; }>();
function editorPolicySnapshot() {
	return {
		revision: editorPolicyRevision, extensions: installed.filter(entry => entry.capabilities.some(capability => capability.kind === 'editorExtension')).map(entry => ({
			installationId: entry.installationId, package: entry.package, entrypoint: editorEntrypoint,
			...(editorPolicies.get(entry.installationId) ?? { enabled: false, granted: false }),
		}))
	};
}
const api: IMarketplaceApi = {
	editorExtensions: async () => editorPolicySnapshot(),
	setEditorExtensionPolicy: async params => {
		requests.push(['editorPolicy', params]);
		const entry = installed.find(entry => entry.installationId === params.installationId && entry.package.digest === params.packageDigest);
		if (!entry || params.expectedRevision !== editorPolicyRevision) throw new Error('Policy revision conflict');
		const state = editorPolicies.get(entry.installationId) ?? { enabled: false, granted: false };
		if (params.action === 'enable' || params.action === 'disable') state.enabled = params.action === 'enable';
		if (params.action === 'grant' || params.action === 'revoke') state.granted = params.action === 'grant';
		editorPolicies.set(entry.installationId, state);
		editorPolicyRevision++;
		return editorPolicySnapshot();
	},
	search: async params => {
		requests.push(['search', params]);
		if (holdSearch) { holdSearch = false; await new Promise<void>((_, reject) => { rejectSearch = reject; }); }
		if (offline) { throw new Error('Catalog unavailable'); }
		return { packages: [params.capabilityKind === 'editorExtension' ? extensionSummary : summary] };
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
services.registerInstance(IMarketplaceService, disposables.add(new AppServerMarketplaceService(api, { subscribe: listener => changed.event(() => listener({ method: 'marketplace/changed', params: { instanceId: 'fixture', generation } })) })));
services.registerInstance(IConfigurationService, { getValue: () => true } as unknown as IConfigurationService);
const dialogs = disposables.add(new DialogService());
services.registerInstance(IDialogService, dialogs);
services.registerInstance(IDialogsModel, dialogs.model);
services.registerInstance(IWorkbenchDialogHandler, new BrowserDialogHandler(document.body));
services.registerInstance(ICommandService, { executeCommand: async (id: string, options: MarketplaceOpenOptions) => { requests.push(['command', id, options]); if (id === CLOSE_EDITOR_COMMAND_ID) { return; } if (id !== OPEN_MARKETPLACE_COMMAND_ID) { throw new Error(id); } await marketplace.open(options); } } as unknown as ICommandService);
let revision = 3;
let enabled = true;
const skillId = { source: 'marketplace:example/web', name: 'review' };
services.registerInstance(ISkillService, {
	list: async () => ({ generation: 1, skills: [] }),
	read: async () => ({ revision, catalog: { generation: 1, skills: [{ id: skillId, description: 'Review changes', enabled, compatible: true, contentDigest: 'digest' }] }, diagnostics: [{ source: 'workspace', subject: 'bad-skill', message: 'Invalid metadata' }] }),
	setEnabled: async (id, value, expectedRevision) => { requests.push(['skill', id, value, expectedRevision]); if (expectedRevision !== revision) { throw new Error('Configuration changed. Refresh before saving.'); } enabled = value; revision++; },
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
const pluginApi: IPluginApi = {
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
services.registerInstance(IPluginService, disposables.add(new AppServerPluginService(pluginApi, { subscribe: () => ({ dispose() { } }) })));
services.registerInstance(IContextViewService, disposables.add(new BrowserContextViewService(document.body)));
services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, text, parameters) => text.replace(/\{(\d+)\}/gu, (match, index: string) => String(parameters?.[index] ?? match)) });
services.registerInstance(IRemoteAgentService, { onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None } as IRemoteAgentService);
services.registerInstance(IAccessibleViewService, { show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { }, dispose() { }, [Symbol.dispose]() { } });
services.registerInstance(ICodeEditorService, { getActiveCodeEditor: () => ({ getModel: () => ({ getLanguageId: () => 'typescriptreact' }) }) } as unknown as ICodeEditorService);
services.registerInstance(IEditorService, { onDidActiveEditorChange: Event.None } as IEditorService);
services.registerInstance(IWorkspaceContextService, { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'fixture', folders: [] }) } as unknown as IWorkspaceContextService);
const marketplace = disposables.add(services.createInstance(MarketplaceViewPane, document.getElementById('marketplace')!, { id: 'marketplace', title: 'Marketplace' }));
services.registerInstance(IViewsService, { openView: () => marketplace } as unknown as IViewsService);
const contributions = disposables.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }));
contributions.advance(WorkbenchPhase.BlockStartup);
const commands = disposables.add(new CommandService(services));
const skills = disposables.add(services.createInstance(SkillsSettingsContent, document.getElementById('skills')!));
const lsp = disposables.add(services.createInstance(LanguageServerSettingsContent, document.getElementById('lsp')!));
document.getElementById('lsp')!.append(lsp.domNode);
lsp.setInput(createSettingsEditorInput());
document.getElementById('skills')!.append(skills.domNode);
marketplace.setVisible(true); skills.setVisible(true); lsp.setVisible(true);

window.ashMarketplaceIntegration = {
	requests,
	startCommand: id => { commandCompletion = commands.executeCommand(id).catch((error: unknown) => requests.push(['commandError', String(error)])); },
	waitCommand: async () => { await commandCompletion; },
	changePluginRevision: () => { pluginRevision++; },
	removeEditorEntrypoint: () => { editorEntrypoint = null; },
	localPackages: () => structuredClone(localPackages),
	open: options => marketplace.open(options),
	setOffline: () => { offline = true; },
	changeRevision: () => { revision++; },
	startHeldSearch: () => { holdSearch = true; heldOpen = marketplace.open({ query: 'old query' }); },
	startHeldCommand: async () => { holdSearch = true; await commands.executeCommand(OPEN_MARKETPLACE_COMMAND_ID, 'held query'); },
	executeCommand: id => commands.executeCommand(id),
	failHeldSearch: async () => { rejectSearch!(new Error('Old request failed')); await heldOpen; },
	addOtherPackage: () => { installed.unshift({ ...installed[0]!, installationId: 'other-package', package: { ...reference, id: 'other@example' } }); },
	addSecondVersion: () => { installed.push({ ...installed[0]!, installationId: 'version-two', package: { ...reference, version: '2.0.0' } }); },
	dispose: () => disposables.dispose(),
};
declare global {
	interface Window {
		ashMarketplaceIntegration: { requests: unknown[]; startCommand(id: string): void; waitCommand(): Promise<void>; changePluginRevision(): void; removeEditorEntrypoint(): void; localPackages(): PluginPackageDto[]; open(options: MarketplaceOpenOptions): Promise<void>; setOffline(): void; changeRevision(): void; startHeldSearch(): void; startHeldCommand(): Promise<void>; executeCommand(id: string): Promise<void>; failHeldSearch(): Promise<void>; addOtherPackage(): void; addSecondVersion(): void; dispose(): void; };
	}
}
