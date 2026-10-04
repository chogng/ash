import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableFromEvent } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { SCMHistoryUnavailableError, type ISCMHistoryItemDetails, type ISCMHistoryItem, type ISCMHistoryItemChange, type ISCMHistoryItemChangeContents, type ISCMHistoryItemRef, type ISCMHistoryOptions, type ISCMHistoryProvider } from '../../scm/common/history.js';
import { GitWorkspaceError, type GitBranch, type GitRemote, type GitCommitChanges, type GitCommitSummary, type GitHead, type GitReference, type GitStatus, type GraphPage, type IGitService } from '../common/gitService.js';
import { gitErrorMessage } from '../common/gitError.js';

const PageSize = 50;
const MaxChatFiles = 40;
const MaxChatFileCharacters = 64 * 1024;
const MaxChatContextCharacters = 512 * 1024;

/** Maps one Git repository to SCM history without exposing Git DTOs to the view. */
export class GitHistoryProvider extends Disposable implements ISCMHistoryProvider {
	private readonly changeEmitter = this._register(new Emitter<void>());
	public readonly onDidChange = this.changeEmitter.event;
	private readonly historyRefChanged = this._register(new Emitter<ISCMHistoryItemRef | undefined>());
	private currentHistoryRef: ISCMHistoryItemRef | undefined;
	public readonly historyItemRef = observableFromEvent(this, this.historyRefChanged.event, () => this.currentHistoryRef);
	private readonly commits: GitCommitSummary[] = [];
	private readonly references = new Map<string, ISCMHistoryItemRef[]>();
	private branches: readonly GitBranch[] = [];
	private remotes: readonly GitRemote[] = [];
	private nextCursor: string | undefined;
	private hasMore = true;
	private generation = 0;
	private loading: Promise<void> | undefined;

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
		this.setHistoryItemRef(currentRef(status.head));
		return this.commits.slice(skip, skip + limit).map(commit => ({
			id: commit.objectId,
			parentIds: commit.parentObjectIds,
			subject: commit.subject,
			message: commit.subject,
			displayId: commit.objectId.slice(0, 7),
			timestamp: commit.timestampSeconds * 1000,
			references: this.references.get(commit.objectId) ?? [],
			remoteLinks: this.remoteLinks(commit.objectId),
		} satisfies ISCMHistoryItem));
	}

	public async provideHistoryItemChanges(historyItemId: string, historyItemParentId: string | undefined): Promise<readonly ISCMHistoryItemChange[]> {
		const firstParent = this.commits.find(commit => commit.objectId === historyItemId)?.parentObjectIds[0];
		let result: GitCommitChanges;
		if (historyItemParentId !== undefined && historyItemParentId !== firstParent) {
			const comparison = await this.gitService.compareChanges(historyItemId, historyItemParentId, 'direct', this.repositoryId);
			result = { parentObjectId: comparison.baseObjectId, changes: comparison.changes };
		} else {
			result = await this.gitService.commitChanges(historyItemId, this.repositoryId);
		}
		return result.changes.map(change => ({
			uri: commitFileUri(this.repositoryId, historyItemId, change.path, 'modified'),
			originalUri: commitFileUri(this.repositoryId, result.parentObjectId ?? 'root', change.originalPath ?? change.path, 'original'),
			modifiedUri: commitFileUri(this.repositoryId, historyItemId, change.path, 'modified'),
			path: change.path,
			originalPath: change.originalPath,
			status: change.status,
			parentId: result.parentObjectId,
		}));
	}

	public async resolveHistoryItemDetails(historyItemId: string): Promise<ISCMHistoryItemDetails> {
		const details = await this.gitService.commitDetails(historyItemId, this.repositoryId);
		return { authorName: details.authorName, authorEmail: details.authorEmail, timestamp: details.timestampSeconds * 1000, message: details.message, statistics: details.statistics };
	}

	public async resolveHistoryItemChangeContents(historyItemId: string, change: ISCMHistoryItemChange): Promise<ISCMHistoryItemChangeContents> {
		const file = await this.gitService.commitFile(historyItemId, change.path, this.repositoryId, change.parentId);
		return { parentId: change.parentId, original: file.original, modified: file.modified };
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
			if (!this.nextCursor) {
				const [graph, branches] = await Promise.all([this.gitService.graph({ limit: PageSize }, this.repositoryId), this.gitService.branches(this.repositoryId)]);
				page = graph;
				if (this.isDisposed || generation !== this.generation) { return; }
				this.branches = branches;
				this.remotes = graph.remotes;
			} else {
				page = await this.gitService.graph({ limit: PageSize, cursor: this.nextCursor }, this.repositoryId);
			}
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
			if (!items.some(item => item.id === referenceId(reference))) {
				const branch = reference.kind === 'localBranch' ? this.branches.find(branch => branch.name === reference.name) : undefined;
				items.push({
					...toHistoryRef(reference),
					upstream: branch?.upstream && page.references.some(remote => remote.kind === 'remoteBranch' && remote.name === branch.upstream) ? branch.upstream : undefined,
					canDelete: branch !== undefined && !branch.current && !branch.checkedOutElsewhere,
				});
			}
			this.references.set(reference.objectId, items);
		}
		this.nextCursor = page.nextCursor;
		this.hasMore = page.hasMore && page.nextCursor !== undefined && page.commits.length > 0;
	}

	private remoteLinks(objectId: string): readonly { name: string; uri: URI }[] {
		return this.remotes.flatMap(remote => {
			const identity = remote.identity;
			if (!identity || identity.provider === 'other') { return []; }
			const repositoryPath = [...identity.owner.split('/'), identity.repository].map(encodeURIComponent).join('/');
			const commitPath = identity.provider === 'gitlab' ? '-/commit' : identity.provider === 'bitbucket' ? 'commits' : 'commit';
			return [{ name: remote.name, uri: URI.parse(`https://${identity.host}/${repositoryPath}/${commitPath}/${objectId}`) }];
		});
	}

	private reset(notify = true): void {
		this.generation += 1;
		this.commits.length = 0;
		this.references.clear();
		this.branches = [];
		this.remotes = [];
		this.nextCursor = undefined;
		this.hasMore = true;
		this.setHistoryItemRef(undefined);
		if (notify) this.changeEmitter.fire();
	}

	private setHistoryItemRef(ref: ISCMHistoryItemRef | undefined): void {
		if (ref === this.currentHistoryRef) return;
		this.currentHistoryRef = ref;
		this.historyRefChanged.fire(ref);
	}
}

function currentRef(head: GitHead): ISCMHistoryItemRef | undefined {
	if (head.type === 'unborn') return undefined;
	if (head.type === 'detached') return { id: 'HEAD', name: head.objectId.slice(0, 7), revision: head.objectId };
	return { id: `localBranch:${head.name}`, name: head.name, revision: head.objectId, category: 'localBranch', upstream: head.upstream?.name };
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
