import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import type { IContextKey } from "../../platform/contextkey/common/contextkey.js";
import type { IContextKeyService } from "../../platform/contextkey/browser/contextKeyService.js";
import { IsLinuxContext, IsMacContext, IsNativeContext, IsWebContext, IsWindowsContext } from '../../platform/contextkey/common/contextkeys.js';
import { type IWorkspaceContextService, workbenchStateToString } from '../../platform/workspace/common/workspace.js';
import { ActiveEditorGroupEmptyContext, ActiveEditorGroupIndexContext, ActiveEditorGroupLastContext, AgentSidebarVisibleContext, AuxiliaryBarVisibleContext, DirtyWorkingCopiesContext, EditorAreaVisibleContext, EditorsVisibleContext, MultipleEditorGroupsContext, PanelMaximizedContext, PanelVisibleContext, SideBarVisibleContext, WorkbenchStateContext, WorkspaceFolderCountContext } from '../common/contextkeys.js';
import type { IEditorGroupsService } from '../services/editor/common/editorGroupsService.js';
import type { IEditorService } from '../services/editor/common/editorService.js';
import type { IWorkbenchLayoutService, WorkbenchPartId } from '../services/layout/common/workbenchLayoutService.js';
import type { IWorkingCopyService } from '../services/workingCopy/common/workingCopyService.js';

/** Projects window-wide service state into Workbench context keys. */
export class WorkbenchContextKeysHandler extends Disposable {
	constructor(
		private readonly contextKeyService: IContextKeyService,
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly editorGroupsService: IEditorGroupsService,
		private readonly editorService: IEditorService,
		private readonly layoutService: IWorkbenchLayoutService,
		private readonly workingCopyService: IWorkingCopyService,
	) {
		super();
		contextKeyService.bufferChangeEvents(() => {
			this.bindPlatformKeys(contextKeyService);
			this.bindWorkspaceKeys(contextKeyService, workspaceContextService);
			this.bindWorkingCopyKeys(contextKeyService, workingCopyService);
			this.bindLayoutKeys(contextKeyService, layoutService);
			this.bindEditorKeys(contextKeyService, editorGroupsService, editorService);
		});
	}

	private bindPlatformKeys(contextKeyService: IContextKeyService): void {
		const keys = bufferContextKeyChanges(contextKeyService, () => [
			IsWindowsContext.bindTo(contextKeyService),
			IsMacContext.bindTo(contextKeyService),
			IsLinuxContext.bindTo(contextKeyService),
			IsWebContext.bindTo(contextKeyService),
			IsNativeContext.bindTo(contextKeyService),
		]);
		this._register(toDisposable(() => resetContextKeys(contextKeyService, keys)));
	}

	private bindWorkspaceKeys(contextKeyService: IContextKeyService, workspaceContextService: IWorkspaceContextService): void {
		const keys = bufferContextKeyChanges(contextKeyService, () => {
			const workbenchState = WorkbenchStateContext.bindTo(contextKeyService);
			const workspaceFolderCount = WorkspaceFolderCountContext.bindTo(contextKeyService);
			updateWorkspaceKeys(workbenchState, workspaceFolderCount, workspaceContextService);
			return { workbenchState, workspaceFolderCount };
		});
		this._register(workspaceContextService.onDidChangeWorkspace(() => {
			contextKeyService.bufferChangeEvents(() => updateWorkspaceKeys(keys.workbenchState, keys.workspaceFolderCount, workspaceContextService));
		}));
		this._register(toDisposable(() => resetContextKeys(contextKeyService, Object.values(keys))));
	}

	private bindWorkingCopyKeys(contextKeyService: IContextKeyService, workingCopyService: IWorkingCopyService): void {
		const dirtyWorkingCopies = DirtyWorkingCopiesContext.bindTo(contextKeyService);
		dirtyWorkingCopies.set(workingCopyService.hasDirtyWorkingCopies);
		this._register(workingCopyService.onDidChangeDirty(() => dirtyWorkingCopies.set(workingCopyService.hasDirtyWorkingCopies)));
		this._register(toDisposable(() => dirtyWorkingCopies.reset()));
	}

