import { localize2, localize } from '../../../../nls.js';
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
import type { PanelPart } from '../../../browser/parts/panelPart.js';
import type { AuxiliaryBarPart } from '../../../browser/parts/auxiliarybar/auxiliaryBarPart.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { DesktopDockedTabsCoordinator } from './desktop/desktopDockedTabsCoordinator.js';
import { DesktopDetailPanelCoordinator } from './desktop/desktopDetailPanelCoordinator.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenusRegistry, MenuId } from '../../../../platform/actions/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';

import { toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import { Menus } from '../../../browser/menus.js';

const editorVisibleContext = new RawContextKey<boolean>('sessions.editorContentVisible', false);
const detailsVisibleContext = new RawContextKey<boolean>('sessions.detailsVisible', false);
const codeContext = new RawContextKey<boolean>('sessions.desktopCode', false);
const supportedDetailsContext = new RawContextKey<boolean>('sessions.supportedDetails', false);
const profileKey = 'sessions.singlePane.sidePaneVisibility';
const lastOpenProfileKey = 'sessions.layout.sidePane.lastOpen';
interface SidePaneProfile { readonly editor: boolean; readonly details: boolean; }

function parseProfile(raw: string): SidePaneProfile {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed) || typeof parsed.editor !== 'boolean' || typeof parsed.details !== 'boolean') {
		throw new TypeError(localize('sessions.layout.invalidState', 'Saved session editor layout is invalid.'));
	}
	return { editor: parsed.editor, details: parsed.details };
}

/** Owns the desktop Code editor and detail composition. */
export class DesktopLayoutController extends BaseLayoutController {
	private readonly tabs: DesktopDockedTabsCoordinator;
	private readonly detailPanel: DesktopDetailPanelCoordinator;
	private updating = false;
	private restoredSession: string | undefined;
	private collapsedEditors: EditorWorkingSet | undefined;
	private existingProfile: SidePaneProfile | undefined;
	private closedProfile: SidePaneProfile = { editor: true, details: true };
	private initialRestore = true;

	constructor(
		panel: PanelPart,
		details: AuxiliaryBarPart,
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
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) {
		super(panel, sessions, management, editor, editors, workspace, layout, storage, notifications, lifecycle);
		this.tabs = instantiation.createInstance(DesktopDockedTabsCoordinator);
		this.detailPanel = instantiation.createInstance(DesktopDetailPanelCoordinator, details);
		const profile = storage.get(profileKey, StorageScope.WORKSPACE);
		if (profile !== undefined) {
			this.existingProfile = parseProfile(profile);
		}
		const lastOpen = storage.get(lastOpenProfileKey, StorageScope.PROFILE);
		if (lastOpen !== undefined) {
			this.closedProfile = parseProfile(lastOpen);
		}
	}

