import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { observableValue, transaction, type IObservable, type IReader, type ITransaction } from "../../../../base/common/observable.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { isRecord } from '../../../../base/common/types.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IActiveSessionThread, IUntitledChatSession, SessionId, ThreadId } from "../common/session.js";
import { ISessionsManagementService } from "../common/sessionsManagement.js";
import type { SessionWorkspaceSelection } from '../common/session.js';

/** One visible slot in the dedicated Sessions Workbench. */
export type SessionsViewSelection =
	| { readonly kind: "session"; readonly active: IActiveSessionThread }
	| { readonly kind: "untitled"; readonly session: IUntitledChatSession };

export type SessionsPage = 'chat' | 'code';

export interface SessionsPageSelection {
	readonly visibleSelections: readonly SessionsViewSelection[];
	readonly activeSelection: SessionsViewSelection | undefined;
}

/** Owns each page's visibility, active selection, and navigation history. */
export interface ISessionsService {
	readonly onDidChange: Event<void>;
	readonly page: IObservable<SessionsPage>;
	selectPage(page: SessionsPage): void;
	getPageSelection(page: SessionsPage, reader?: IReader): SessionsPageSelection;
	readonly visibleSelections: readonly SessionsViewSelection[];
	readonly activeSelection: SessionsViewSelection | undefined;
	readonly canNavigateBack: boolean;
	readonly canNavigateForward: boolean;
	initialize(): Promise<void>;
	openThread(sessionId: SessionId, threadId: ThreadId): Promise<void>;
	openSession(sessionId: SessionId, threadId: ThreadId): void;
	openUntitledSession(untitledSessionId: string): void;
	openNewSession(title?: string, page?: SessionsPage): IUntitledChatSession;
	activateSelection(selection: SessionsViewSelection, page?: SessionsPage): void;
	closeVisibleSelection(selection: SessionsViewSelection, page?: SessionsPage): void;
	navigateBack(): void;
	navigateForward(): void;
}

export const ISessionsService = createServiceIdentifier<ISessionsService>("sessionsService");

type SessionsViewReference =
	| { readonly kind: "session"; readonly sessionId: SessionId; readonly threadId: ThreadId }
	| { readonly kind: "untitled"; readonly untitledSessionId: string };

/** Dedicated Sessions-window view state layered over the canonical Session model service. */
export class SessionsService extends Disposable implements ISessionsService {
	private readonly sessionService: ISessionsManagementService;
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly page = observableValue<SessionsPage>(this, 'chat');
	private readonly pages = { chat: new SessionsPageState(), code: new SessionsPageState() };
	private initialized = false;
	private readonly storedState: StoredSessionsViewState | undefined;

	private get current(): SessionsPageState { return this.pages[this.page.get()]; }

	readonly onDidChange = this._onDidChange.event;

	constructor(@ISessionsManagementService sessionService: ISessionsManagementService, @IStorageService private readonly storage: IStorageService) {
		super();
		this.sessionService = sessionService;
		const raw = storage.get('sessions.viewState', StorageScope.WORKSPACE);
		this.storedState = raw === undefined ? undefined : parseStoredSessionsViewState(JSON.parse(raw));
		this._register(storage.onWillSaveState(() => this.saveState()));
		this._register(sessionService.onDidChange(() => this.syncFromSessionService()));
		this.syncFromSessionService();
	}

	get visibleSelections(): readonly SessionsViewSelection[] { return this.current.visibleSelections.get(); }
	get activeSelection(): SessionsViewSelection | undefined { return this.current.activeSelection.get(); }
	get canNavigateBack(): boolean { return this.findNavigableIndex(this.current.historyIndex, -1) !== undefined; }
	get canNavigateForward(): boolean { return this.findNavigableIndex(this.current.historyIndex, 1) !== undefined; }

	selectPage(page: SessionsPage): void {
		if (page === this.page.get()) return;
		this.page.set(page);
		if (!this.activeSelection) this.openNewSession(page === 'code' ? 'New code session' : 'New chat');
		this._onDidChange.fire();
	}

	getPageSelection(page: SessionsPage, reader?: IReader): SessionsPageSelection {
		return { visibleSelections: this.pages[page].visibleSelections.read(reader), activeSelection: this.pages[page].activeSelection.read(reader) };
	}

