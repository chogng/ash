import { type IObservable, type IReader } from '../../../../base/common/observable.js';
import { isRecord } from '../../../../base/common/types.js';
import { BaseLayoutController } from './baseSessionLayoutController.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { EditorWorkingSet } from '../../../../workbench/services/editor/common/editorWorkingSet.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ISessionsService, type SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { DesktopDockedTabsCoordinator } from './desktop/desktopDockedTabsCoordinator.js';
import { DesktopDetailPanelCoordinator } from './desktop/desktopDetailPanelCoordinator.js';
import { DesktopExistingSessionStrategy } from './desktop/desktopExistingSessionStrategy.js';
import type { EditorParts } from '../../../browser/parts/editorParts.js';
import type { IEditorGroupView } from '../../../../workbench/browser/parts/editor/editor.js';
import { ISessionEditorWorkingSetService } from '../common/sessionEditorWorkingSet.js';
import { DOCS_ARKDOWN_EDITOR_ID } from '../../docs/common/docs.js';

/** The entry owner supplies policy; the controller never owns another product selection. */
export interface IDesktopLayoutContext {
	readonly isSessionContent: boolean;
	readonly sessionEditorRestorationEnabled: IObservable<boolean>;
	readonly isDocumentContent: boolean;
	readonly documentContent: IObservable<boolean>;
	readonly isChangingContent: boolean;
	isConversationEditorGroup(id: number): boolean;
	isActiveConversationEditorGroup(id: number): boolean;
	runOperation(operation: () => Promise<void>): Promise<void>;
}

/** Restores session documents and coordinates desktop Editor/Details behavior. */
export class DesktopLayoutController extends BaseLayoutController {
	/** Retain live group identities across session switches; workingSets remains the layout/state owner. */
	private readonly liveGroups = new Map<string, readonly number[]>();
	private currentWorkingSet: string | undefined;
	private codeGroupsVisible = true;
	private codeActiveGroup: number | undefined;
	/** Temporary geometry while entries project the same retained groups as hidden. */
	private codeLayout: EditorWorkingSet | undefined;
	private initialEditorLayoutRestored = false;
	private readonly tabs: DesktopDockedTabsCoordinator;
	private readonly detailPanel: DesktopDetailPanelCoordinator;
	private readonly existingSession: DesktopExistingSessionStrategy;

	constructor(private readonly pageGroupId: number, private readonly context: IDesktopLayoutContext,
		@ISessionsService sessions: ISessionsService,
		@ISessionsManagementService management: ISessionsManagementService,
		@IEditorPart editor: IEditorPart,
		@IEditorService editors: IEditorService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@ILayoutService layout: IAgentWorkbenchLayoutService,
		@IStorageService storage: IStorageService,
		@INotificationService notifications: INotificationService,
		@ILogService logService: ILogService,
		@ILifecycleService lifecycle: ILifecycleService,
		@IInstantiationService instantiation: IInstantiationService,
		@ISessionEditorWorkingSetService editorWorkingSets: ISessionEditorWorkingSetService,
	) {
		super(sessions, management, editor, editors, workspace, layout, storage, notifications, logService, lifecycle, instantiation, editorWorkingSets);
		this._register((editor as EditorParts).setGroupScope(
			id => this.context.isConversationEditorGroup(id)
				? this.context.isActiveConversationEditorGroup(id) : this.documentGroups.some(group => group.id === id),
			() => this.context.isDocumentContent,
		));
		this.tabs = this._register(instantiation.createInstance(DesktopDockedTabsCoordinator, pageGroupId));
		this.detailPanel = instantiation.createInstance(DesktopDetailPanelCoordinator);
		this.existingSession = instantiation.createInstance(DesktopExistingSessionStrategy);
	}

	/** Save the restored editor working set before removing the old Browser snapshot. */
	public async checkpointEditorLayout(): Promise<void> {
		await this.whenSettled();
		if (this.isDisposed) return;
		this.initialEditorLayoutRestored = true;
		if (!this.context.isDocumentContent) return;
		this.captureEditors(true);
		this.saveState();
		this.storage.remove('sessions.browser.editorState', StorageScope.WORKSPACE);
	}

