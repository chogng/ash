import { Emitter, type Event } from '../../../../base/common/event.js';
import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { autorun, observableFromEvent, observableValue, transaction, type IObservable, type IReader } from '../../../../base/common/observable.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { canOpenThreadInCode, type IUntitledChatSession, type ModelRef, type SessionWorkspaceSelection, type SessionId, type ThreadId } from '../common/session.js';
import { ISessionsManagementService } from '../common/sessionsManagement.js';
import { WELCOME_COMPLETE_KEY } from '../../../common/welcome.js';
import { ICustomViewService } from '../../customView/browser/customViewService.js';
import { ClosedItemHistory } from './closedItemHistory.js';
import { SessionsRecencyHistory, type SessionRecencyEntry } from './sessionsRecencyHistory.js';
import { SessionsNavigation } from './sessionNavigation.js';
import { loadChatSelection, loadSessionGridState, saveChatSelection, saveSessionGridState, storedReference, type ISessionGridState, type SessionsChatModelPreference, type StoredChatSelection } from './sessionGridState.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { VisibleSessions, referenceForSelection, referenceKey, type SessionSlotPlacement, type SessionsSelection, type SessionsViewReference, type SessionsViewSelection } from './visibleSessions.js';

export type { SessionsSelection, SessionsViewSelection } from './visibleSessions.js';

interface ISessionOpenOptions {
	readonly reveal?: 'code';
}

/** Owns window-local visibility, active selection, and navigation history. */
export interface ISessionsService {
	readonly onDidChange: Event<void>;
	getSelection(reader?: IReader): SessionsSelection;
	readonly visibleSelections: readonly SessionsViewSelection[];
	readonly activeSelection: SessionsViewSelection | undefined;
	/** Changes for explicit conversation and covering Custom View navigation. */
	readonly navigationRevision: number;
	/** Entry composition supplies replay operations; this service remains the sole history owner. */
	recordEntryNavigation(id: string, open: () => Promise<void>, conversation: boolean): void;
	readonly canNavigateBack: boolean;
	readonly canNavigateForward: boolean;
	readonly recentSessions: readonly SessionRecencyEntry[];
	readonly chatSelection: IObservable<StoredChatSelection | undefined>;
	getChatSelection(reader?: IReader): SessionsViewSelection | undefined;
	restoreChatSelection(): Promise<void>;
	openChatDraft(model?: ModelRef, prepare?: (draftId: string) => void): void;
	selectChatThread(sessionId: SessionId, threadId: ThreadId): void;
	setChatModelPreference(preference: SessionsChatModelPreference): void;
	getLastViewedAt(entry: SessionRecencyEntry, reader?: IReader): number | undefined;
	markVisibleThreadViewed(entry: SessionRecencyEntry): void;
	initialize(): Promise<void>;
	openThread(sessionId: SessionId, threadId: ThreadId, options?: { readonly sideBySide?: boolean; }): Promise<void>;
	openSession(sessionId: SessionId, threadId: ThreadId, options?: ISessionOpenOptions): Promise<void>;
	openUntitledSession(untitledSessionId: string, options?: ISessionOpenOptions): Promise<void>;
	openNewSession(title?: string, options?: { readonly sideBySide?: boolean; readonly source?: 'restore'; readonly providerId?: string; readonly workspace?: SessionWorkspaceSelection; readonly devContainer?: boolean; readonly projectId?: string; readonly forkSource?: IUntitledChatSession['forkSource']; }): IUntitledChatSession;
	activateSelection(selection: SessionsViewSelection, options?: { readonly source: 'restore'; }): void;
	closeVisibleSelection(selection: SessionsViewSelection): void;
	reopenLastClosedItem(): Promise<void>;
	openPreviousSession(): Promise<void>;
	openNextSession(): Promise<void>;
}

type SessionPlacement = SessionSlotPlacement | 'focus';

export const ISessionsService = createServiceIdentifier<ISessionsService>('sessionsService');

type NavigationEntry = (SessionsViewReference | { readonly kind: 'customView'; readonly id: string; readonly state?: string; } | { readonly kind: 'entry'; readonly id: string; readonly open: () => Promise<void>; }) & { readonly reveal?: () => Promise<void>; };

