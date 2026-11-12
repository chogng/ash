import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../agentHost/browser/disconnectedAppServer.js';
import { CancellationTokenSource, type CancellationToken } from '../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../base/common/async.js';
import type { GitRepositoryContext, GitSessionComparison, GitSessionComparisonSnapshot, GitWorktreeChangesSnapshot, ILocalGitService } from '../common/localGitService.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { canceled } from '../../../base/common/errors.js';

/** Converts the App contract to typed Rust requests; it owns no Git or installation state. */
export class AppServerLocalGitService implements ILocalGitService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly connection: AppServerProtocolClient) { }

	public async listWorktrees(token: CancellationToken, sourcePath?: string): ReturnType<ILocalGitService['listWorktrees']> {
		const generation = this.connection.generation;
		using cancellation = new CancellationTokenSource(token);
		using subscription = this.connection.onStateChange(state => { if (state !== 'ready') cancellation.cancel(); });
		const checkCurrent = (): void => {
			if (cancellation.token.isCancellationRequested || generation !== this.connection.generation || this.connection.state !== 'ready') {
				throw canceled();
			}
		};
		checkCurrent();
		if (sourcePath !== undefined) {
			try {
				const result = await raceCancellationError(appServerRequest(this.connection, 'git/worktree/list', { sourcePath }), cancellation.token);
				checkCurrent();
				return result.worktrees.filter(worktree => worktree.state === 'ready').map(worktree => ({
					label: worktree.branch || worktree.path, path: worktree.current ? sourcePath : worktree.path, sourcePath,
				}));
			} catch (error) {
				if (error instanceof AppServerRemoteError && error.errorName === 'PermissionRequired') return [];
				throw error;
			}
		}
		const repositories = await raceCancellationError(appServerRequest(this.connection, 'git/repositories', {}), cancellation.token);
		checkCurrent();
		const checkouts = await Promise.all(repositories.repositories.map(async repository => {
			const result = await raceCancellationError(appServerRequest(this.connection, 'git/worktree/list', { repositoryId: repository.id }), cancellation.token);
			checkCurrent();
			const sourcePath = result.worktrees.find(worktree => worktree.current)?.path;
			return sourcePath ? result.worktrees.filter(worktree => worktree.state === 'ready').map(worktree => ({
				label: worktree.branch || repository.label, path: worktree.path, sourcePath,
			})) : [];
		}));
		return checkouts.flat();
	}

	async readRepositoryContexts(directory: { readonly sessionId: string; readonly path: string; }, token?: CancellationToken): Promise<readonly GitRepositoryContext[]> {
		const generation = this.connection.generation;
		using cancellation = new CancellationTokenSource(token);
		using subscription = this.connection.onStateChange(state => { if (state !== 'ready') cancellation.cancel(); });
		if (cancellation.token.isCancellationRequested || this.connection.state !== 'ready') throw canceled();
		const result = await raceCancellationError(appServerRequest(this.connection, 'git/repositoryContexts', { sessionDirectory: directory }), cancellation.token).catch(error => {
			if (error instanceof AppServerRemoteError && error.errorName === 'PermissionRequired') return { repositories: [] };
			throw error;
		});
		if (cancellation.token.isCancellationRequested || generation !== this.connection.generation) throw canceled();
		return result.repositories.map(repository => ({
			id: repository.id, label: repository.label, path: repository.path, rootPath: repository.rootPath,
			head: { type: repository.head.type, name: 'name' in repository.head ? repository.head.name : '', ...('objectId' in repository.head ? { objectId: repository.head.objectId } : {}), ...('upstream' in repository.head && repository.head.upstream ? { upstream: { ...repository.head.upstream } } : {}) },
			remotes: repository.remotes.map(remote => ({ name: remote.name, ...(remote.identity ? { identity: { ...remote.identity } } : {}) })),
		}));
	}

	async clone(operationId: string, cloneUrl: string, targetPath: string, ref?: string): Promise<void> {
		// Git allows fifteen minutes for cloning, followed by bounded revision fetch and verification.
		try {
			await this.connection.request(APP_SERVER_METHODS['git/cloneTo'], {
				operationId, url: cloneUrl, targetPath, reference: ref ?? null,
			}, { timeoutMs: 20 * 60_000 });
		} catch (error) {
			if (error instanceof AppServerRemoteError && error.errorName === 'RequestCancelled') {
				throw canceled(error);
			}
			throw error;
		}
	}

	async readSessionComparison(directory: { readonly sessionId: string; readonly path: string; }, repositoryId: string, comparison: GitSessionComparison, signal: AbortSignal): Promise<GitSessionComparisonSnapshot> {
		const generation = this.connection.generation;
		const result = await this.connection.request(APP_SERVER_METHODS['git/sessionComparison'], { sessionDirectory: directory, repositoryId, comparison }, { signal });
		if (signal.aborted || generation !== this.connection.generation || this.connection.state !== 'ready') throw canceled();
		return result.kind === 'branches'
			? { kind: 'branches', references: result.references.map(({ name, objectId }) => ({ name, objectId })) }
			: { kind: 'changes', files: result.files.map(({ path, originalPath, original, modified }) => ({ path, originalPath, original, modified })) };
	}

	async readWorktreeChanges(sourcePath: string, query: 'summary' | 'diff', signal: AbortSignal): Promise<GitWorktreeChangesSnapshot> {
		const generation = this.connection.generation;
		const result = await this.connection.request(APP_SERVER_METHODS['git/worktree/changes'], { sourcePath, query }, { signal });
		if (signal.aborted || generation !== this.connection.generation || this.connection.state !== 'ready') throw canceled();
		return result.kind === 'summary'
			? { kind: 'summary', files: result.files }
			: { kind: 'diff', files: result.files.map(({ path, originalPath, original, modified }) => ({ path, originalPath, original, modified })) };
	}

	async cancel(operationId: string): Promise<void> {
		await appServerRequest(this.connection, 'git/cloneTo/cancel', { operationId });
	}
}

export function createDisconnectedLocalGitService(unavailable: UnavailableOperation): ILocalGitService {
	return {
		_serviceBrand: undefined,
		listWorktrees: () => unavailable('git/worktree/list'),
		readRepositoryContexts: () => unavailable('git/repositoryContexts'),
		readSessionComparison: () => unavailable('git/sessionComparison'),
		readWorktreeChanges: () => unavailable('git/worktree/changes'),
		clone: () => unavailable('git/cloneTo'),
		cancel: () => unavailable('git/cloneTo/cancel'),
	};
}