	public override start(): void {
		super.start();
		this._register(this.editor.onDidChangeEditors(event => {
			if (event.kind !== 'groupChanged' || event.event.kind !== 'editorClosed' || !this.context.isDocumentContent) return;
			if (this.isRestoringEditors || this.context.isChangingContent) return;
			const groups = this.documentGroups;
			const closedGroup = groups.find(group => group.id === event.groupId);
			if (!closedGroup || groups.some(group => group.inputs.length > 0 && this.editor.isGroupVisible(group.id))) return;
			this.layout.hidePart('editor');
			const { activeElement, body } = closedGroup.domNode.ownerDocument;
			if (event.event.reason === 'close' && event.event.editor.isActive && activeElement === body) {
				this.layout.focus();
			}
		}));
	}


	private get documentGroups(): readonly IEditorGroupView[] {
		const otherGroups = new Set([...this.liveGroups].filter(([key]) => key !== this.currentWorkingSet).flatMap(([, ids]) => ids));
		return (this.editor as EditorParts).mainWindowGroups.filter(group => group.id !== this.pageGroupId
			&& !this.context.isConversationEditorGroup(group.id) && !otherGroups.has(group.id));
	}
	private get documentsVisible(): boolean { return this.context.isDocumentContent && this.layout.isPartVisible('editor'); }
	public get hasDocumentEditors(): boolean { return this.documentGroups.some(group => group.inputs.some(input => !this.tabs.isManaged(input))); }
	public get supportsDetails(): boolean { return this.detailPanel.supportsActiveEditor; }
	public get isRestoringEditors(): boolean { return this.restoring || this.layout.isEditorPartAutoVisibilitySuppressed(); }

	public setDocumentGroupsVisible(visible: boolean): void {
		if (this.codeGroupsVisible === visible) return;
		if (!visible) {
			this.codeActiveGroup = this.editor.activeGroup.id;
			this.codeLayout = this.editor.saveWorkingSet('code-entry', this.editor.groups.filter(group => this.context.isConversationEditorGroup(group.id)).map(group => group.id));
		}
		this.codeGroupsVisible = visible;
		if (visible && this.codeLayout) {
			const editor = this.editor as EditorParts;
			editor.restoreWorkingSetLayout(this.codeLayout, new Map(editor.mainWindowGroups.map(group => [group.id, group.id])));
		}
		for (const group of (this.editor as EditorParts).mainWindowGroups) {
			if (this.context.isConversationEditorGroup(group.id)) continue;
			if (group.id !== this.pageGroupId && (!visible || !this.documentGroups.includes(group))) this.editor.setGroupVisible(group.id, false);
			else if (visible && !this.codeLayout && group.id !== this.pageGroupId) this.editor.setGroupVisible(group.id, true);
		}
		if (visible && this.documentGroups.some(group => group.id === this.codeActiveGroup) && this.editor.isGroupVisible(this.codeActiveGroup!)) this.editor.activateGroup(this.codeActiveGroup!);
		if (visible) this.codeLayout = undefined;
	}

	/** Settle the current session before capturing the document groups that the entry leaves behind. */
	public async prepareContentChange(): Promise<void> {
		await this.whenSettled();
		if (this.isDisposed) { return; }
		this.captureEditors();
	}

	public async activate(revealDetails: boolean): Promise<void> {
		await this.whenSettled();
		if (this.isDisposed) { return; }
		if (!this.documentGroups.includes(this.editor.activeGroup)) this.editor.activateGroup(this.documentGroups[0]!.id);
		const selection = this.sessions.activeSelection;
		if (selection) { await this.tabs.reconcile(selection, !this.documentsVisible && revealDetails, this.documentGroups); }
		if (this.isDisposed) { return; }
		const editor = this.editor as EditorParts;
		if (revealDetails && editor.fileEditorsVisible) {
			if (editor.filesDetailsOpen) this.layout.showPart('editor');
			else this.detailPanel.showDetails();
		}
		if (this.initialEditorLayoutRestored) await this.checkpointEditorLayout();
	}

	/** Details-only keeps the tab strip while its editor content is hidden; focus the visible pane instead. */
	public focus(): void {
		if (this.isDisposed) { return; }
		const files = this.editor as EditorParts;
		if (this.documentsVisible && files.filesDetailsVisible && !files.filesPart.isEditorVisible) files.filesPart.auxiliaryBar.focus();
		else if (this.documentsVisible) { this.editor.focus(); }
		else { this.layout.focus(); }
	}

