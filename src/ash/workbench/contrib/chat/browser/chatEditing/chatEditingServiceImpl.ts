import { Emitter } from '../../../../../base/common/event.js';
import { TaskQueue, RunOnceScheduler } from '../../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableFromEvent, type IObservable, type IReader } from '../../../../../base/common/observable.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { IBulkEditService, ResourceFileEdit, ResourceTextEdit, type IBulkEditResult, ResourceEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import type { LanguageWorkspaceEdit } from '../../../../../editor/common/languages.js';
import { ITextModelResourceService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { localize } from '../../../../../nls.js';
import { IChatEditingService, type IChatEditReviewSession, type IModifiedFileEntry, type IModifiedFileEntryChangeHunk } from '../../common/editing/chatEditingService.js';
import { ChatEditingModifiedDocumentEntry } from './chatEditingModifiedDocumentEntry.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ChatEditSource, ChatEditOutcome } from '../../../../services/chat/common/chatService.js';
import { autoAcceptDelaySetting } from '../../common/constants.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { FileNotFoundError, IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { ChatEditingSessionStorage, type StoredFileReview, type StoredReviewEntry } from './chatEditingSessionStorage.js';
import { WorkspaceEditConflictError } from '../../../../../editor/browser/services/bulkEditService.js';
import type { LanguageWorkspaceEditEntry } from '../../../../../editor/common/languages.js';

interface ReviewTurn {
	readonly source: ChatEditSource;
	readonly outcome: ChatEditOutcome | 'pending';
}

interface EntryReview {
	readonly turns: Map<string, ReviewTurn>;
	cancelled: boolean;
	deadline: number | undefined;
	revision: number;
}

export class ChatEditingService extends Disposable implements IChatEditingService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly reviews = this._register(new DisposableMap<string, IModifiedFileEntry>());
	private readonly sessions = this._register(new DisposableMap<string, ChatEditReviewSession>());
	public readonly editingSessionsObs: IObservable<readonly IChatEditReviewSession[]> = observableFromEvent(
		this, this.onDidChange, () => [...this.sessions].map(([, session]) => session),
	);
	private readonly operations = new TaskQueue();
	private applyingEdits = false;
	private readonly autoAcceptChanged = this._register(new Emitter<IModifiedFileEntry>());
	public readonly onDidChangeAutoAccept = this.autoAcceptChanged.event;
	private readonly entryReviews = new Map<IModifiedFileEntry, EntryReview>();
	private readonly countdown = this._register(new RunOnceScheduler(() => this.tick(), 1000));
	private readonly persistence: ChatEditingSessionStorage;
	private initialized = false;
	private restorationFailed = false;
	private reviewRevision = 0;
	private savedRevision = -1;
	private readonly saveReview = this._register(new RunOnceScheduler(() => {
		void this.operations.schedule(() => this.saveReviews()).catch(onUnexpectedError);
	}, 100));

	constructor(
		@IBulkEditService private readonly bulkEdits: IBulkEditService,
		@ITextModelResourceService private readonly models: ITextModelResourceService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IAccessibilitySignalService private readonly signals: IAccessibilitySignalService,
		@IFileService private readonly files: IFileService,
		@IInstantiationService instantiation: IInstantiationService,
		@ILifecycleService lifecycle: ILifecycleService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.persistence = instantiation.createInstance(ChatEditingSessionStorage);
		this._register(this.onDidChange(() => {
			this.reviewRevision++;
			if (this.initialized && !this.applyingEdits) { this.saveReview.schedule(); }
		}));
		this._register(lifecycle.onWillShutdown(event => {
			this.saveReview.cancel();
			event.join(() => this.operations.schedule(() => this.storeState()), 'Agent reviews', () => this.restorationFailed || this.savedRevision === this.reviewRevision);
		}));
		void this.operations.schedule(() => this.restoreState()).catch(onUnexpectedError);
		this._register(toDisposable(() => { this.operations.clearPending(); this.entryReviews.clear(); }));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(autoAcceptDelaySetting)) {
				for (const [entry, review] of this.entryReviews) { this.startCountdown(entry, review); }
				this.scheduleTick();
			}
		}));
	}

	public get entries(): readonly IModifiedFileEntry[] { return [...this.reviews].map(([, entry]) => entry); }

	public applyEdits(edit: LanguageWorkspaceEdit, signal: AbortSignal, source: ChatEditSource): Promise<IBulkEditResult> {
		return this.operations.schedule(async () => {
			try { return await this.applyEdit(edit, signal, source); }
			finally { await this.saveReviews(); }
		});
	}

	private async applyEdit(edit: LanguageWorkspaceEdit, signal: AbortSignal, source: ChatEditSource): Promise<IBulkEditResult> {
		this.assertNotDisposed();
		signal.throwIfAborted();
		const edits = ResourceEdit.convert(edit);
		const documents = new Set<ChatEditingModifiedDocumentEntry>();
		this.applyingEdits = true;
		try {
			const fileEdits = edits.filter((edit): edit is ResourceFileEdit => edit instanceof ResourceFileEdit);
			const resources = new Map<string, URI>();
			for (const edit of edits) {
				for (const resource of edit instanceof ResourceTextEdit ? [edit.resource] : edit instanceof ResourceFileEdit ? [edit.oldResource, edit.newResource] : []) {
					if (resource) { resources.set(extUriBiasedIgnorePathCase.getComparisonKey(resource), resource); }
				}
			}
			const previous = new Map<string, IModifiedFileEntry>();
			for (const [key, entry] of this.reviews) {
				if (entry.resources.some(resource => resources.has(extUriBiasedIgnorePathCase.getComparisonKey(resource)))) { previous.set(key, entry); }
			}
			const atomic = fileEdits.length > 0 || [...previous.values()].some(entry => entry instanceof ChatEditingFileOperationEntry);
			const turns = new Map<string, ReviewTurn>();
			for (const entry of previous.values()) {
				for (const [key, outcome] of this.entryReviews.get(entry)?.turns ?? []) { turns.set(key, outcome); }
				this.cancelAutoAccept(entry);
			}
			turns.set(JSON.stringify([source.threadId, source.turnId]), { source, outcome: 'pending' });
			if (atomic) {
				// A later tool may edit a newly created or moved file. Its inverse joins the
				// earlier operation so review never restores only half of a resource change.
				for (const entry of previous.values()) {
					for (const resource of entry.resources) { resources.set(extUriBiasedIgnorePathCase.getComparisonKey(resource), resource); }
					if (entry instanceof ChatEditingModifiedDocumentEntry) {
						entry.beginAgentEdit(edits.filter((edit): edit is ResourceTextEdit => edit instanceof ResourceTextEdit && extUriBiasedIgnorePathCase.isEqual(edit.resource, entry.modifiedURI)).map(edit => edit.textEdit));
						documents.add(entry);
					}
				}
			} else {
				for (const resource of resources.values()) {
					const key = extUriBiasedIgnorePathCase.getComparisonKey(resource);
					let entry = this.reviews.get(key) as ChatEditingModifiedDocumentEntry | undefined;
					if (!entry) {
						const reference = await this.models.acquire({ resource }, signal);
						try { signal.throwIfAborted(); this.assertNotDisposed(); }
						catch (error) { reference.dispose(); throw error; }
						entry = new ChatEditingModifiedDocumentEntry(resource, reference, () => this.remove(key), () => this.changed.fire());
						this.reviews.set(key, entry);
					}
					entry.beginAgentEdit(edits.filter((edit): edit is ResourceTextEdit => edit instanceof ResourceTextEdit && extUriBiasedIgnorePathCase.isEqual(edit.resource, resource)).map(edit => edit.textEdit));
					documents.add(entry);
				}
			}
			const originalFiles = new Map<string, string | null>();
			if (atomic) {
				for (const resource of resources.values()) { originalFiles.set(resource.toString(), await this.readFile(resource)); }
				for (const entry of previous.values()) {
					if (entry instanceof ChatEditingFileOperationEntry) {
						for (const file of entry.fileSnapshots ?? []) { originalFiles.set(file.resource, file.original); }
					} else if (entry instanceof ChatEditingModifiedDocumentEntry) {
						const snapshot = entry.createSnapshot();
						const bom = originalFiles.get(snapshot.resource.toString())?.startsWith('\uFEFF') ? '\uFEFF' : '';
						originalFiles.set(snapshot.resource.toString(), bom + snapshot.original);
					}
				}
			}
			const result = await this.bulkEdits.apply(edit, { token: signal, showPreview: false });
			if (result.isApplied && atomic) {
				for (const entry of documents) { entry.endAgentEdit(); }
				documents.clear();
				const retained: IModifiedFileEntry[] = [];
				for (const key of previous.keys()) {
					const entry = this.reviews.deleteAndLeak(key);
					if (entry) { this.entryReviews.delete(entry); retained.push(entry); }
				}
				let fileSnapshots: StoredFileReview[] | undefined;
				try {
					fileSnapshots = await Promise.all([...resources.values()].map(async resource => ({
						resource: resource.toString(), original: originalFiles.get(resource.toString())!, current: await this.readFile(resource),
					})));
				} catch (error) { this.reportStorageError(error); }
				const entry = new ChatEditingFileOperationEntry([...resources.values()], result.undo, retained, () => this.remove(entry.id), () => this.changed.fire(), fileSnapshots);
				this.reviews.set(entry.id, entry);
			}
			if (result.isApplied) {
				void this.signals.playSignal(AccessibilitySignal.chatEditModifiedFile);
				for (const entry of this.entries) {
					if (entry.resources.some(resource => resources.has(extUriBiasedIgnorePathCase.getComparisonKey(resource)))) {
						const entryTurns = atomic ? new Map(turns) : new Map(this.entryReviews.get(entry)?.turns);
						entryTurns.set(JSON.stringify([source.threadId, source.turnId]), { source, outcome: 'pending' });
						this.entryReviews.set(entry, { turns: entryTurns, cancelled: false, deadline: undefined, revision: 0 });
					}
				}
			}
			return result;
		} finally {
			for (const entry of documents) { entry.endAgentEdit(); }
			this.applyingEdits = false;
			this.synchronizeSessions();
			this.changed.fire();
		}
	}

	public acceptEntry(entry: IModifiedFileEntry, hunk?: IModifiedFileEntryChangeHunk): Promise<void> {
		const contributors = new Set([...this.entryReviews.get(entry)?.turns.values() ?? []].map(turn => turn.source.threadId));
		this.cancelAutoAccept(entry);
		return this.operations.schedule(async () => {
			this.requireEntry(entry, contributors);
			try { await entry.accept(hunk); }
			finally { await this.saveReviews(); }
			void this.signals.playSignal(AccessibilitySignal.editsKept);
		});
	}

	public rejectEntry(entry: IModifiedFileEntry, hunk?: IModifiedFileEntryChangeHunk): Promise<void> {
		const contributors = new Set([...this.entryReviews.get(entry)?.turns.values() ?? []].map(turn => turn.source.threadId));
		this.cancelAutoAccept(entry);
		return this.operations.schedule(async () => {
			this.requireEntry(entry, contributors);
			try { await entry.reject(hunk); }
			finally { await this.saveReviews(); }
			void this.signals.playSignal(AccessibilitySignal.editsUndone);
		});
	}

	private ensureSession(threadId: string): void {
		if (this.sessions.has(threadId)) { return; }
		const resource = URI.from({ scheme: Schemas.internal, authority: 'chat-session', query: new URLSearchParams({ threadId }).toString() });
		const entries = observableFromEvent(this, this.onDidChange, () => this.entriesForThread(threadId));
		this.sessions.set(threadId, new ChatEditReviewSession(resource, entries, (accept, resources) => this.decideSession(threadId, accept, resources)));
	}

	private entriesForThread(threadId: string): readonly IModifiedFileEntry[] {
		return this.entries.filter(entry => [...this.entryReviews.get(entry)?.turns.values() ?? []].some(turn => turn.source.threadId === threadId));
	}

	private synchronizeSessions(): void {
		const activeThreads = new Set<string>();
		for (const review of this.entryReviews.values()) {
			for (const turn of review.turns.values()) { activeThreads.add(turn.source.threadId); }
		}
		for (const threadId of activeThreads) { this.ensureSession(threadId); }
		for (const [threadId] of this.sessions) {
			if (!activeThreads.has(threadId)) { this.sessions.deleteAndDispose(threadId); }
		}
	}

	private async decideSession(threadId: string, accept: boolean, resources: readonly URI[]): Promise<void> {
		const select = (): readonly IModifiedFileEntry[] => {
			const entries = this.entriesForThread(threadId).filter(entry => resources.length === 0 || entry.resources.some(resource => resources.some(selected => extUriBiasedIgnorePathCase.isEqual(selected, resource))));
			// Validate the whole selection before changing anything. A shared baseline
			// cannot be decided by one chat without also deciding another chat's edits.
			if (entries.some(entry => [...this.entryReviews.get(entry)!.turns.values()].some(turn => turn.source.threadId !== threadId))) {
				throw new Error(localize('chatEditing.sharedReview', 'These changes include edits from other chats. Review the shared file or change set separately.'));
			}
			return entries;
		};
		this.assertNotDisposed();
		for (const entry of select()) { this.cancelAutoAccept(entry); }
		return this.operations.schedule(async () => {
			this.assertNotDisposed();
			const selected = select();
			try {
				for (const entry of selected) {
					this.cancelAutoAccept(entry);
					if (accept) { await entry.accept(); } else { await entry.reject(); }
				}
			} finally { await this.saveReviews(); }
			if (selected.length) { void this.signals.playSignal(accept ? AccessibilitySignal.editsKept : AccessibilitySignal.editsUndone); }
		});
	}

	private requireEntry(entry: IModifiedFileEntry, contributors: ReadonlySet<string>): void {
		this.assertNotDisposed();
		if (!this.entries.includes(entry) || [...this.entryReviews.get(entry)?.turns.values() ?? []].some(turn => !contributors.has(turn.source.threadId))) {
			throw new Error(localize('chatEditing.stale', 'The change has changed. Review it again.'));
		}
	}

	public finishTurn(source: ChatEditSource, outcome: ChatEditOutcome): Promise<void> {
		return this.operations.schedule(async () => {
			const key = JSON.stringify([source.threadId, source.turnId]);
			for (const [entry, review] of this.entryReviews) {
				if (review.turns.get(key)?.outcome === 'pending') {
					review.turns.set(key, { source, outcome });
					this.startCountdown(entry, review);
				}
			}
			this.scheduleTick();
		});
	}

	public getAutoAcceptCountdown(entry: IModifiedFileEntry): number | undefined {
		const deadline = this.entryReviews.get(entry)?.deadline;
		return deadline === undefined ? undefined : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
	}

	public cancelAutoAccept(entry: IModifiedFileEntry): void {
		const review = this.entryReviews.get(entry);
		if (!review) { return; }
		review.cancelled = true;
		review.revision++;
		review.deadline = undefined;
		this.autoAcceptChanged.fire(entry);
		this.scheduleTick();
	}

	private startCountdown(entry: IModifiedFileEntry, review: EntryReview): void {
		const delay = this.configuration.getValue<number>(autoAcceptDelaySetting);
		review.revision++;
		review.deadline = delay > 0 && !review.cancelled && [...review.turns.values()].every(turn => turn.outcome === 'completed') ? Date.now() + delay * 1000 : undefined;
		this.autoAcceptChanged.fire(entry);
	}

	private scheduleTick(): void {
		this.countdown.cancel();
		const deadlines = [...this.entryReviews.values()].flatMap(review => review.deadline === undefined ? [] : [review.deadline]);
		if (deadlines.length > 0) { this.countdown.schedule(Math.max(0, Math.min(1000, Math.min(...deadlines) - Date.now()))); }
	}

	private tick(): void {
		for (const [entry, review] of this.entryReviews) {
			if (review.deadline === undefined) { continue; }
			if (review.deadline <= Date.now()) {
				const revision = review.revision;
				review.deadline = undefined;
				// Recheck inside the edit queue: a newer tool write or cancellation wins over an expired timer.
				void this.operations.scheduleSkipIfCleared(async () => {
					if (this.entryReviews.get(entry) === review && review.revision === revision && !review.cancelled && [...review.turns.values()].every(turn => turn.outcome === 'completed')) {
						await entry.accept();
						await this.saveReviews();
						void this.signals.playSignal(AccessibilitySignal.editsKept);
					}
				}).catch(onUnexpectedError);
			} else { this.autoAcceptChanged.fire(entry); }
		}
		this.scheduleTick();
	}

	private remove(key: string): void {
		const entry = this.reviews.get(key);
		if (entry) { this.entryReviews.delete(entry); }
		this.reviews.deleteAndDispose(key);
		if (!this.applyingEdits) { this.synchronizeSessions(); }
		this.scheduleTick();
		this.changed.fire();
	}

	private async readFile(resource: URI): Promise<string | null> {
		try { return (await this.files.readFile(resource)).content; }
		catch (error) { if (error instanceof FileNotFoundError) { return null; } throw error; }
	}

	private reportStorageError(error: unknown): void {
		this.notifications.error(localize('chatEditing.storageFailed', 'Could not restore or save Agent reviews: {0}', String(error)));
	}

	private async saveReviews(): Promise<void> {
		this.saveReview.cancel();
		try { await this.storeState(); }
		catch (error) { this.reportStorageError(error); }
	}

	private async storeState(): Promise<void> {
		if (!this.initialized || this.restorationFailed || this.isDisposed) { return; }
		const revision = this.reviewRevision;
		const entries: StoredReviewEntry[] = this.entries.map(entry => {
			const sources = [...this.entryReviews.get(entry)!.turns.values()].map(turn => ({ ...turn.source, outcome: turn.outcome }));
			if (entry instanceof ChatEditingModifiedDocumentEntry) {
				const snapshot = entry.createSnapshot();
				return { kind: 'text', resource: snapshot.resource.toString(), original: snapshot.original, current: snapshot.current, sources };
			}
			if (entry instanceof ChatEditingFileOperationEntry && entry.fileSnapshots) {
				return { kind: 'files', files: entry.fileSnapshots, sources };
			}
			throw new Error(localize('chatEditing.noRecovery', 'The file operation has no recovery snapshot. Review it before closing the window.'));
		});
		await this.persistence.storeState({ version: 1, entries });
		this.savedRevision = revision;
	}

	private async restoreState(): Promise<void> {
		try {
			const saved = this.persistence.restoreState();
			for (const snapshot of saved?.entries ?? []) {
				if (this.isDisposed) { return; }
				let entry: IModifiedFileEntry;
				let key: string;
				if (snapshot.kind === 'text') {
					const resource = URI.parse(snapshot.resource);
					let reference: Awaited<ReturnType<ITextModelResourceService['acquire']>>;
					try { reference = await this.models.acquire({ resource }, new AbortController().signal); }
					catch (error) { if (error instanceof FileNotFoundError) { continue; } throw error; }
					if (this.isDisposed) { reference.dispose(); return; }
					key = extUriBiasedIgnorePathCase.getComparisonKey(resource);
					const document = new ChatEditingModifiedDocumentEntry(resource, reference, () => this.remove(key), () => this.changed.fire(), { resource, original: snapshot.original, current: snapshot.current });
					if (document.hunks.length === 0) { document.dispose(); continue; }
					entry = document;
				} else {
					const files = snapshot.files;
					const operation = new ChatEditingFileOperationEntry(files.map(file => URI.parse(file.resource)), () => this.restoreFiles(files), [], () => this.remove(operation.id), () => this.changed.fire(), files);
					entry = operation;
					key = operation.id;
				}
				this.reviews.set(key, entry);
				this.entryReviews.set(entry, {
					turns: new Map(snapshot.sources.map(source => [JSON.stringify([source.threadId, source.turnId]), { source, outcome: source.outcome }])),
					cancelled: true, deadline: undefined, revision: 0,
				});
			}
		} catch (error) {
			// Preserve unreadable saved data rather than overwriting it with a partial restore.
			this.restorationFailed = true;
			this.reportStorageError(error);
		} finally {
			if (!this.isDisposed) { this.synchronizeSessions(); }
			this.initialized = true;
			this.changed.fire();
		}
	}

	private async restoreFiles(files: readonly StoredFileReview[]): Promise<void> {
		for (const file of files) {
			if (await this.readFile(URI.parse(file.resource)) !== file.current) {
				throw new WorkspaceEditConflictError(localize('chatEditing.recoveryConflict', 'A file changed after the Agent edit. Its changes were kept; review the file before rejecting this change set.'));
			}
		}
		const entries = files.flatMap<LanguageWorkspaceEditEntry>(file => {
			const resource = URI.parse(file.resource);
			if (file.original === file.current) { return []; }
			return file.original === null
				? [{ kind: 'delete', resource, missing: 'error', mode: 'fileOrEmptyDirectory' }]
				: [{ kind: 'create', resource, contents: file.original, existing: file.current === null ? 'error' : 'overwrite' }];
		});
		if (entries.length > 0) {
			const result = await this.bulkEdits.apply({ entries }, { showPreview: false });
			if (!result.isApplied) { throw new Error(localize('chatEditing.restoreCancelled', 'The change set was not restored. It remains available for review.')); }
		}
	}
}

