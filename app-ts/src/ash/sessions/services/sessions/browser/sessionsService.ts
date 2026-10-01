import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { observableValue, transaction, type IObservable, type ITransaction } from "../../../../base/common/observable.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { IActiveSessionThread, IUntitledChatSession, SessionId, ThreadId } from "../common/session.js";
import type { ISessionsManagementService } from "../common/sessionsManagement.js";

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
	getPageSelection(page: SessionsPage): SessionsPageSelection;
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

	private get current(): SessionsPageState { return this.pages[this.page.get()]; }

	readonly onDidChange = this._onDidChange.event;

	constructor(sessionService: ISessionsManagementService) {
		super();
		this.sessionService = sessionService;
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

	getPageSelection(page: SessionsPage): SessionsPageSelection {
		return { visibleSelections: this.pages[page].visibleSelections.get(), activeSelection: this.pages[page].activeSelection.get() };
	}

	async initialize(): Promise<void> {
		await this.sessionService.initialize();
		if (!this.initialized) {
			this.initialized = true;
			const restored = activeSelection(this.sessionService);
			const alreadyOpen = restored && Object.values(this.pages).some(state => state.visibleReferences.some(reference => referenceKey(reference) === selectionKey(restored)));
			if (restored && !alreadyOpen && !this.pages.chat.activeSelection.get()) this.select(restored, this.pages.chat);
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
	activateSelection(selection: SessionsViewSelection, page = this.page.get()): void { this.activate(referenceForSelection(selection), this.pages[page]); }
	closeVisibleSelection(selection: SessionsViewSelection, page = this.page.get()): void {
		const state = this.pages[page];
		const key = visibilityKey(referenceForSelection(selection));
		const index = state.visibleReferences.findIndex(reference => visibilityKey(reference) === key);
		if (index < 0) return;
		const active = state.activeSelection.get();
		const wasActive = active !== undefined && visibilityKey(referenceForSelection(active)) === key;
		state.visibleReferences.splice(index, 1);
		const replacement = state.visibleReferences[Math.min(index, state.visibleReferences.length - 1)];
		if (wasActive) state.activeSelection.set(undefined);
		if (selection.kind === "untitled") this.sessionService.discardUntitledSession(selection.session.untitledSessionId);
		if (wasActive && replacement) this.activate(replacement, state);
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
			const previous = state.activeSelection.get();
			state.visibleReferences = state.visibleReferences.map(reference => this.materializedReference(reference));
			state.history = state.history.map(reference => this.materializedReference(reference));
			const reference = previous ? this.materializedReference(referenceForSelection(previous)) : undefined;
			state.activeSelection.set(this.resolve(reference));
			this.projectVisibleSelections(state);
			if (!state.activeSelection.get() && state.visibleReferences.length > 0) this.select(this.resolve(state.visibleReferences[0])!, state);
		}
		this._onDidChange.fire();
	}

	private materializedReference(reference: SessionsViewReference): SessionsViewReference {
		const active = reference.kind === 'untitled' ? this.sessionService.materializedSessions.get().get(reference.untitledSessionId) : undefined;
		return active ? { kind: 'session', sessionId: active.sessionId, threadId: active.threadId } : reference;
	}

	private select(selection: SessionsViewSelection, state = this.current): void {
		const reference = referenceForSelection(selection);
		const previous = state.activeSelection.get();
		const existing = state.visibleReferences.findIndex(candidate => visibilityKey(candidate) === visibilityKey(reference));
		if (existing >= 0) state.visibleReferences[existing] = reference;
		else {
			const previousIndex = previous ? state.visibleReferences.findIndex(candidate => visibilityKey(candidate) === visibilityKey(referenceForSelection(previous))) : -1;
			state.visibleReferences.splice(previousIndex >= 0 ? previousIndex + 1 : state.visibleReferences.length, 0, reference);
		}
		transaction(tx => {
			state.activeSelection.set(selection, tx);
			this.projectVisibleSelections(state, tx);
		});
		if (!state.navigating && selectionKey(previous) !== selectionKey(selection)) this.record(reference, state);
		this._onDidChange.fire();
	}

	private projectVisibleSelections(state: SessionsPageState, tx?: ITransaction): void {
		state.visibleReferences = state.visibleReferences.filter(reference => this.resolve(reference) !== undefined);
		state.visibleSelections.set(state.visibleReferences.map(reference => this.resolve(reference)!), tx);
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

	private activate(reference: SessionsViewReference, state = this.current): void {
		if (reference.kind === "session") this.sessionService.selectThread(reference.sessionId, reference.threadId);
		else this.sessionService.selectUntitledSession(reference.untitledSessionId);
		this.select(this.resolve(reference)!, state);
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
