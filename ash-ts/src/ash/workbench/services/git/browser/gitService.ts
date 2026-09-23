import type { ConfigReadResult, GitConfigDto, GitHeadDto, GitRepositoryChangeDto, GitRepositoryDto, GitStatusResult } from "../../../../platform/app-server/common/generated/index.js";
import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { URI } from "../../../../base/common/uri.js";
import type { AppServerConnectionState, IAppServerApi, IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IGitApi } from "../../../../platform/git/common/gitApi.js";
import { ILogService } from '../../../../platform/log/common/log.js';
import { getRemoteWorkspacePath, isRemoteResource } from "../../../../platform/remote/common/remote.js";
import type { IWorkspaceContextService, IWorkspaceFolder } from "../../../../platform/workspace/common/workspace.js";
import type { GitBranch, GitChangeFile, GitChangeFileComparison, GitCommitChanges, GitCommitFile, GitCommitResult, GitCommitSummary, GitHead, GitRepository, GitRepositoryChange, GitStatus, GraphPage, GraphQuery, IGitService } from "../common/gitService.js";
import { GitConfiguration, type GitAutofetch } from '../common/gitConfiguration.js';

export interface GitServiceOptions {
	readonly api: IGitApi;
	readonly appServerApi: IAppServerApi;
	readonly eventApi: IServerEventApi;
	readonly workspaceContext: IWorkspaceContextService;
}

/** App Server-backed implementation of the frontend Git repository collection. */
export class GitService extends Disposable implements IGitService {
	private readonly _onDidChangeStatus = this._register(new Emitter<GitStatus>());
	private readonly _onDidChangeRepositoryStatus = this._register(new Emitter<GitStatus>());
	private readonly _onDidChangeRepositories = this._register(new Emitter<readonly GitRepository[]>());
	private readonly _onDidChangeActiveRepository = this._register(new Emitter<GitRepository | undefined>());
	private readonly _onDidBecomeReady = this._register(new Emitter<void>());
	private readonly _onDidChangeAutoFetch = this._register(new Emitter<void>());
	private readonly api: IGitApi;
	private repositoryList: readonly GitRepository[] = Object.freeze([]);
	private activeRepositoryId: string | undefined;
	private discoveryGeneration = 0;
	private selectionGeneration = 0;
	private discovery: Promise<readonly GitRepository[]> | undefined;
	private connectionRevision = 0;
	private configRevision = -1;
	private autoFetchValue: GitAutofetch = false;
	private autoFetchPeriodValue = 180;
	private legacyMigration: Promise<void> | undefined;

	readonly onDidChangeStatus = this._onDidChangeStatus.event;
	readonly onDidChangeRepositoryStatus = this._onDidChangeRepositoryStatus.event;
	readonly onDidChangeRepositories = this._onDidChangeRepositories.event;
	readonly onDidChangeActiveRepository = this._onDidChangeActiveRepository.event;
	readonly onDidBecomeReady = this._onDidBecomeReady.event;
	readonly onDidChangeAutoFetch = this._onDidChangeAutoFetch.event;
	get autoFetch(): GitAutofetch { return this.autoFetchValue; }
	get autoFetchPeriod(): number { return this.autoFetchPeriodValue; }

	get repositories(): readonly GitRepository[] {
		return this.repositoryList;
	}

	get activeRepository(): GitRepository | undefined {
		return this.repositoryList.find(repository => repository.id === this.activeRepositoryId);
	}

