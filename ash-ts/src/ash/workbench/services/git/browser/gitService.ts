import type { GitFetchModeDto, GitHeadDto, GitRepositoryChangeDto, GitRepositoryDto, GitStatusResult } from "../../../../platform/app-server/common/generated/index.js";
import { Emitter } from "../../../../base/common/event.js";
import { AbstractDisposable, Disposable, DisposableMap, toDisposable } from "../../../../base/common/lifecycle.js";
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
	private readonly api: IGitApi;
	private repositoryList: readonly GitRepository[] = Object.freeze([]);
	private activeRepositoryId: string | undefined;
	private discoveryGeneration = 0;
	private selectionGeneration = 0;
	private discovery: Promise<readonly GitRepository[]> | undefined;
	private readonly autofetchers = this._register(new DisposableMap<string, RepositoryAutoFetcher>());
	private connectionReady = false;
	private connectionRevision = 0;

	readonly onDidChangeStatus = this._onDidChangeStatus.event;
	readonly onDidChangeRepositoryStatus = this._onDidChangeRepositoryStatus.event;
	readonly onDidChangeRepositories = this._onDidChangeRepositories.event;
	readonly onDidChangeActiveRepository = this._onDidChangeActiveRepository.event;
	readonly onDidBecomeReady = this._onDidBecomeReady.event;

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
			this.connectionReady = false;
			this.syncAutofetch();
			if (state === 'ready' && !this.hasWorkspaceFolder()) {
				this.connectionReady = true;
				return;
			}
			if (state === 'ready' && this.hasWorkspaceFolder()) {
				void this.refreshRepositories().then(() => {
					if (this.isDisposed || revision !== this.connectionRevision) return;
					this.connectionReady = true;
					this.syncAutofetch();
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
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(GitConfiguration.autofetch) || event.affectsConfiguration(GitConfiguration.autofetchPeriod)) this.syncAutofetch();
		}));
		this._register(options.workspaceContext.onDidChangeWorkspace(({ workspace }) => {
			this.clearRepositories();
			this.syncAutofetch();
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

	private acceptStatus(status: GitStatus): void {
		this._onDidChangeRepositoryStatus.fire(status);
		if (status.repositoryId === this.activeRepositoryId) this._onDidChangeStatus.fire(status);
	}

	private syncAutofetch(): void {
		let mode: GitFetchModeDto | undefined;
		if (this.connectionReady && this.hasWorkspaceFolder()) {
			const setting = this.configurationService.getValue<GitAutofetch>(GitConfiguration.autofetch);
			if (setting === true) mode = 'default';
			if (setting === 'all') mode = 'all';
		}
		const period = this.configurationService.getValue<number>(GitConfiguration.autofetchPeriod);
		const repositories = new Map(this.repositoryList.map(repository => [repository.id, repository]));
		for (const [id, fetcher] of this.autofetchers) {
			const repository = repositories.get(id);
			if (!repository || !fetcher.matches(repository)) this.autofetchers.deleteAndDispose(id);
		}
		for (const repository of this.repositoryList) {
			let fetcher = this.autofetchers.get(repository.id);
			if (!fetcher && mode === undefined) continue;
			if (!fetcher) fetcher = this.autofetchers.set(repository.id, new RepositoryAutoFetcher(repository, this.api, status => this.acceptStatus(status), this.logService));
			fetcher.configure(mode, period);
		}
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
			this.syncAutofetch();
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

class RepositoryAutoFetcher extends AbstractDisposable {
	private mode: GitFetchModeDto | undefined;
	private period = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private revision = 0;

	constructor(
		private readonly repository: GitRepository,
		private readonly api: IGitApi,
		private readonly acceptStatus: (status: GitStatus) => void,
		private readonly logService: ILogService,
	) {
		super();
	}

	public matches(repository: GitRepository): boolean {
		return repository.id === this.repository.id
			&& repository.label === this.repository.label
			&& repository.path === this.repository.path
			&& repository.root.toString() === this.repository.root.toString();
	}

	public configure(mode: GitFetchModeDto | undefined, period: number): void {
		if (this.mode === mode && this.period === period) return;
		this.mode = mode;
		this.period = period;
		this.revision += 1;
		this.clearTimer();
		if (!this.running && mode !== undefined) this.schedule(0);
	}

	protected override disposeCore(): void {
		this.mode = undefined;
		this.revision += 1;
		this.clearTimer();
	}

	private schedule(delay: number): void {
		if (this.isDisposed || this.mode === undefined) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.run();
		}, delay);
	}

	private async run(): Promise<void> {
		const mode = this.mode;
		if (this.isDisposed || mode === undefined) return;
		this.running = true;
		const revision = this.revision;
		try {
			const result = await this.api.fetch({ repositoryId: this.repository.id, mode });
			if (!this.isDisposed && revision === this.revision) this.acceptStatus(toGitStatus(result.status, this.repository));
		} catch (error) {
			if (!this.isDisposed && revision === this.revision) this.logService.error('git', `Automatic fetch failed for ${this.repository.label}`, error);
		} finally {
			this.running = false;
			if (!this.isDisposed && this.mode !== undefined) this.schedule(revision === this.revision ? this.period * 1000 : 0);
		}
	}

	private clearTimer(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
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
