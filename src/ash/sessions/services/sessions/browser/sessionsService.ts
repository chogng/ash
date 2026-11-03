import { localize } from '../../../../nls.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, transaction, type IReader } from '../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IUntitledChatSession, SessionId, ThreadId } from '../common/session.js';
import { ISessionsManagementService } from '../common/sessionsManagement.js';
import { WELCOME_COMPLETE_KEY } from '../../../common/welcome.js';
import { ICustomViewService } from '../../customView/browser/customViewService.js';
import { ClosedItemHistory } from './closedItemHistory.js';
import { SessionsRecencyHistory, type SessionRecencyEntry } from './sessionsRecencyHistory.js';
import { SessionsNavigation } from './sessionNavigation.js';
import { loadSessionGridState, saveSessionGridState, storedReference, type ISessionGridState } from './sessionGridState.js';
import { VisibleSessions, referenceForSelection, referenceKey, type SessionSlotPlacement, type SessionsSelection, type SessionsViewReference, type SessionsViewSelection } from './visibleSessions.js';

export type { SessionsSelection, SessionsViewSelection } from './visibleSessions.js';

/** Owns window-local visibility, active selection, and navigation history. */
export interface ISessionsService {
	readonly onDidChange: Event<void>;
	getSelection(reader?: IReader): SessionsSelection;
	readonly visibleSelections: readonly SessionsViewSelection[];
	readonly activeSelection: SessionsViewSelection | undefined;
	/** Changes for explicit conversation and covering Custom View navigation. */
	readonly navigationRevision: number;
	readonly canNavigateBack: boolean;
	readonly canNavigateForward: boolean;
	readonly recentSessions: readonly SessionRecencyEntry[];
	getLastViewedAt(entry: SessionRecencyEntry): number | undefined;
	initialize(): Promise<void>;
	openThread(sessionId: SessionId, threadId: ThreadId, options?: { readonly sideBySide?: boolean; }): Promise<void>;
	openSession(sessionId: SessionId, threadId: ThreadId): void;
	openUntitledSession(untitledSessionId: string): void;
	openNewSession(title?: string, options?: { readonly sideBySide?: boolean; readonly source?: 'restore'; readonly providerId?: string; readonly forkSource?: IUntitledChatSession['forkSource']; }): IUntitledChatSession;
	activateSelection(selection: SessionsViewSelection, options?: { readonly source: 'restore'; }): void;
	closeVisibleSelection(selection: SessionsViewSelection): void;
	reopenLastClosedItem(): Promise<void>;
	openPreviousSession(): Promise<void>;
	openNextSession(): Promise<void>;
}

type SessionPlacement = SessionSlotPlacement | 'focus';

export const ISessionsService = createServiceIdentifier<ISessionsService>('sessionsService');

type NavigationEntry = SessionsViewReference | { readonly kind: 'customView'; readonly id: string; readonly state?: string; };

/** Dedicated Sessions-window view state layered over the canonical Session model service. */
export class SessionsService extends Disposable implements ISessionsService {
	private readonly sessionService: ISessionsManagementService;
	private readonly _onDidChange = this._register(new Emitter<void>());
	private readonly slots = new VisibleSessions(reference => this.resolve(reference));
	private readonly recency: SessionsRecencyHistory;
	private readonly closedItems = new ClosedItemHistory();
	private readonly navigation = new SessionsNavigation<NavigationEntry>(
		navigationKey,
		entry => entry.kind === 'customView' || this.resolve(entry) !== undefined,
		entry => this.openHistoryEntry(entry),
		() => this._onDidChange.fire(),
	);
	private _navigationRevision = 0;
	private initialized = false;
	private readonly storedState: ISessionGridState | undefined;

	private readonly threadOpenFinished = this._register(new Emitter<{
		readonly outcome: 'opened' | 'superseded' | 'cancelled' | 'failed';
		readonly durationMs: number;
		readonly preparationMs?: number;
		readonly activationMs?: number;
		readonly sideBySide: boolean;
	}>());
	readonly onDidFinishThreadOpen = this.threadOpenFinished.event;

	readonly onDidChange = this._onDidChange.event;

