import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, constObservable, derived, observableSignalFromEvent, observableValue } from '../../../../base/common/observable.js';
import type { ISessionEditorWorkingSetState } from '../../../services/layout/common/sessionsLayoutService.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { Emitter } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatLayoutContext, ChatLayoutPresentation, chatLayoutOwnersEqual, type IChatLayoutOwner, type IChatLayoutSnapshot } from '../../../common/chatLayout.js';
import '../../../common/sessionConfig.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { EditorWorkingSet } from '../../../../workbench/services/editor/common/editorWorkingSet.js';
import { ILifecycleService, LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { ISessionsService, type SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import { ViewContainerLocation, WorkbenchViewContainerId } from '../../../../workbench/common/views.js';

const layoutStateKey = 'sessions.singlePane.layoutState';

/** Editor working sets follow the selected session, independently of window geometry. */
export abstract class BaseLayoutController extends Disposable {
	readonly editorWorkingSetState = observableValue<ISessionEditorWorkingSetState>(this, { owner: undefined, restoring: false, applying: false });
	private readonly retainedEditors = new Set<IResourceEditorInput>();
	protected autoVisibilitySuppressions = 0;
	public retainEditor(input: IResourceEditorInput) { this.retainedEditors.add(input); return toDisposable(() => this.retainedEditors.delete(input)); }
	public suppressEditorAutoVisibility() { this.autoVisibilitySuppressions++; return toDisposable(() => this.autoVisibilitySuppressions--); }
	private readonly workingSets = new Map<string, EditorWorkingSet>();
	private readonly panelViews = new Map<string, string>();
	private readonly chatVisibility = new Map<string, { readonly editor: boolean; readonly auxiliarybar: boolean; }>();
	protected readonly chatLayoutPresentation: ChatLayoutPresentation;
	private readonly chatLayoutContext: ChatLayoutContext;
	private readonly restored = this._register(new Emitter<void>());
	public readonly onDidEndSessionLayoutRestore = this.restored.event;
	private editorSession: string | undefined;
	private requestedSession: string | undefined;
	private requestedThread: string | undefined;
	private requestedLayout: IChatLayoutSnapshot | undefined;
	private revision = 0;
	private scheduledRevision = -1;
	private pendingRestore = Promise.resolve();
	private directoryRestore = new AbortController();
	protected restoring = false;

	constructor(
		@IPaneCompositePartService protected readonly panes: IPaneCompositePartService,
		@ISessionsService protected readonly sessions: ISessionsService,
		@ISessionsManagementService protected readonly management: ISessionsManagementService,
		@IEditorPart protected readonly editor: IEditorPart,
		@IEditorService protected readonly editors: IEditorService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILayoutService protected readonly layout: IAgentWorkbenchLayoutService,
		@IStorageService protected readonly storage: IStorageService,
		@INotificationService protected readonly notifications: INotificationService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.chatLayoutPresentation = this._register(instantiation.createInstance(ChatLayoutPresentation, true, constObservable(false)));
		const owner = derived<IChatLayoutOwner | undefined>(reader => {
			const selected = sessions.getSelection(reader).activeSelection;
			if (!selected) { return undefined; }
			const key = selected.kind === 'session' ? selected.active.session.sessionId : selected.session.untitledSessionId;
			return {
				sessionResource: URI.from({ scheme: 'ash-session', path: `/${key}` }),
				chatResource: URI.from({ scheme: 'ash-chat', path: `/${selected.kind === 'session' ? selected.active.threadId : key}` }),
			};
		});
		this.chatLayoutContext = this._register(new ChatLayoutContext(this.chatLayoutPresentation, owner));
		this._register(toDisposable(() => this.directoryRestore.abort()));
		const raw = storage.get(layoutStateKey, StorageScope.WORKSPACE);
		if (raw !== undefined) {
			const entries: unknown = JSON.parse(raw);
			if (!Array.isArray(entries)) {
				throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.'));
			}
			for (const entry of entries) {
				if (!isRecord(entry) || typeof entry.sessionResource !== 'string' || (entry.editorWorkingSet !== undefined && !isRecord(entry.editorWorkingSet)) || (entry.panelViewContainerId !== undefined && typeof entry.panelViewContainerId !== 'string')) {
					throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.'));
				}
				// The editor owns validation and deserialization of its persisted working sets.
				if (entry.editorWorkingSet) {
					this.workingSets.set(entry.sessionResource, removeLegacyPageEditors(entry.editorWorkingSet as unknown as EditorWorkingSet));
				}
				if (typeof entry.panelViewContainerId === 'string') {
					this.panelViews.set(entry.sessionResource, entry.panelViewContainerId);
				}
				if (entry.partVisibility !== undefined) {
					if (!isRecord(entry.partVisibility) || typeof entry.partVisibility.editor !== 'boolean' || typeof entry.partVisibility.auxiliarybar !== 'boolean') {
						throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.'));
					}
					this.chatVisibility.set(entry.sessionResource, { editor: entry.partVisibility.editor, auxiliarybar: entry.partVisibility.auxiliarybar });
				}
			}
		}
	}

	public start(): void {
		this._register(this.panes.onDidPaneCompositeOpen(event => {
			if (event.viewContainerLocation !== ViewContainerLocation.Panel) { return; }
			const selected = this.sessions.getSelection();
			if (this.layout.isPartVisible('panel') && selected.activeSelection && selected.visibleSelections.length === 1) {
				this.panelViews.set(this.sessionKey(selected.activeSelection), event.composite.id);
			}
		}));
		this._register(this.storage.onWillSaveState(() => this.saveState()));
		this._register(this.lifecycle.onWillShutdown(event => event.join(this.whenSettled().then(() => this.saveState()), 'session editor layout')));
		// The service scope outlives editor Parts; stop capturing state before those Parts are released.
		this._register(this.lifecycle.onDidShutdown(() => this.dispose()));
		this._register(this.editors.onDidVisibleEditorsChange(() => {
			if (this.isEditorAutoVisibilitySuppressed()) {
				return;
			}
			if (this.shouldShowEditor()) {
				this.layout.showPart('editor');
			} else {
				this.layout.hidePart('editor');
			}
		}));
		this._register(this.management.onDidChange(() => this.pruneWorkingSets()));
		void this.lifecycle.when(LifecyclePhase.Restored).then(() => {
			if (!this.isDisposed) {
				this.pruneWorkingSets();
			}
		});
		const workspaceChanged = observableSignalFromEvent(this, this.workspace.onDidChangeWorkspace);
		const partVisibilityChanged = observableSignalFromEvent(this, this.layout.onDidChangePartVisibility);
		this._register(autorun(reader => {
			for (const [draft, created] of this.management.materializedSessions.read(reader)) {
				const from = `untitled:${draft}`;
				const to = this.persistedSessionKey(created.sessionId, created.threadId);
				const saved = this.workingSets.get(from);
				if (saved) {
					this.workingSets.set(to, saved);
					this.workingSets.delete(from);
				}
				const panelView = this.panelViews.get(from);
				if (panelView) {
					this.panelViews.set(to, panelView);
					this.panelViews.delete(from);
				}
				const visibility = this.chatVisibility.get(from);
				if (visibility) {
					this.chatVisibility.set(to, visibility);
					this.chatVisibility.delete(from);
				}
				if (this.editorSession === from) {
					this.editorSession = to;
					this.onSessionIdentityChanged(from, to);
					this.revision++;
				}
				if (this.requestedSession === from) {
					this.requestedSession = to;
				}
			}
			const selected = this.sessions.getSelection(reader);
			const layoutSnapshot = this.chatLayoutContext.state.read(reader);
			const selection = selected.activeSelection;
			const key = selection ? this.sessionKey(selection) : undefined;
			const threadId = selection?.kind === 'session' ? selection.active.threadId : undefined;
			// A pending directory restore follows the Thread; working sets remain Session-owned.
			if (key !== this.requestedSession || threadId !== this.requestedThread || layoutSnapshot.presentation !== this.requestedLayout?.presentation) {
				if (key !== this.requestedSession || layoutSnapshot.presentation !== this.requestedLayout?.presentation) this.captureEditors();
				if (key && this.editorSession && this.requestedLayout && layoutSnapshot.presentation.mode !== this.requestedLayout.presentation.mode
					&& chatLayoutOwnersEqual(layoutSnapshot.owner, this.requestedLayout.owner) && !this.workingSets.has(key)) {
					// A newly selected scope adopts the current documents. A setting change must
					// not close live editors before that scope has ever acquired a working set.
					this.workingSets.set(key, this.getWorkingSet(key));
					const panel = this.panelViews.get(this.editorSession);
					if (panel) { this.panelViews.set(key, panel); }
				}
				this.requestedSession = key;
				this.requestedThread = threadId;
				this.requestedLayout = layoutSnapshot;
				this.directoryRestore.abort();
				this.directoryRestore = new AbortController();
				this.revision += 1;
				this.editorWorkingSetState.set({ ...this.editorWorkingSetState.get(), restoring: !!selection, applying: false }, undefined);
			}
			workspaceChanged.read(reader);
			partVisibilityChanged.read(reader);
			if (selected.visibleSelections.length > 1) {
				for (const visible of selected.visibleSelections) {
					this.panelViews.delete(this.sessionKey(visible));
				}
			}
			if (selection && selected.visibleSelections.length === 1 && this.layout.isPartVisible('panel')) {
				void this.panes.openPaneComposite(this.panelViews.get(this.sessionKey(selection)) ?? WorkbenchViewContainerId.Terminal, ViewContainerLocation.Panel).catch(error => this.notifications.error(String(error)));
			}
			if (!selection || selected.visibleSelections.length !== 1 || !this.canRestoreSessionEditors()) {
				this.editorWorkingSetState.set({ ...this.editorWorkingSetState.get(), restoring: false, applying: false }, undefined);
				return;
			}
			if (this.scheduledRevision === this.revision) {
				return;
			}
			// Workspace switching precedes editor deserialization; file inputs must use the incoming directory.
			if (selection.kind === 'session' && this.workspace.getWorkspace().id !== selection.active.session.sessionId) {
				return;
			}
			const revision = this.revision;
			this.scheduledRevision = revision;
			const signal = this.directoryRestore.signal;
			this.pendingRestore = this.pendingRestore.then(async () => {
				if (this.isDisposed || revision !== this.revision) {
					return;
				}
				if (selection.kind === 'session') {
					await this.management.whenDirectoriesReady(signal);
					if (this.isDisposed || revision !== this.revision) { return; }
					const latest = this.sessions.getSelection().activeSelection;
					if (latest?.kind !== 'session' || latest.active.session.sessionId !== selection.active.session.sessionId || latest.active.threadId !== selection.active.threadId) { throw canceled(); }
					const directory = latest.active.session.chats.find(chat => chat.threadId === latest.active.threadId)?.workspace;
					const folders = this.workspace.getWorkspace().folders;
					if (directory === undefined) { throw canceled(); }
					const uri = directory ? sessionWorkspaceUri(directory) : undefined;
					if (uri ? folders.length !== 1 || !extUriBiasedIgnorePathCase.isEqual(folders[0]!.uri, uri) : folders.length !== 0) { throw canceled(); }
				}
				await this.restoreEditors(selection);
				if (revision !== this.revision || this.isDisposed) {
					return;
				}
				this.restoring = true;
				try {
					await this.onSessionRestored(selection, this.workingSets.has(this.sessionKey(selection)));
				} finally {
					this.restoring = false;
				}
				if (!this.isDisposed) {
					this.restored.fire();
				}
			}).catch(error => {
				if (!this.isDisposed && !isCancellationError(error)) {
					this.notifications.error(localize('sessions.layout.restoreFailed', 'Could not restore the editors for this session: {0}', String(error)));
				}
			}).finally(() => {
				if (revision === this.revision && !this.isDisposed) {
					const selectedOwner = selection.kind === 'session' ? {
						sessionResource: URI.from({ scheme: 'ash-session', path: '/' + selection.active.session.sessionId }),
						chatResource: this.chatLayoutPresentation.configured !== 'session-shared' ? URI.from({ scheme: 'ash-thread', path: '/' + selection.active.threadId }) : undefined,
					} : undefined;
					this.editorWorkingSetState.set({ owner: selectedOwner, restoring: false, applying: false }, undefined);
				}
			});
		}));
	}

	public async whenSettled(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.pendingRestore;
			await pending;
		} while (pending !== this.pendingRestore);
	}

	protected captureEditors(): void {
		if (this.editorSession && this.canRestoreSessionEditors() && !this.isEditorAutoVisibilitySuppressed()) {
			let snapshot = this.getWorkingSet(this.editorSession);
			const previous = this.workingSets.get(this.editorSession);
			if (previous && !this.layout.isPartVisible('editor') && this.retainedEditors.size && this.editor.groups.some(group => group.inputs.some(input => this.retainedEditors.has(input)))
				&& snapshot.groups.length === previous.groups.length && snapshot.groups.every(group => group.id !== undefined && previous.groups.some(saved => saved.id === group.id))) {
				// A hidden retained page has no new geometry. Preserve its split sizes while still capturing changes to tabs.
				snapshot = { ...snapshot, ...(previous.layout ? { layout: previous.layout } : {}), groups: snapshot.groups.map(group => ({ ...group, size: previous.groups.find(saved => saved.id === group.id)!.size })) };
			}
			this.workingSets.set(this.editorSession, snapshot);
			if (this.chatLayoutPresentation.configured === 'chat') {
				this.chatVisibility.set(this.editorSession, { editor: this.layout.isPartVisible('editor'), auxiliarybar: this.layout.isPartVisible('auxiliarybar') });
			}
		}
	}

	protected getWorkingSet(key: string): EditorWorkingSet { return this.editor.saveWorkingSet(key); }
	protected isEditorAutoVisibilitySuppressed(): boolean { return this.restoring || this.autoVisibilitySuppressions > 0; }
	protected shouldShowEditor(): boolean { return this.editors.visibleEditors.length > 0 || !this.layout.isPartVisible('sessions'); }
	protected canRestoreSessionEditors(): boolean { return this.layout.isPartVisible('sessions'); }
	protected applyWorkingSet(saved: EditorWorkingSet | 'empty'): Promise<void> { return this.editor.applyWorkingSet(saved, { preserveFocus: true }); }
	protected async onSessionRestored(_selection: SessionsViewSelection, _hasSavedEditors: boolean): Promise<void> { }
	protected onSessionIdentityChanged(_from: string, _to: string): void { }

	/** User transitions share the restore queue so they never mutate an incoming working set. */
	protected enqueueLayoutOperation(operation: () => Promise<void>): Promise<void> {
		const revision = this.revision;
		const owner = this.chatLayoutContext.state.get();
		this.pendingRestore = this.pendingRestore.then(async () => {
			if (!this.isDisposed && revision === this.revision && (!owner.presentation.active || this.chatLayoutContext.isCurrent(owner))) {
				await operation();
			}
		}).catch(error => {
			if (!this.isDisposed) {
				this.notifications.error(localize('sessions.layout.restoreFailed', 'Could not restore the editors for this session: {0}', String(error)));
			}
		});
		return this.pendingRestore;
	}

	private async restoreEditors(selection: SessionsViewSelection): Promise<void> {
		const key = this.sessionKey(selection);
		if (this.editorSession === key) {
			return;
		}
		this.captureEditors();
		const saved = this.workingSets.get(key);
		// New drafts and the initial unsaved composition adopt live editors rather than closing them.
		if (!saved && (selection.kind === 'untitled' || this.editorSession === undefined)) {
			this.editorSession = key;
			return;
		}
		this.restoring = true;
		const revision = this.revision;
		this.editorWorkingSetState.set({ ...this.editorWorkingSetState.get(), applying: true }, undefined);
		try {
			await this.applyWorkingSet(saved ?? 'empty');
			const visibility = revision === this.revision && this.chatLayoutPresentation.configured === 'chat' ? this.chatVisibility.get(key) : undefined;
			if (visibility) {
				for (const part of ['editor', 'auxiliarybar'] as const) {
					if (visibility[part]) { this.layout.showPart(part); } else { this.layout.hidePart(part); }
				}
			}
			if (!this.isDisposed) {
				this.editorSession = this.sessionKey(selection);
			}
		} finally {
			this.restoring = false;
			this.editorWorkingSetState.set({ ...this.editorWorkingSetState.get(), applying: false }, undefined);
		}
	}

	private saveState(): void {
		this.pruneWorkingSets();
		this.captureEditors();
		const keys = new Set([...this.workingSets.keys(), ...this.panelViews.keys(), ...this.chatVisibility.keys()]);
		this.storage.store(layoutStateKey, JSON.stringify([...keys].map(sessionResource => ({ sessionResource, editorWorkingSet: this.workingSets.get(sessionResource), panelViewContainerId: this.panelViews.get(sessionResource), partVisibility: this.chatVisibility.get(sessionResource) }))), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private pruneWorkingSets(): void {
		// Catalog readiness precedes restoration of local drafts; absence is authoritative only after both finish.
		if (this.lifecycle.phase < LifecyclePhase.Restored || this.management.state !== 'ready') {
			return;
		}
		const live = new Set([
			...this.management.sessions.filter(session => session.status === 'active').map(session => `session:${session.sessionId}`),
			...this.management.sessions.filter(session => session.status === 'active').flatMap(session => session.chats.filter(chat => chat.status === 'active').map(chat => `chat:${JSON.stringify([session.sessionId, chat.threadId])}`)),
			...this.management.untitledSessions.map(session => `untitled:${session.untitledSessionId}`),
		]);
		for (const key of this.workingSets.keys()) {
			if (!live.has(key)) {
				this.workingSets.delete(key);
			}
		}
		for (const key of this.panelViews.keys()) {
			if (!live.has(key)) {
				this.panelViews.delete(key);
			}
		}
		for (const key of this.chatVisibility.keys()) {
			if (!live.has(key)) { this.chatVisibility.delete(key); }
		}
		if (this.editorSession && !live.has(this.editorSession)) {
			this.editorSession = undefined;
		}
	}

	protected sessionKey(selection: SessionsViewSelection): string {
		if (selection.kind === 'session') {
			return this.persistedSessionKey(selection.active.session.sessionId, selection.active.threadId);
		}
		const created = this.management.materializedSessions.get().get(selection.session.untitledSessionId);
		return created ? this.persistedSessionKey(created.sessionId, created.threadId) : `untitled:${selection.session.untitledSessionId}`;
	}

	private persistedSessionKey(sessionId: string, threadId: string): string {
		return this.chatLayoutPresentation.state.get().active ? `chat:${JSON.stringify([sessionId, threadId])}` : `session:${sessionId}`;
	}
}

/** Retired page resources must not return as Code tabs when restoring an older working set. */
function removeLegacyPageEditors(workingSet: EditorWorkingSet): EditorWorkingSet {
	return {
		...workingSet,
		groups: workingSet.groups.map(group => {
			const active = group.editors[group.activeEditorIndex];
			const editors = group.editors.filter(editor => {
				if (editor.input.typeId !== 'workbench.editorInput.resource') { return true; }
				const value = editor.input.value;
				if (!isRecord(value) || typeof value.resource !== 'string') { return true; }
				const scheme = URI.parse(value.resource).scheme;
				return scheme !== 'ash-design';
			});
			if (editors.length === group.editors.length) { return group; }
			return { ...group, editors, activeEditorIndex: active && editors.includes(active) ? editors.indexOf(active) : editors.length - 1 };
		}),
	};
}
