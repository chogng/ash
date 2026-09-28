import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { SCMHistoryUnavailableError, type ISCMHistoryItem, type ISCMHistoryItemChange, type ISCMHistoryItemChangeContents, type ISCMHistoryItemRef, type ISCMHistoryOptions, type ISCMHistoryProvider } from '../../scm/common/history.js';
import { GitWorkspaceError, type GitCommitSummary, type GitHead, type GitReference, type GitRemote, type GitStatus, type GraphPage, type IGitService } from '../common/gitService.js';
import { gitErrorMessage } from '../common/gitError.js';

const PageSize = 50;
const MaxChatFiles = 40;
const MaxChatFileCharacters = 64 * 1024;
const MaxChatContextCharacters = 512 * 1024;

/** Maps one Git repository to SCM history without exposing Git DTOs to the view. */
export class GitHistoryProvider extends Disposable implements ISCMHistoryProvider {
	private readonly changeEmitter = this._register(new Emitter<void>());
	public readonly onDidChange = this.changeEmitter.event;
	public readonly historyItemRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	private readonly commits: GitCommitSummary[] = [];
	private readonly references = new Map<string, ISCMHistoryItemRef[]>();
	private remoteLabels: readonly string[] = [];
	private nextCursor: string | undefined;
	private hasMore = true;
	private generation = 0;
	private loading: Promise<void> | undefined;
	private readonly parents = new Map<string, string | undefined>();

	constructor(private readonly gitService: IGitService, readonly repositoryId: string) {
		super();
		this._register(gitService.onDidChangeRepositoryStatus(status => {
			if (status.repositoryId !== repositoryId) return;
			this.reset();
		}));
		this._register(gitService.onDidBecomeReady(() => this.reset()));
	}

	public refresh(): void {
		this.reset(false);
	}

	public async provideHistoryItems(options: ISCMHistoryOptions): Promise<readonly ISCMHistoryItem[]> {
		const skip = options.skip ?? 0;
		const limit = options.limit ?? PageSize;
		if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1) {
			throw new RangeError('SCM history skip and limit must be positive integers');
		}
		await this.loadUntil(skip + limit);
		let status: GitStatus;
		try {
			status = await this.gitService.status(this.repositoryId);
		} catch (error) {
			throw historyError(error);
		}
		this.historyItemRef.set(currentRef(status.head));
		return this.commits.slice(skip, skip + limit).map(commit => ({
			id: commit.objectId,
			parentIds: commit.parentObjectIds,
			subject: commit.subject,
			message: commit.subject,
			displayId: commit.objectId.slice(0, 7),
			timestamp: commit.timestampSeconds * 1000,
			references: this.references.get(commit.objectId) ?? [],
		} satisfies ISCMHistoryItem));
	}

	public async provideRemoteLabels(): Promise<readonly string[]> {
		await this.loadUntil(1);
		return this.remoteLabels;
	}

	public async provideHistoryItemChanges(historyItemId: string, _historyItemParentId: string | undefined): Promise<readonly ISCMHistoryItemChange[]> {
		const result = await this.gitService.commitChanges(historyItemId, this.repositoryId);
		this.parents.set(historyItemId, result.parentObjectId);
		return result.changes.map(change => ({
			uri: commitFileUri(this.repositoryId, historyItemId, change.path, 'modified'),
			originalUri: commitFileUri(this.repositoryId, result.parentObjectId ?? 'root', change.originalPath ?? change.path, 'original'),
			modifiedUri: commitFileUri(this.repositoryId, historyItemId, change.path, 'modified'),
			path: change.path,
			originalPath: change.originalPath,
			status: change.status,
		}));
	}

	public async resolveHistoryItemChangeContents(historyItemId: string, change: ISCMHistoryItemChange): Promise<ISCMHistoryItemChangeContents> {
		const file = await this.gitService.commitFile(historyItemId, change.path, this.repositoryId);
		return { parentId: this.parents.get(historyItemId), original: file.original, modified: file.modified };
	}

	public async resolveHistoryItemChatContext(historyItemId: string): Promise<string | undefined> {
		const commit = this.commits.find(item => item.objectId === historyItemId);
		if (!commit) return undefined;
		const result = await this.gitService.commitChanges(historyItemId, this.repositoryId);
		const selected = result.changes.slice(0, MaxChatFiles);
		const files = await Promise.all(selected.map(async change => ({
			change,
			file: await this.gitService.commitFile(historyItemId, change.path, this.repositoryId),
		})));
		const sections = [
			`Commit: ${historyItemId}`,
			`Subject: ${commit.subject}`,
			`Parents: ${commit.parentObjectIds.join(', ') || '(root commit)'}`,
			`Changed files: ${result.changes.length}`,
			...files.map(({ change, file }) => formatFileChange(historyItemId, change.path, change.originalPath, change.status, file.original, file.modified)),
		];
		if (result.changes.length > selected.length) sections.push(`[${result.changes.length - selected.length} additional files omitted]`);
		return truncate(sections.join('\n\n'), MaxChatContextCharacters, 'commit context');
	}

	public async resolveHistoryItemChangeRangeChatContext(historyItemId: string, _historyItemParentId: string, path: string): Promise<string | undefined> {
		const changes = await this.gitService.commitChanges(historyItemId, this.repositoryId);
		const change = changes.changes.find(item => item.path === path);
		if (!change) return undefined;
		const file = await this.gitService.commitFile(historyItemId, path, this.repositoryId);
		return formatFileChange(historyItemId, change.path, change.originalPath, change.status, file.original, file.modified);
	}

	private async loadUntil(count: number): Promise<void> {
		while (this.commits.length < count && this.hasMore) {
			if (this.loading) {
				await this.loading;
				continue;
			}
			const generation = this.generation;
			this.loading = this.loadPage(generation);
			try {
				await this.loading;
			} finally {
				this.loading = undefined;
			}
		}
	}

	private async loadPage(generation: number): Promise<void> {
		let page: GraphPage;
		try {
			page = await this.gitService.graph({ limit: PageSize, ...(this.nextCursor ? { cursor: this.nextCursor } : {}) }, this.repositoryId);
		} catch (error) {
			throw historyError(error);
		}
		if (this.isDisposed || generation !== this.generation) return;
		const known = new Set(this.commits.map(commit => commit.objectId));
		for (const commit of page.commits) {
			if (known.has(commit.objectId)) continue;
			known.add(commit.objectId);
			this.commits.push(commit);
		}
		for (const reference of page.references) {
			const items = this.references.get(reference.objectId) ?? [];
			if (!items.some(item => item.id === referenceId(reference))) items.push(toHistoryRef(reference));
			this.references.set(reference.objectId, items);
		}
		this.remoteLabels = page.remotes.map(remoteLabel);
		this.nextCursor = page.nextCursor;
		this.hasMore = page.hasMore && page.nextCursor !== undefined && page.commits.length > 0;
	}

	private reset(notify = true): void {
		this.generation += 1;
		this.commits.length = 0;
		this.references.clear();
		this.remoteLabels = [];
		this.parents.clear();
		this.nextCursor = undefined;
		this.hasMore = true;
		this.historyItemRef.set(undefined);
		if (notify) this.changeEmitter.fire();
	}
}