	constructor(
		@ISessionsManagementService sessionService: ISessionsManagementService,
		@IStorageService private readonly storage: IStorageService,
		@ICustomViewService private readonly customViews: ICustomViewService,
	) {
		// Validate persisted input before allocating subscriptions that a failed constructor cannot release.
		const storedState = loadSessionGridState(storage);
		super();
		this.sessionService = sessionService;
		this.recency = new SessionsRecencyHistory(storage);
		this.storedState = storedState;
		this._register(storage.onWillSaveState(() => this.saveState()));
		this._register(sessionService.onDidChange(() => this.syncFromSessionService()));
		this.syncFromSessionService();
		this._register(autorun(reader => {
			const opening = customViews.activeCustomViewOpen.read(reader);
			if (!opening) return;
			// A custom-view open supersedes an in-flight Thread open without changing the covered selection.
			this._navigationRevision++;
			const entry = { kind: 'customView', id: opening.descriptor.id, state: opening.state } as const;
			if (opening.source === 'explicit') this.recency.markOpened(entry);
			if (opening.source !== 'history' && (opening.source !== 'restore' || this.initialized)) this.navigation.recordOpened(entry);
			this._onDidChange.fire();
		}));
	}

	get recentSessions(): readonly SessionRecencyEntry[] { return this.recency.entries.filter((entry): entry is SessionRecencyEntry => !('kind' in entry)); }
	getLastViewedAt(entry: SessionRecencyEntry): number | undefined { return this.recency.getLastViewedAt(entry); }
	get navigationRevision(): number { return this._navigationRevision; }
	get visibleSelections(): readonly SessionsViewSelection[] { return this.slots.read().visibleSelections; }
	get activeSelection(): SessionsViewSelection | undefined { return this.slots.read().activeSelection; }
	get canNavigateBack(): boolean { return this.navigation.canGoBack; }
	get canNavigateForward(): boolean { return this.navigation.canGoForward; }

	getSelection(reader?: IReader): SessionsSelection {
		return this.slots.read(reader);
	}

	async initialize(): Promise<void> {
		await this.sessionService.initialize();
		if (this.isDisposed) return;
		if (!this.initialized) {
			let restoredNavigation = false;
			for (const draft of this.storedState?.drafts ?? []) {
				if (!this.sessionService.untitledSessions.some(current => current.untitledSessionId === draft.untitledSessionId)) {
					this.sessionService.restoreUntitledSession(draft);
				}
			}
			// An explicit choice made while the catalog loads supersedes the saved arrangement.
			if (this.storedState && !this.slots.hasSlots) {
				const saved = this.storedState;
				this.slots.restore(saved.visible.map(storedReference), saved.active, this.catalogUnavailable);
				const active = this.activeSelection;
				if (active) {
					const current = referenceForSelection(active);
					const previous = [...this.recency.entries].reverse().map(entry =>
						'kind' in entry ? entry : { kind: 'session' as const, sessionId: entry.sessionId, threadId: entry.threadId });
					const opening = this.customViews.activeCustomViewOpen.get();
					const currentDestination = opening
						? { kind: 'customView' as const, id: opening.descriptor.id, state: opening.state }
						: current;
					restoredNavigation = this.navigation.restorePreviousVisits(previous, currentDestination);
					if (!restoredNavigation && !opening) this.navigation.recordOpened(current);
				}
			}

			const restored = activeSelection(this.sessionService);
			const alreadyOpen = restored && this.slots.find(reference => referenceKey(reference) === selectionKey(restored));
			if (!this.storedState && restored && !alreadyOpen && !this.activeSelection) {
				this.select(restored, 'open', 'automatic');
			}
			if (this.activeSelection && this.sessionService.state !== 'error') {
				this.activate(referenceForSelection(this.activeSelection), 'focus', 'automatic');
			}
			// Restoring drafts emits catalog changes; none may persist an incomplete arrangement.
			this.initialized = true;
			const opening = this.customViews.activeCustomViewOpen.get();
			if (!restoredNavigation && opening?.source === 'restore') {
				if (this.activeSelection) this.navigation.recordOpened(referenceForSelection(this.activeSelection));
				this.navigation.recordOpened({ kind: 'customView', id: opening.descriptor.id, state: opening.state });
			}
		}
		this.syncFromSessionService();
	}