	constructor(
		private readonly options: GitServiceOptions,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.api = options.api;
		const events = options.eventApi.subscribe(event => {
			if (event.method === 'config/changed') {
				void this.refreshAutoFetch().catch(error => this.logService.error('git', 'Unable to read automatic Git fetch settings', error));
				return;
			}
			if (event.method !== "git/statusChanged" || !this.hasWorkspaceFolder()) return;
			const repository = this.repositoryList.find(candidate => candidate.id === event.params.status.repositoryId);
			if (!repository) {
				void this.refreshRepositories().catch(() => undefined);
				return;
			}
			this.acceptStatus(toGitStatus(event.params.status, repository));
		});
		this._register(toDisposable(() => events.dispose()));
		const handleConnectionState = (state: AppServerConnectionState): void => {
			const revision = ++this.connectionRevision;
			if (state !== 'ready') this.configRevision = -1;
			if (state === 'ready') void this.refreshAutoFetch().catch(error => this.logService.error('git', 'Unable to read automatic Git fetch settings', error));
			if (state === 'ready' && !this.hasWorkspaceFolder()) {
				return;
			}
			if (state === 'ready' && this.hasWorkspaceFolder()) {
				void this.refreshRepositories().then(() => {
					if (this.isDisposed || revision !== this.connectionRevision) return;
				}).catch(error => this.logService.error('git', 'Unable to discover repositories', error));
			}
		};
		const connection = options.appServerApi.onConnectionState(handleConnectionState);
		this._register(toDisposable(() => connection.dispose()));
		const connectionRevision = this.connectionRevision;
		void options.appServerApi.getConnectionState().then(state => {
			if (this.isDisposed || connectionRevision !== this.connectionRevision) return;
			handleConnectionState(state);
		}).catch(error => this.logService.error('git', 'Unable to read App Server connection state', error));
		this._register(options.workspaceContext.onDidChangeWorkspace(({ workspace }) => {
			this.clearRepositories();
			if (workspace.folders.length > 0) void this.refreshRepositories().catch(error => this.logService.error('git', 'Unable to discover repositories', error));
		}));
	}

	async listRepositories(): Promise<readonly GitRepository[]> {
		this.requireWorkspaceFolders();
		return this.refreshRepositories();
	}

	async selectRepository(repositoryId: string): Promise<GitStatus> {
		const selection = ++this.selectionGeneration;
		const repository = await this.requireRepository(repositoryId);
		const status = toGitStatus(await this.api.status({ repositoryId: repository.id }), repository);
		if (selection !== this.selectionGeneration) return status;
		if (this.activeRepositoryId !== repository.id) {
			this.activeRepositoryId = repository.id;
			this._onDidChangeActiveRepository.fire(repository);
		}
		this.acceptStatus(status);
		this._onDidBecomeReady.fire();
		return status;
	}

	repositoryForResource(resource: URI): GitRepository | undefined {
		let match: GitRepository | undefined;
		for (const repository of this.repositoryList) {
			if (!isEqualOrParent(resource, repository.root)) continue;
			if (!match || repositoryPath(repository.root).length > repositoryPath(match.root).length) match = repository;
		}
		return match;
	}

	async status(repositoryId?: string): Promise<GitStatus> {
		const repository = await this.requireRepository(repositoryId);
		return toGitStatus(await this.api.status({ repositoryId: repository.id }), repository);
	}

	async history(repositoryId?: string): Promise<readonly GitCommitSummary[]> {
		const repository = await this.requireRepository(repositoryId);
		const result = await this.api.history({ repositoryId: repository.id });
		return result.commits.map(commit => ({ ...commit, repositoryId: repository.id }));
	}

	async branches(repositoryId?: string): Promise<readonly GitBranch[]> {
		const repository = await this.requireRepository(repositoryId);
		const result = await this.api.branches({ repositoryId: repository.id });
		return result.branches.map(branch => ({ ...branch, upstream: branch.upstream ?? undefined }));
	}

	async switchBranch(name: string, repositoryId?: string): Promise<GitStatus> {
		const repository = await this.requireRepository(repositoryId);
		return toGitStatus((await this.api.switchBranch({ repositoryId: repository.id, name })).status, repository);
	}