/** Dedicated Sessions-window view state layered over the canonical Session model service. */
export class SessionsService extends Disposable implements ISessionsService {
	private readonly sessionService: ISessionsManagementService;
	private readonly _onDidChange = this._register(new Emitter<void>());
	private readonly slots = new VisibleSessions(reference => this.resolve(reference));
	private workspaceMode: 'chat' | 'code' = 'chat';
	private readonly recency: SessionsRecencyHistory;
	private readonly closedItems = new ClosedItemHistory();
	private readonly navigation = new SessionsNavigation<NavigationEntry>(
		navigationKey,
		entry => entry.kind === 'customView' || entry.kind === 'entry' || this.resolve(entry) !== undefined,
		entry => this.openHistoryEntry(entry),
		() => this._onDidChange.fire(),
	);
	private _navigationRevision = 0;
	private entryNavigation: { id: string; open: () => Promise<void>; } | undefined;
	private conversationNavigation: (() => Promise<void>) | undefined;
	private initialized = false;
	private readonly storedState: ISessionGridState | undefined;
	private readonly compactSelection = observableValue<StoredChatSelection | undefined>(this, undefined);
	readonly chatSelection: IObservable<StoredChatSelection | undefined> = this.compactSelection;
	private readonly chatCatalog;

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
		@ICommandService private readonly commands: ICommandService,
	) {
		// Validate persisted input before allocating subscriptions that a failed constructor cannot release.
		const storedState = loadSessionGridState(storage);
		super();
		this.sessionService = sessionService;
		this.compactSelection.set(loadChatSelection(storage), undefined);
		this.chatCatalog = observableFromEvent(this, sessionService.onDidChange, () => ({
			sessions: sessionService.sessions, drafts: sessionService.untitledSessions,
		}));
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
			const entry = { kind: 'customView', id: opening.descriptor.id, state: opening.state, reveal: this.entryNavigation?.open } as const;
			if (opening.source === 'explicit') this.recency.markOpened(entry);
			if (opening.source !== 'history' && (opening.source !== 'restore' || this.initialized)) this.navigation.recordOpened(entry);
			this._onDidChange.fire();
		}));
	}

	get recentSessions(): readonly SessionRecencyEntry[] { return this.recency.entries.filter((entry): entry is SessionRecencyEntry => !('kind' in entry)); }
	getLastViewedAt(entry: SessionRecencyEntry, reader?: IReader): number | undefined { return this.recency.getLastViewedAt(entry, reader); }

	markVisibleThreadViewed(entry: SessionRecencyEntry): void {
		const session = this.sessionService.sessions.find(candidate => candidate.sessionId === entry.sessionId && candidate.status === 'active');
		const thread = session?.chats.find(candidate => candidate.threadId === entry.threadId && candidate.status === 'active');
		if (thread) {
			// Record the activity seen in this window, even when the provider's clock differs from ours.
			const management = thread.management ?? (session?.chats.filter(chat => chat.status === 'active' && chat.origin.type !== 'agentSpawn').length === 1 ? session.management : undefined);
			this.recency.markViewed(entry, Math.max(thread.updatedAt?.getTime() ?? 0, management?.statusChangedAtUnixMs ?? 0));
		}
	}
	get navigationRevision(): number { return this._navigationRevision; }
	get visibleSelections(): readonly SessionsViewSelection[] { return this.getSelection().visibleSelections; }
	get activeSelection(): SessionsViewSelection | undefined { return this.getSelection().activeSelection; }
	get canNavigateBack(): boolean { return this.navigation.canGoBack; }
	get canNavigateForward(): boolean { return this.navigation.canGoForward; }

	getSelection(reader?: IReader): SessionsSelection {
		return this.slots.read(reader);
	}

	getChatSelection(reader?: IReader): SessionsViewSelection | undefined {
		const reference = this.chatSelection.read(reader);
		const { sessions, drafts } = this.chatCatalog.read(reader);
		if (reference?.kind === 'draft') {
			const session = drafts.find(draft => draft.untitledSessionId === reference.id);
			return session ? { kind: 'untitled', session } : undefined;
		}
		if (reference?.kind === 'thread') {
			const session = sessions.find(candidate => candidate.sessionId === reference.sessionId && candidate.kind === 'chat'
				&& candidate.backendSessionId === undefined && candidate.status === 'active');
			if (session?.chats.some(chat => chat.threadId === reference.threadId && chat.status === 'active')) {
				return { kind: 'session', active: { session, threadId: reference.threadId } };
			}
		}
		return undefined;
	}

	async restoreChatSelection(): Promise<void> {
		const reference = this.chatSelection.get();
		if (reference?.kind === 'thread') {
			await this.sessionService.initialize();
			if (this.isDisposed || this.chatSelection.get() !== reference || this.getChatSelection()) return;
			if (!this.sessionService.primaryCatalogReady) {
				throw new Error(this.sessionService.error ?? localize('sessions.chat.ashHistoryUnavailable', 'This Ash Chat conversation is unavailable.'));
			}
		}
		if (this.getChatSelection()) return;
		if (reference?.kind === 'draft') {
			const stored = this.storedState?.drafts.find(draft => draft.untitledSessionId === reference.id && draft.kind === 'chat');
			this.sessionService.restoreUntitledSession(stored ?? {
				untitledSessionId: reference.id, title: '', kind: 'chat', providerId: LOCAL_AGENT_HOST_PROVIDER_ID,
				workspace: { type: 'current' }, model: reference.model, reasoningEffortSelection: reference.effort, agent: undefined,
			});
		} else {
			this.openChatDraft();
		}
	}

	openChatDraft(model?: ModelRef, prepare?: (draftId: string) => void): void {
		const draft = this.sessionService.createUntitledSession('', { type: 'current' }, LOCAL_AGENT_HOST_PROVIDER_ID, false, undefined, { kind: 'chat' });
		try {
			if (model) this.sessionService.setUntitledSessionModel(draft.untitledSessionId, model);
			prepare?.(draft.untitledSessionId);
			this.setChatSelection({ kind: 'draft', id: draft.untitledSessionId, model });
		} catch (error) {
			this.sessionService.discardUntitledSession(draft.untitledSessionId);
			throw error;
		}
	}

	selectChatThread(sessionId: SessionId, threadId: ThreadId): void {
		const current = this.chatSelection.get();
		if (current?.kind === 'thread' && current.sessionId === sessionId && current.threadId === threadId) return;
		this.setChatSelection({ kind: 'thread', sessionId, threadId });
	}

	setChatModelPreference(preference: SessionsChatModelPreference): void {
		const current = this.chatSelection.get();
		if (current) this.setChatSelection({ ...current, model: preference.model, effort: preference.effort });
	}

	private setChatSelection(selection: StoredChatSelection): void {
		const previous = this.chatSelection.get();
		saveChatSelection(this.storage, selection);
		this.compactSelection.set(selection, undefined);
		if (previous?.kind === 'draft' && (selection.kind !== 'draft' || selection.id !== previous.id)) {
			this.sessionService.discardUntitledSession(previous.id);
		}
	}

	setWorkspaceMode(mode: 'chat' | 'code'): void {
		if (this.workspaceMode === mode) return;
		// Switching shells supersedes pending opens without changing the visible conversations.
		this.workspaceMode = mode;
		this._navigationRevision++;
		this._onDidChange.fire();
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

	openSession(sessionId: SessionId, threadId: ThreadId, options?: ISessionOpenOptions): Promise<void> {
		return this.openReference({ kind: 'session', sessionId, threadId }, options);
	}
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
			if (revision !== this._navigationRevision || !this.resolve({ kind: 'session', sessionId, threadId })) return;
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
	openUntitledSession(untitledSessionId: string, options?: ISessionOpenOptions): Promise<void> {
		return this.openReference({ kind: 'untitled', untitledSessionId }, options);
	}
	openNewSession(title?: string, options?: Parameters<ISessionsService['openNewSession']>[1]): IUntitledChatSession {
		const session = this.sessionService.createUntitledSession(title, options?.workspace, options?.providerId, true, options?.forkSource, options);
		this.select({ kind: 'untitled', session }, options?.sideBySide ? 'add' : 'open', options?.source === 'restore' ? 'automatic' : 'explicit');
		return session;
	}
	activateSelection(selection: SessionsViewSelection, options?: { readonly source: 'restore'; }): void { this.activate(referenceForSelection(selection), 'focus', options?.source === 'restore' ? 'automatic' : 'explicit'); }
	closeVisibleSelection(selection: SessionsViewSelection): void {
		const removed = this.slots.remove(selection, this.activeSelection);
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
			const session = this.sessionService.createUntitledSession();
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
		if (!this.resolve(reference)) return;
		const revision = ++this._navigationRevision;
		await this.sessionService.prepareThread(reference.sessionId, reference.threadId);
		if (this.isDisposed || this._navigationRevision !== revision || !this.resolve(reference)) {
			return;
		}
		this.activate(reference, replacedBy ? { index, replacedBy: this.materializedReference(replacedBy) } : index);
		this.closedItems.clear(item);
	}

	recordEntryNavigation(id: string, open: () => Promise<void>, conversation: boolean): void {
		const initial = !this.entryNavigation;
		const changed = this.entryNavigation?.id !== id || this.navigation.current?.kind === 'customView';
		this.entryNavigation = { id, open };
		if (conversation) this.conversationNavigation = open;
		if (!changed) return;
		this._navigationRevision++;
		const entry = { kind: 'entry', id, open } as const;
		// The first shell composition describes the startup selection rather than a second visit to it.
		const replaced = initial && conversation && this.navigation.replaceCurrent(entry, current =>
			current.kind !== 'entry' && current.kind !== 'customView' && referenceKey(current) === selectionKey(this.activeSelection));
		if (!replaced) this.navigation.recordOpened(entry);
		this._onDidChange.fire();
	}

	async openPreviousSession(): Promise<void> { await this.navigation.goBack(); }
	async openNextSession(): Promise<void> { await this.navigation.goForward(); }

	private syncFromSessionService(): void {
		const chat = this.chatSelection.get();
		const promoted = chat?.kind === 'draft' ? this.sessionService.materializedSessions.get().get(chat.id) : undefined;
		if (promoted) this.setChatSelection({ kind: 'thread', sessionId: promoted.sessionId, threadId: promoted.threadId, model: chat?.model, effort: chat?.effort });
		if (this.sessionService.sessions.length && !this.storage.getBoolean(WELCOME_COMPLETE_KEY, StorageScope.PROFILE, false)) {
			this.storage.store(WELCOME_COMPLETE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		}
		// Catalog changes refresh identities without changing the foreground selection.
		this.navigation.updateEntries(reference => reference.kind === 'customView' || reference.kind === 'entry' ? reference : { ...this.materializedReference(reference), reveal: reference.reveal });
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
			this.navigation.recordOpened({ ...reference, reveal: this.conversationNavigation });
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

	private async openHistoryEntry(entry: NavigationEntry): Promise<boolean> {
		if (entry.kind === 'entry') {
			await entry.open();
			return true;
		}
		await entry.reveal?.();
		if (entry.kind !== 'customView') {
			this.activate(entry, 'open', 'history');
			return true;
		}
		this.customViews.showCustomView(entry.id, { source: 'history', state: entry.state });
		return this.customViews.activeCustomView.get()?.id === entry.id
			&& this.customViews.activeCustomViewOpen.get()?.state === entry.state;
	}

	private async openReference(reference: SessionsViewReference, options: ISessionOpenOptions | undefined): Promise<void> {
		if (!this.isDisposed && this.activate(reference) && options?.reveal === 'code') {
			await this.commands.executeCommand('sessions.open.code', 'conversation');
		}
	}

	private activate(reference: SessionsViewReference, mode: SessionPlacement = 'open', intent: 'explicit' | 'automatic' | 'history' = 'explicit'): boolean {
		// Ordinary navigation to an already visible side Thread keeps that slot.
		const visible = this.slots.find(candidate => referenceKey(candidate) === referenceKey(reference)) ?? reference;
		if (!this.resolve(visible)) return false;
		this.updateManagementSelection(visible);
		const current = this.resolve(visible);
		if (!current) return false;
		this.select(current, mode, intent);
		return true;
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
		const thread = session?.chats.find(candidate => candidate.threadId === reference.threadId);
		return session && thread && canOpenThreadInCode(session, thread) ? { kind: 'session', active: { session, threadId: thread.threadId }, ...(reference.sideThread ? { sideThread: true } : {}) } : undefined;
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
	if (entry?.kind === 'entry') return `entry:${entry.id}`;
	return entry?.kind === 'customView' ? `customView:${JSON.stringify([entry.id, entry.state])}` : referenceKey(entry);
}
