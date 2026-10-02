import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { isRecord } from '../../../../base/common/types.js';
import { Emitter } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { EditorWorkingSet } from '../../../../workbench/services/editor/common/editorWorkingSet.js';
import { ILifecycleService, LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { ISessionsService, type SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { PanelPart } from '../../../browser/parts/panelPart.js';
import { WorkbenchViewContainerId } from '../../../../workbench/common/views.js';

const layoutStateKey = 'sessions.singlePane.layoutState';

/** Code session editor state is independent of Chat navigation and window geometry. */
export abstract class BaseLayoutController extends Disposable {
	private readonly workingSets = new Map<string, EditorWorkingSet>();
	private readonly panelViews = new Map<string, string>();
	private readonly restored = this._register(new Emitter<void>());
	public readonly onDidEndSessionLayoutRestore = this.restored.event;
	private editorSession: string | undefined;
	private requestedSession: string | undefined;
	private revision = 0;
	private scheduledRevision = -1;
	private pendingRestore = Promise.resolve();
	protected restoring = false;

	constructor(
		private readonly panel: PanelPart,
		@ISessionsService protected readonly sessions: ISessionsService,
		@ISessionsManagementService protected readonly management: ISessionsManagementService,
		@IEditorPart protected readonly editor: IEditorPart,
		@IEditorService protected readonly editors: IEditorService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILayoutService protected readonly layout: IAgentWorkbenchLayoutService,
		@IStorageService protected readonly storage: IStorageService,
		@INotificationService protected readonly notifications: INotificationService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
	) {
		super();
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
					this.workingSets.set(entry.sessionResource, entry.editorWorkingSet as unknown as EditorWorkingSet);
				}
				if (typeof entry.panelViewContainerId === 'string') {
					this.panelViews.set(entry.sessionResource, entry.panelViewContainerId);
				}
			}
		}
	}

	public start(): void {
		this._register(this.panel.onDidPaneCompositeOpen(id => {
			const selected = this.sessions.getPageSelection('code');
			if (this.layout.isPartVisible('panel') && selected.activeSelection && selected.visibleSelections.length === 1) {
				this.panelViews.set(this.sessionKey(selected.activeSelection), id);
			}
		}));
		this._register(this.storage.onWillSaveState(() => this.saveState()));
		this._register(this.lifecycle.onWillShutdown(event => event.join(this.whenSettled().then(() => this.saveState()), 'session editor layout')));
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
				const to = `session:${created.sessionId}`;
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
				if (this.editorSession === from) {
					this.editorSession = to;
					this.onSessionIdentityChanged(from, to);
					this.revision++;
				}
				if (this.requestedSession === from) {
					this.requestedSession = to;
				}
			}
			const selected = this.sessions.getPageSelection('code', reader);
			const selection = selected.activeSelection;
			const key = selection ? this.sessionKey(selection) : undefined;
			if (key !== this.requestedSession) {
				this.captureEditors();
				this.requestedSession = key;
				this.revision += 1;
			}
			workspaceChanged.read(reader);
			partVisibilityChanged.read(reader);
			const page = this.sessions.page.read(reader);
			if (selected.visibleSelections.length > 1) {
				for (const visible of selected.visibleSelections) {
					this.panelViews.delete(this.sessionKey(visible));
				}
			}
			if (selection && selected.visibleSelections.length === 1 && page === 'code' && this.layout.isPartVisible('panel')) {
				this.panel.showComposite(this.panelViews.get(this.sessionKey(selection)) ?? WorkbenchViewContainerId.Terminal);
			}
			if (!selection || selected.visibleSelections.length !== 1 || page !== 'code' || !this.layout.isPartVisible('sessions') || this.scheduledRevision === this.revision) {
				return;
			}
			// Workspace switching precedes editor deserialization; file inputs must use the incoming directory.
			if (selection.kind === 'session' && this.workspace.getWorkspace().id !== selection.active.session.sessionId) {
				return;
			}
			const revision = this.revision;
			this.scheduledRevision = revision;
			this.pendingRestore = this.pendingRestore.then(async () => {
				if (this.isDisposed || revision !== this.revision) {
					return;
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
				if (!this.isDisposed) {
					this.notifications.error(localize('sessions.layout.restoreFailed', 'Could not restore the editors for this session: {0}', String(error)));
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
		if (this.editorSession && !this.isEditorAutoVisibilitySuppressed()) {
			this.workingSets.set(this.editorSession, this.getWorkingSet(this.editorSession));
		}
	}

	protected getWorkingSet(key: string): EditorWorkingSet { return this.editor.saveWorkingSet(key); }
	protected isEditorAutoVisibilitySuppressed(): boolean { return this.restoring; }
	protected shouldShowEditor(): boolean { return this.editors.visibleEditors.length > 0 || !this.layout.isPartVisible('sessions'); }
	protected async onSessionRestored(_selection: SessionsViewSelection, _hasSavedEditors: boolean): Promise<void> {}
	protected onSessionIdentityChanged(_from: string, _to: string): void {}

	/** User transitions share the restore queue so they never mutate an incoming working set. */
	protected enqueueLayoutOperation(operation: () => Promise<void>): Promise<void> {
		const revision = this.revision;
		this.pendingRestore = this.pendingRestore.then(async () => {
			if (!this.isDisposed && revision === this.revision) {
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
		try {
			await this.editor.applyWorkingSet(saved ?? 'empty', { preserveFocus: true });
			if (!this.isDisposed) {
				this.editorSession = this.sessionKey(selection);
			}
		} finally {
			this.restoring = false;
		}
	}

	private saveState(): void {
		this.pruneWorkingSets();
		this.captureEditors();
		const keys = new Set([...this.workingSets.keys(), ...this.panelViews.keys()]);
		this.storage.store(layoutStateKey, JSON.stringify([...keys].map(sessionResource => ({ sessionResource, editorWorkingSet: this.workingSets.get(sessionResource), panelViewContainerId: this.panelViews.get(sessionResource) }))), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private pruneWorkingSets(): void {
		// Catalog readiness precedes restoration of local drafts; absence is authoritative only after both finish.
		if (this.lifecycle.phase < LifecyclePhase.Restored || this.management.state !== 'ready') {
			return;
		}
		const live = new Set([
			...this.management.sessions.filter(session => session.status === 'active').map(session => `session:${session.sessionId}`),
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
		if (this.editorSession && !live.has(this.editorSession)) {
			this.editorSession = undefined;
		}
	}

	protected sessionKey(selection: SessionsViewSelection): string {
		if (selection.kind === 'session') {
			return `session:${selection.active.session.sessionId}`;
		}
		const created = this.management.materializedSessions.get().get(selection.session.untitledSessionId);
		return created ? `session:${created.sessionId}` : `untitled:${selection.session.untitledSessionId}`;
	}
}
