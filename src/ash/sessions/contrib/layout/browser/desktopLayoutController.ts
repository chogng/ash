import type { IObservable } from '../../../../base/common/observable.js';
import { isRecord } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { BaseLayoutController } from './baseSessionLayoutController.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { EditorWorkingSet } from '../../../../workbench/services/editor/common/editorWorkingSet.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ISessionsService, type SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IPaneCompositePartService } from '../../../../workbench/services/panecomposite/browser/panecomposite.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { DesktopDockedTabsCoordinator } from './desktop/desktopDockedTabsCoordinator.js';
import { DesktopDetailPanelCoordinator } from './desktop/desktopDetailPanelCoordinator.js';
import type { IEditorGroupView } from '../../../../workbench/browser/parts/editor/editor.js';

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
	private readonly tabs: DesktopDockedTabsCoordinator;
	private readonly detailPanel: DesktopDetailPanelCoordinator;
	private closedProfile = { documents: true, details: true };

	constructor(private readonly pageGroupId: string, private readonly context: IDesktopLayoutContext,
		@IPaneCompositePartService panes: IPaneCompositePartService,
		@ISessionsService sessions: ISessionsService,
		@ISessionsManagementService management: ISessionsManagementService,
		@IEditorPart editor: IEditorPart,
		@IEditorService editors: IEditorService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@ILayoutService layout: IAgentWorkbenchLayoutService,
		@IStorageService storage: IStorageService,
		@INotificationService notifications: INotificationService,
		@ILifecycleService lifecycle: ILifecycleService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(panes, sessions, management, editor, editors, workspace, layout, storage, notifications, lifecycle);
		this.tabs = instantiation.createInstance(DesktopDockedTabsCoordinator);
		this.detailPanel = instantiation.createInstance(DesktopDetailPanelCoordinator);
		const lastOpen = storage.get(lastOpenKey, StorageScope.PROFILE);
		if (lastOpen !== undefined) {
			const profile: unknown = JSON.parse(lastOpen);
			if (!isRecord(profile) || typeof profile.editor !== 'boolean' || typeof profile.details !== 'boolean') { throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.')); }
			this.closedProfile = { documents: profile.editor, details: profile.details };
		}
	}
	public override start(): void {
		super.start();
		this._register(this.editor.onDidChangeEditors(event => {
			if (event.kind === 'groupChanged' && event.event.kind === 'editorClosed' && this.context.isDocumentContent && !this.isRestoringEditors && !this.context.isChangingContent && this.documentGroups.every(group => group.inputs.length === 0)) {
				this.layout.updateParts(() => { this.layout.hidePart('editor'); this.layout.hidePart('auxiliarybar'); });
			}
		}));
	}


	private get documentGroups(): readonly IEditorGroupView[] { return this.editor.groups.filter(group => group.id !== this.pageGroupId); }
	private get documentsVisible(): boolean { return this.context.isDocumentContent && this.layout.isPartVisible('editor'); }
	public get hasDocumentEditors(): boolean { return this.documentGroups.some(group => group.inputs.some(input => !this.tabs.isManaged(input))); }
	public get supportsDetails(): boolean { return this.detailPanel.supportsActiveEditor; }
	public get isRestoringEditors(): boolean { return this.restoring; }

	/** Settle the current session before capturing the document groups that the entry leaves behind. */
	public async prepareContentChange(): Promise<void> {
		await this.whenSettled();
		this.captureEditors();
	}

	public async activate(revealDetails: boolean): Promise<void> {
		await this.whenSettled();
		this.editor.activateGroup(this.documentGroups[0]!.id);
		const selection = this.sessions.activeSelection;
		if (selection) { await this.tabs.reconcile(selection, !this.documentsVisible && revealDetails); }
		await this.detailPanel.update(revealDetails);
	}

	public updateDetails(reveal: boolean): Promise<void> { return this.detailPanel.update(reveal); }

	private setDocumentsVisible(visible: boolean): void {
		if (visible) { this.layout.showPart('editor'); }
		else { this.layout.hidePart('editor'); }
	}

	private setPartVisible(visible: boolean): void {
		if (visible) { this.layout.showPart('auxiliarybar'); }
		else { this.layout.hidePart('auxiliarybar'); }
	}

	protected override canRestoreSessionEditors(): boolean { return this.context.isSessionContent; }
	protected override shouldShowEditor(): boolean {
		return !this.context.isSessionContent || (this.context.isDocumentContent && this.editors.visibleEditors.length > 0 && (this.layout.isPartVisible('editor') || !this.editors.activeEditor || !this.tabs.isManaged(this.editors.activeEditor)));
	}
	protected override isEditorAutoVisibilitySuppressed(): boolean { return this.restoring || this.context.isChangingContent; }
	protected override getWorkingSet(key: string): EditorWorkingSet { return this.editor.saveWorkingSet(key, [this.pageGroupId]); }
	protected override async applyWorkingSet(saved: EditorWorkingSet | 'empty'): Promise<void> {
		await this.editor.applyWorkingSet(saved, { preserveFocus: true, preserveGroups: [this.pageGroupId] });
		this.editor.setGroupVisible(this.pageGroupId, false);
		this.editor.activateGroup(this.documentGroups[0]!.id);
	}
	protected override async onSessionRestored(selection: SessionsViewSelection, _hasSavedEditors: boolean): Promise<void> {
		if (!this.context.isDocumentContent) { return; }
		this.editor.activateGroup(this.documentGroups[0]!.id);
		await this.tabs.reconcile(selection, !this.documentsVisible && this.layout.isPartVisible('auxiliarybar'));
		await this.detailPanel.update(false);
	}
	public async hideEditor(): Promise<void> {
		this.setDocumentsVisible(false);
		this.layout.showPart('auxiliarybar');
		if (this.sessions.activeSelection) { await this.tabs.reconcile(this.sessions.activeSelection, true); }
		await this.detailPanel.update(true);
		this.layout.focus();
	}
	public async showEditor(): Promise<void> {
		this.setDocumentsVisible(true);
		this.editor.activateGroup(this.documentGroups[0]!.id);
		if (this.sessions.activeSelection) { await this.tabs.reconcile(this.sessions.activeSelection, false); }
		await this.detailPanel.update(false);
		this.editor.focus();
	}
	public async toggleDetails(): Promise<void> {
		if (this.layout.isPartVisible('auxiliarybar')) {
			if (!this.documentsVisible) { await this.showEditor(); }
			this.layout.hidePart('auxiliarybar');
		}
		else { this.editor.activateGroup(this.documentGroups[0]!.id); await this.detailPanel.update(true); }
	}
	public async toggleSidePane(): Promise<void> {
		if (this.documentsVisible || this.layout.isPartVisible('auxiliarybar')) {
			this.closedProfile = { documents: this.documentsVisible, details: this.layout.isPartVisible('auxiliarybar') };
			this.storage.store(lastOpenKey, JSON.stringify({ editor: this.closedProfile.documents, details: this.closedProfile.details }), StorageScope.PROFILE, StorageTarget.MACHINE);
			this.setDocumentsVisible(false);
			this.layout.hidePart('auxiliarybar');
			this.layout.focus();
		} else {
			this.setDocumentsVisible(this.closedProfile.documents);
			this.editor.activateGroup(this.documentGroups[0]!.id);
			this.setPartVisible(this.closedProfile.details);
			await this.detailPanel.update(false);
		}
	}

	public async openFiles(): Promise<void> {
		await this.showEditor();
		await this.tabs.openFiles();
		await this.detailPanel.update(true);
	}

	public async openChanges(): Promise<void> {
		await this.showEditor();
		const selection = this.sessions.activeSelection;
		if (selection) { await this.tabs.openChanges(selection); }
		await this.detailPanel.update(true);
	}
}