	public override start(): void {
		super.start();
		const editorVisible = editorVisibleContext.bindTo(this.contextKeys);
		const detailsVisible = detailsVisibleContext.bindTo(this.contextKeys);
		const code = codeContext.bindTo(this.contextKeys);
		const supportedDetails = supportedDetailsContext.bindTo(this.contextKeys);
		this._register(toDisposable(() => {
			editorVisible.reset();
			detailsVisible.reset();
			code.reset();
			supportedDetails.reset();
		}));
		const updateContext = (): void => this.contextKeys.bufferChangeEvents(() => {
			code.set(this.isCodeActive());
			editorVisible.set(this.layout.isPartVisible('editor'));
			detailsVisible.set(this.layout.isPartVisible('auxiliarybar'));
			supportedDetails.set(this.detailPanel.supportsActiveEditor);
		});
		this._register(this.layout.onDidLayoutMainContainer(updateContext));
		this._register(this.layout.onDidChangePartVisibility(() => {
			updateContext();
			if (!this.isCodeActive() || this.isEditorAutoVisibilitySuppressed()) {
				return;
			}
			if (this.layout.isPartVisible('editor') && this.collapsedEditors) {
				void this.enqueueDetails(() => this.restoreCollapsedEditors());
			}
			if (this.sessions.getPageSelection('code').activeSelection?.kind === 'session') {
				this.existingProfile = this.profile;
				this.saveProfile();
			}
		}));
		this._register(this.editor.onDidChangeEditors(event => {
			if (!this.isCodeActive() || this.isEditorAutoVisibilitySuppressed()) {
				return;
			}
			if (event.kind === 'groupChanged' && event.event.kind === 'editorClosed' && event.event.reason === 'close' && this.editor.groups.every(group => group.inputs.length === 0)) {
				this.layout.hidePart('auxiliarybar');
				this.layout.hidePart('editor');
			}
		}));
		this._register(this.editors.onDidActiveEditorChange(() => {
			updateContext();
			if (!this.isCodeActive() || this.isEditorAutoVisibilitySuppressed()) {
				return;
			}
			const input = this.editors.activeEditor;
			if (input && this.tabs.isManaged(input) && !this.layout.isPartVisible('editor') && this.collapsedEditors) {
				// A Details tab selection belongs to the restorable composition too, including after reload.
				const current = this.editor.saveWorkingSet('details');
				const activeGroup = current.groups[current.activeGroupIndex]!;
				const active = activeGroup.editors[activeGroup.activeEditorIndex]!;
				const saved = this.collapsedEditors;
				this.collapsedEditors = {
					...saved,
					groups: saved.groups.map((group, index) => {
						if (index !== saved.activeGroupIndex) {
							return group;
						}
						const selected = group.editors.findIndex(entry => entry.input.typeId === active.input.typeId);
						return { ...group, editors: selected < 0 ? [...group.editors, active] : group.editors, activeEditorIndex: selected < 0 ? group.editors.length : selected };
					}),
				};
			}
			void this.enqueueDetails(async () => {
				if (input && !this.tabs.isManaged(input) && ['file', 'ash-remote', 'untitled'].includes(input.resource.scheme)) {
					await this.tabs.removeFilesLandingTab();
				}
				this.detailPanel.update(true);
			});
		}));
		this._register(this.storage.onWillSaveState(() => this.saveProfile()));
		for (const [id, run] of [
			['ash.sessions.toggleDetails', () => this.toggleDetails()],
			['ash.sessions.hideEditor', () => this.hideEditor()],
			['ash.sessions.showEditor', () => this.showEditor()],
			['ash.sessions.toggleSidePane', () => this.toggleSidePane()],
			['ash.sessions.openFilesTab', async () => {
				await this.showEditor();
				await this.tabs.openFiles();
				this.detailPanel.update(true);
			}],
			['ash.sessions.openChangesTab', async () => {
				await this.showEditor();
				const selection = this.sessions.getPageSelection('code').activeSelection;
				if (selection) {
					await this.tabs.openChanges(selection);
					this.detailPanel.update(true);
				}
			}],
		] as const) {
			this._register(CommandsRegistry.register(id, () => this.isCodeActive() && this.enqueueDetails(run)));
		}
		this._register(MenusRegistry.appendMenuItems([
			{ id: Menus.TitleBarLeftLayout, item: { command: { id: 'ash.sessions.toggleSidePane', title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleSidePane' }, 'Toggle Code side panel'), icon: Lxicon.layoutSidebarRight2, toggled: ContextKeyExpr.or(editorVisibleContext.isEqualTo(true), detailsVisibleContext.isEqualTo(true)) }, when: codeContext.isEqualTo(true), group: 'navigation', order: 4 } },
			{ id: MenuId.EditorTitle, item: { title: localize2({ bundle: 'ash', key: 'sessions.layout.addTab' }, 'Add tab'), submenu: Menus.CodeAddTab, when: codeContext.isEqualTo(true), group: 'navigation', order: 89 } },
			{ id: Menus.CodeAddTab, item: { command: { id: 'ash.sessions.openFilesTab', title: localize2({ bundle: 'ash', key: 'sessions.layout.openFiles' }, 'Open Files tab'), icon: Lxicon.files }, order: 0 } },
			{ id: Menus.CodeAddTab, item: { command: { id: 'ash.sessions.openChangesTab', title: localize2({ bundle: 'ash', key: 'sessions.layout.openChanges' }, 'Open Changes tab'), icon: Lxicon.diff }, order: 1 } },
			{ id: MenuId.EditorTitle, item: { command: { id: 'ash.sessions.toggleDetails', title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleDetails' }, 'Toggle details'), icon: Lxicon.files, toggled: detailsVisibleContext.isEqualTo(true), precondition: supportedDetailsContext.isEqualTo(true) }, when: codeContext.isEqualTo(true), group: 'navigation', order: 90 } },
			{ id: MenuId.EditorTitle, item: { command: { id: 'ash.sessions.hideEditor', title: localize2({ bundle: 'ash', key: 'sessions.layout.hideEditor' }, 'Hide editor'), icon: Lxicon.layoutSidebarRightOff2 }, when: ContextKeyExpr.and(codeContext.isEqualTo(true), editorVisibleContext.isEqualTo(true)), group: 'navigation', order: 91 } },
			{ id: MenuId.EditorTitle, item: { command: { id: 'ash.sessions.showEditor', title: localize2({ bundle: 'ash', key: 'sessions.layout.showEditor' }, 'Show editor'), icon: Lxicon.layoutSidebarRight2 }, when: ContextKeyExpr.and(codeContext.isEqualTo(true), editorVisibleContext.isEqualTo(false)), group: 'navigation', order: 91 } },
		]));
		const codeLayoutCommands = [
			{
				command: { id: 'ash.sessions.toggleSidePane', title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleSidePane' }, 'Toggle Code side panel'), toggled: ContextKeyExpr.or(editorVisibleContext.isEqualTo(true), detailsVisibleContext.isEqualTo(true)) },
				when: codeContext.isEqualTo(true), order: 0,
			},
			{
				command: { id: 'ash.sessions.toggleDetails', title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleDetails' }, 'Toggle details'), toggled: detailsVisibleContext.isEqualTo(true), precondition: supportedDetailsContext.isEqualTo(true) },
				when: codeContext.isEqualTo(true), order: 1,
			},
			{
				command: { id: 'ash.sessions.hideEditor', title: localize2({ bundle: 'ash', key: 'sessions.layout.hideEditor' }, 'Hide editor') },
				when: ContextKeyExpr.and(codeContext.isEqualTo(true), editorVisibleContext.isEqualTo(true)), order: 2,
			},
			{
				command: { id: 'ash.sessions.showEditor', title: localize2({ bundle: 'ash', key: 'sessions.layout.showEditor' }, 'Show editor') },
				when: ContextKeyExpr.and(codeContext.isEqualTo(true), editorVisibleContext.isEqualTo(false)), order: 2,
			},
			{
				command: { id: 'ash.sessions.openFilesTab', title: localize2({ bundle: 'ash', key: 'sessions.layout.openFiles' }, 'Open Files tab') },
				when: codeContext.isEqualTo(true), order: 4,
			},
			{
				command: { id: 'ash.sessions.openChangesTab', title: localize2({ bundle: 'ash', key: 'sessions.layout.openChanges' }, 'Open Changes tab') },
				when: codeContext.isEqualTo(true), order: 5,
			},
		];
		this._register(MenusRegistry.appendMenuItems(codeLayoutCommands.flatMap(item => [MenuId.CommandPalette, MenuId.MenubarViewMenu].map(id => ({ id, item: { ...item, group: '2_code_layout' } })))));
		updateContext();
	}

	protected override isEditorAutoVisibilitySuppressed(): boolean { return this.restoring || this.updating; }
	protected override shouldShowEditor(): boolean {
		const input = this.editors.activeEditor;
		return super.shouldShowEditor() && (this.layout.isPartVisible('editor') || !input || !this.tabs.isManaged(input));
	}
	protected override getWorkingSet(key: string): EditorWorkingSet {
		const current = super.getWorkingSet(key);
		if (!this.collapsedEditors) {
			return current;
		}
		const saved = this.collapsedEditors;
		const savedInputs = new Set(saved.groups.flatMap(group => group.editors.map(entry => JSON.stringify(entry.input))));
		const opened = current.groups.flatMap(group => group.editors).filter(entry => !['sessions.editorInput.files', 'sessions.editorInput.changes'].includes(entry.input.typeId) && !savedInputs.has(JSON.stringify(entry.input)));
		return {
			...saved,
			id: key,
			groups: saved.groups.map((group, index) => index === saved.activeGroupIndex ? {
				...group,
				editors: [...group.editors, ...opened],
				activeEditorIndex: opened.length ? group.editors.length + opened.length - 1 : group.activeEditorIndex,
			} : group),
		};
	}

	protected override onSessionIdentityChanged(from: string, to: string): void {
		if (this.restoredSession === from) {
			this.restoredSession = to;
			this.existingProfile = this.profile;
			this.saveProfile();
		}
	}

	protected override async onSessionRestored(selection: SessionsViewSelection, hasSavedEditors: boolean): Promise<void> {
		// Design retains its live document when covered by Code. Code composition must
		// wait for a Code editor rather than closing the hidden, possibly dirty canvas.
		if (!this.layout.isPartAvailable('editor')) {
			return;
		}
		if (this.restoredSession !== this.sessionKey(selection)) {
			this.collapsedEditors = undefined;
		}
		this.restoredSession = this.sessionKey(selection);
		if (!this.initialRestore && selection.kind === 'session' && this.existingProfile) {
			this.applyProfile(this.existingProfile);
		}
		this.initialRestore = false;
		await this.tabs.reconcile(selection, !this.layout.isPartVisible('editor') && this.layout.isPartVisible('auxiliarybar'));
		if (!this.isCurrentSession(selection)) {
			return;
		}
		if (!hasSavedEditors && selection.kind === 'untitled' && this.editor.groups.every(group => group.inputs.every(input => this.tabs.isManaged(input))) && this.layout.isPartVisible('auxiliarybar')) {
			await this.hideEditor();
		} else if (!this.layout.isPartVisible('editor') && this.layout.isPartVisible('auxiliarybar')) {
			await this.hideEditor();
		}
		this.detailPanel.update(false);
	}

	private get profile(): SidePaneProfile { return { editor: this.layout.isPartVisible('editor'), details: this.layout.isPartVisible('auxiliarybar') }; }
	private isCodeActive(): boolean { return this.sessions.page.get() === 'code' && this.layout.isPartAvailable('panel'); }
	private isCurrentSession(selection: SessionsViewSelection): boolean {
		const current = this.sessions.getPageSelection('code').activeSelection;
		return this.isCodeActive() && current !== undefined && this.sessionKey(current) === this.sessionKey(selection);
	}
	private saveProfile(): void {
		this.storage.store(lastOpenProfileKey, JSON.stringify(this.closedProfile), StorageScope.PROFILE, StorageTarget.MACHINE);
		if (this.existingProfile) {
			this.storage.store(profileKey, JSON.stringify(this.existingProfile), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}
	private applyProfile(profile: SidePaneProfile): void {
		if (profile.editor) {
			this.layout.showPart('editor');
		} else {
			this.layout.hidePart('editor');
		}
		if (profile.details) {
			this.layout.showPart('auxiliarybar');
		} else {
			this.layout.hidePart('auxiliarybar');
		}
	}
	private enqueueDetails(operation: () => Promise<void> | void): Promise<void> {
		return this.enqueueLayoutOperation(async () => {
			if (this.isDisposed || !this.isCodeActive()) {
				return;
			}
			const selected = this.sessions.getPageSelection('code').activeSelection;
			this.captureEditors();
			this.updating = true;
			try {
				await operation();
			} finally {
				this.updating = false;
			}
			if (selected?.kind === 'session' && this.isCurrentSession(selected) && this.detailPanel.supportsActiveEditor) {
				this.existingProfile = this.profile;
				this.saveProfile();
			}
		});
	}
	private async hideEditor(): Promise<void> {
		const selection = this.sessions.getPageSelection('code').activeSelection;
		if (!selection || !await this.editor.confirmCloseAllEditors() || !this.isCurrentSession(selection)) {
			return;
		}
		this.collapsedEditors ??= this.editor.saveWorkingSet('collapsed');
		for (const group of this.editor.groups) {
			for (const input of [...group.inputs].filter(input => !this.tabs.isManaged(input))) {
				await group.closeEditor(input, { skipConfirmation: true, reason: 'reset' });
				if (!this.isCurrentSession(selection)) {
					return;
				}
			}
		}
		this.layout.showPart('auxiliarybar');
		this.layout.hidePart('editor');
		await this.tabs.reconcile(selection, true);
		this.detailPanel.update(true);
	}
	private async restoreCollapsedEditors(): Promise<void> {
		const saved = this.collapsedEditors ? this.getWorkingSet('collapsed') : undefined;
		this.collapsedEditors = undefined;
		if (saved) {
			await this.editor.applyWorkingSet(saved, { preserveFocus: true });
		}
		const selection = this.sessions.getPageSelection('code').activeSelection;
		if (selection) {
			await this.tabs.reconcile(selection, false);
		}
	}
	private async showEditor(): Promise<void> {
		await this.restoreCollapsedEditors();
		this.layout.showPart('editor');
		this.detailPanel.update(false);
		this.editor.focus();
	}
	private async toggleDetails(): Promise<void> {
		if (this.layout.isPartVisible('auxiliarybar')) {
			if (!this.layout.isPartVisible('editor')) {
				await this.showEditor();
			}
			this.layout.hidePart('auxiliarybar');
		} else {
			this.detailPanel.update(true);
		}
	}
	private async toggleSidePane(): Promise<void> {
		if (this.layout.isPartVisible('editor') || this.layout.isPartVisible('auxiliarybar')) {
			this.closedProfile = this.profile;
			this.layout.hidePart('editor');
			this.layout.hidePart('auxiliarybar');
		} else {
			this.applyProfile(this.closedProfile);
			if (this.closedProfile.editor) {
				await this.restoreCollapsedEditors();
			}
			const selection = this.sessions.getPageSelection('code').activeSelection;
			if (selection) {
				await this.tabs.reconcile(selection, !this.closedProfile.editor);
			}
			this.detailPanel.update(false);
		}
		if (this.sessions.getPageSelection('code').activeSelection?.kind === 'session') {
			this.existingProfile = this.profile;
		}
		this.saveProfile();
	}
}