	async initialize(): Promise<void> {
		await this.sessionService.initialize();
		if (!this.initialized) {
			this.initialized = true;
			if (this.storedState) {
				for (const page of ['chat', 'code'] as const) {
					const state = this.pages[page];
					// A user choice made while the catalog loads supersedes that page's saved arrangement.
					if (state.visibleReferences.length > 0) {
						continue;
					}
					const saved = this.storedState.pages[page];
					for (const reference of saved.visible) {
						if (reference.kind === 'untitled') {
							this.sessionService.restoreUntitledSession(reference.session);
						}
					}
					state.visibleReferences = saved.visible.map(storedReference);
					state.activeReference.set(state.visibleReferences[saved.active]);
					state.activeSelection.set(this.resolve(state.activeReference.get()));
					this.projectVisibleSelections(state);
					if (!state.activeSelection.get()) {
						state.activeSelection.set(state.visibleSelections.get()[0]);
					}
					const active = state.activeSelection.get();
					if (active) {
						this.record(referenceForSelection(active), state);
					}
				}
			}
			const restored = activeSelection(this.sessionService);
			const alreadyOpen = restored && Object.values(this.pages).some(state => state.visibleReferences.some(reference => referenceKey(reference) === selectionKey(restored)));
			if (!this.storedState && restored && !alreadyOpen && !this.pages.chat.activeSelection.get()) {
				this.select(restored, this.pages.chat);
			}
			if (this.activeSelection && this.sessionService.state !== 'error') {
				this.activate(referenceForSelection(this.activeSelection), this.current, 'focus');
			}
		}
		this.syncFromSessionService();
	}

	openSession(sessionId: SessionId, threadId: ThreadId): void { this.activate({ kind: 'session', sessionId, threadId }); }
	async openThread(sessionId: SessionId, threadId: ThreadId): Promise<void> {
		const state = this.current;
		await this.sessionService.openThread(sessionId, threadId);
		this.activate({ kind: 'session', sessionId, threadId }, state);
	}
	openUntitledSession(untitledSessionId: string): void { this.activate({ kind: 'untitled', untitledSessionId }); }
	openNewSession(title = this.page.get() === 'code' ? 'New code session' : 'New chat', page = this.page.get()): IUntitledChatSession {
		const session = this.sessionService.createUntitledSession(title);
		this.select({ kind: 'untitled', session }, this.pages[page]);
		return session;
	}
	activateSelection(selection: SessionsViewSelection, page = this.page.get()): void { this.activate(referenceForSelection(selection), this.pages[page], 'focus'); }
	closeVisibleSelection(selection: SessionsViewSelection, page = this.page.get()): void {
		const state = this.pages[page];
		const key = visibilityKey(referenceForSelection(selection));
		const index = state.visibleReferences.findIndex(reference => visibilityKey(reference) === key);
		if (index < 0) return;
		const active = state.activeSelection.get();
		const wasActive = active !== undefined && visibilityKey(referenceForSelection(active)) === key;
		state.visibleReferences.splice(index, 1);
		const replacement = state.visibleReferences.slice(index).find(reference => this.resolve(reference))
			?? state.visibleReferences.slice(0, index).reverse().find(reference => this.resolve(reference));
		if (wasActive) state.activeSelection.set(undefined);
		if (wasActive) {
			state.activeReference.set(undefined);
		}
		if (selection.kind === "untitled") {
			this.sessionService.discardUntitledSession(selection.session.untitledSessionId);
		}
		if (wasActive && replacement) this.activate(replacement, state, 'focus');
		else if (wasActive) {
			const session = this.sessionService.createUntitledSession(page === 'code' ? 'New code session' : 'New chat');
			this.select({ kind: 'untitled', session }, state);
		}
		this.projectVisibleSelections(state);
		this._onDidChange.fire();
	}
	navigateBack(): void { this.navigate(-1); }
	navigateForward(): void { this.navigate(1); }

	private syncFromSessionService(): void {
		// Catalog changes refresh identities; foreground selection belongs to the page that opened them.
		for (const state of Object.values(this.pages)) {
			state.visibleReferences = state.visibleReferences.map(reference => this.materializedReference(reference));
			state.history = state.history.map(reference => this.materializedReference(reference));
			const reference = state.activeReference.get();
			state.activeReference.set(reference ? this.materializedReference(reference) : undefined);
			this.projectVisibleSelections(state);
			if (this.sessionService.state !== 'loading' && this.sessionService.state !== 'error' && !this.resolve(state.activeReference.get())) {
				state.activeReference.set(state.visibleReferences[0]);
			}
			state.activeSelection.set(this.resolve(state.activeReference.get()) ?? state.visibleSelections.get()[0]);
		}
		this._onDidChange.fire();
	}