/** A disposable view of service-owned entries; it never owns another text baseline. */
class ChatEditReviewSession extends Disposable implements IChatEditReviewSession {
	public readonly isGlobalEditingSession = false;
	private readonly disposed = this._register(new Emitter<void>());
	public readonly onDidDispose = this.disposed.event;

	constructor(
		public readonly chatSessionResource: URI,
		public readonly entries: IObservable<readonly IModifiedFileEntry[]>,
		private readonly decide: (accept: boolean, resources: readonly URI[]) => Promise<void>,
	) { super(); }

	public getEntry(uri: URI): IModifiedFileEntry | undefined {
		return this.entries.get().find(entry => entry.resources.some(resource => extUriBiasedIgnorePathCase.isEqual(resource, uri)));
	}

	public readEntry(uri: URI, reader: IReader): IModifiedFileEntry | undefined {
		return this.entries.read(reader).find(entry => entry.resources.some(resource => extUriBiasedIgnorePathCase.isEqual(resource, uri)));
	}

	public async accept(...uris: URI[]): Promise<void> {
		this.assertNotDisposed();
		await this.decide(true, uris);
	}

	public async reject(...uris: URI[]): Promise<void> {
		this.assertNotDisposed();
		await this.decide(false, uris);
	}

	public override dispose(): void {
		if (this.isDisposed) { return; }
		this.disposed.fire();
		super.dispose();
	}
}

