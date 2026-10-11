import { Emitter } from './support.js';
import { Disposable } from './support.js';
import { observableFromEvent } from './support.js';
import { URI } from './support.js';
import { SCMHistoryUnavailableError, type ISCMHistoryItemDetails, type ISCMHistoryItem, type ISCMHistoryItemChange, type ISCMHistoryItemChangeContents, type ISCMHistoryItemRef, type ISCMHistoryOptions, type ISCMHistoryProvider } from './support.js';
import { GitWorkspaceError, type GitBranch, type GitRemote, type GitCommitChanges, type GitCommitSummary, type GitHead, type GitReference, type GitStatus, type GraphPage, type IGitService } from './types.js';
import { gitErrorMessage } from './gitError.js';

const PageSize = 50;
const MaxChatFiles = 40;
const MaxChatFileCharacters = 64 * 1024;
const MaxChatContextCharacters = 512 * 1024;

/** Maps one Git repository to SCM history without exposing Git DTOs to the view. */
export class GitHistoryProvider extends Disposable implements ISCMHistoryProvider {
	private readonly changeEmitter = this._register(new Emitter<void>());
	public readonly onDidChange = this.changeEmitter.event;
	private readonly refsChanged = this._register(new Emitter<readonly ISCMHistoryItem[]>());
	public readonly onDidChangeHistoryItemRefs = this.refsChanged.event;
	private readonly historyRefChanged = this._register(new Emitter<ISCMHistoryItemRef | undefined>());
	private currentHistoryRef: ISCMHistoryItemRef | undefined;
	private currentRemoteRef: ISCMHistoryItemRef | undefined;
	private readonly remoteRefChanged = this._register(new Emitter<ISCMHistoryItemRef | undefined>());
	public readonly historyItemRemoteRef = observableFromEvent(this, this.remoteRefChanged.event, () => this.currentRemoteRef);
	private historyRoots: readonly string[] | undefined;
	public readonly historyItemRef = observableFromEvent(this, this.historyRefChanged.event, () => this.currentHistoryRef);
	private readonly commits: GitCommitSummary[] = [];
	private readonly references = new Map<string, ISCMHistoryItemRef[]>();
	private branches: readonly GitBranch[] = [];
	private remotes: readonly GitRemote[] = [];
	private nextCursor: string | undefined;
	private hasMore = true;
	private generation = 0;
	private loading: Promise<void> | undefined;
	private referencesLoading: Promise<void> | undefined;
	private graphRevision: number | undefined;
	private referencesRevision = 0;
	private historyStatus: Pick<GitStatus, 'streamInstanceId' | 'historyRevision'> | undefined;

	constructor(private readonly gitService: IGitService, readonly repositoryId: string) {
		super();
		this._register(gitService.onDidChangeRepositoryStatus(status => this.handleStatus(status)));
		this._register(gitService.onDidBecomeReady(async () => {
			const generation = this.generation;
			try {
				const status = await gitService.status(repositoryId);
				if (!this.isDisposed && generation === this.generation) this.handleStatus(status);
			} catch {
				if (!this.isDisposed && generation === this.generation) {
					this.historyStatus = undefined;
					this.reset();
				}
			}
		}));
	}

	public refresh(): void {
		this.reset(false);
	}