	private saveState(): void {
		// Initial catalog loading must not replace a saved arrangement with an incomplete list.
		if (!this.initialized) {
			return;
		}
		const snapshot = (page: SessionsPage): StoredSessionsPageState => {
			const state = this.pages[page];
			return {
				visible: state.visibleReferences.map(reference => {
					if (reference.kind === 'session') {
						return reference;
					}
					const session = this.sessionService.untitledSessions.find(draft => draft.untitledSessionId === reference.untitledSessionId)!;
					return { kind: 'untitled', session };
				}),
				active: state.visibleReferences.findIndex(reference => visibilityKey(reference) === visibilityKey(state.activeReference.get())),
			};
		};
		const state: StoredSessionsViewState = { version: 1, pages: { chat: snapshot('chat'), code: snapshot('code') } };
		this.storage.store('sessions.viewState', JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private materializedReference(reference: SessionsViewReference): SessionsViewReference {
		const active = reference.kind === 'untitled' ? this.sessionService.materializedSessions.get().get(reference.untitledSessionId) : undefined;
		return active ? { kind: 'session', sessionId: active.sessionId, threadId: active.threadId } : reference;
	}

	private select(selection: SessionsViewSelection, state = this.current, mode: 'open' | 'focus' = 'open'): void {
		const reference = referenceForSelection(selection);
		const previous = state.activeSelection.get();
		const existing = state.visibleReferences.findIndex(candidate => visibilityKey(candidate) === visibilityKey(reference));
		if (mode === 'focus' && existing >= 0) state.visibleReferences[existing] = reference;
		else {
			// List and history navigation show only the requested Session, even when it already occupies a restored split.
			state.visibleReferences = [reference];
		}
		transaction(tx => {
			state.activeReference.set(reference, tx);
			state.activeSelection.set(selection, tx);
			this.projectVisibleSelections(state, tx);
		});
		if (!state.navigating && selectionKey(previous) !== selectionKey(selection)) this.record(reference, state);
		this._onDidChange.fire();
	}

	private projectVisibleSelections(state: SessionsPageState, tx?: ITransaction): void {
		// A disconnected catalog cannot prove that a saved conversation was deleted.
		const catalogUnavailable = this.sessionService.state === 'loading' || this.sessionService.state === 'error';
		state.visibleReferences = state.visibleReferences.filter(reference => this.resolve(reference) !== undefined || reference.kind === 'session' && catalogUnavailable);
		state.visibleSelections.set(state.visibleReferences.flatMap(reference => {
			const selection = this.resolve(reference);
			return selection ? [selection] : [];
		}), tx);
	}

	private record(reference: SessionsViewReference, state: SessionsPageState): void {
		const key = referenceKey(reference);
		if (referenceKey(state.history[state.historyIndex]) === key) return;
		state.history.splice(state.historyIndex + 1);
		state.history.push(reference);
		state.historyIndex = state.history.length - 1;
	}

	private navigate(direction: -1 | 1): void {
		const state = this.current;
		const targetIndex = this.findNavigableIndex(state.historyIndex, direction);
		if (targetIndex === undefined) return;
		const reference = state.history[targetIndex];
		const previousIndex = state.historyIndex;
		state.navigating = true;
		state.historyIndex = targetIndex;
		try {
			this.activate(reference);
		} catch (error) {
			state.historyIndex = previousIndex;
			this._onDidChange.fire();
			throw error;
		} finally {
			state.navigating = false;
		}
	}

	private findNavigableIndex(from: number, direction: -1 | 1): number | undefined {
		for (let index = from + direction; index >= 0 && index < this.current.history.length; index += direction) {
			if (this.resolve(this.current.history[index])) return index;
		}
		return undefined;
	}

	private activate(reference: SessionsViewReference, state = this.current, mode: 'open' | 'focus' = 'open'): void {
		if (reference.kind === "session") this.sessionService.selectThread(reference.sessionId, reference.threadId);
		else this.sessionService.selectUntitledSession(reference.untitledSessionId);
		this.select(this.resolve(reference)!, state, mode);
	}

	private resolve(reference: SessionsViewReference | undefined): SessionsViewSelection | undefined {
		if (!reference) return undefined;
		if (reference.kind === "untitled") {
			const session = this.sessionService.untitledSessions.find(candidate => candidate.untitledSessionId === reference.untitledSessionId);
			return session ? { kind: "untitled", session } : undefined;
		}
		const session = this.sessionService.sessions.find(candidate => candidate.sessionId === reference.sessionId && candidate.status === "active");
		const thread = session?.chats.find(candidate => candidate.threadId === reference.threadId && candidate.status === "active");
		return session && thread ? { kind: "session", active: { session, threadId: thread.threadId } } : undefined;
	}
}

class SessionsPageState {
	// Keep the chosen identity while an unavailable catalog prevents a rendered selection.
	readonly activeReference = observableValue<SessionsViewReference | undefined>(this, undefined);
	readonly activeSelection = observableValue<SessionsViewSelection | undefined>(this, undefined);
	readonly visibleSelections = observableValue<readonly SessionsViewSelection[]>(this, []);
	visibleReferences: SessionsViewReference[] = [];
	history: SessionsViewReference[] = [];
	historyIndex = -1;
	navigating = false;
}

function activeSelection(sessionService: ISessionsManagementService): SessionsViewSelection | undefined {
	const untitled = sessionService.activeUntitledSession;
	if (untitled) return { kind: "untitled", session: untitled };
	const active = sessionService.active;
	return active?.session.status === "active" && active.session.chats.some(thread => thread.threadId === active.threadId && thread.status === "active")
		? { kind: "session", active }
		: undefined;
}

function referenceForSelection(selection: SessionsViewSelection): SessionsViewReference {
	return selection.kind === "session"
		? { kind: "session", sessionId: selection.active.session.sessionId, threadId: selection.active.threadId }
		: { kind: "untitled", untitledSessionId: selection.session.untitledSessionId };
}

function selectionKey(selection: SessionsViewSelection | undefined): string | undefined {
	return selection ? referenceKey(referenceForSelection(selection)) : undefined;
}

function referenceKey(reference: SessionsViewReference | undefined): string | undefined {
	return reference?.kind === "session"
		? `session:${reference.sessionId}:${reference.threadId}`
		: reference ? `untitled:${reference.untitledSessionId}` : undefined;
}

function visibilityKey(reference: SessionsViewReference | undefined): string | undefined {
	return reference?.kind === "session"
		? `session:${reference.sessionId}`
		: reference ? `untitled:${reference.untitledSessionId}` : undefined;
}

type StoredSessionsViewReference = Extract<SessionsViewReference, { kind: 'session' }> | { readonly kind: 'untitled'; readonly session: IUntitledChatSession };

interface StoredSessionsPageState {
	readonly visible: readonly StoredSessionsViewReference[];
	readonly active: number;
}

interface StoredSessionsViewState {
	readonly version: 1;
	readonly pages: Readonly<Record<SessionsPage, StoredSessionsPageState>>;
}

function storedReference(reference: StoredSessionsViewReference): SessionsViewReference {
	return reference.kind === 'session' ? reference : { kind: 'untitled', untitledSessionId: reference.session.untitledSessionId };
}

function parseStoredSessionsViewState(value: unknown): StoredSessionsViewState {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.pages)) {
		throw new TypeError('Invalid stored Sessions view state');
	}
	const untitledIds = new Set<string>();
	for (const page of ['chat', 'code'] as const) {
		const state = value.pages[page];
		if (!isRecord(state) || !Array.isArray(state.visible) || !Number.isInteger(state.active)
			|| (state.visible.length === 0 ? state.active !== -1 : (state.active as number) < 0 || (state.active as number) >= state.visible.length)) {
			throw new TypeError('Invalid stored Sessions page selection');
		}
		const keys = new Set<string>();
		for (const reference of state.visible) {
			if (!isRecord(reference)) {
				throw new TypeError('Invalid stored Sessions reference');
			}
			if (reference.kind === 'session') {
				if (!nonEmptyString(reference.sessionId) || !nonEmptyString(reference.threadId)) {
					throw new TypeError('Invalid stored Session identity');
				}
			} else if (reference.kind === 'untitled') {
				if (!isUntitledSession(reference.session) || untitledIds.has(reference.session.untitledSessionId)) {
					throw new TypeError('Invalid stored untitled Session');
				}
				untitledIds.add(reference.session.untitledSessionId);
			} else {
				throw new TypeError('Invalid stored Sessions reference kind');
			}
			const key = visibilityKey(storedReference(reference as unknown as StoredSessionsViewReference))!;
			if (keys.has(key)) {
				throw new TypeError('Duplicate stored Sessions slot');
			}
			keys.add(key);
		}
	}
	return value as unknown as StoredSessionsViewState;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isUntitledSession(value: unknown): value is IUntitledChatSession {
	return isRecord(value) && nonEmptyString(value.untitledSessionId) && typeof value.title === 'string'
		&& (value.model === undefined || isRecord(value.model) && nonEmptyString(value.model.provider) && nonEmptyString(value.model.model))
		&& (value.modelSelectionKind === undefined || value.modelSelectionKind === 'manual')
		&& (value.agent === undefined || isRecord(value.agent) && nonEmptyString(value.agent.name) && typeof value.agent.description === 'string' && nonEmptyString(value.agent.sourceId))
		&& isWorkspaceSelection(value.workspace);
}

function isWorkspaceSelection(value: unknown): value is SessionWorkspaceSelection {
	if (!isRecord(value)) {
		return false;
	}
	if (value.type === 'current') {
		return true;
	}
	if (value.type === 'local') {
		return nonEmptyString(value.root);
	}
	if (value.type === 'ssh') {
		return nonEmptyString(value.host) && nonEmptyString(value.root);
	}
	return value.type === 'multiple' && Array.isArray(value.folders) && value.folders.length > 0
		&& value.folders.every(folder => isRecord(folder) && typeof folder.label === 'string' && isRecord(folder.target)
			&& (folder.target.type === 'local' || folder.target.type === 'ssh') && isWorkspaceSelection(folder.target));
}
