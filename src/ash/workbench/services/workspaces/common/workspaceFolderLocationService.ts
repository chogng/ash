import { raceCancellationError } from '../../../../base/common/async.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isNative } from '../../../../base/common/platform.js';
import { basenameOrAuthority, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ILocalGitService } from '../../../../platform/git/common/localGitService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type {
	IFolderLocation, IFolderLocationChangeEvent, IFolderLocationGroup, IResolvedFolderLocation,
	IWorkspaceFolderLocationProvider, IWorkspaceFolderLocationService,
} from '../../../../platform/workspace/common/folderLocations.js';
import {
	getWorkspacePrimaryFolderUri, IWorkspaceContextService, type IWorkspace, type IWorkspaceFolder,
} from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';

export class WorkspaceFolderLocationService extends Disposable implements IWorkspaceFolderLocationService {
	declare readonly _serviceBrand: undefined;

	private readonly providers = new Map<string, { readonly provider: IWorkspaceFolderLocationProvider; readonly builtIn: boolean; }>();
	private readonly providerListeners = this._register(new DisposableStore());
	private readonly canSetLocationChanged = this._register(new Emitter<void>());
	private readonly locationChanged = this._register(new Emitter<IFolderLocationChangeEvent>());
	private readonly providersChanged = this._register(new Emitter<void>());
	private readonly locationsChanged = this._register(new Emitter<void>());
	readonly onDidChangeCanSetLocation = this.canSetLocationChanged.event;
	readonly onDidChangeLocation = this.locationChanged.event;
	readonly onDidChangeProviders = this.providersChanged.event;
	readonly onDidChangeLocations = this.locationsChanged.event;

	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILocalGitService git: ILocalGitService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(toDisposable(() => this.providers.clear()));
		this._register(workspace.onDidChangeWorkspace(({ previous, workspace }) => {
			const folder = workspace.folders[0];
			const previousFolder = previous.folders[0];
			const changedLocation = folder && previousFolder && !sameFolderLocation(folder.uri, previousFolder.uri);
			if (changedLocation && workspace.id === previous.id && workspace.folderLocation) {
				this.locationChanged.fire({ folder, reason: workspace.folderLocation.reason });
			}
			if (changedLocation || workspace.id !== previous.id || this.supportsLocations(workspace) !== this.supportsLocations(previous)) {
				this.canSetLocationChanged.fire();
			}
		}));
		if (isNative) {
			const provideLocations = async (primary: URI, token: CancellationToken): Promise<IFolderLocation[]> => {
				if (primary.scheme !== Schemas.file) return [];
				const worktrees = await git.listWorktrees(token, primary.fsPath);
				return worktrees.map(worktree => ({ uri: URI.file(worktree.path), label: worktree.label, description: worktree.path }));
			};
			this._register(this.registerProvider({
				id: 'git-worktrees',
				label: localize('workspace.folderLocation.worktrees', 'Git Worktrees'),
				provideLocations,
				resolveLocation: async (primary, location, token) =>
					(await provideLocations(primary, token)).find(candidate => sameFolderLocation(candidate.uri, location)),
			}, { builtIn: true }));
		}
	}

	private supportsLocations(workspace: IWorkspace): boolean {
		return isNative && !workspace.remoteAuthority && getWorkspacePrimaryFolderUri(workspace)?.scheme === Schemas.file;
	}

	canSetLocation(folder: IWorkspaceFolder): boolean {
		const workspace = this.workspace.getWorkspace();
		const current = workspace.folders[0];
		return !!current && this.supportsLocations(workspace) && current.id === folder.id && sameFolderLocation(current.uri, folder.uri);
	}

	getLocation(folder: IWorkspaceFolder): IResolvedFolderLocation | undefined {
		const alternate = this.workspace.getWorkspace().folderLocation?.alternate;
		return alternate && this.canSetLocation(folder) ? { ...alternate, uri: folder.uri } : undefined;
	}

	isAtAlternateLocation(folder: IWorkspaceFolder): boolean {
		return this.getLocation(folder) !== undefined;
	}

	registerProvider(provider: IWorkspaceFolderLocationProvider, options?: { readonly builtIn?: boolean; }): ReturnType<IWorkspaceFolderLocationService['registerProvider']> {
		this.assertNotDisposed();
		if (this.providers.has(provider.id)) throw new Error(`Folder location provider already registered: ${provider.id}`);
		const entry = { provider, builtIn: options?.builtIn ?? false };
		this.providers.set(provider.id, entry);
		const listener = provider.onDidChangeLocations?.(() => this.locationsChanged.fire());
		if (listener) this.providerListeners.add(listener);
		this.providersChanged.fire();
		return toDisposable(() => {
			if (listener && this.providerListeners.delete(listener)) listener.dispose();
			if (this.providers.delete(provider.id)) this.providersChanged.fire();
		});
	}

	async getLocations(primary: URI, token: CancellationToken): Promise<IFolderLocation[]> {
		return (await this.getLocationGroups(primary, token)).flatMap(group => group.locations);
	}

	async getLocationGroups(primary: URI, token: CancellationToken): Promise<IFolderLocationGroup[]> {
		const entries = [...this.providers.values()];
		const results = await this.queryProviders(entries, token, provider => provider.provideLocations(primary, token));
		const seen = new Set([locationKey(primary)]);
		const groups: IFolderLocationGroup[] = [];
		for (const [index, candidates] of results.entries()) {
			const entry = entries[index]!;
			if (this.providers.get(entry.provider.id) !== entry || !candidates) continue;
			const locations = candidates.filter(candidate => {
				const key = locationKey(candidate.uri);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
			if (locations.length) groups.push({ label: entry.provider.label, locations });
		}
		return groups;
	}

	async getFolderLocations(folder: IWorkspaceFolder, token: CancellationToken): Promise<IFolderLocation[]> {
		const canSet = this.canSetLocation(folder);
		const primary = canSet ? getWorkspacePrimaryFolderUri(this.workspace.getWorkspace())! : folder.uri;
		const location = { uri: primary, label: basenameOrAuthority(primary) };
		return canSet ? [location, ...await this.getLocations(primary, token)] : [location];
	}

	async resolveLocation(primary: URI, location: URI, token: CancellationToken): Promise<IResolvedFolderLocation | undefined> {
		if (sameFolderLocation(primary, location)) return undefined;
		const entries = [...this.providers.values()];
		const results = await this.queryProviders(entries, token, provider => provider.resolveLocation(primary, location, token));
		for (const [index, result] of results.entries()) {
			const entry = entries[index]!;
			if (result && sameFolderLocation(result.uri, location) && this.providers.get(entry.provider.id) === entry) {
				return { ...result, providerId: entry.provider.id, builtIn: entry.builtIn, group: entry.provider.label };
			}
		}
		return undefined;
	}

	private async queryProviders<T>(
		entries: readonly { readonly provider: IWorkspaceFolderLocationProvider; }[],
		token: CancellationToken,
		query: (provider: IWorkspaceFolderLocationProvider) => Promise<T>,
	): Promise<(T | undefined)[]> {
		if (token.isCancellationRequested || this.isDisposed) throw new CancellationError();
		const results = await raceCancellationError(Promise.all(entries.map(async ({ provider }) => {
			try {
				return await query(provider);
			} catch (error) {
				if (!isCancellationError(error)) this.log.warn(`Folder location provider '${provider.id}' failed`, error);
				return undefined;
			}
		})), token);
		if (token.isCancellationRequested || this.isDisposed) throw new CancellationError();
		return results;
	}
}

function locationKey(location: URI): string {
	const path = location.path.length > 1 ? location.path.replace(/\/+$/u, '') : location.path;
	return extUriBiasedIgnorePathCase.getComparisonKey(location.with({ path }));
}

function sameFolderLocation(left: URI, right: URI): boolean {
	return locationKey(left) === locationKey(right);
}
