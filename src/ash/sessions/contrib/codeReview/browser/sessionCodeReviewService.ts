import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';

export const codeReviewScheme = 'ash-code-review';
export const codeReviewRequestPrefix = 'ash-code-review-';
const storagePrefix = 'sessions.codeReview.';

export interface CodeReviewTarget {
	readonly sessionId: string;
	readonly threadId: string;
}

export interface CodeReviewFile {
	/** The comparison identity includes its source revision. */
	readonly key: string;
	readonly path: string;
	/** Older saved comparisons can derive this from their source identity. */
	readonly repositoryId?: string;
	readonly before: string;
	readonly after: string;
}

export interface CodeReviewComment {
	readonly id: string;
	readonly file: string;
	readonly side: 'original' | 'modified';
	readonly line: number;
	readonly endLine?: number;
	readonly text: string;
}

export interface CodeReviewDraft {
	readonly files: readonly CodeReviewFile[];
	readonly comments: readonly CodeReviewComment[];
}

export interface CodeReviewBatch extends CodeReviewDraft {
	readonly id: string;
	readonly pending?: { readonly expectedSequence: number; };
}

interface ReviewState {
	readonly draft: CodeReviewDraft;
	readonly batches: readonly CodeReviewBatch[];
	readonly seen: readonly string[];
}

const emptyDraft: CodeReviewDraft = { files: [], comments: [] };
const emptyState: ReviewState = { draft: emptyDraft, batches: [], seen: [] };

function isDraft(value: unknown): value is CodeReviewDraft {
	if (!isRecord(value) || !Array.isArray(value.files) || !Array.isArray(value.comments)) return false;
	const { files } = value;
	return files.every(file => isRecord(file) && typeof file.key === 'string' && typeof file.path === 'string'
		&& (file.repositoryId === undefined || typeof file.repositoryId === 'string')
		&& typeof file.before === 'string' && typeof file.after === 'string')
		&& value.comments.every(comment => isRecord(comment) && typeof comment.id === 'string'
			&& typeof comment.file === 'string' && (comment.side === 'original' || comment.side === 'modified')
			&& typeof comment.line === 'number' && Number.isSafeInteger(comment.line) && comment.line > 0
			&& (comment.endLine === undefined || typeof comment.endLine === 'number' && Number.isSafeInteger(comment.endLine) && comment.endLine >= comment.line)
			&& typeof comment.text === 'string'
			&& files.some(file => isRecord(file) && file.key === comment.file));
}

function isBatch(value: unknown): value is CodeReviewBatch {
	return isRecord(value) && typeof value.id === 'string' && value.id.startsWith(codeReviewRequestPrefix)
		&& (value.pending === undefined || isRecord(value.pending) && Number.isSafeInteger(value.pending.expectedSequence))
		&& isDraft(value) && value.comments.length > 0;
}

function storageKey(target: CodeReviewTarget): string {
	return storagePrefix + JSON.stringify([target.sessionId, target.threadId]);
}

export function codeReviewTarget(resource: URI): CodeReviewTarget | undefined {
	const threadId = new URLSearchParams(resource.query).get('thread');
	const sessionId = resource.path.slice(1);
	if (threadId && sessionId && !sessionId.includes('/')) return { sessionId, threadId };
	return undefined;
}

/** Removes the snapshot identity prefix from a file's display path. */
export function codeReviewFilePath(resource: URI): string {
	const prefix = resource.scheme === 'ash-thread-change' ? 3 : resource.scheme === 'ash-turn-diff' ? 2 : 1;
	return resource.path.split('/').slice(prefix).join('/');
}

export function codeReviewRepositoryId(resource: URI, turnRepositories?: ReadonlyMap<string, string>): string | undefined {
	if (resource.scheme === 'ash-thread-change') {
		return new URLSearchParams(resource.query).get('repository') ?? undefined;
	}
	if (resource.scheme === 'ash-turn-diff') {
		return turnRepositories?.get(resource.path.split('/', 2)[1]);
	}
	return undefined;
}

export function codeReviewResource(target?: CodeReviewTarget, batch?: string): URI {
	const query = new URLSearchParams();
	if (target) query.set('thread', target.threadId);
	if (batch) query.set('review', batch);
	return URI.from({ scheme: codeReviewScheme, path: target ? `/${target.sessionId}` : '/', query: query.toString() });
}

