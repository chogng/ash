import { Emitter } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import type { IActiveSessionThread, IUntitledChatSession, SessionId, ThreadId } from "../../../services/sessions/common/session.js";
import type { ISessionsManagementService } from "../../../services/sessions/common/sessionsManagementService.js";
import type { ISessionsService, SessionsViewSelection } from "../common/sessionsService.js";

type SessionsViewReference =
	| { readonly kind: "session"; readonly sessionId: SessionId; readonly threadId: ThreadId }
	| { readonly kind: "untitled"; readonly untitledSessionId: string };

/** Dedicated Sessions-window view state layered over the canonical Session model service. */
export class SessionsService extends Disposable implements ISessionsService {
	private readonly sessionService: ISessionsManagementService;
	private readonly _onDidChange = this._register(new Emitter<void>());
	private _activeSelection: SessionsViewSelection | undefined;
	private _visibleSelections: readonly SessionsViewSelection[] = [];
	private visibleReferences: SessionsViewReference[] = [];
	private readonly history: SessionsViewReference[] = [];
	private historyIndex = -1;
	private navigating = false;
	private closingVisibilityKey: string | undefined;

	readonly onDidChange = this._onDidChange.event;

	constructor(sessionService: ISessionsManagementService) {
		super();
		this.sessionService = sessionService;
		this._register(sessionService.onDidChange(() => this.syncFromSessionService()));
		this.syncFromSessionService();
	}

	get visibleSelections(): readonly SessionsViewSelection[] { return this._visibleSelections; }
	get activeSelection(): SessionsViewSelection | undefined { return this._activeSelection; }
	get canNavigateBack(): boolean { return this.findNavigableIndex(this.historyIndex, -1) !== undefined; }
	get canNavigateForward(): boolean { return this.findNavigableIndex(this.historyIndex, 1) !== undefined; }

	async initialize(): Promise<void> {
		await this.sessionService.initialize();
		this.syncFromSessionService();
	}

	openSession(sessionId: SessionId, threadId: ThreadId): void { this.sessionService.selectThread(sessionId, threadId); }
	openUntitledSession(untitledSessionId: string): void { this.sessionService.selectUntitledSession(untitledSessionId); }
	openNewSession(title = "New session"): IUntitledChatSession { return this.sessionService.createUntitledSession(title); }
	activateSelection(selection: SessionsViewSelection): void { this.activate(referenceForSelection(selection)); }
	closeVisibleSelection(selection: SessionsViewSelection): void {
		const key = visibilityKey(referenceForSelection(selection));
		const index = this.visibleReferences.findIndex(reference => visibilityKey(reference) === key);
		if (index < 0) return;
		const wasActive = this._activeSelection !== undefined && visibilityKey(referenceForSelection(this._activeSelection)) === key;
		this.visibleReferences.splice(index, 1);
		const replacement = this.visibleReferences[Math.min(index, this.visibleReferences.length - 1)];
		this.closingVisibilityKey = key;
		try {
			if (selection.kind === "untitled") this.sessionService.discardUntitledSession(selection.session.untitledSessionId);
			if (wasActive && replacement) this.activate(replacement);
			else if (wasActive && this.visibleReferences.length === 0) {
				this.closingVisibilityKey = undefined;
				this.openNewSession("New code session");
			}
			else if (selection.kind === "session") {
				this.projectVisibleSelections();
				this._onDidChange.fire();
			}
		} finally {
			this.closingVisibilityKey = undefined;
		}
	}
	navigateBack(): void { this.navigate(-1); }
	navigateForward(): void { this.navigate(1); }

	private syncFromSessionService(): void {
		const next = activeSelection(this.sessionService);
		const previousKey = selectionKey(this._activeSelection);
		const nextKey = selectionKey(next);
		this.reconcileVisibleReferences(this._activeSelection, next);
		this._activeSelection = next;
		this.projectVisibleSelections();
		if (!this.navigating && next && nextKey !== previousKey) this.record(referenceForSelection(next));
		this._onDidChange.fire();
	}

	private reconcileVisibleReferences(previous: SessionsViewSelection | undefined, next: SessionsViewSelection | undefined): void {
		const previousReference = previous ? referenceForSelection(previous) : undefined;
		const nextReference = next ? referenceForSelection(next) : undefined;
		if (
			previousReference?.kind === "untitled" &&
			nextReference?.kind === "session" &&
			!this.sessionService.untitledSessions.some(session => session.untitledSessionId === previousReference.untitledSessionId)
		) {
			const materializedIndex = this.visibleReferences.findIndex(reference => visibilityKey(reference) === visibilityKey(previousReference));
			if (materializedIndex >= 0) this.visibleReferences[materializedIndex] = nextReference;
		}
		this.visibleReferences = this.visibleReferences.filter(reference => this.resolve(reference) !== undefined);
		if (!nextReference || visibilityKey(nextReference) === this.closingVisibilityKey) return;
		const existingIndex = this.visibleReferences.findIndex(reference => visibilityKey(reference) === visibilityKey(nextReference));
		if (existingIndex >= 0) {
			this.visibleReferences[existingIndex] = nextReference;
			return;
		}
		if (this.closingVisibilityKey !== undefined) return;
		const previousIndex = previousReference
			? this.visibleReferences.findIndex(reference => visibilityKey(reference) === visibilityKey(previousReference))
			: -1;
		this.visibleReferences.splice(previousIndex >= 0 ? previousIndex + 1 : this.visibleReferences.length, 0, nextReference);
	}

	private projectVisibleSelections(): void {
		this.visibleReferences = this.visibleReferences.filter(reference => this.resolve(reference) !== undefined);
		this._visibleSelections = this.visibleReferences.map(reference => this.resolve(reference)!);
	}

	private record(reference: SessionsViewReference): void {
		const key = referenceKey(reference);
		if (referenceKey(this.history[this.historyIndex]) === key) return;
		this.history.splice(this.historyIndex + 1);
		this.history.push(reference);
		this.historyIndex = this.history.length - 1;
	}

	private navigate(direction: -1 | 1): void {
		const targetIndex = this.findNavigableIndex(this.historyIndex, direction);
		if (targetIndex === undefined) return;
		const reference = this.history[targetIndex];
		const previousIndex = this.historyIndex;
		this.navigating = true;
		this.historyIndex = targetIndex;
		try {
			this.activate(reference);
		} catch (error) {
			this.historyIndex = previousIndex;
			this._onDidChange.fire();
			throw error;
		} finally {
			this.navigating = false;
		}
	}

	private findNavigableIndex(from: number, direction: -1 | 1): number | undefined {
		for (let index = from + direction; index >= 0 && index < this.history.length; index += direction) {
			if (this.resolve(this.history[index])) return index;
		}
		return undefined;
	}

	private activate(reference: SessionsViewReference): void {
		if (reference.kind === "session") this.sessionService.selectThread(reference.sessionId, reference.threadId);
		else this.sessionService.selectUntitledSession(reference.untitledSessionId);
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