	public async provideHistoryItems(options: ISCMHistoryOptions): Promise<readonly ISCMHistoryItem[]> {
		const roots = options.historyItemRefs === undefined ? undefined : [...new Set(options.historyItemRefs)].sort();
		if (JSON.stringify(roots) !== JSON.stringify(this.historyRoots)) {
			this.reset(false, true);
			this.historyRoots = roots;
		}
		const generation = this.generation;
		const skip = options.skip ?? 0;
		const limit = options.limit ?? PageSize;
		if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1) {
			throw new RangeError('SCM history skip and limit must be positive integers');
		}
		await this.loadUntil(skip + limit, generation);
		let status: GitStatus;
		try {
			status = await this.gitService.status(this.repositoryId);
		} catch (error) {
			throw historyError(error);
		}
		if (generation === this.generation) {
			if (!this.historyStatus || this.historyStatus.streamInstanceId === status.streamInstanceId && this.historyStatus.historyRevision <= status.historyRevision) {
				if (this.historyStatus && this.historyStatus.historyRevision < status.historyRevision) { this.handleStatus(status); }
				else { this.historyStatus = status; }
				this.setHistoryItemRef(currentRef(status.head));
			}
		}
		return (generation === this.generation ? this.commits.slice(skip, skip + limit) : []).map(commit => this.historyItem(commit));
	}

	public async provideHistoryItemRefs(historyItemRefs?: readonly string[]): Promise<readonly ISCMHistoryItemRef[]> {
		const generation = this.generation;
		const snapshot = await this.gitService.historyRefs(this.repositoryId);
		if (this.isDisposed || generation !== this.generation) { return []; }
		this.branches = snapshot.branches;
		this.remotes = snapshot.remotes;
		this.acceptReferences(snapshot.references);
		this.setHistoryItemRef(currentRef(snapshot.status.head));
		const refs = [...this.references.values()].flat();
		return historyItemRefs ? refs.filter(ref => historyItemRefs.includes(ref.id)) : refs;
	}

	public async resolveHistoryItemRefsCommonAncestor(historyItemRefs: readonly string[]): Promise<string | undefined> {
		let ancestor = historyItemRefs[0];
		if (!ancestor) { return undefined; }
		for (const revision of historyItemRefs.slice(1)) {
			ancestor = (await this.gitService.compareChanges(ancestor, revision, 'mergeBase', this.repositoryId)).baseObjectId;
		}
		return ancestor;
	}

	private historyItem(commit: GitCommitSummary): ISCMHistoryItem {
		return {
			id: commit.objectId,
			parentIds: commit.parentObjectIds,
			subject: commit.subject,
			message: commit.subject,
			displayId: commit.objectId.slice(0, 7),
			timestamp: commit.timestampSeconds * 1000,
			references: this.references.get(commit.objectId) ?? [],
			remoteLinks: this.remoteLinks(commit.objectId),
		};
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

	private async loadUntil(count: number, generation: number): Promise<void> {
		while (!this.isDisposed && generation === this.generation && this.commits.length < count && this.hasMore) {
			if (this.loading) {
				await this.loading;
				continue;
			}
			const loading = this.loadPage(generation);
			this.loading = loading;
			try {
				await loading;
			} finally {
				if (this.loading === loading) this.loading = undefined;
			}
		}
	}

	private async loadPage(generation: number): Promise<void> {
		let page: GraphPage;
		try {
			if (!this.nextCursor) {
				const [graph, branches] = await Promise.all([this.gitService.graph({ limit: PageSize, revisions: this.historyRoots }, this.repositoryId), this.gitService.branches(this.repositoryId)]);
				page = graph;
				if (this.isDisposed || generation !== this.generation) { return; }
				if (graph.historyRevision >= this.referencesRevision || this.graphRevision === undefined) { this.branches = branches; }
			} else {
				page = await this.gitService.graph({ limit: PageSize, cursor: this.nextCursor, revisions: this.historyRoots }, this.repositoryId);
			}
		} catch (error) {
			throw historyError(error);
		}
		if (this.isDisposed || generation !== this.generation) return;
		if (this.graphRevision !== undefined && page.graphRevision !== this.graphRevision) {
			this.reset();
			return;
		}
		this.graphRevision = page.graphRevision;
		const known = new Set(this.commits.map(commit => commit.objectId));
		for (const commit of page.commits) {
			if (known.has(commit.objectId)) continue;
			known.add(commit.objectId);
			this.commits.push(commit);
		}
		if (page.historyRevision >= this.referencesRevision || this.referencesRevision === 0) {
			this.referencesRevision = page.historyRevision;
			this.remotes = page.remotes;
			this.acceptReferences(page.references);
		}
		this.nextCursor = page.nextCursor;
		this.hasMore = page.hasMore && page.nextCursor !== undefined && page.commits.length > 0;
	}

	private acceptReferences(references: readonly GitReference[]): void {
		this.references.clear();
		for (const reference of references) {
			const items = this.references.get(reference.objectId) ?? [];
			if (!items.some(item => item.id === referenceId(reference))) {
				const branch = reference.kind === 'localBranch' ? this.branches.find(branch => branch.name === reference.name) : undefined;
				items.push({
					...toHistoryRef(reference),
					upstream: branch?.upstream && references.some(remote => remote.kind === 'remoteBranch' && remote.name === branch.upstream) ? branch.upstream : undefined,
					canDelete: branch !== undefined && !branch.current && !branch.checkedOutElsewhere,
				});
			}
			this.references.set(reference.objectId, items);
		}
	}

	private remoteLinks(objectId: string): readonly { name: string; uri: URI; }[] {
		return this.remotes.flatMap(remote => {
			const identity = remote.identity;
			if (!identity || identity.provider === 'other') { return []; }
			const repositoryPath = [...identity.owner.split('/'), identity.repository].map(encodeURIComponent).join('/');
			const commitPath = identity.provider === 'gitlab' ? '-/commit' : identity.provider === 'bitbucket' ? 'commits' : 'commit';
			return [{ name: remote.name, uri: URI.parse(`https://${identity.host}/${repositoryPath}/${commitPath}/${objectId}`) }];
		});
	}

	private handleStatus(status: GitStatus): void {
		if (status.repositoryId !== this.repositoryId) return;
		const previous = this.historyStatus;
		if (previous?.streamInstanceId === status.streamInstanceId && previous.historyRevision >= status.historyRevision) return;
		this.historyStatus = status;
		if (previous?.streamInstanceId !== status.streamInstanceId || this.graphRevision === undefined) {
			this.reset();
			return;
		}
		if (this.referencesLoading) { return; }
		const generation = this.generation;
		const loading = this.updateReferences(generation).catch(() => {
			if (!this.isDisposed && generation === this.generation) { this.reset(); }
		}).finally(() => {
			if (this.referencesLoading === loading) { this.referencesLoading = undefined; }
		});
		this.referencesLoading = loading;
	}

	private async updateReferences(generation: number): Promise<void> {
		while (!this.isDisposed && generation === this.generation) {
			const snapshot = await this.gitService.historyRefs(this.repositoryId);
			if (this.isDisposed || generation !== this.generation) { return; }
			const wanted = this.historyStatus;
			if (snapshot.status.streamInstanceId !== wanted?.streamInstanceId) { return; }
			if (snapshot.status.historyRevision < wanted.historyRevision) { continue; }
			if (snapshot.graphRevision !== this.graphRevision) {
				this.reset();
				return;
			}
			this.historyStatus = snapshot.status;
			this.referencesRevision = snapshot.status.historyRevision;
			this.branches = snapshot.branches;
			this.remotes = snapshot.remotes;
			this.acceptReferences(snapshot.references);
			this.setHistoryItemRef(currentRef(snapshot.status.head));
			this.refsChanged.fire(this.commits.map(commit => this.historyItem(commit)));
			return;
		}
	}

	private reset(notify = true, preserveReferences = false): void {
		this.generation += 1;
		this.loading = undefined;
		this.referencesLoading = undefined;
		this.graphRevision = undefined;
		this.commits.length = 0;
		// Changing traversal roots does not change the repository's HEAD or upstream.
		if (!preserveReferences) {
			this.referencesRevision = 0;
			this.references.clear();
			this.branches = [];
			this.remotes = [];
			this.setHistoryItemRef(undefined);
		}
		this.nextCursor = undefined;
		this.hasMore = true;
		if (notify) this.changeEmitter.fire();
	}

	private setHistoryItemRef(ref: ISCMHistoryItemRef | undefined): void {
		const remote = [...this.references.values()].flat().find(item => item.category === 'remoteBranch' && item.name === ref?.upstream);
		if (remote?.id !== this.currentRemoteRef?.id || remote?.revision !== this.currentRemoteRef?.revision) {
			this.currentRemoteRef = remote;
			this.remoteRefChanged.fire(remote);
		}
		const previous = this.currentHistoryRef;
		if (ref?.id === previous?.id && ref?.name === previous?.name && ref?.revision === previous?.revision && ref?.category === previous?.category && ref?.upstream === previous?.upstream) return;
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
