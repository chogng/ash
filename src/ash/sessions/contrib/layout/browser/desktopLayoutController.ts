import { type IObservable } from '../../../../base/common/observable.js';
import { isRecord } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { BaseLayoutController } from './baseSessionLayoutController.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
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
import type { DesktopEditorParts } from '../../../browser/parts/desktopEditorParts.js';
import type { IEditorGroupView } from '../../../../workbench/browser/parts/editor/editor.js';
import { readCodeCardLayout, readCodeCardLayoutState, migrateCodeCardLayout, type CodeCardLayoutSnapshot } from '../../../browser/codeCardLayout.js';
import type { EditorWorkingSetLayout } from '../../../../workbench/services/editor/common/editorWorkingSet.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';

/** The entry owner supplies policy; the controller never owns another product selection. */
export interface IDesktopLayoutContext {
	readonly isSessionContent: boolean;
	readonly isDocumentContent: boolean;
	readonly documentContent: IObservable<boolean>;
	readonly isChangingContent: boolean;
	runOperation(operation: () => Promise<void>): Promise<void>;
}

const lastOpenKey = 'sessions.layout.sidePane.lastOpen';

/** Restores session documents and coordinates desktop Editor/Details behavior. */
export class DesktopLayoutController extends BaseLayoutController {
	/** Retain live group identities across session switches; workingSets remains the layout/state owner. */
	private readonly liveGroups = new Map<string, readonly number[]>();
	private currentWorkingSet: string | undefined;
	private codeGroupsVisible = true;
	private codeActiveGroup: number | undefined;
	/** Temporary geometry while entries project the same retained groups as hidden. */
	private codeLayout: EditorWorkingSet | undefined;
	private readonly legacyLayouts = new Map<string, CodeCardLayoutSnapshot>();
	private legacyFallback: CodeCardLayoutSnapshot | undefined;
	private migrationReady = false;
	private readonly tabs: DesktopDockedTabsCoordinator;
	private readonly detailPanel: DesktopDetailPanelCoordinator;
	private readonly existingSession: DesktopExistingSessionStrategy;
	private closedProfile = { documents: true, details: true };

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
	) {
		super(sessions, management, editor, editors, workspace, layout, storage, notifications, logService, lifecycle, instantiation);
		this._register((editor as DesktopEditorParts).setGroupScope(id => this.documentGroups.some(group => group.id === id)));
		this.tabs = this._register(instantiation.createInstance(DesktopDockedTabsCoordinator, pageGroupId));
		this.detailPanel = instantiation.createInstance(DesktopDetailPanelCoordinator);
		this.existingSession = instantiation.createInstance(DesktopExistingSessionStrategy);
		const lastOpen = storage.get(lastOpenKey, StorageScope.PROFILE);
		if (lastOpen !== undefined) {
			const profile: unknown = JSON.parse(lastOpen);
			if (!isRecord(profile) || typeof profile.editor !== 'boolean' || typeof profile.details !== 'boolean') { throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.')); }
			this.closedProfile = { documents: profile.editor, details: profile.details };
		}
		const legacy = readCodeCardLayoutState(storage.get('sessions.code.cardLayouts', StorageScope.WORKSPACE));
		this.legacyFallback = legacy.fallback;
		for (const [key, snapshot] of legacy.sessions) this.legacyLayouts.set(key, snapshot);
		if (!this.legacyFallback && this.legacyLayouts.size === 0) {
			const profile = storage.get('sessions.code.cardLayout', StorageScope.PROFILE);
			const fixed = ['titlebar', 'sidebar', 'sessions', 'customview', 'panel', 'info'];
			const tree = readCodeCardLayout(profile, [...fixed, 'files', 'changes', 'browser'])
				?? readCodeCardLayout(profile, [...fixed, 'files', 'changes'])
				?? readCodeCardLayout(profile, [...fixed, 'editor', 'auxiliarybar']);
			if (tree) this.legacyFallback = { tree, placed: [] };
		}
	}

	/** Commit unified working sets before the bootstrap removes legacy browser state. */
	public async checkpointEditorLayout(): Promise<void> {
		await this.whenSettled();
		if (this.isDisposed) return;
		this.migrationReady = true;
		if (!this.context.isDocumentContent) return;
		this.migrateLegacyLayout();
		this.captureEditors(true);
		this.saveState();
		this.storage.remove('sessions.browser.editorState', StorageScope.WORKSPACE);
	}

	private migrateLegacyLayout(): void {
		if (!this.migrationReady) return;
		const selection = this.sessions.activeSelection;
		const key = selection ? this.sessionKey(selection) : undefined;
		const legacy = key ? this.legacyLayouts.get(key) ?? this.legacyFallback : this.legacyFallback;
		if (!legacy) return;
		const groups = this.documentGroups;
		const mappings = new Map<string, EditorWorkingSetLayout>();
		for (const [id, accepts] of [
			['panel', (group: IEditorGroupView) => group.inputs.some(input => input instanceof TerminalEditorInput)],
			['browser', (group: IEditorGroupView) => group.inputs.some(input => input.resource.scheme === BrowserViewUri.scheme)],
			['changes', (group: IEditorGroupView) => group.inputs.some(input => input.resource.scheme === 'ash-session-changes')],
			['files', (group: IEditorGroupView) => group.inputs.length === 0 || group.inputs.some(input => !(input instanceof TerminalEditorInput) && input.resource.scheme !== BrowserViewUri.scheme && input.resource.scheme !== 'ash-session-changes')],
		] as const) {
			const included = groups.filter(accepts);
			if (included.length) mappings.set(id, this.editor.saveWorkingSet('legacy-tools', this.editor.groups.filter(group => !included.includes(group)).map(group => group.id)).layout!);
		}
		const files = mappings.get('files');
		if (files) mappings.set('auxiliarybar', files);
		const layout = migrateCodeCardLayout(legacy.tree, mappings);
		if (layout) {
			const identities = new Map<number, number>();
			const collect = (node: EditorWorkingSetLayout): void => {
				if (node.type === 'leaf') identities.set(node.data.groupId, node.data.groupId);
				else node.children.forEach(collect);
			};
			collect(layout);
			(this.editor as DesktopEditorParts).restoreLayout(layout, identities);
			for (const group of this.editor.groups) if (!groups.includes(group)) this.editor.setGroupVisible(group.id, false);
		}
		if (key) this.legacyLayouts.delete(key);
		this.legacyFallback = undefined;
		this.captureEditors(true);
		this.saveState();
		if (this.legacyLayouts.size) this.storage.store('sessions.code.cardLayouts', JSON.stringify({ version: 1, sessions: [...this.legacyLayouts] }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		else this.storage.remove('sessions.code.cardLayouts', StorageScope.WORKSPACE);
		this.storage.remove('sessions.code.cardLayout', StorageScope.PROFILE);
	}
	public override start(): void {
		super.start();
		this._register(this.editor.onDidChangeEditors(event => {
			if (event.kind !== 'groupChanged' || event.event.kind !== 'editorClosed' || !this.context.isDocumentContent) return;
			if (this.isRestoringEditors || this.context.isChangingContent || (this.editor as DesktopEditorParts).filesDetailsOpen) return;
			if (this.documentGroups.every(group => group.inputs.length === 0)) {
				this.layout.hidePart('editor');
			}
		}));
	}


	private get documentGroups(): readonly IEditorGroupView[] {
		const otherGroups = new Set([...this.liveGroups].filter(([key]) => key !== this.currentWorkingSet).flatMap(([, ids]) => ids));
		return this.editor.groups.filter(group => group.id !== this.pageGroupId && !otherGroups.has(group.id));
	}
	private get documentsVisible(): boolean { return this.context.isDocumentContent && this.layout.isPartVisible('editor'); }
	public get hasDocumentEditors(): boolean { return this.documentGroups.some(group => group.inputs.some(input => !this.tabs.isManaged(input))); }
	public get supportsDetails(): boolean { return this.detailPanel.supportsActiveEditor; }
	public get isRestoringEditors(): boolean { return this.restoring || this.autoVisibilitySuppressions > 0; }

	public setDocumentGroupsVisible(visible: boolean): void {
		if (this.codeGroupsVisible === visible) return;
		if (!visible) {
			this.codeActiveGroup = this.editor.activeGroup.id;
			this.codeLayout = this.editor.saveWorkingSet('code-entry');
		}
		this.codeGroupsVisible = visible;
		if (visible && this.codeLayout) {
			(this.editor as DesktopEditorParts).restoreWorkingSetLayout(this.codeLayout, new Map(this.editor.groups.map(group => [group.id, group.id])));
		}
		for (const group of this.editor.groups) {
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
		if (this.documentGroups.every(group => group.inputs.length === 0)) { this.layout.hidePart('editor'); }
		const selection = this.sessions.activeSelection;
		if (selection) { await this.tabs.reconcile(selection, !this.documentsVisible && revealDetails, this.documentGroups); }
		if (this.isDisposed) { return; }
		revealDetails = revealDetails && (this.editor as DesktopEditorParts).fileEditorsVisible;
		await this.detailPanel.update(revealDetails);
		if (revealDetails && !this.isDisposed) this.layout.showPart('editor');
		if (this.migrationReady) await this.checkpointEditorLayout();
	}

	public updateDetails(reveal: boolean): Promise<void> { return this.isDisposed ? Promise.resolve() : this.detailPanel.update(reveal); }

	/** Details-only keeps the tab strip while its editor content is hidden; focus the visible pane instead. */
	public focus(): void {
		if (this.isDisposed) { return; }
		const files = this.editor as DesktopEditorParts;
		if (this.documentsVisible && files.filesDetailsVisible && !files.filesPart.isEditorVisible) files.filesPart.auxiliaryBar.focus();
		else if (this.documentsVisible) { this.editor.focus(); }
		else { this.layout.focus(); }
	}

	private setDocumentsVisible(visible: boolean): void {
		if (visible) { this.layout.showPart('editor'); }
		else { this.layout.hidePart('editor'); }
	}

	protected override canRestoreSessionEditors(): boolean { return this.context.isSessionContent; }
	protected override shouldShowEditor(): boolean {
		return !this.context.isSessionContent || (this.context.isDocumentContent && (
			(this.layout.isPartRequested('editor') && (this.editor as DesktopEditorParts).filesDetailsOpen)
			|| (this.editors.visibleEditors.length > 0 && (this.layout.isPartRequested('editor') || !this.editors.activeEditor || !this.tabs.isManaged(this.editors.activeEditor)))
		));
	}
	protected override isEditorAutoVisibilitySuppressed(): boolean { return super.isEditorAutoVisibilitySuppressed() || this.context.isChangingContent; }
	protected override getWorkingSet(key: string): EditorWorkingSet {
		// New drafts adopt the current composition under the base controller's policy.
		if (this.currentWorkingSet && this.currentWorkingSet !== key) this.liveGroups.delete(this.currentWorkingSet);
		this.currentWorkingSet = key;
		const groups = this.documentGroups;
		this.liveGroups.set(key, groups.map(group => group.id));
		const saved = this.editor.saveWorkingSet(key, this.editor.groups.filter(group => !groups.includes(group)).map(group => group.id));
		if (this.codeGroupsVisible || !this.codeLayout) return saved;
		// Entry switches hide the same live groups. Persist their Code visibility and
		// active group rather than the temporary hidden projection used by Chat/pages.
		return (this.editor as DesktopEditorParts).withWorkingSetLayout(saved, this.codeLayout, this.codeActiveGroup);
	}
	protected override async applyWorkingSet(saved: EditorWorkingSet | 'empty', key = saved === 'empty' ? 'empty' : saved.id): Promise<void> {
		const previous = this.editor.groups.map(group => group.id);
		let incoming = this.liveGroups.get(key)?.filter(id => previous.includes(id));
		const reused = !!incoming?.length;
		if (!incoming?.length) {
			await this.editor.applyWorkingSet(saved, { preserveFocus: true, preserveGroups: previous });
			incoming = this.editor.groups.filter(group => !previous.includes(group.id)).map(group => group.id);
			const owned = new Set([...this.liveGroups.values()].flat());
			for (const group of [...this.editor.groups]) {
				if (group.id !== this.pageGroupId && previous.includes(group.id) && !owned.has(group.id) && group.inputs.length === 0) await this.editor.removeGroup(group);
			}
		}
		if (this.isDisposed) { return; }
		this.liveGroups.set(key, incoming);
		this.currentWorkingSet = key;
		if (saved !== 'empty' && reused) {
			const mapping = new Map(saved.groups.flatMap((group, index) => incoming[index] === undefined || group.id === undefined ? [] : [[group.id, incoming[index]!] as const]));
			(this.editor as DesktopEditorParts).restoreWorkingSetLayout(saved, mapping);
		}
		for (const group of this.editor.groups) {
			if (!incoming.includes(group.id)) this.editor.setGroupVisible(group.id, false);
		}
		if (!this.codeGroupsVisible) {
			this.codeLayout = this.editor.saveWorkingSet('code-entry');
			for (const id of incoming) this.editor.setGroupVisible(id, false);
		}
		const active = incoming[saved === 'empty' ? 0 : saved.activeGroupIndex] ?? incoming[0];
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
		this.legacyLayouts.delete(key);
		if (this.currentWorkingSet === key) this.currentWorkingSet = undefined;
	}
	protected override async onSessionRestored(selection: SessionsViewSelection, _hasSavedEditors: boolean): Promise<void> {
		if (!this.context.isDocumentContent) { return; }
		if (this.isDisposed) { return; }
		if (!this.documentGroups.includes(this.editor.activeGroup)) this.editor.activateGroup(this.documentGroups[0]!.id);
		// Switching working sets preserves shared Editor visibility, even when the incoming session has no documents.
		await this.tabs.reconcile(selection, false, this.documentGroups);
		if (this.isDisposed) { return; }
		await this.detailPanel.update(false);
		this.migrateLegacyLayout();
		const editor = this.editor as DesktopEditorParts;
		if (editor.filesDetailsOpen && this.documentsVisible) {
			if (editor.filesPart.fileGroups.some(group => editor.isGroupVisible(group.id))) editor.filesPart.showDetails();
		}
	}
	public async hideEditor(): Promise<void> {
		if (this.isDisposed) return;
		await this.detailPanel.openFiles();
		if (this.isDisposed) return;
		this.existingSession.hideEditor();
		this.focus();
	}
	public async showEditor(): Promise<void> {
		if (this.isDisposed) { return; }
		this.setDocumentsVisible(true);
		const files = (this.editor as DesktopEditorParts);
		if (files.filesDetailsOpen) { files.filesPart.setEditorVisible(true); }
		if (!this.documentGroups.includes(this.editor.activeGroup) || !this.editor.isGroupVisible(this.editor.activeGroup.id)) {
			const group = this.documentGroups.find(group => this.editor.isGroupVisible(group.id)) ?? this.documentGroups[0]!;
			// Entry restoration can reapply a hidden group after an explicit document open.
			this.editor.setGroupVisible(group.id, true);
			this.editor.activateGroup(group.id);
		}
		if (this.sessions.activeSelection) { await this.tabs.reconcile(this.sessions.activeSelection, false, this.documentGroups); }
		if (this.isDisposed) { return; }
		await this.detailPanel.update(false);
		if (!this.isDisposed) { this.editor.focus(); }
	}
	public async toggleFiles(): Promise<void> {
		if (this.isDisposed) return;
		const editor = this.editor as DesktopEditorParts;
		if (!this.documentsVisible) {
			await this.openFiles();
			return;
		}
		if (!await editor.toggleFileEditors()) await this.openFiles();
		if (!this.documentGroups.some(group => editor.isGroupVisible(group.id))) this.layout.hidePart('editor');
		else {
			this.layout.showPart('editor');
			if (!editor.isGroupVisible(editor.activeGroup.id)) editor.activateGroup(this.documentGroups.find(group => editor.isGroupVisible(group.id))!.id);
		}
		this.layout.focus();
	}
	public async toggleDetails(): Promise<void> {
		if (this.isDisposed) return;
		if (this.existingSession.toggleDetails()) { await this.detailPanel.openFiles(); }
		else if (this.documentGroups.every(group => group.inputs.length === 0)) { this.layout.hidePart('editor'); }
		if (!this.isDisposed) { this.focus(); }
	}
	public async toggleSidePane(): Promise<void> {
		if (this.isDisposed) { return; }
		const editor = this.editor as DesktopEditorParts;
		if (this.documentsVisible) {
			this.closedProfile = { documents: true, details: editor.filesDetailsOpen };
			this.storage.store(lastOpenKey, JSON.stringify({ editor: this.closedProfile.documents, details: this.closedProfile.details }), StorageScope.PROFILE, StorageTarget.MACHINE);
			this.setDocumentsVisible(false);
			this.layout.focus();
		} else {
			this.setDocumentsVisible(true);
			this.editor.activateGroup(this.documentGroups[0]!.id);
			if (this.closedProfile.details) await this.detailPanel.openFiles();
			this.focus();
		}
	}

	public async openFiles(): Promise<void> {
		if (!this.isDisposed) await this.detailPanel.openFiles();
	}

	public async openChanges(): Promise<void> {
		if (this.isDisposed) { return; }
		await this.tabs.openChanges();
	}

	public async toggleChanges(): Promise<void> {
		if (this.isDisposed) { return; }
		const editor = this.editor as DesktopEditorParts;
		if (!this.documentsVisible || !await editor.toggleToolEditors(input => input.resource.scheme === 'ash-session-changes')) {
			await this.openChanges();
			return;
		}
		const visibleGroup = this.documentGroups.find(group => editor.isGroupVisible(group.id));
		if (visibleGroup) {
			this.layout.showPart('editor');
			if (!editor.isGroupVisible(editor.activeGroup.id)) { editor.activateGroup(visibleGroup.id); }
		} else {
			this.layout.hidePart('editor');
		}
		this.layout.focus();
	}
}