	async graph(query: GraphQuery, repositoryId?: string): Promise<GraphPage> {
		const repository = await this.requireRepository(repositoryId);
		const result = await this.api.graph({ repositoryId: repository.id, limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) });
		return {
			commits: result.commits.map(commit => ({ ...commit, repositoryId: repository.id, parentObjectIds: [...commit.parentObjectIds] })),
			references: result.references.map(reference => ({ ...reference, remoteName: reference.remoteName ?? undefined })),
			remotes: result.remotes.map(remote => ({ name: remote.name, identity: remote.identity ? { ...remote.identity } : undefined })),
			hasMore: result.hasMore,
			nextCursor: result.nextCursor,
		};
	}

	async commitChanges(objectId: string, repositoryId?: string): Promise<GitCommitChanges> {
		const repository = await this.requireRepository(repositoryId);
		const result = await this.api.commitChanges({ repositoryId: repository.id, objectId });
		return {
			parentObjectId: result.parentObjectId ?? undefined,
			changes: result.changes.map(change => ({ ...change, originalPath: change.originalPath ?? undefined })),
		};
	}

	async commitFile(objectId: string, path: string, repositoryId?: string): Promise<GitCommitFile> {
		const repository = await this.requireRepository(repositoryId);
		const result = await this.api.commitFile({ repositoryId: repository.id, objectId, path });
		return { original: { ...result.original }, modified: { ...result.modified } };
	}

	async changeFile(path: string, comparison: GitChangeFileComparison, repositoryId?: string): Promise<GitChangeFile> {
		const repository = await this.requireRepository(repositoryId);
		const result = await this.api.changeFile({ repositoryId: repository.id, path, comparison });
		return { original: { ...result.original }, modified: { ...result.modified } };
	}

	async stage(paths: readonly string[], repositoryId?: string): Promise<GitStatus> {
		const repository = await this.requireRepository(repositoryId);
		return toGitStatus((await this.api.stage({ repositoryId: repository.id, paths: [...paths] })).status, repository);
	}

	async unstage(paths: readonly string[], repositoryId?: string): Promise<GitStatus> {
		const repository = await this.requireRepository(repositoryId);
		return toGitStatus((await this.api.unstage({ repositoryId: repository.id, paths: [...paths] })).status, repository);
	}

	async discardWorktree(paths: readonly string[], repositoryId?: string): Promise<GitStatus> {
		const repository = await this.requireRepository(repositoryId);
		return toGitStatus((await this.api.discardWorktree({ repositoryId: repository.id, paths: [...paths] })).status, repository);
	}

	async commit(message: string, repositoryId?: string): Promise<GitCommitResult> {
		const repository = await this.requireRepository(repositoryId);
		const result = await this.api.commit({ repositoryId: repository.id, message });
		return { objectId: result.objectId, status: toGitStatus(result.status, repository) };
	}

	async fetch(repositoryId?: string): Promise<GitStatus> {
		const repository = await this.requireRepository(repositoryId);
		return toGitStatus((await this.api.fetch({ repositoryId: repository.id, mode: 'all' })).status, repository);
	}

	async pull(repositoryId?: string): Promise<GitStatus> {
		const repository = await this.requireRepository(repositoryId);
		return toGitStatus((await this.api.pull({ repositoryId: repository.id })).status, repository);
	}

	async push(repositoryId?: string): Promise<GitStatus> {
		const repository = await this.requireRepository(repositoryId);
		return toGitStatus((await this.api.push({ repositoryId: repository.id })).status, repository);
	}

	async setAutoFetch(value: GitAutofetch): Promise<void> {
		await this.ensureLegacyMigration();
		const current = await this.api.readConfig();
		await this.api.updateConfig({
			commandId: `desktop-git-${crypto.randomUUID()}`,
			expectedRevision: current.revision,
			git: { ...current.git, autofetch: value === false ? 'off' : value === true ? 'default' : 'all' },
		});
		await this.refreshAutoFetch();
	}

	async setAutoFetchPeriod(seconds: number): Promise<void> {
		if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) throw new RangeError('git.autofetchPeriod must be an integer from 1 to 86400 seconds');
		await this.ensureLegacyMigration();
		const current = await this.api.readConfig();
		await this.api.updateConfig({
			commandId: `desktop-git-${crypto.randomUUID()}`,
			expectedRevision: current.revision,
			git: { ...current.git, autofetchPeriod: seconds },
		});
		await this.refreshAutoFetch();
	}

	private async refreshAutoFetch(): Promise<void> {
		await this.ensureLegacyMigration();
		const config = await this.api.readConfig();
		if (this.isDisposed || config.revision < this.configRevision) return;
		this.configRevision = config.revision;
		const mode: GitAutofetch = config.git.autofetch === 'off' ? false : config.git.autofetch === 'default' ? true : 'all';
		if (this.autoFetchValue === mode && this.autoFetchPeriodValue === config.git.autofetchPeriod) return;
		this.autoFetchValue = mode;
		this.autoFetchPeriodValue = config.git.autofetchPeriod;
		this._onDidChangeAutoFetch.fire();
	}

	private async ensureLegacyMigration(): Promise<void> {
		if (!this.legacyMigration) {
			this.legacyMigration = this.migrateLegacyAutoFetch().catch(error => {
				this.legacyMigration = undefined;
				throw error;
			});
		}
		await this.legacyMigration;
	}

	private async migrateLegacyAutoFetch(): Promise<void> {
		const legacyMode = this.configurationService.inspect<GitAutofetch>(GitConfiguration.autofetch).userLocalValue;
		const legacyPeriod = this.configurationService.inspect<number>(GitConfiguration.autofetchPeriod).userLocalValue;
		if (legacyMode === undefined && legacyPeriod === undefined) return;
		const current = await this.api.readConfig();
		const desired: GitConfigDto = {
			autofetch: legacyMode === undefined ? current.git.autofetch : legacyMode === false ? 'off' : legacyMode === true ? 'default' : 'all',
			autofetchPeriod: legacyPeriod ?? current.git.autofetchPeriod,
		};
		if (current.gitConfigured && (current.git.autofetch !== desired.autofetch || current.git.autofetchPeriod !== desired.autofetchPeriod)) {
			this.logService.error('git', 'Desktop Git settings conflict with shared Git configuration; migration requires a single chosen value');
			return;
		}
		if (!current.gitConfigured) {
			await this.api.updateConfig({ commandId: `desktop-git-migrate-${crypto.randomUUID()}`, expectedRevision: current.revision, git: desired });
		}
		if (legacyMode !== undefined) await this.configurationService.updateValue(GitConfiguration.autofetch, undefined);
		if (legacyPeriod !== undefined) await this.configurationService.updateValue(GitConfiguration.autofetchPeriod, undefined);
	}

	private acceptStatus(status: GitStatus): void {
		this._onDidChangeRepositoryStatus.fire(status);
		if (status.repositoryId === this.activeRepositoryId) this._onDidChangeStatus.fire(status);
	}

	private async requireRepository(repositoryId?: string): Promise<GitRepository> {
		this.requireWorkspaceFolders();
		if (this.repositoryList.length === 0) await this.refreshRepositories();
		const id = repositoryId ?? this.activeRepositoryId;
		const repository = this.repositoryList.find(candidate => candidate.id === id);
		if (!repository) throw new Error(repositoryId ? `GitRepositoryNotFound: ${repositoryId}` : "GitUnavailable: no Git repository found in the workspace");
		return repository;
	}

	private refreshRepositories(): Promise<readonly GitRepository[]> {
		if (this.discovery) return this.discovery;
		const generation = this.discoveryGeneration;
		const workspaceFolders = this.requireWorkspaceFolders();
		const request = this.api.repositories().then(result => {
			if (this.isDisposed || generation !== this.discoveryGeneration) return this.repositoryList;
			const repositories = Object.freeze(result.repositories.map(repository => toGitRepository(repository, workspaceFolders)));
			const previousActiveId = this.activeRepositoryId;
			const previousSignature = repositorySignature(this.repositoryList);
			this.repositoryList = repositories;
			if (!repositories.some(repository => repository.id === previousActiveId)) this.activeRepositoryId = repositories[0]?.id;
			if (repositorySignature(repositories) !== previousSignature) this._onDidChangeRepositories.fire(repositories);
			if (this.activeRepositoryId !== previousActiveId) this._onDidChangeActiveRepository.fire(this.activeRepository);
			this._onDidBecomeReady.fire();
			return repositories;
		}).finally(() => {
			if (this.discovery === request) this.discovery = undefined;
		});
		this.discovery = request;
		return request;
	}

	private clearRepositories(): void {
		this.discoveryGeneration += 1;
		this.selectionGeneration += 1;
		this.discovery = undefined;
		const hadRepositories = this.repositoryList.length > 0;
		const hadActiveRepository = this.activeRepositoryId !== undefined;
		this.repositoryList = Object.freeze([]);
		this.activeRepositoryId = undefined;
		if (hadRepositories) this._onDidChangeRepositories.fire(this.repositoryList);
		if (hadActiveRepository) this._onDidChangeActiveRepository.fire(undefined);
	}

	private hasWorkspaceFolder(): boolean {
		return this.options.workspaceContext.getWorkspace().folders.length > 0;
	}

	private requireWorkspaceFolders(): readonly IWorkspaceFolder[] {
		const folders = this.options.workspaceContext.getWorkspace().folders;
		if (folders.length === 0) throw new Error("GitUnavailable: Git requires at least one workspace folder");
		return folders;
	}
}

