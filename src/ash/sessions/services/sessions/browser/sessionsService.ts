import { Emitter, type Event } from '../../../../base/common/event.js';
import { canceled } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue, transaction, type IReader, type ITransaction } from '../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { isRecord } from '../../../../base/common/types.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IActiveSessionThread, IUntitledChatSession, SessionId, ThreadId } from '../common/session.js';
import { ISessionsManagementService } from '../common/sessionsManagement.js';
import type { SessionWorkspaceSelection } from '../common/session.js';
import { WELCOME_COMPLETE_KEY } from '../../../common/welcome.js';
import { ICustomViewService } from '../../customView/browser/customViewService.js';

/** One visible slot in the dedicated Sessions Workbench. */
export type SessionsViewSelection = { readonly kind: 'session'; readonly active: IActiveSessionThread } | { readonly kind: 'untitled'; readonly session: IUntitledChatSession };

export interface SessionsSelection {
	readonly visibleSelections: readonly SessionsViewSelection[];
	readonly activeSelection: SessionsViewSelection | undefined;
}

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
	initialize(): Promise<void>;
	openThread(sessionId: SessionId, threadId: ThreadId): Promise<void>;
	openSession(sessionId: SessionId, threadId: ThreadId): void;
	openUntitledSession(untitledSessionId: string): void;
	openNewSession(title?: string, options?: { readonly sideBySide?: boolean; readonly source?: 'restore'; readonly providerId?: string }): IUntitledChatSession;
	activateSelection(selection: SessionsViewSelection, options?: { readonly source: 'restore' }): void;
	closeVisibleSelection(selection: SessionsViewSelection): void;
	navigateBack(): void;
	navigateForward(): void;
}

export const ISessionsService = createServiceIdentifier<ISessionsService>('sessionsService');

type SessionsViewReference = { readonly kind: 'session'; readonly sessionId: SessionId; readonly threadId: ThreadId } | { readonly kind: 'untitled'; readonly untitledSessionId: string };

type NavigationEntry = SessionsViewReference | { readonly kind: 'customView'; readonly id: string };

/** Dedicated Sessions-window view state layered over the canonical Session model service. */
export class SessionsService extends Disposable implements ISessionsService {
	private readonly sessionService: ISessionsManagementService;
	private readonly _onDidChange = this._register(new Emitter<void>());
	private readonly current = new SessionsViewState();
	private _navigationRevision = 0;
	private initialized = false;
	private readonly storedState: StoredSessionsViewState | undefined;

	readonly onDidChange = this._onDidChange.event;

	constructor(
		@ISessionsManagementService sessionService: ISessionsManagementService,
		@IStorageService private readonly storage: IStorageService,
		@ICustomViewService private readonly customViews: ICustomViewService,
	) {
		// Validate persisted input before allocating subscriptions that a failed constructor cannot release.
		const raw = storage.get('sessions.viewState', StorageScope.WORKSPACE);
		const storedState = raw === undefined ? undefined : parseStoredSessionsViewState(JSON.parse(raw), storage.get('sessions.activityBar.activePage', StorageScope.WORKSPACE) === 'code');
		super();
		this.sessionService = sessionService;
		this.storedState = storedState;
		this._register(storage.onWillSaveState(() => this.saveState()));
		this._register(sessionService.onDidChange(() => this.syncFromSessionService()));
		this.syncFromSessionService();
		this._register(
			autorun(reader => {
				const opening = customViews.activeCustomViewOpen.read(reader);
				if (!opening) return;
				// A custom-view open supersedes an in-flight Thread open without changing the covered selection.
				this._navigationRevision++;
				if (opening.source !== 'history' && (opening.source !== 'restore' || this.initialized)) this.record({ kind: 'customView', id: opening.descriptor.id }, this.current);
				this._onDidChange.fire();
			}),
		);
	}

	get navigationRevision(): number {
		return this._navigationRevision;
	}
	get visibleSelections(): readonly SessionsViewSelection[] {
		return this.current.visibleSelections.get();
	}
	get activeSelection(): SessionsViewSelection | undefined {
		return this.current.activeSelection.get();
	}
	get canNavigateBack(): boolean {
		return this.findNavigableIndex(this.current.historyIndex, -1) !== undefined;
	}
	get canNavigateForward(): boolean {
		return this.findNavigableIndex(this.current.historyIndex, 1) !== undefined;
	}

