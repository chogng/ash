import { extensionTips, type ProductExtensionTip } from '../../../../platform/extensionManagement/common/extensionTipsService.js';
import { isWeb } from '../../../../base/common/platform.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';
import { localize } from '../../../../nls.js';
import { Emitter } from '../../../../base/common/event.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { extname } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ILanguageServerService } from '../../../../platform/language/common/languageServerService.js';
import { ExtensionUiTarget, IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { RecommendationSource } from '../../../../platform/extensionRecommendations/common/extensionRecommendations.js';
import { IFileService, FileKind, FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IFileTextModelService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { IWorkspaceExtensionsConfigService } from '../../../services/extensionRecommendations/common/workspaceExtensionsConfig.js';
import { ExtensionRecommendationReason, IExtensionIgnoredRecommendationsService, extensionRecommendationKey as identity, type ExtensionRecommendation, type ExtensionRecommendationsSnapshot, type IExtensionRecommendationsService } from '../../../services/extensionRecommendations/common/extensionRecommendations.js';

const recentKey = 'extensionsAssistant/recentRecommendations';
const recentDuration = 7 * 24 * 60 * 60 * 1000;
const editorTips = extensionTips.editors;
const projectLanguages = extensionTips.projects;

/** Derives recommendations from the current editors, language catalog and workspace declarations. */
export class ExtensionRecommendationsService extends Disposable implements IExtensionRecommendationsService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeRecommendations = this.changed.event;
	private readonly watches = this._register(new DisposableStore());
	private readonly requestedResources = new Map<string, URI>();
	private generation = 0;
	private pending: Promise<ExtensionRecommendationsSnapshot> | undefined;

	constructor(
		public readonly target: ExtensionUiTarget,
		@IWorkspaceExtensionsConfigService private readonly configs: IWorkspaceExtensionsConfigService,
		@IFileTextModelService private readonly models: IFileTextModelService,
		@IModelService private readonly editorModels: IModelService,
		@IEditorService private readonly editors: IEditorService,
		@ILanguageService private readonly languages: ILanguageService,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
		@ILanguageServerService private readonly languageServers: ILanguageServerService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IFileService private readonly files: IFileService,
		@IExtensionManagementService private readonly packages: IExtensionManagementService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IStorageService private readonly storage: IStorageService,
		@IExtensionIgnoredRecommendationsService private readonly ignored: IExtensionIgnoredRecommendationsService,
		@IUriIdentityService private readonly uriIdentity: IUriIdentityService,
		@IAppServerRemoteAgentService private readonly remote: IAppServerRemoteAgentService,
	) {
		super();
		for (const event of [configs.onDidChangeExtensionsConfigs, editors.onDidActiveEditorChange, editors.onDidVisibleEditorsChange, languages.onDidChange, packages.onDidChangeInstalled, extensions.onDidChange]) {
			this._register(event(() => this.invalidate()));
		}
		this._register(models.onModelAdded(() => this.invalidate()));
		this._register(models.onModelRemoved(() => this.invalidate()));
		this._register(models.onModelLanguageChanged(() => this.invalidate()));
		this._register(editorModels.onModelAdded(() => this.invalidate()));
		this._register(editorModels.onModelRemoved(() => this.invalidate()));
		this._register(editorModels.onModelLanguageChanged(() => this.invalidate()));
		this._register(ignored.onDidChangeIgnoredRecommendations(() => this.invalidate()));
		this._register(languageFeatures.hoverProvider.onDidChange(() => this.invalidate()));
		this._register(storage.onDidChangeValue(event => { if (event.external && event.scope === StorageScope.PROFILE && event.key === this.recentStorageKey) { this.invalidate(); } }));
		this._register(workspace.onDidChangeWorkspace(() => { this.requestedResources.clear(); this.watchProjects(); this.invalidate(); }));
		this._register(files.onDidChangeFileSystemProviderRegistrations(() => { this.watchProjects(); this.invalidate(); }));
		this._register(files.onDidChangeFiles(event => {
			if (!event.resources || this.projectResources().some(({ resource }) => event.resources!.some(changed => uriIdentity.extUri.isEqual(changed, resource) || uriIdentity.extUri.isEqual(changed, dirname(resource))))) { this.invalidate(); }
		}));
		this._register(remote.onDidChangeConnection(() => this.invalidate()));
		this._register(remote.onDidChangeConnectionState(() => this.invalidate()));
		this.watchProjects();
	}

	private invalidate(): void { ++this.generation; this.pending = undefined; this.changed.fire(); }
	public refresh(): void { this.configs.refresh(); }
	public recommendForResource(resource: URI): void {
		// These are recommendation intents, not an additional catalog of open documents.
		this.requestedResources.set(this.uriIdentity.extUri.getComparisonKey(resource), resource);
		if (this.requestedResources.size > 32) { this.requestedResources.delete(this.requestedResources.keys().next().value!); }
		this.invalidate();
	}

	public getRecommendations(): Promise<ExtensionRecommendationsSnapshot> {
		this.assertNotDisposed();
		return this.pending ??= this.collect(this.generation);
	}

	private async collect(generation: number): Promise<ExtensionRecommendationsSnapshot> {
		const folders = this.workspace.getWorkspace().folders;
		const [declared, configs, installed, serverLanguages] = await Promise.all([
			this.getWorkspaceRecommendations(), this.configs.getExtensionsConfigs(), this.packages.listInstalled(),
			Promise.all(folders.map(async folder => {
				try {
					// Discovery advertises enabled servers before first use without launching them.
					const snapshot = await this.languageServers.read(folders.length > 1 ? folder.id : undefined);
					return [folder.id, new Set(snapshot.servers.flatMap(server => server.languageIds))] as const;
				} catch { return [folder.id, new Set<string>()] as const; }
			})).then(entries => new Map(entries)),
		]);
		const excluded = new Set([
			...this.ignored.globalIgnoredRecommendations,
			...configs.flatMap(config => config.unwantedRecommendations).map(identity),
			...installed.map(item => identity(item.package.id)),
			...this.extensions.currentCatalog.extensions.map(item => identity(item.id)),
		]);
		const recommendations = new Map<string, ExtensionRecommendation>();
		const add = (recommendation: ExtensionRecommendation): void => {
			if (recommendation.uiTargets && !recommendation.uiTargets.includes(this.target)) { return; }
			const key = identity(recommendation.extensionId);
			if (!excluded.has(key) && !recommendations.has(key)) { recommendations.set(key, recommendation); }
		};
		const targetQueries = new Map<string, Promise<readonly ExtensionUiTarget[] | undefined>>();
		const targetsFor = (extensionId: string): Promise<readonly ExtensionUiTarget[] | undefined> => {
			const key = identity(extensionId);
			let query = targetQueries.get(key);
			if (!query) { query = this.getRecommendationTargets(extensionId); targetQueries.set(key, query); }
			return query;
		};
		for (const recommendation of declared.recommendations) {
			if (excluded.has(identity(recommendation.extensionId))) { continue; }
			const uiTargets = await targetsFor(recommendation.extensionId);
			// Unresolved declarations remain inspectable, without assuming they suit both windows.
			add({ ...recommendation, uiTargets, ...(uiTargets?.includes(this.target) ? { context: { source: RecommendationSource.WORKSPACE, name: localize({ bundle: 'ash.extensions', key: 'recommendationWorkspace' }, 'this workspace') } } : {}) });
		}
		const languageQueries = new Map<string, ReturnType<IExtensionManagementService['search']>>();
		const forLanguage = async (languageId: string, name: string, reasonId: ExtensionRecommendationReason, resource: URI): Promise<void> => {
			const folder = this.workspace.getWorkspaceFolder(resource) ?? folders[0];
			const hasProvider = [...this.editorModels.getModels(), ...this.models.getModels()].some(model =>
				model.getLanguageId() === languageId
				&& (this.uriIdentity.extUri.isEqual(model.uri, resource) || reasonId === ExtensionRecommendationReason.WorkspaceConfig && this.workspace.getWorkspaceFolder(model.uri)?.id === folder?.id)
				&& this.languageFeatures.hoverProvider.has(model));
			if (languageId === 'plaintext' || hasProvider || folder && serverLanguages.get(folder.id)?.has(languageId)) { return; }
			let query = languageQueries.get(languageId);
			if (!query) {
				// A recognized language already has its declarations. Search only exact server
				// routes; free-text metadata also matches unrelated associations such as .css.map.
				query = this.packages.search('', { languageId, capabilityKind: 'executable', limit: 5 }).catch(() => []);
				languageQueries.set(languageId, query);
			}
			try {
				for (const candidate of await query) {
					add({ extensionId: candidate.id, uiTargets: candidate.uiTargets, reason: { reasonId, reasonText: localize({ bundle: 'ash.extensions', key: 'contextRecommendationReason' }, 'Recommended for {0}', name) }, ...(candidate.uiTargets?.includes(this.target) ? { context: { source: reasonId === ExtensionRecommendationReason.WorkspaceConfig ? RecommendationSource.WORKSPACE : RecommendationSource.FILE, name, ...(candidate.packageType === 'language' ? { searchValue: languageId } : { languageId, searchValue: '' }) } } : {}) });
				}
			} catch { /* Offline language discovery must not prevent declared or editor recommendations. */ }
		};
		const resources = new Map<string, { resource: URI; languageId?: string; }>();
		for (const resource of this.requestedResources.values()) { resources.set(this.uriIdentity.extUri.getComparisonKey(resource), { resource }); }
		for (const input of this.editors.visibleEditors) { resources.set(this.uriIdentity.extUri.getComparisonKey(input.resource), { resource: input.resource, languageId: input.languageId }); }
		const directResources = new Set(resources.keys());
		for (const model of [...this.editorModels.getModels(), ...this.models.getModels()]) {
			const key = this.uriIdentity.extUri.getComparisonKey(model.uri);
			// Agents can load documents for execution and previews. Only an actual editor or
			// explicit editor request establishes a recommendation context in that window.
			if (!model.isForSimpleWidget && (this.target === ExtensionUiTarget.IDE || directResources.has(key))) {
				resources.set(key, { resource: model.uri, languageId: model.getLanguageId() });
			}
		}
		const work: Promise<void>[] = [];
		for (const { resource, languageId } of resources.values()) {
			if (!['file', 'untitled', 'ash-remote', ...this.workspace.getWorkspace().folders.map(folder => folder.uri.scheme)].includes(resource.scheme)) { continue; }
			const extension = extname(resource.path).toLowerCase();
			const tip = editorTips.find(tip => (tip.extensions as readonly string[]).includes(extension));
			if (tip) {
				const uiTargets = await targetsFor(tip.id);
				const name = tip.kind === 'docs' ? localize({ bundle: 'ash.extensions', key: 'recommendationDocs' }, 'Docs') : localize({ bundle: 'ash.extensions', key: 'recommendationPdf' }, 'PDF');
				add({ extensionId: tip.id, uiTargets, reason: { reasonId: ExtensionRecommendationReason.File, reasonText: localize({ bundle: 'ash.extensions', key: 'fileRecommendationReason' }, 'Recommended for {0} files', extension) }, ...(uiTargets?.includes(this.target) ? { context: { source: RecommendationSource.FILE, name, searchValue: tip.query } } : {}) });
			}
			const language = languageId && languageId !== 'plaintext' ? languageId : this.languages.guessLanguageIdByFilepathOrFirstLine(resource);
			if (language) { work.push(forLanguage(language, this.languages.getLanguageName(language) ?? language, ExtensionRecommendationReason.Application, resource)); }
			else if (!tip && extension) {
				// Language packages publish file extensions in their searchable catalog metadata, even before installation.
				const key = `file:${extension}`;
				let query = languageQueries.get(key);
				if (!query) { query = this.packages.search(extension, { packageType: 'language', limit: 5 }); languageQueries.set(key, query); }
				work.push(query.then(candidates => {
					for (const candidate of candidates) {
						add({ extensionId: candidate.id, uiTargets: candidate.uiTargets, reason: { reasonId: ExtensionRecommendationReason.File, reasonText: localize({ bundle: 'ash.extensions', key: 'fileRecommendationReason' }, 'Recommended for {0} files', extension) }, ...(candidate.uiTargets?.includes(this.target) ? { context: { source: RecommendationSource.FILE, name: extension, searchValue: extension } } : {}) });
					}
				}, () => { /* Missing catalogs leave the built-in editor available. */ }));
			}
		}
		await Promise.all(work);
		const diagnostics = [...declared.diagnostics];
		await Promise.all(this.projectResources().map(async ({ resource, language }) => {
			try {
				if ((await this.files.stat(resource)).kind === FileKind.File) { await forLanguage(language, basename(resource), ExtensionRecommendationReason.WorkspaceConfig, resource); }
			} catch (error) {
				if (toFileSystemProviderErrorCode(error instanceof Error ? error : undefined) !== FileSystemProviderErrorCode.FileNotFound) {
					diagnostics.push(localize({ bundle: 'ash.extensions', key: 'projectRecommendationsReadError' }, 'Could not inspect {0}: {1}', resource.toString(), error instanceof Error ? error.message : String(error)));
				}
			}
		}));
		// Stronger file and project evidence must win over host-tool discovery for the same package.
		await this.collectProductRecommendations(add);
		if (this.isDisposed || generation !== this.generation) { throw new CancellationError(); }
		const recent = this.readRecent();
		for (const recommendation of recommendations.values()) {
			if (recommendation.context?.source === RecommendationSource.FILE) { recent[recommendation.extensionId] = Date.now(); }
		}
		const remembered = Object.entries(recent).sort((a, b) => b[1] - a[1]).slice(0, 200);
		const serialized = JSON.stringify(Object.fromEntries(remembered));
		if (serialized !== this.storage.get(this.recentStorageKey, StorageScope.PROFILE, '{}')) { this.storage.store(this.recentStorageKey, serialized, StorageScope.PROFILE, StorageTarget.MACHINE); }
		for (let index = 0; index < remembered.length; index += 6) {
			const group = remembered.slice(index, index + 6).filter(([id]) => !excluded.has(identity(id)) && !recommendations.has(identity(id)));
			const targets = await Promise.all(group.map(([id]) => targetsFor(id)));
			if (this.isDisposed || generation !== this.generation) { throw new CancellationError(); }
			for (const [offset, [extensionId]] of group.entries()) {
				add({ extensionId, uiTargets: targets[offset], reason: { reasonId: ExtensionRecommendationReason.File, reasonText: localize({ bundle: 'ash.extensions', key: 'recentRecommendationReason' }, 'Recommended because of recently opened files') } });
			}
		}
		if (this.isDisposed || generation !== this.generation) { throw new CancellationError(); }
		return { recommendations: [...recommendations.values()], resources: declared.resources, diagnostics };
	}

	private async getRecommendationTargets(extensionId: string): Promise<readonly ExtensionUiTarget[] | undefined> {
		try { return (await this.packages.get(extensionId)).uiTargets; }
		catch { return undefined; }
	}

	private async collectProductRecommendations(add: (recommendation: ExtensionRecommendation) => void): Promise<void> {
		const remoteWorkspace = !!this.workspace.getWorkspace().remoteAuthority || !!this.remote.connection && this.remote.connection.kind !== 'local';
		const candidates: { tip: ProductExtensionTip; reason: string; executable?: boolean; }[] = (this.target === ExtensionUiTarget.IDE ? extensionTips.keymaps : []).map(tip => ({ tip, reason: localize({ bundle: 'ash.extensions', key: 'keymapRecommendationReason' }, 'Keymap recommended for {0}', tip.name) }));
		if (remoteWorkspace && this.target === ExtensionUiTarget.IDE) { candidates.push(...extensionTips.remote.map(tip => ({ tip, reason: localize({ bundle: 'ash.extensions', key: 'remoteRecommendationReason' }, 'Recommended for remote workspaces') }))); }
		if (isWeb) { candidates.push(...extensionTips.web.map(tip => ({ tip, reason: localize({ bundle: 'ash.extensions', key: 'webRecommendationReason' }, 'Recommended for Ash in a browser') }))); }
		try {
			const tips = (this.target === ExtensionUiTarget.IDE ? extensionTips.executables : []);
			const environment = tips.length ? await this.packages.recommendationEnvironment() : undefined;
			for (const tip of tips) {
				if (tip.executables.some(name => environment?.executables.includes(name))) {
					candidates.push({ tip, reason: localize({ bundle: 'ash.extensions', key: 'executableRecommendationReason' }, 'Recommended because {0} is available on this host', tip.name), executable: true });
				}
			}
		} catch { /* Older or disconnected hosts still support file and workspace recommendations. */ }
		await Promise.all(candidates.map(async ({ tip, reason, executable }) => {
			try {
				const details = await this.packages.get(tip.id);
				if (this.target === ExtensionUiTarget.Agents && !details.uiTargets?.includes(this.target)) { return; }
				// Host tools may be installed for unrelated work. Keep these tips on demand;
				// file and project discovery supply automatic contexts when support is relevant.
				add({ extensionId: details.package.id, uiTargets: details.uiTargets, reason: { reasonId: executable ? ExtensionRecommendationReason.Executable : ExtensionRecommendationReason.Application, reasonText: reason } });
			} catch { /* A product catalog entry is only offered when an enabled source can resolve it. */ }
		}));
	}

	private get recentStorageKey(): string { return this.target === ExtensionUiTarget.IDE ? recentKey : `${recentKey}/agents`; }

	private readRecent(): Record<string, number> {
		try {
			const value: unknown = JSON.parse(this.storage.get(this.recentStorageKey, StorageScope.PROFILE, '{}'));
			if (!value || typeof value !== 'object' || Array.isArray(value)) { return {}; }
			const now = Date.now();
			return Object.fromEntries(Object.entries(value).slice(0, 2000).filter(([id, time]) => /^[a-z0-9][a-z0-9_.@/-]{0,255}$/iu.test(id) && typeof time === 'number' && Number.isFinite(time) && time <= now && now - time < recentDuration));
		} catch { return {}; }
	}

	private projectResources(): { resource: URI; language: string; }[] {
		return this.target !== ExtensionUiTarget.IDE ? [] : this.workspace.getWorkspace().folders.flatMap(folder => projectLanguages.map(tip => ({ resource: URI.joinPath(folder.uri, tip.filename), language: tip.language })));
	}
	private watchProjects(): void {
		this.watches.clear();
		if (this.target !== ExtensionUiTarget.IDE) { return; }
		for (const folder of this.workspace.getWorkspace().folders) {
			try {
				if (this.files.hasProvider(folder.uri)) { this.watches.add(this.files.watch(folder.uri, { recursive: false, excludes: [] })); }
			} catch { /* Optional discovery cannot prevent opening a workspace whose provider cannot watch. */ }
		}
	}
	public async getWorkspaceRecommendations(): Promise<ExtensionRecommendationsSnapshot> {
		const configs = await this.configs.getExtensionsConfigs();
		const excluded = new Set(configs.flatMap(config => config.unwantedRecommendations));
		const ids = new Set(configs.flatMap(config => config.recommendations));
		return {
			recommendations: [...ids].filter(id => !excluded.has(id)).map(extensionId => ({ extensionId, reason: { reasonId: ExtensionRecommendationReason.Workspace, reasonText: localize({ bundle: 'ash.extensions', key: 'workspaceRecommendationReason' }, 'Recommended by this workspace') } })),
			resources: configs.map(config => config.resource),
			diagnostics: configs.flatMap(config => config.diagnostic ? [config.diagnostic] : []),
		};
	}
}