	private setDocumentsVisible(visible: boolean): void {
		if (visible) { this.layout.showPart('editor'); }
		else { this.layout.hidePart('editor'); }
	}

	protected override canRestoreSessionEditors(reader?: IReader): boolean {
		return this.context.sessionEditorRestorationEnabled.read(reader);
	}
	protected override shouldShowEditor(): boolean {
		return !this.context.isSessionContent || (this.context.isDocumentContent && (
			this.documentGroups.some(group => this.editor.isGroupVisible(group.id) && !!group.activeInput)
			&& (this.layout.isPartRequested('editor') || !this.editors.activeEditor || !this.tabs.isManaged(this.editors.activeEditor))
		));
	}
	protected override isEditorAutoVisibilitySuppressed(): boolean {
		// The entry service owns retained Chat tools. Code's visible-editor events must
		// not hide their shared area when a sibling tool loses its last tab.
		return super.isEditorAutoVisibilitySuppressed() || this.context.isChangingContent
			|| (this.context.isSessionContent && !this.context.isDocumentContent);
	}
	protected override getWorkingSet(key: string): EditorWorkingSet {
		// New drafts adopt the current composition under the base controller's policy.
		if (this.currentWorkingSet && this.currentWorkingSet !== key) this.liveGroups.delete(this.currentWorkingSet);
		this.currentWorkingSet = key;
		const groups = this.documentGroups;
		this.liveGroups.set(key, groups.map(group => group.id));
		const saved = this.editor.saveWorkingSet(key, (this.editor as EditorParts).mainWindowGroups.filter(group => !groups.includes(group)).map(group => group.id));
		if (this.codeGroupsVisible || !this.codeLayout) return saved;
		// Entry switches hide the same live groups. Persist their Code visibility and
		// active group rather than the temporary hidden projection used by Chat/pages.
		return (this.editor as EditorParts).withWorkingSetLayout(saved, this.codeLayout, this.codeActiveGroup);
	}
	protected override async applyWorkingSet(saved: EditorWorkingSet | 'empty', key = saved === 'empty' ? 'empty' : saved.id): Promise<void> {
		const editor = this.editor as EditorParts;
		if (saved !== 'empty') {
			// Older builds included the preloaded Chat Docs tab in Code's working set.
			const groups = saved.groups.map(group => {
				const editors = group.editors.filter(({ input, paneId }) => paneId !== DOCS_ARKDOWN_EDITOR_ID
					&& !(input.typeId === 'workbench.editorInput.resource' && isRecord(input.value) && input.value.editorId === DOCS_ARKDOWN_EDITOR_ID));
				if (editors.length === group.editors.length) return group;
				const active = group.editors[group.activeEditorIndex];
				return { ...group, editors, activeEditorIndex: editors.length ? Math.max(0, active ? editors.indexOf(active) : -1) : -1 };
			});
			saved = editor.migrateWorkingSet({ ...saved, groups });
		}
		const previous = editor.mainWindowGroups.map(group => group.id);
		let incoming = this.liveGroups.get(key)?.filter(id => previous.includes(id));
		const reused = !!incoming?.length;
		if (!incoming?.length) {
			await this.editor.applyWorkingSet(saved, { preserveFocus: true, preserveGroups: previous });
			incoming = editor.mainWindowGroups.filter(group => !previous.includes(group.id)).map(group => group.id);
			const owned = new Set([...this.liveGroups.values()].flat());
			for (const group of editor.mainWindowGroups) {
				if (group.id !== this.pageGroupId && !this.context.isConversationEditorGroup(group.id)
					&& previous.includes(group.id) && !owned.has(group.id) && group.inputs.length === 0) await this.editor.removeGroup(group);
			}
		}
		if (this.isDisposed) { return; }
		this.liveGroups.set(key, incoming);
		this.currentWorkingSet = key;
		if (saved !== 'empty' && reused) {
			const mapping = new Map(saved.groups.flatMap((group, index) => incoming[index] === undefined || group.id === undefined ? [] : [[group.id, incoming[index]!] as const]));
			(this.editor as EditorParts).restoreWorkingSetLayout(saved, mapping);
		}
		for (const group of editor.mainWindowGroups) {
			if (!incoming.includes(group.id)) this.editor.setGroupVisible(group.id, false);
		}
		if (!this.codeGroupsVisible) {
			this.codeLayout = this.editor.saveWorkingSet('code-entry');
			for (const id of incoming) this.editor.setGroupVisible(id, false);
		}
		const active = !reused && incoming.includes(this.editor.activeGroup.id)
			? this.editor.activeGroup.id
			: incoming[saved === 'empty' ? 0 : saved.activeGroupIndex] ?? incoming[0];
		if (active !== undefined) {
			if (!this.codeGroupsVisible) this.codeActiveGroup = active;
			this.editor.activateGroup(active);
		}
	}
	protected override onSessionIdentityChanged(from: string, to: string): void {
		const groups = this.liveGroups.get(from);
		if (groups) { this.liveGroups.delete(from); this.liveGroups.set(to, groups); }
		if (this.currentWorkingSet === from) this.currentWorkingSet = to;
	}
	protected override onSessionLayoutRemoved(key: string): void {
		// Keep dirty documents and live tools accessible after their session is removed.
		// Unbound groups become part of the current composition on its next capture.
		this.liveGroups.delete(key);
		if (this.currentWorkingSet === key) this.currentWorkingSet = undefined;
	}
	protected override async onSessionRestored(selection: SessionsViewSelection, _hasSavedEditors: boolean): Promise<void> {
		if (!this.context.isDocumentContent) { return; }
		if (this.isDisposed) { return; }
		if (!this.documentGroups.includes(this.editor.activeGroup)) this.editor.activateGroup(this.documentGroups[0]!.id);
		// Switching working sets preserves shared Editor visibility, even when the incoming session has no documents.
		await this.tabs.reconcile(selection, false, this.documentGroups);
		if (this.isDisposed) { return; }
		const editor = this.editor as EditorParts;
		if (editor.filesDetailsOpen && this.documentsVisible) {
			if (editor.filesPart.fileGroups.some(group => editor.isGroupVisible(group.id))) editor.filesPart.showDetails();
		}
	}
	public async hideEditor(): Promise<void> {
		if (this.isDisposed) return;
		this.detailPanel.showDetails();
		this.existingSession.hideEditor();
		this.focus();
	}
	public async showEditor(): Promise<void> {
		if (this.isDisposed) { return; }
		this.setDocumentsVisible(true);
		const files = (this.editor as EditorParts);
		if (files.filesDetailsOpen) { files.filesPart.setEditorVisible(true); }
		if (!this.documentGroups.includes(this.editor.activeGroup) || !this.editor.isGroupVisible(this.editor.activeGroup.id)) {
			const group = this.documentGroups.find(group => this.editor.isGroupVisible(group.id)) ?? this.documentGroups[0]!;
			// Entry restoration can reapply a hidden group after an explicit document open.
			this.editor.setGroupVisible(group.id, true);
			this.editor.activateGroup(group.id);
		}
		if (this.sessions.activeSelection) { await this.tabs.reconcile(this.sessions.activeSelection, false, this.documentGroups); }
		if (this.isDisposed) { return; }
		if (!this.isDisposed) { this.editor.focus(); }
	}
	public async toggleFiles(): Promise<void> {
		if (this.isDisposed) return;
		const editor = this.editor as EditorParts;
		if (!this.documentsVisible || editor.activeGroup.activeInput?.resource.scheme !== 'ash-sessions-files' || !await editor.toggleFileEditors()) {
			await this.openFiles();
			return;
		}
		if (!this.documentGroups.some(group => editor.isGroupVisible(group.id))) this.layout.hidePart('editor');
		this.layout.focus();
	}
	public async toggleDetails(): Promise<void> {
		if (this.isDisposed) return;
		if (!(this.editor as EditorParts).fileEditorsVisible) {
			await this.openFiles();
			return;
		}
		if (this.existingSession.toggleDetails()) this.detailPanel.showDetails();
		if (!this.isDisposed) { this.focus(); }
	}

	public async openFiles(): Promise<void> {
		if (!this.isDisposed) await this.detailPanel.openFiles();
	}

	public async openChanges(): Promise<void> {
		if (this.isDisposed) { return; }
		await this.tabs.openChanges();
	}

	public async toggleChanges(): Promise<void> { await this.openChanges(); }
}
