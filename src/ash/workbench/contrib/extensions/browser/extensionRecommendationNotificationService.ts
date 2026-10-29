import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IAction } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IExtensionManagementService, OPEN_EXTENSIONS_COMMAND_ID, type ExtensionsPackageSummary } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IExtensionRecommendationNotificationService, RecommendationSource, RecommendationsNotificationResult, type IExtensionRecommendations } from '../../../../platform/extensionRecommendations/common/extensionRecommendations.js';
import { INotificationService, NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IWorkspaceExtensionsConfigService } from '../../../services/extensionRecommendations/common/workspaceExtensionsConfig.js';
import { IExtensionIgnoredRecommendationsService, extensionRecommendationKey as identity } from '../../../services/extensionRecommendations/common/extensionRecommendations.js';
import { changeExtensionPackage } from './extensionEditor.js';

const ignoredKey = 'extensionsAssistant/importantRecommendationsIgnore';
const ignoredWorkspaceKey = 'extensionsAssistant/workspaceRecommendationsIgnore';

/** Owns notification suppression and lifetime, while catalogs retain package and installation state. */
export class ExtensionRecommendationNotificationService extends Disposable implements IExtensionRecommendationNotificationService {
	private readonly attempted = new Set<string>();
	private readonly prompted = new Set<string>();
	private readonly notifications = this._register(new DisposableStore());
	private generation = 0;
	private shown = 0;
	private executableShown = false;
	public get ignoredRecommendations(): readonly string[] {
		try {
			const value: unknown = JSON.parse(this.storage.get(ignoredKey, StorageScope.PROFILE, '[]'));
			return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').map(identity) : [];
		} catch { return []; }
	}

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IStorageService private readonly storage: IStorageService,
		@IExtensionManagementService private readonly packages: IExtensionManagementService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IWorkspaceExtensionsConfigService private readonly workspaceConfigs: IWorkspaceExtensionsConfigService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commands: ICommandService,
		@IDialogService private readonly dialogs: IDialogService,
		@IExtensionIgnoredRecommendationsService private readonly ignored: IExtensionIgnoredRecommendationsService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
	) {
		super();
		this._register(configuration.onDidChangeConfiguration(event => {
			if ((event.affectsConfiguration('extensions.ignoreRecommendations') || event.affectsConfiguration('extensions.showRecommendationsOnlyOnDemand')) && this.hasToIgnoreRecommendationNotifications()) { this.notifications.clear(); }
		}));
		this._register(workspaceConfigs.onDidChangeExtensionsConfigs(() => { ++this.generation; this.notifications.clear(); }));
		this._register(packages.onDidChangeInstalled(() => { ++this.generation; this.notifications.clear(); }));
		this._register(ignored.onDidChangeIgnoredRecommendations(() => { ++this.generation; this.notifications.clear(); }));
		this._register(ignored.onDidChangeGlobalIgnoredRecommendation(() => { this.attempted.clear(); this.prompted.clear(); }));
		this._register(workspace.onDidChangeWorkspace(() => { this.clearSession(); }));
	}

	private clearSession(): void { ++this.generation; this.attempted.clear(); this.prompted.clear(); this.shown = 0; this.executableShown = false; this.notifications.clear(); }
	public resetIgnoredRecommendations(): void {
		this.clearSession();
		this.storage.remove(ignoredKey, StorageScope.PROFILE);
		this.storage.remove(ignoredWorkspaceKey, StorageScope.WORKSPACE);
	}

	public hasToIgnoreRecommendationNotifications(): boolean {
		return this.configuration.getValue<boolean>('extensions.ignoreRecommendations') === true || this.configuration.getValue<boolean>('extensions.showRecommendationsOnlyOnDemand') === true;
	}

	public async promptWorkspaceRecommendations(recommendations: readonly string[], signal?: AbortSignal): Promise<void> {
		if (this.storage.getBoolean(ignoredWorkspaceKey, StorageScope.WORKSPACE, false)) { return; }
		await this.promptImportantExtensionsInstallNotification({
			extensions: recommendations, source: RecommendationSource.WORKSPACE, signal,
			name: localize({ bundle: 'ash.extensions', key: 'recommendationWorkspace' }, 'this workspace'),
		});
	}

	public async promptImportantExtensionsInstallNotification(request: IExtensionRecommendations): Promise<RecommendationsNotificationResult> {
		if (this.isDisposed || request.signal?.aborted || this.hasToIgnoreRecommendationNotifications()) { return RecommendationsNotificationResult.Ignored; }
		const key = `${request.source}:${request.extensions.map(identity).sort().join(',')}`;
		if (this.attempted.has(key)) { return RecommendationsNotificationResult.Ignored; }
		this.attempted.add(key);
		const generation = this.generation;
		const [installed, configs] = await Promise.allSettled([this.packages.listInstalled(), this.workspaceConfigs.getExtensionsConfigs()]);
		if (installed.status === 'rejected' || configs.status === 'rejected') { this.attempted.delete(key); return RecommendationsNotificationResult.Ignored; }
		const excluded = new Set([
			...this.ignoredRecommendations,
			...this.ignored.ignoredRecommendations,
			...this.extensions.currentCatalog.extensions.map(extension => identity(extension.id)),
			...(installed.status === 'fulfilled' ? installed.value.map(extension => identity(extension.package.id)) : []),
			...(configs.status === 'fulfilled' ? configs.value.flatMap(config => config.unwantedRecommendations).map(identity) : []),
		]);
		const candidates: ExtensionsPackageSummary[] = [];
		for (const id of new Set(request.extensions)) {
			if (request.signal?.aborted) { break; }
			if (excluded.has(identity(id)) || this.prompted.has(identity(id))) { continue; }
			// Reserve before awaiting the registry so concurrent sources cannot suggest the same package twice.
			this.prompted.add(identity(id));
			try {
				// Package identity is resolved by the catalog owner, independently of human search terms.
				const details = await this.packages.get(id);
				candidates.push({
					id: details.package.id, version: details.package.version, packageType: details.packageType,
					displayName: details.displayName, description: details.description,
				});
			} catch { this.prompted.delete(identity(id)); /* A missing or offline registry must not interrupt editing. */ }
		}
		if (this.isDisposed || request.signal?.aborted || generation !== this.generation || this.hasToIgnoreRecommendationNotifications() || !candidates.length) {
			for (const candidate of candidates) { this.prompted.delete(identity(candidate.id)); }
			this.attempted.delete(key);
			return RecommendationsNotificationResult.Ignored;
		}
		// Keep automatic discovery quiet during a busy window. Explicit workspace recommendations
		// retain their own suppression scope, and all candidates remain available in Recommended.
		if (request.source !== RecommendationSource.WORKSPACE && (this.shown >= 3 || request.source === RecommendationSource.EXE && (this.executableShown || this.shown >= 2))) {
			for (const candidate of candidates) { this.prompted.delete(identity(candidate.id)); }
			this.attempted.delete(key);
			return RecommendationsNotificationResult.TooMany;
		}
		if (request.source !== RecommendationSource.WORKSPACE) { ++this.shown; }
		if (request.source === RecommendationSource.EXE) { this.executableShown = true; }
		// Each request completes on a user action, dismissal or window shutdown.
		return new Promise(resolve => {
			const lifetime = this.notifications.add(new DisposableStore());
			let result = RecommendationsNotificationResult.Cancelled;
			const action = (id: string, label: string, run: () => void | Promise<void>): IAction => ({
				id, label, tooltip: label, enabled: true,
				run: async () => {
					result = RecommendationsNotificationResult.Accepted;
					handle.close();
					try { await run(); } catch (error) { this.notificationService.error(error instanceof Error ? error : String(error)); }
				},
			});
			const show = action('extensions.recommendations.show', localize({ bundle: 'ash.extensions', key: 'showRecommendations' }, 'Show recommendations'), async () => {
				await this.commands.executeCommand(OPEN_EXTENSIONS_COMMAND_ID, candidates.length > 1 ? { query: '@recommended' } : { mode: 'browse', query: request.searchValue ?? candidates[0].displayName, ...(request.languageId ? { languageId: request.languageId } : {}) });
			});
			const install = action('extensions.recommendations.install', localize({ bundle: 'ash.extensions', key: 'installRecommended' }, 'Install'), async () => {
				for (const candidate of candidates) { await changeExtensionPackage(this.packages, this.dialogs, this.notificationService, 'install', await this.packages.get(candidate.id, candidate.version)); }
			});
			const never = action('extensions.recommendations.never', localize({ bundle: 'ash.extensions', key: 'neverRecommend' }, "Don't show again"), () => {
				if (request.source === RecommendationSource.WORKSPACE) { this.storage.store(ignoredWorkspaceKey, true, StorageScope.WORKSPACE, StorageTarget.USER); }
				else { this.storage.store(ignoredKey, JSON.stringify([...new Set([...this.ignoredRecommendations, ...candidates.map(candidate => identity(candidate.id))])]), StorageScope.PROFILE, StorageTarget.USER); }
			});
			const handle = this.notificationService.notify({
				severity: Severity.Info, priority: NotificationPriority.OPTIONAL,
				source: { id: 'extensions.recommendations', label: localize({ bundle: 'ash.extensions', key: 'recommendationSource' }, 'Extension recommendations') },
				message: localize({ bundle: 'ash.extensions', key: 'contextRecommendation' }, 'Recommended for {0}: {1}.', request.name, candidates.map(candidate => candidate.displayName).join(', ')),
				actions: { primary: [install, show], secondary: [never] },
			});
			lifetime.add(handle.onDidClose(() => {
				resolve(result);
				this.notifications.delete(lifetime);
				lifetime.dispose();
			}));
			lifetime.add(toDisposable(() => { handle.close(); resolve(result); }));
			if (request.signal) {
				const close = (): void => {
					// Context retirement is not a user dismissal. The still-relevant replacement context may retry.
					this.attempted.delete(key);
					for (const candidate of candidates) { this.prompted.delete(identity(candidate.id)); }
					if (request.source !== RecommendationSource.WORKSPACE) { --this.shown; }
					if (request.source === RecommendationSource.EXE) { this.executableShown = false; }
					handle.close();
				};
				request.signal.addEventListener('abort', close, { once: true });
				lifetime.add(toDisposable(() => request.signal?.removeEventListener('abort', close)));
			}
		});
	}
}