function toGitRepository(repository: GitRepositoryDto, workspaceFolders: readonly IWorkspaceFolder[]): GitRepository {
	const workspaceFolder = repository.dirId
		? workspaceFolders.find(folder => folder.id === repository.dirId)
		: workspaceFolders.length === 1 ? workspaceFolders[0] : undefined;
	if (!workspaceFolder) throw new Error(`GitRepositoryWorkspaceFolderNotFound: ${repository.dirId ?? repository.id}`);
	return Object.freeze({
		id: repository.id,
		label: repository.label,
		path: repository.path,
		root: appendRelativePath(workspaceFolder.uri, repository.path),
	});
}

function appendRelativePath(root: URI, relativePath: string): URI {
	if (!relativePath) return root;
	const encoded = relativePath.replaceAll("\\", "/").split("/").filter(Boolean).map(encodeURIComponent).join("/");
	return root.withPath(`${root.path.replace(/\/$/u, "")}/${encoded}`);
}

function repositorySignature(repositories: readonly GitRepository[]): string {
	return repositories.map(repository => `${repository.id}\0${repository.label}\0${repository.root}`).join("\n");
}

function isEqualOrParent(resource: URI, root: URI): boolean {
	if (resource.scheme !== root.scheme || resource.authority.toLowerCase() !== root.authority.toLowerCase()) return false;
	const candidate = repositoryPath(resource);
	const parent = repositoryPath(root).replace(/\/$/u, "");
	return candidate === parent || candidate.startsWith(`${parent}/`);
}

