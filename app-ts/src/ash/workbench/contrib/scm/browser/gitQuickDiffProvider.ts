import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { type IGitService } from '../../../services/git/common/gitService.js';
import { type QuickDiffOriginalResource, type QuickDiffProvider } from '../common/quickDiff.js';

/** Git-backed original-resource provider for worktree and index changes. */
export class GitQuickDiffProvider extends Disposable implements QuickDiffProvider {
	readonly id = 'git';
	readonly label = 'Git';
	private readonly changeEmitter = this._register(new Emitter<URI | undefined>());
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly gitService: IGitService) {
		super();
		this._register(gitService.onDidChangeRepositoryStatus(() => this.changeEmitter.fire(undefined)));
		this._register(gitService.onDidChangeRepositories(() => this.changeEmitter.fire(undefined)));
		this._register(gitService.onDidBecomeReady(() => this.changeEmitter.fire(undefined)));
	}

	async provideOriginalResource(resource: URI, signal: AbortSignal): Promise<QuickDiffOriginalResource | undefined> {
		if (resource.scheme !== 'file' && !isRemoteResource(resource)) return undefined;
		signal.throwIfAborted();
		let repository = this.gitService.repositoryForResource(resource);
		if (!repository) {
			await this.gitService.listRepositories();
			signal.throwIfAborted();
			repository = this.gitService.repositoryForResource(resource);
		}
		if (!repository) return undefined;
		const status = await this.gitService.status(repository.id);
		signal.throwIfAborted();
		const path = workspaceRelativePath(resource, status.workspacePath);
		if (!path) return undefined;
		const change = status.changes.find(candidate => normalizePath(candidate.path) === path);
		if (!change || change.conflicted) return undefined;
		const comparison = change.worktreeStatus !== 'unmodified' ? 'unstaged' : 'staged';
		const file = await this.gitService.changeFile(path, comparison, repository.id);
		signal.throwIfAborted();
		if (file.original.kind === 'binary' || file.modified.kind === 'binary') return undefined;
		const revision = `${status.streamInstanceId}:${status.revision}:${comparison}`;
		return Object.freeze({
			providerId: this.id,
			providerLabel: this.label,
			label: comparison === 'unstaged' ? 'Index' : 'HEAD',
			originalResource: URI.parse(`git-quickdiff:/original?resource=${encodeURIComponent(resource.toString())}&revision=${encodeURIComponent(revision)}`),
			revision,
			text: file.original.kind === 'text' ? file.original.text : '',
		});
	}
}

function workspaceRelativePath(resource: URI, workspacePath: string): string | undefined {
	const resourcePath = normalizePath(isRemoteResource(resource) ? getRemoteWorkspacePath(resource) : resource.fsPath);
	const workspace = normalizePath(workspacePath).replace(/\/$/u, '');
	const compareResource = /^[A-Za-z]:\//u.test(resourcePath) ? resourcePath.toLowerCase() : resourcePath;
	const compareWorkspace = /^[A-Za-z]:\//u.test(workspace) ? workspace.toLowerCase() : workspace;
	if (!compareResource.startsWith(`${compareWorkspace}/`)) return undefined;
	return resourcePath.slice(workspace.length + 1);
}

function normalizePath(value: string): string {
	return value.replaceAll('\\', '/').replace(/\/{2,}/gu, '/');
}