	getSelection(reader?: IReader): SessionsSelection {
		return {
			visibleSelections: this.current.visibleSelections.read(reader),
			activeSelection: this.current.activeSelection.read(reader),
		};
	}

	async initialize(): Promise<void> {
		await this.sessionService.initialize();
		if (this.isDisposed) return;
		if (!this.initialized) {
			const state = this.current;
			for (const draft of this.storedState?.drafts ?? []) {
				if (!this.sessionService.untitledSessions.some(current => current.untitledSessionId === draft.untitledSessionId)) {
					this.sessionService.restoreUntitledSession(draft);
				}
			}
			// An explicit choice made while the catalog loads supersedes the saved arrangement.
			if (this.storedState && state.visibleReferences.length === 0) {
				const saved = this.storedState;
				state.visibleReferences = saved.visible.map(storedReference);
				state.activeReference.set(state.visibleReferences[saved.active]);
				state.activeSelection.set(this.resolve(state.activeReference.get()));
				this.projectVisibleSelections(state);
				if (!state.activeSelection.get()) {
					state.activeSelection.set(state.visibleSelections.get()[0]);
				}
				const active = state.activeSelection.get();
				if (active && !this.customViews.activeCustomView.get()) {
					this.record(referenceForSelection(active), state);
				}
			}

			const restored = activeSelection(this.sessionService);
			const alreadyOpen = restored && this.current.visibleReferences.some(reference => referenceKey(reference) === selectionKey(restored));
			if (!this.storedState && restored && !alreadyOpen && !this.current.activeSelection.get()) {
				this.select(restored, this.current, 'open', 'automatic');
			}
			if (this.activeSelection && this.sessionService.state !== 'error') {
				this.activate(referenceForSelection(this.activeSelection), this.current, 'focus', 'automatic');
			}
			// Restoring drafts emits catalog changes; none may persist an incomplete arrangement.
			this.initialized = true;
			const opening = this.customViews.activeCustomViewOpen.get();
			if (opening?.source === 'restore') {
				if (this.activeSelection) this.record(referenceForSelection(this.activeSelection), state);
				this.record({ kind: 'customView', id: opening.descriptor.id }, state);
			}
		}
		this.syncFromSessionService();
	}

	openSession(sessionId: SessionId, threadId: ThreadId): void {
		this.activate({ kind: 'session', sessionId, threadId });
	}
	async openThread(sessionId: SessionId, threadId: ThreadId): Promise<void> {
		const revision = ++this._navigationRevision;
		await this.sessionService.openThread(sessionId, threadId);
		if (this.isDisposed) throw canceled();
		if (revision === this._navigationRevision) {
			this.activate({ kind: 'session', sessionId, threadId });
		}
	}
	openUntitledSession(untitledSessionId: string): void {
		this.activate({ kind: 'untitled', untitledSessionId });
	}
	openNewSession(title = 'New chat', options?: { readonly sideBySide?: boolean; readonly source?: 'restore'; readonly providerId?: string }): IUntitledChatSession {
		const session = this.sessionService.createUntitledSession(title, undefined, options?.providerId);
		this.select({ kind: 'untitled', session }, this.current, options?.sideBySide ? 'add' : 'open', options?.source === 'restore' ? 'automatic' : 'explicit');
		return session;
	}
	activateSelection(selection: SessionsViewSelection, options?: { readonly source: 'restore' }): void {
		this.activate(referenceForSelection(selection), this.current, 'focus', options?.source === 'restore' ? 'automatic' : 'explicit');
	}
	closeVisibleSelection(selection: SessionsViewSelection): void {
		const state = this.current;
		const key = visibilityKey(referenceForSelection(selection));
		const index = state.visibleReferences.findIndex(reference => visibilityKey(reference) === key);
		if (index < 0) return;
		this._navigationRevision++;
		const active = state.activeSelection.get();
		const wasActive = active !== undefined && visibilityKey(referenceForSelection(active)) === key;
		// Closing a sibling supersedes pending navigation even when the foreground identity stays the same.
		if (!wasActive && active) this.updateManagementSelection(referenceForSelection(active));
		state.visibleReferences.splice(index, 1);
		const replacement =
			state.visibleReferences.slice(index).find(reference => this.resolve(reference)) ??
			state.visibleReferences
				.slice(0, index)
				.reverse()
				.find(reference => this.resolve(reference));
		if (wasActive) state.activeSelection.set(undefined);
		if (wasActive) {
			state.activeReference.set(undefined);
		}
		if (selection.kind === 'untitled') {
			this.sessionService.discardUntitledSession(selection.session.untitledSessionId);
		}
		if (wasActive && replacement) this.activate(replacement, state, 'focus', 'automatic');
		else if (wasActive) {
			const session = this.sessionService.createUntitledSession('New chat');
			this.select({ kind: 'untitled', session }, state, 'open', 'automatic');
		}
		this.projectVisibleSelections(state);
		this.saveState();
		this._onDidChange.fire();
	}
	navigateBack(): void {
		this.navigate(-1);
	}
	navigateForward(): void {
		this.navigate(1);
	}