function currentRef(head: GitHead): ISCMHistoryItemRef | undefined {
	if (head.type === 'unborn') return undefined;
	if (head.type === 'detached') return { id: 'HEAD', name: head.objectId.slice(0, 7), revision: head.objectId };
	return { id: `localBranch:${head.name}`, name: head.name, revision: head.objectId, category: 'localBranch' };
}

function referenceId(reference: GitReference): string {
	return `${reference.kind}:${reference.name}`;
}

function toHistoryRef(reference: GitReference): ISCMHistoryItemRef {
	return {
		id: referenceId(reference),
		name: reference.name,
		revision: reference.objectId,
		category: reference.kind,
		...(reference.remoteName ? { description: reference.remoteName } : {}),
	};
}

function remoteLabel(remote: GitRemote): string {
	const identity = remote.identity;
	if (!identity) return remote.name;
	const provider = identity.provider === 'github' ? 'GitHub' : identity.provider === 'gitlab' ? 'GitLab' : identity.provider === 'bitbucket' ? 'Bitbucket' : 'Remote';
	return `${provider} · ${identity.owner}/${identity.repository} · ${remote.name}`;
}

function commitFileUri(repositoryId: string, objectId: string, path: string, side: 'original' | 'modified'): URI {
	const encodedPath = path.split('/').map(encodeURIComponent).join('/');
	return URI.parse(`git-commit:/${encodeURIComponent(repositoryId)}/${encodeURIComponent(objectId)}/${encodedPath}?side=${side}`);
}

function historyError(error: unknown): Error {
	const message = gitErrorMessage(error);
	return error instanceof GitWorkspaceError ? new SCMHistoryUnavailableError(message) : new Error(message, { cause: error });
}

function formatFileChange(commitId: string, path: string, originalPath: string | undefined, status: string, original: ISCMHistoryItemChangeContents['original'], modified: ISCMHistoryItemChangeContents['modified']): string {
	return [
		`File: ${path}`,
		...(originalPath ? [`Previous path: ${originalPath}`] : []),
		`Status: ${status}`,
		`Before:\n${formatContent(original)}`,
		`After:\n${formatContent(modified)}`,
		`Commit: ${commitId}`,
	].join('\n');
}

function formatContent(content: ISCMHistoryItemChangeContents['original']): string {
	switch (content.kind) {
		case 'missing': return '[file does not exist on this side]';
		case 'binary': return '[binary content omitted]';
		case 'text': return truncate(content.text, MaxChatFileCharacters, 'file content');
	}
}

function truncate(value: string, maximum: number, label: string): string {
	if (value.length <= maximum) return value;
	return `${value.slice(0, maximum)}\n[${label} truncated after ${maximum} characters]`;
}
