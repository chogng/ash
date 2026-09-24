import '../../../src/ash/base/browser/ui/dialog/dialog.css';
import '../../../src/ash/base/browser/ui/button/button.css';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { ServiceContainer } from '../../../src/ash/platform/instantiation/common/instantiation.js';
import { BrowserDialogHandler } from '../../../src/ash/platform/dialogs/browser/browserDialogHandler.js';
import { DialogResult, IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { ILanguageServerService } from '../../../src/ash/platform/language/common/languageServerService.js';
import type { IMarketplaceApi } from '../../../src/ash/platform/marketplace/common/marketplaceApi.js';
import { IMarketplaceService, OPEN_MARKETPLACE_COMMAND_ID, type MarketplaceInstalledPackage, type MarketplaceOpenOptions } from '../../../src/ash/platform/marketplace/common/marketplaceService.js';
import { ISkillService } from '../../../src/ash/platform/skills/common/skillService.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { ILanguageServerStatusService } from '../../../src/ash/workbench/services/language/common/languageServerStatusService.js';
import { AppServerMarketplaceService } from '../../../src/ash/workbench/services/marketplace/browser/appServerMarketplaceService.js';
import { MarketplaceViewPane } from '../../../src/ash/workbench/contrib/marketplace/browser/marketplaceViewPane.js';
import { SkillsViewPane } from '../../../src/ash/workbench/contrib/skills/browser/skillsViewPane.js';
import { LanguageServersViewPane } from '../../../src/ash/workbench/contrib/language/browser/languageServersViewPane.js';

const disposables = new DisposableStore();
const services = disposables.add(new ServiceContainer());
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
const api: IMarketplaceApi = {
	search: async params => {
		requests.push(['search', params]);
		if (holdSearch) { holdSearch = false; await new Promise<void>((_, reject) => { rejectSearch = reject; }); }
		if (offline) { throw new Error('Catalog unavailable'); }
		return { packages: [summary] };
	},
	get: async params => { requests.push(['get', params]); if (offline) { throw new Error('Catalog unavailable'); } return { ...packageDetails, package: { ...reference, version: params.version ?? '2.0.0' } }; },
	listInstalled: async () => ({ instanceId: 'fixture', generation, packages: installed.map(entry => ({ ...entry, capabilities: entry.capabilities.map(capability => ({ ...capability, permissions: [...capability.permissions] })) })) }),
	download: async () => { throw new Error('Install owns downloading'); },
	install: async params => {
		requests.push(['install', params]);
		const entry = { installationId: 'version-one', package: { ...reference, version: params.version! }, state: 'installed' as const, capabilities: capabilities.map(capability => ({ ...capability, permissions: [...capability.permissions], reference: { id: `cap:${capability.id}` } })) };
		installed.push(entry); generation++; changed.fire(); return entry;
	},
	update: async params => {
		requests.push(['update', params]);
		const index = installed.findIndex(entry => entry.installationId === params.installationId);
		installed[index] = { ...installed[index]!, installationId: 'updated-installation', package: { ...reference, version: params.version! } }; generation++; changed.fire(); return { ...installed[index]!, capabilities: installed[index]!.capabilities.map(capability => ({ ...capability, permissions: [...capability.permissions] })) };
	},
	uninstall: async params => { requests.push(['uninstall', params]); installed = installed.filter(entry => entry.installationId !== params.installationId); generation++; changed.fire(); },
	acquireCapability: async () => { throw new Error('unused'); }, releaseCapability: async () => {}, openResource: async () => { throw new Error('unused'); },
};
services.registerInstance(IMarketplaceService, disposables.add(new AppServerMarketplaceService(api, { subscribe: listener => changed.event(() => listener({ method: 'marketplace/changed', params: { instanceId: 'fixture', generation } })) })));
services.registerInstance(IConfigurationService, { getValue: () => true } as unknown as IConfigurationService);
const dialogs = new BrowserDialogHandler(document.body);
const signal = new AbortController().signal;
services.registerInstance(IDialogService, {
	confirm: async options => await dialogs.showDialog({ kind: 'confirmation', ...options }, signal) === DialogResult.Primary,
	showMessage: async options => { await dialogs.showDialog({ kind: 'message', ...options }, signal); },
	prompt: options => dialogs.showDialog({ kind: 'prompt', ...options }, signal),
});
services.registerInstance(ICommandService, { executeCommand: async (id: string, options: MarketplaceOpenOptions) => { requests.push(['command', id, options]); if (id !== OPEN_MARKETPLACE_COMMAND_ID) { throw new Error(id); } await marketplace.open(options); } } as unknown as ICommandService);
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
	removeConfiguration: async () => {},
});
services.registerInstance(ILanguageServerStatusService, { onDidChange: Event.None, getStates: () => [{ server: 'typescript-language-server', state: 'ready' }], getProgress: () => [] });
services.registerInstance(ICodeEditorService, { getActiveCodeEditor: () => ({ getModel: () => ({ getLanguageId: () => 'typescriptreact' }) }) } as unknown as ICodeEditorService);
services.registerInstance(IEditorService, { onDidActiveEditorChange: Event.None } as IEditorService);
services.registerInstance(IWorkspaceContextService, { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ id: 'fixture', folders: [] }) } as unknown as IWorkspaceContextService);
const marketplace = disposables.add(services.createInstance(MarketplaceViewPane, document.getElementById('marketplace')!, { id: 'marketplace', title: 'Marketplace' }));
const skills = disposables.add(services.createInstance(SkillsViewPane, document.getElementById('skills')!, { id: 'skills', title: 'Skills' }));
const lsp = disposables.add(services.createInstance(LanguageServersViewPane, document.getElementById('lsp')!, { id: 'lsp', title: 'Language servers' }));
marketplace.setVisible(true); skills.setVisible(true); lsp.setVisible(true);

window.ashMarketplaceIntegration = {
	requests,
	open: options => marketplace.open(options),
	setOffline: () => { offline = true; },
	changeRevision: () => { revision++; },
	startHeldSearch: () => { holdSearch = true; heldOpen = marketplace.open({ query: 'old query' }); },
	failHeldSearch: async () => { rejectSearch!(new Error('Old request failed')); await heldOpen; },
	addOtherPackage: () => { installed.unshift({ ...installed[0]!, installationId: 'other-package', package: { ...reference, id: 'other@example' } }); },
	addSecondVersion: () => { installed.push({ ...installed[0]!, installationId: 'version-two', package: { ...reference, version: '2.0.0' } }); },
	dispose: () => disposables.dispose(),
};
declare global {
	interface Window {
		ashMarketplaceIntegration: { requests: unknown[]; open(options: MarketplaceOpenOptions): Promise<void>; setOffline(): void; changeRevision(): void; startHeldSearch(): void; failHeldSearch(): Promise<void>; addOtherPackage(): void; addSecondVersion(): void; dispose(): void };
	}
}