	openSession(sessionId: SessionId, threadId: ThreadId): void { this.activate({ kind: 'session', sessionId, threadId }); }
	async openThread(sessionId: SessionId, threadId: ThreadId, options?: { readonly sideBySide?: boolean; }): Promise<void> {
		const revision = ++this._navigationRevision;
		const started = performance.now();
		const sideBySide = options?.sideBySide === true;
		let outcome: 'opened' | 'superseded' | 'cancelled' | 'failed' = 'superseded';
		let preparedAt: number | undefined;
		let activationMs: number | undefined;
		try {
			await this.sessionService.prepareThread(sessionId, threadId);
			preparedAt = performance.now();
			if (this.isDisposed) throw canceled();
			if (revision !== this._navigationRevision) return;
			const sideThread = sideBySide && this.slots.find(reference =>
				reference.kind === 'session' && reference.sessionId === sessionId && reference.threadId !== threadId);
			this.activate({ kind: 'session', sessionId, threadId, ...(sideThread ? { sideThread: true } : {}) }, sideBySide ? 'add' : 'open');
			activationMs = Math.round(performance.now() - preparedAt);
			outcome = 'opened';
		} catch (error) {
			outcome = isCancellationError(error) ? 'cancelled' : 'failed';
			throw error;
		} finally {
			this.threadOpenFinished.fire({ outcome, durationMs: Math.round(performance.now() - started), preparationMs: preparedAt === undefined ? undefined : Math.round(preparedAt - started), activationMs, sideBySide });
		}
	}
	openUntitledSession(untitledSessionId: string): void { this.activate({ kind: 'untitled', untitledSessionId }); }
	openNewSession(title = localize({ bundle: 'ash', key: 'chat.sessions.new' }, 'New Session'), options?: { readonly sideBySide?: boolean; readonly source?: 'restore'; readonly providerId?: string; readonly forkSource?: IUntitledChatSession['forkSource']; }): IUntitledChatSession {
		const session = this.sessionService.createUntitledSession(title, undefined, options?.providerId, true, options?.forkSource);
		this.select({ kind: 'untitled', session }, options?.sideBySide ? 'add' : 'open', options?.source === 'restore' ? 'automatic' : 'explicit');
		return session;
	}
	activateSelection(selection: SessionsViewSelection, options?: { readonly source: 'restore'; }): void { this.activate(referenceForSelection(selection), 'focus', options?.source === 'restore' ? 'automatic' : 'explicit'); }
	closeVisibleSelection(selection: SessionsViewSelection): void {
		const removed = this.slots.remove(selection);
		if (!removed) {
			return;
		}
		this._navigationRevision++;
		const { index, wasActive, replacement } = removed;
		const reference = referenceForSelection(selection);
		if (reference.kind === 'session') {
			if (wasActive && !this.customViews.activeCustomView.get()) this.recency.markViewed(reference);
			this.closedItems.recordClosedItem(reference, index);
		}
		if (selection.kind === 'untitled') {
			this.sessionService.discardUntitledSession(selection.session.untitledSessionId);
		}
		if (wasActive && replacement) this.activate(replacement, 'focus', 'automatic');
		else if (wasActive) {
			const session = this.sessionService.createUntitledSession('New chat');
			this.select({ kind: 'untitled', session }, 'open', 'automatic');
		}
		this.slots.publish(this.catalogUnavailable);
		this.saveState();
		this._onDidChange.fire();
	}
	async reopenLastClosedItem(): Promise<void> {
		const item = this.closedItems.lastClosedItem;
		if (!item) {
			return;
		}
		const { reference, index, replacedBy } = item;
		if (!this.resolve(reference)) {
			if (!this.catalogUnavailable) {
				this.closedItems.clear(item);
			}
			return;
		}
		const revision = ++this._navigationRevision;
		await this.sessionService.prepareThread(reference.sessionId, reference.threadId);
		if (this.isDisposed || this._navigationRevision !== revision || !this.resolve(reference)) {
			return;
		}
		this.activate(reference, replacedBy ? { index, replacedBy: this.materializedReference(replacedBy) } : index);
		this.closedItems.clear(item);
	}

	async openPreviousSession(): Promise<void> { this.navigation.goBack(); }
	async openNextSession(): Promise<void> { this.navigation.goForward(); }