class ChatEditingFileOperationEntry extends Disposable implements IModifiedFileEntry {
	public readonly isFileOperation = true;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	public readonly id = crypto.randomUUID();
	public readonly hunks = [];
	public isBusy = false;
	public readonly modifiedURI: URI;
	private reverted = false;
	private readonly remaining: IModifiedFileEntry[];

	constructor(public readonly resources: readonly URI[], private readonly undo: () => Promise<void>, previous: readonly IModifiedFileEntry[], private readonly complete: () => void, notify: () => void, public readonly fileSnapshots?: readonly StoredFileReview[]) {
		super();
		this._register(this.onDidChange(notify));
		for (const entry of previous) { this._register(entry); }
		this.remaining = [...previous].reverse();
		this.modifiedURI = resources[resources.length - 1]!;
	}

	public async accept(): Promise<void> { if (!this.isBusy) { this.complete(); } }
	public async reject(): Promise<void> {
		if (this.isBusy) { return; }
		this.isBusy = true;
		this.changed.fire();
		try {
			if (!this.reverted) {
				const documents = this.remaining.filter((entry): entry is ChatEditingModifiedDocumentEntry => entry instanceof ChatEditingModifiedDocumentEntry);
				for (const entry of documents) { entry.beginRestore(); }
				try { await this.undo(); this.reverted = true; }
				finally { for (const entry of documents) { entry.endAgentEdit(); } }
			}
			while (this.remaining.length > 0) { await this.remaining[0]!.reject(); this.remaining.shift(); }
		}
		finally { this.isBusy = false; this.changed.fire(); }
		this.complete();
	}
	public getAccessibleContent(): string { return localize('chatEditing.atomicFiles', 'Atomic file operation affecting:\n{0}', this.resources.map(resource => resource.fsPath).join('\n')); }
}