export const ISessionCodeReviewService = createServiceIdentifier<SessionCodeReviewService>('sessionCodeReviewService');

/** Owns local drafts and the immutable comparison reviewed by each submitted request. */
export class SessionCodeReviewService extends Disposable {
	private readonly changed = this._register(new Emitter<string>());
	private readonly sending = new Set<string>();
	private stateCache: { readonly key: string; readonly state: ReviewState; } | undefined;

	public readonly onDidChange = this.changed.event;

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@IChatService private readonly chat: IChatService,
	) {
		super();
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.WORKSPACE && event.key.startsWith(storagePrefix)) {
				if (this.stateCache?.key === event.key) this.stateCache = undefined;
				this.changed.fire(event.key);
			}
		}));
	}

	private read(target: CodeReviewTarget): ReviewState {
		const key = storageKey(target);
		if (this.stateCache?.key === key) return this.stateCache.state;
		let value: unknown;
		try { value = JSON.parse(this.storage.get(key, StorageScope.WORKSPACE, 'null')); } catch { return emptyState; }
		const state = isRecord(value) ? {
			draft: isDraft(value.draft) ? value.draft : emptyDraft,
			batches: Array.isArray(value.batches) ? value.batches.filter(isBatch) : [],
			seen: Array.isArray(value.seen) ? value.seen.filter((key): key is string => typeof key === 'string') : [],
		} : emptyState;
		this.stateCache = { key, state };
		return state;
	}

	private write(target: CodeReviewTarget, state: ReviewState): void {
		this.storage.store(storageKey(target), JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	public affects(target: CodeReviewTarget, key: string): boolean { return key === storageKey(target); }
	public draft(target: CodeReviewTarget): CodeReviewDraft { return this.read(target).draft; }
	public batch(target: CodeReviewTarget, id: string): CodeReviewBatch | undefined {
		return this.batches(target).find(batch => batch.id === id);
	}
	public batches(target: CodeReviewTarget): readonly CodeReviewBatch[] { return this.read(target).batches; }
	public pending(target: CodeReviewTarget): CodeReviewBatch | undefined {
		return this.read(target).batches.find(batch => !!batch.pending);
	}
	public isSending(target: CodeReviewTarget): boolean { return this.sending.has(storageKey(target)); }
	public seenFiles(target: CodeReviewTarget): readonly string[] { return this.read(target).seen; }

	public setFileSeen(target: CodeReviewTarget, key: string, seen: boolean): void {
		const state = this.read(target);
		const files = new Set(state.seen);
		if (seen) files.add(key);
		else files.delete(key);
		this.write(target, { ...state, seen: [...files] });
	}

	public save(target: CodeReviewTarget, file: CodeReviewFile, anchor: Pick<CodeReviewComment, 'side' | 'line' | 'endLine'>, text: string): void {
		const state = this.read(target);
		const previous = state.draft.comments.find(comment => comment.file === file.key && comment.side === anchor.side && (comment.endLine ?? comment.line) === (anchor.endLine ?? anchor.line));
		const comment: CodeReviewComment = { id: previous?.id ?? generateUuid(), file: file.key, ...anchor, text };
		const comments = previous ? state.draft.comments.map(entry => entry === previous ? comment : entry) : [...state.draft.comments, comment];
		const existingFile = state.draft.files.find(entry => entry.key === file.key);
		let files = state.draft.files;
		if (!existingFile) {
			files = [...files, file];
		} else if (!existingFile.repositoryId && file.repositoryId) {
			files = files.map(entry => entry === existingFile ? { ...entry, repositoryId: file.repositoryId } : entry);
		}
		this.write(target, { ...state, draft: { files, comments } });
	}

	public remove(target: CodeReviewTarget, id: string): void {
		const state = this.read(target);
		const comments = state.draft.comments.filter(comment => comment.id !== id);
		this.write(target, { ...state, draft: { comments, files: state.draft.files.filter(file => comments.some(comment => comment.file === file.key)) } });
	}

	public async send(target: CodeReviewTarget, isCurrent: () => boolean): Promise<void> {
		const key = storageKey(target);
		if (this.sending.has(key) || !isCurrent()) return;
		this.sending.add(key);
		this.changed.fire(key);
		try {
			const { thread } = await this.chat.readThread(target.sessionId, target.threadId);
			if (!isCurrent()) return;
			if (thread.status === 'archived') throw new Error(localize('sessions.codeReview.archived', 'This conversation is archived.'));
			const state = this.read(target);
			let batch = state.batches.find(batch => !!batch.pending);
			if (batch && thread.turns.some(turn => turn.items.some(item => item.type === 'userMessage' && item.clientId === batch?.id))) {
				this.finishSubmission(target, batch.id);
				return;
			}
			if (thread.turns.some(turn => !['completed', 'failed', 'interrupted'].includes(turn.status))) {
				throw new Error(localize('sessions.codeReview.agentBusy', 'Wait for the current agent turn to finish before sending review comments.'));
			}
			if (!batch) {
				if (!state.draft.comments.length) return;
				let current = state;
				let files = state.draft.files;
				if (files.some(file => file.repositoryId === undefined)) {
					files = await this.resolveDraftRepositories(target, files);
					current = this.read(target);
					if (!isCurrent() || current.batches.some(batch => batch.pending)
						|| (current.draft !== state.draft && JSON.stringify(current.draft) !== JSON.stringify(state.draft))) {
						return;
					}
				}
				batch = { ...state.draft, files, id: codeReviewRequestPrefix + generateUuid(), pending: { expectedSequence: thread.sequence } };
				this.write(target, { ...current, draft: emptyDraft, batches: [...current.batches, batch] });
			} else if (batch.pending?.expectedSequence !== thread.sequence) {
				// The old command can no longer be admitted. Keep its snapshot in history and
				// allow subsequent reviews without retrying an unconfirmed submission.
				this.finishSubmission(target, batch.id);
				throw new Error(localize('sessions.codeReview.changed', 'The conversation changed before this submission could be confirmed. Your review is still available here.'));
			}
			// Persist the exact comparison and command identity before the backend can accept it.
			await this.storage.flush();
			if (!isCurrent()) return;
			await this.chat.startTurn({
				...target, commandId: batch.id, expectedSequence: thread.sequence,
				mode: 'agent', commandInterpretation: 'literal',
				text: localize('sessions.codeReview.prompt', 'Please address these code review comments. Use each comment number when replying. The code shown is from the comparison I reviewed.'),
				contexts: [{ name: localize('sessions.codeReview.title', 'Code Review'), content: reviewContext(batch) }],
			});
			this.finishSubmission(target, batch.id);
		} finally {
			this.sending.delete(key);
			this.changed.fire(key);
		}
	}

	private async resolveDraftRepositories(target: CodeReviewTarget, files: readonly CodeReviewFile[]): Promise<readonly CodeReviewFile[]> {
		const resources = files.map(file => {
			if (file.repositoryId) return undefined;
			const modified = file.key.split('\0', 2)[1];
			if (!modified) return undefined;
			try { return URI.parse(modified); } catch { return undefined; }
		});
		const turnRepositories = resources.some(resource => resource?.scheme === 'ash-turn-diff')
			? new Map((await this.chat.listTurnChanges(target.sessionId, target.threadId)).map(capture => [capture.changeSetId, capture.repositoryId]))
			: undefined;
		return files.map((file, index) => {
			const resource = resources[index];
			const repositoryId = resource && codeReviewRepositoryId(resource, turnRepositories);
			return repositoryId ? { ...file, repositoryId } : file;
		});
	}

	private finishSubmission(target: CodeReviewTarget, id: string): void {
		const state = this.read(target);
		this.write(target, { ...state, batches: state.batches.map(batch => batch.id === id ? { ...batch, pending: undefined } : batch) });
	}
}

function reviewContext(batch: CodeReviewBatch): string {
	return JSON.stringify(batch.comments.map((comment, index) => {
		const file = batch.files.find(file => file.key === comment.file)!;
		const lines = (comment.side === 'original' ? file.before : file.after).split(/\r\n|\r|\n/);
		const firstLine = Math.max(1, comment.line - 2);
		const code = lines.slice(firstLine - 1, (comment.endLine ?? comment.line) + 2).join('\n');
		const excerptLimit = 4_000;
		return {
			comment: index + 1, repositoryId: file.repositoryId, path: file.path, side: comment.side, line: comment.line,
			...(comment.endLine ? { endLine: comment.endLine } : {}), firstLine, code: code.slice(0, excerptLimit), ...(code.length > excerptLimit ? { codeTruncated: true } : {}),
			feedback: comment.text,
		};
	}), undefined, 2);
}