	private syncFromSessionService(): void {
		if (this.sessionService.sessions.length && !this.storage.getBoolean(WELCOME_COMPLETE_KEY, StorageScope.PROFILE, false)) {
			this.storage.store(WELCOME_COMPLETE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		}
		// Catalog changes refresh identities without changing the foreground selection.
		const state = this.current;
		state.visibleReferences = state.visibleReferences.map(reference => this.materializedReference(reference));
		state.history = state.history.map(reference => (reference.kind === 'customView' ? reference : this.materializedReference(reference)));
		const reference = state.activeReference.get();
		state.activeReference.set(reference ? this.materializedReference(reference) : undefined);
		this.projectVisibleSelections(state);
		if (this.sessionService.state !== 'loading' && this.sessionService.state !== 'error' && !this.resolve(state.activeReference.get())) {
			state.activeReference.set(state.visibleReferences[0]);
		}
		state.activeSelection.set(this.resolve(state.activeReference.get()) ?? state.visibleSelections.get()[0]);
		this.saveState();
		this._onDidChange.fire();
	}

	private saveState(): void {
		// Initial catalog loading must not replace a saved arrangement with an incomplete list.
		if (!this.initialized) {
			return;
		}
		const snapshot = (): StoredSessionsSelection => {
			const state = this.current;
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
		const state: StoredSessionsViewState = {
			version: 2,
			drafts: this.sessionService.untitledSessions,
			...snapshot(),
		};
		this.storage.store('sessions.viewState', JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private materializedReference(reference: SessionsViewReference): SessionsViewReference {
		const active = reference.kind === 'untitled' ? this.sessionService.materializedSessions.get().get(reference.untitledSessionId) : undefined;
		return active ? { kind: 'session', sessionId: active.sessionId, threadId: active.threadId } : reference;
	}

	private select(selection: SessionsViewSelection, state = this.current, mode: 'open' | 'focus' | 'add' = 'open', intent: 'explicit' | 'automatic' = 'explicit'): void {
		this._navigationRevision++;
		const reference = referenceForSelection(selection);
		const previous = state.activeSelection.get();
		const covered = this.customViews.activeCustomView.get() !== undefined;
		if (covered && intent === 'automatic' && this.customViews.activeCustomViewOpen.get()?.source === 'restore' && state.history.length === 1 && state.history[0]?.kind === 'customView') {
			// A restored view in an otherwise empty window covers the startup draft, rather than visiting it.
			state.history.unshift(reference);
			state.historyIndex++;
		}
		const existing = state.visibleReferences.findIndex(candidate => visibilityKey(candidate) === visibilityKey(reference));
		if (existing >= 0) state.visibleReferences[existing] = reference;
		else if (mode === 'add') state.visibleReferences.push(reference);
		else {
			// Ash uses single-content editor groups: ordinary opens replace the active
			// Session in place and preserve siblings. Unlike VS Code's Agents pin policy,
			// replacement does not search for another transient slot or create a group.
			const current = state.activeReference.get();
			const activeIndex = current ? state.visibleReferences.findIndex(candidate => visibilityKey(candidate) === visibilityKey(current)) : -1;
			if (activeIndex >= 0) state.visibleReferences[activeIndex] = reference;
			else state.visibleReferences = [reference];
		}
		transaction(tx => {
			if (intent === 'explicit') this.customViews.hideCustomView(tx);
			state.activeReference.set(reference, tx);
			state.activeSelection.set(selection, tx);
			this.projectVisibleSelections(state, tx);
		});
		if (!state.navigating && !(covered && intent === 'automatic') && (covered || selectionKey(previous) !== selectionKey(selection))) this.record(reference, state);
		this.saveState();
		this._onDidChange.fire();
	}

	private projectVisibleSelections(state: SessionsViewState, tx?: ITransaction): void {
		// A disconnected catalog cannot prove that a saved conversation was deleted.
		const catalogUnavailable = this.sessionService.state === 'loading' || this.sessionService.state === 'error';
		state.visibleReferences = state.visibleReferences.filter(reference => this.resolve(reference) !== undefined || (reference.kind === 'session' && catalogUnavailable));
		state.visibleSelections.set(
			state.visibleReferences.flatMap(reference => {
				const selection = this.resolve(reference);
				return selection ? [selection] : [];
			}),
			tx,
		);
	}

	private record(reference: NavigationEntry, state: SessionsViewState): void {
		const key = navigationKey(reference);
		if (navigationKey(state.history[state.historyIndex]) === key) return;
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
			if (reference.kind === 'customView') {
				this.customViews.showCustomView(reference.id, { source: 'history' });
				if (this.customViews.activeCustomView.get()?.id !== reference.id) {
					// A removed contribution cannot be a destination; discard its visit and continue in the same direction.
					state.history.splice(targetIndex, 1);
					state.historyIndex = previousIndex - (targetIndex < previousIndex ? 1 : 0);
					this.navigate(direction);
				}
			} else this.activate(reference);
		} catch (error) {
			state.historyIndex = previousIndex;
			this._onDidChange.fire();
			throw error;
		} finally {
			state.navigating = false;
			this._onDidChange.fire();
		}
	}

	private findNavigableIndex(from: number, direction: -1 | 1): number | undefined {
		for (let index = from + direction; index >= 0 && index < this.current.history.length; index += direction) {
			const entry = this.current.history[index]!;
			if (entry.kind === 'customView' || this.resolve(entry)) return index;
		}
		return undefined;
	}

	private activate(reference: SessionsViewReference, state = this.current, mode: 'open' | 'focus' | 'add' = 'open', intent: 'explicit' | 'automatic' = 'explicit'): void {
		this.updateManagementSelection(reference);
		this.select(this.resolve(reference)!, state, mode, intent);
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
		return session && thread ? { kind: 'session', active: { session, threadId: thread.threadId } } : undefined;
	}
}

class SessionsViewState {
	// Keep the chosen identity while an unavailable catalog prevents a rendered selection.
	readonly activeReference = observableValue<SessionsViewReference | undefined>(this, undefined);
	readonly activeSelection = observableValue<SessionsViewSelection | undefined>(this, undefined);
	readonly visibleSelections = observableValue<readonly SessionsViewSelection[]>(this, []);
	visibleReferences: SessionsViewReference[] = [];
	history: NavigationEntry[] = [];
	historyIndex = -1;
	navigating = false;
}

function activeSelection(sessionService: ISessionsManagementService): SessionsViewSelection | undefined {
	const untitled = sessionService.activeUntitledSession;
	if (untitled) return { kind: 'untitled', session: untitled };
	const active = sessionService.active;
	return active?.session.status === 'active' && active.session.chats.some(thread => thread.threadId === active.threadId && thread.status === 'active') ? { kind: 'session', active } : undefined;
}

function referenceForSelection(selection: SessionsViewSelection): SessionsViewReference {
	return selection.kind === 'session'
		? { kind: 'session', sessionId: selection.active.session.sessionId, threadId: selection.active.threadId }
		: { kind: 'untitled', untitledSessionId: selection.session.untitledSessionId };
}

function selectionKey(selection: SessionsViewSelection | undefined): string | undefined {
	return selection ? referenceKey(referenceForSelection(selection)) : undefined;
}

function navigationKey(entry: NavigationEntry | undefined): string | undefined {
	return entry?.kind === 'customView' ? `customView:${entry.id}` : referenceKey(entry);
}

function referenceKey(reference: SessionsViewReference | undefined): string | undefined {
	return reference?.kind === 'session' ? `session:${reference.sessionId}:${reference.threadId}` : reference ? `untitled:${reference.untitledSessionId}` : undefined;
}

function visibilityKey(reference: SessionsViewReference | undefined): string | undefined {
	return reference?.kind === 'session' ? `session:${reference.sessionId}` : reference ? `untitled:${reference.untitledSessionId}` : undefined;
}

type StoredSessionsViewReference = Extract<SessionsViewReference, { kind: 'session' }> | { readonly kind: 'untitled'; readonly session: IUntitledChatSession };

interface StoredSessionsSelection {
	readonly visible: readonly StoredSessionsViewReference[];
	readonly active: number;
}

interface StoredSessionsViewState extends StoredSessionsSelection {
	readonly version: 2;
	readonly drafts: readonly IUntitledChatSession[];
}

function storedReference(reference: StoredSessionsViewReference): SessionsViewReference {
	return reference.kind === 'session' ? reference : { kind: 'untitled', untitledSessionId: reference.session.untitledSessionId };
}

function parseStoredSessionsViewState(value: unknown, preferCode: boolean): StoredSessionsViewState {
	if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
		throw new TypeError('Invalid stored Sessions view state');
	}
	let states: unknown[];
	if (value.version === 1) {
		if (!isRecord(value.pages)) {
			throw new TypeError('Invalid stored Sessions view state');
		}
		states = preferCode ? [value.pages.code, value.pages.chat] : [value.pages.chat, value.pages.code];
	} else {
		states = [value];
	}
	for (const state of states) {
		if (
			!isRecord(state) ||
			!Array.isArray(state.visible) ||
			!Number.isInteger(state.active) ||
			(state.visible.length === 0 ? state.active !== -1 : (state.active as number) < 0 || (state.active as number) >= state.visible.length)
		) {
			throw new TypeError('Invalid stored Sessions selection');
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
				if (!isUntitledSession(reference.session)) {
					throw new TypeError('Invalid stored untitled Session');
				}
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
	const selections = states as StoredSessionsSelection[];
	const drafts = [
		...new Map(
			selections.flatMap(state => state.visible.flatMap(reference => (reference.kind === 'untitled' ? [[reference.session.untitledSessionId, reference.session] as const] : []))),
		).values(),
	];
	if (value.version === 2) {
		if (!Array.isArray(value.drafts) || !value.drafts.every(isUntitledSession) || new Set(value.drafts.map(draft => draft.untitledSessionId)).size !== value.drafts.length) {
			throw new TypeError('Invalid stored Sessions drafts');
		}
		for (const reference of selections[0]!.visible) {
			if (reference.kind === 'untitled' && !value.drafts.some(draft => draft.untitledSessionId === reference.session.untitledSessionId)) {
				throw new TypeError('Stored visible draft is missing from the draft catalog');
			}
		}
		drafts.splice(0, drafts.length, ...value.drafts);
	}
	const visible: StoredSessionsViewReference[] = [];
	const keys = new Set<string>();
	for (const state of selections) {
		for (const reference of state.visible) {
			const key = visibilityKey(storedReference(reference))!;
			if (!keys.has(key)) {
				visible.push(reference);
				keys.add(key);
			}
		}
	}
	const preferred = selections.find(state => state.active >= 0);
	const activeKey = preferred && visibilityKey(storedReference(preferred.visible[preferred.active]!));
	return {
		version: 2,
		drafts,
		visible,
		active: activeKey ? visible.findIndex(reference => visibilityKey(storedReference(reference)) === activeKey) : -1,
	};
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

export function isUntitledSession(value: unknown): value is IUntitledChatSession {
	return (
		isRecord(value) &&
		nonEmptyString(value.untitledSessionId) &&
		typeof value.title === 'string' &&
		(value.model === undefined || (isRecord(value.model) && nonEmptyString(value.model.provider) && nonEmptyString(value.model.model))) &&
		(value.providerId === undefined || nonEmptyString(value.providerId)) &&
		(value.modelSelectionKind === undefined || value.modelSelectionKind === 'manual') &&
		(value.agent === undefined || (isRecord(value.agent) && nonEmptyString(value.agent.name) && typeof value.agent.description === 'string' && nonEmptyString(value.agent.sourceId))) &&
		isWorkspaceSelection(value.workspace)
	);
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
	if (value.type === 'provider') {
		return nonEmptyString(value.providerId) && nonEmptyString(value.workspace) && nonEmptyString(value.root);
	}
	return (
		value.type === 'multiple' &&
		Array.isArray(value.folders) &&
		value.folders.length > 0 &&
		value.folders.every(
			folder =>
				isRecord(folder) &&
				typeof folder.label === 'string' &&
				isRecord(folder.target) &&
				(folder.target.type === 'local' || folder.target.type === 'ssh' || folder.target.type === 'provider') &&
				isWorkspaceSelection(folder.target),
		)
	);
}