function repositoryPath(resource: URI): string {
	const path = resource.scheme === "file" ? resource.fsPath.replaceAll("\\", "/") : decodeURIComponent(resource.path);
	return resource.scheme === "file" && /^[A-Za-z]:\//u.test(path) ? path.toLowerCase() : path;
}

function toGitStatus(status: GitStatusResult, repository: GitRepository): GitStatus {
	return {
		repositoryId: status.repositoryId,
		streamInstanceId: status.streamInstanceId,
		revision: status.revision,
		workspacePath: isRemoteResource(repository.root) ? getRemoteWorkspacePath(repository.root) : repository.root.fsPath,
		head: toGitHead(status.head),
		changes: status.changes.map(toGitChange),
	};
}

function toGitHead(head: GitHeadDto): GitHead {
	switch (head.type) {
		case "branch": return { type: "branch", name: head.name, objectId: head.objectId, upstream: head.upstream ? { ...head.upstream } : undefined };
		case "detached": return { type: "detached", objectId: head.objectId };
		case "unborn": return { type: "unborn", name: head.name };
	}
}

function toGitChange(change: GitRepositoryChangeDto): GitRepositoryChange {
	return {
		path: change.path,
		originalPath: change.originalPath ?? undefined,
		indexStatus: change.indexStatus,
		worktreeStatus: change.worktreeStatus,
		conflicted: change.conflicted,
		submodule: { ...change.submodule },
	};
}