	private bindLayoutKeys(contextKeyService: IContextKeyService, layoutService: IWorkbenchLayoutService): void {
		const { visibilityKeys, panelMaximized } = bufferContextKeyChanges(contextKeyService, () => ({
			visibilityKeys: new Map<WorkbenchPartId, IContextKey<boolean>>([
				['sidebar', SideBarVisibleContext.bindTo(contextKeyService)],
				['auxiliarybar', AuxiliaryBarVisibleContext.bindTo(contextKeyService)],
				['agentSidebar', AgentSidebarVisibleContext.bindTo(contextKeyService)],
				['panel', PanelVisibleContext.bindTo(contextKeyService)],
				['editor', EditorAreaVisibleContext.bindTo(contextKeyService)],
			]),
			panelMaximized: PanelMaximizedContext.bindTo(contextKeyService),
		}));
		const updateAll = (): void => contextKeyService.bufferChangeEvents(() => {
			for (const [partId, key] of visibilityKeys) key.set(layoutService.isPartVisible(partId));
			panelMaximized.set(layoutService.isPanelMaximized());
		});
		updateAll();
		this._register(layoutService.onDidChangePartVisibility(event => {
			contextKeyService.bufferChangeEvents(() => {
				visibilityKeys.get(event.partId)?.set(event.visible);
				panelMaximized.set(layoutService.isPanelMaximized());
			});
		}));
		this._register(toDisposable(() => resetContextKeys(contextKeyService, [...visibilityKeys.values(), panelMaximized])));
	}

	private bindEditorKeys(contextKeyService: IContextKeyService, editorGroupsService: IEditorGroupsService, editorService: IEditorService): void {
		const keys = bufferContextKeyChanges(contextKeyService, () => ({
			activeEditorGroupEmpty: ActiveEditorGroupEmptyContext.bindTo(contextKeyService),
			activeEditorGroupIndex: ActiveEditorGroupIndexContext.bindTo(contextKeyService),
			activeEditorGroupLast: ActiveEditorGroupLastContext.bindTo(contextKeyService),
			multipleEditorGroups: MultipleEditorGroupsContext.bindTo(contextKeyService),
			editorsVisible: EditorsVisibleContext.bindTo(contextKeyService),
		}));
		const update = (): void => contextKeyService.bufferChangeEvents(() => {
			const groups = editorGroupsService.groups;
			const activeGroup = editorGroupsService.activeGroup;
			const activeGroupIndex = groups.findIndex(group => group.id === activeGroup.id);
			keys.activeEditorGroupEmpty.set(activeGroup.editors.length === 0 && editorService.activeEditor === undefined);
			keys.activeEditorGroupIndex.set(activeGroupIndex >= 0 ? activeGroupIndex + 1 : 0);
			keys.activeEditorGroupLast.set(activeGroupIndex >= 0 && activeGroupIndex === groups.length - 1);
			keys.multipleEditorGroups.set(groups.length > 1);
			keys.editorsVisible.set(editorService.visibleEditors.length > 0);
		});
		update();
		this._register(editorGroupsService.onDidChangeGroups(update));
		this._register(editorService.onDidActiveEditorChange(update));
		this._register(editorService.onDidVisibleEditorsChange(update));
		void editorGroupsService.whenReady.then(() => {
			if (!this.isDisposed) update();
		});
		this._register(toDisposable(() => resetContextKeys(contextKeyService, Object.values(keys))));
	}
}

function updateWorkspaceKeys(workbenchState: IContextKey<string>, workspaceFolderCount: IContextKey<number>, workspaceContextService: IWorkspaceContextService): void {
	workbenchState.set(workbenchStateToString(workspaceContextService.getWorkbenchState()));
	workspaceFolderCount.set(workspaceContextService.getWorkspace().folders.length);
}

function resetContextKeys(contextKeyService: IContextKeyService, keys: readonly Pick<IContextKey<never>, 'reset'>[]): void {
	contextKeyService.bufferChangeEvents(() => {
		for (const key of keys) key.reset();
	});
}

function bufferContextKeyChanges<T>(contextKeyService: IContextKeyService, callback: () => T): T {
	let result!: T;
	contextKeyService.bufferChangeEvents(() => {
		result = callback();
	});
	return result;
}