	private syncFromSessionService(): void {
		if (this.sessionService.sessions.length && !this.storage.getBoolean(WELCOME_COMPLETE_KEY, StorageScope.PROFILE, false)) {
			this.storage.store(WELCOME_COMPLETE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		}
		// Catalog changes refresh identities without changing the foreground selection.
		this.navigation.updateEntries(reference => reference.kind === 'customView' ? reference : this.materializedReference(reference));
		const before = this.activeSelection;
		this.slots.refresh(reference => this.materializedReference(reference), this.catalogUnavailable);
		const after = this.activeSelection;
		if (before?.kind === 'untitled' && after?.kind === 'session' && !this.customViews.activeCustomView.get()) {
			const materialized = this.materializedReference(referenceForSelection(before));
			if (materialized.kind === 'session' && referenceKey(materialized) === selectionKey(after)) {
				this.recency.markOpened({ sessionId: materialized.sessionId, threadId: materialized.threadId });
			}
		}
		this.saveState();
		this._onDidChange.fire();
	}

	private saveState(): void {
		// Initial catalog loading must not replace a saved arrangement with an incomplete list.
		if (!this.initialized) {
			return;
		}
		saveSessionGridState(this.storage, this.slots.snapshot(), this.sessionService.untitledSessions);
	}

	private materializedReference(reference: SessionsViewReference): SessionsViewReference {
		const active = reference.kind === 'untitled' ? this.sessionService.materializedSessions.get().get(reference.untitledSessionId) : undefined;
		return active ? { kind: 'session', sessionId: active.sessionId, threadId: active.threadId, ...(active.sideThread ? { sideThread: true } : {}) } : reference;
	}

	private select(selection: SessionsViewSelection, mode: SessionPlacement = 'open', intent: 'explicit' | 'automatic' | 'history' = 'explicit'): void {
		this._navigationRevision++;
		const reference = referenceForSelection(selection);
		const previous = this.activeSelection;
		const covered = this.customViews.activeCustomView.get() !== undefined;
		if (!covered && previous?.kind === 'session' && selectionKey(previous) !== selectionKey(selection)) {
			this.recency.markViewed({ sessionId: previous.active.session.sessionId, threadId: previous.active.threadId });
		}
		if (covered && intent === 'automatic' && this.customViews.activeCustomViewOpen.get()?.source === 'restore') {
			// A restored view in an otherwise empty window covers the startup draft, rather than visiting it.
			this.navigation.insertBeforeInitialVisit(reference, entry => entry.kind === 'customView');
		}
		transaction(tx => {
			if (intent !== 'automatic') this.customViews.hideCustomView(tx);
			const displaced = this.slots.select(reference, mode === 'focus' ? 'open' : mode, this.catalogUnavailable, tx);
			if (intent === 'explicit' && mode === 'open' && displaced?.reference.kind === 'session') {
				this.closedItems.recordClosedItem(displaced.reference, displaced.index, reference);
			}
		});
		if (intent === 'explicit' || !(covered && intent === 'automatic') && (covered || selectionKey(previous) !== selectionKey(selection))) {
			this.navigation.recordOpened(reference);
		}
		if (intent === 'explicit' && reference.kind === 'session') {
			this.recency.markOpened({ sessionId: reference.sessionId, threadId: reference.threadId });
		}
		this.saveState();
		this._onDidChange.fire();
	}

	private get catalogUnavailable(): boolean {
		return this.sessionService.state === 'loading' || this.sessionService.state === 'error';
	}

	private openHistoryEntry(entry: NavigationEntry): boolean {
		if (entry.kind !== 'customView') {
			this.activate(entry, 'open', 'history');
			return true;
		}
		this.customViews.showCustomView(entry.id, { source: 'history', state: entry.state });
		return this.customViews.activeCustomView.get()?.id === entry.id
			&& this.customViews.activeCustomViewOpen.get()?.state === entry.state;
	}

	private activate(reference: SessionsViewReference, mode: SessionPlacement = 'open', intent: 'explicit' | 'automatic' | 'history' = 'explicit'): void {
		// Ordinary navigation to an already visible side Thread keeps that slot.
		const visible = this.slots.find(candidate => referenceKey(candidate) === referenceKey(reference)) ?? reference;
		this.updateManagementSelection(visible);
		this.select(this.resolve(visible)!, mode, intent);
	}

	private updateManagementSelection(reference: SessionsViewReference): void {
		if (reference.kind === 'session') this.sessionService.selectThread(reference.sessionId, reference.threadId);
		else this.sessionService.selectUntitledSession(reference.untitledSessionId);
	}

	private resolve(reference: SessionsViewReference | undefined): SessionsViewSelection | undefined {
		if (!reference) return undefined;
		if (reference.kind === 'untitled') {
			const session = this.sessionService.untitledSessions.find(candidate => candidate.untitledSessionId === reference.untitledSessionId);
			return session ? { kind: 'untitled', session } : undefined;
		}
		const session = this.sessionService.sessions.find(candidate => candidate.sessionId === reference.sessionId && candidate.status === 'active');
		const thread = session?.chats.find(candidate => candidate.threadId === reference.threadId && candidate.status === 'active');
		return session && thread ? { kind: 'session', active: { session, threadId: thread.threadId }, ...(reference.sideThread ? { sideThread: true } : {}) } : undefined;
	}
}

function activeSelection(sessionService: ISessionsManagementService): SessionsViewSelection | undefined {
	const untitled = sessionService.activeUntitledSession;
	if (untitled) return { kind: 'untitled', session: untitled };
	const active = sessionService.active;
	return active?.session.status === 'active' && active.session.chats.some(thread => thread.threadId === active.threadId && thread.status === 'active')
		? { kind: 'session', active }
		: undefined;
}

function selectionKey(selection: SessionsViewSelection | undefined): string | undefined {
	return selection ? referenceKey(referenceForSelection(selection)) : undefined;
}

function navigationKey(entry: NavigationEntry | undefined): string | undefined {
	return entry?.kind === 'customView' ? `customView:${JSON.stringify([entry.id, entry.state])}` : referenceKey(entry);
}
