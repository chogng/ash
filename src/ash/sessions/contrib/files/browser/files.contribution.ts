import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { NEW_FILE_TAB_COMMAND_ID } from '../../../../workbench/contrib/sessions/common/sessionCommands.js';
import { localize2, localize } from '../../../../nls.js';
import '../../../../workbench/contrib/files/browser/files.contribution.js';
import '../../../../workbench/contrib/files/browser/media/explorerviewlet.css';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ASH_REMOTE_SCHEME } from '../../../../platform/remote/common/remote.js';
import { FocusedViewContext, IsSessionsWindowContext, ResourceSchemeContext, SessionsCodeEditorContext, WorkspaceFolderCountContext } from '../../../../workbench/common/contextkeys.js';
import { resolveCommandsContext } from '../../../../workbench/browser/parts/editor/editorCommandsContext.js';
import { DOWNLOAD_COMMAND_ID } from '../../../../workbench/contrib/files/browser/fileActions.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { SESSIONS_FILES_VIEW_ID, SessionsExplorerView } from './filesView.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorPartsService } from '../../../../workbench/browser/parts/editor/editorParts.js';
import { DesktopMainEditorPart } from '../../../browser/parts/desktopEditorPart.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';

/** Installs Files on the document host while window commands keep the multi-window coordinator. */
class FilesViewContribution extends Disposable {
	constructor(
		@IEditorPartsService parts: IEditorPartsService,
		@ICommandService commands: ICommandService,
	) {
		super();
		const editor = parts.mainPart;
		if (editor instanceof DesktopMainEditorPart) {
			this._register(editor.auxiliaryBar.registerViewContainer({
				id: SESSIONS_FILES_CONTAINER_ID, title: localize('sessions.files.title', 'Files'), location: ViewContainerLocation.AuxiliaryBar,
			}, [{
				id: SESSIONS_FILES_VIEW_ID, title: localize('sessions.files.title', 'Files'), canMoveView: false,
				ctorDescriptor: new SyncDescriptor(SessionsExplorerView),
			}], () => commands.executeCommand(NEW_FILE_TAB_COMMAND_ID)));
		}
	}
}

registerWorkbenchContribution('sessions.contrib.filesView', WorkbenchPhase.BlockStartup,
	services => services.get(IInstantiationService).createInstance(FilesViewContribution));

const codeFiles = SessionsCodeEditorContext.isEqualTo(true);
const canCollapseFolders = ContextKeyExpr.and(codeFiles, ContextKeyExpr.notEquals(WorkspaceFolderCountContext.key, 0));

export const SESSIONS_FILES_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.filesContainer';

registerAction2(class extends Action2 {
	constructor() { super({ id: SESSIONS_FILES_CONTAINER_ID, title: localize2('sessions.files.title', 'Files') }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		if (!accessor.get(IContextKeyService).contextMatchesRules(codeFiles)) return;
		await accessor.get(ICommandService).executeCommand(NEW_FILE_TAB_COMMAND_ID);
	}
});

// Keep the existing Files shortcut while its View is scoped to the Files Part.
KeybindingsRegistry.registerKeybindingRule({
	command: SESSIONS_FILES_CONTAINER_ID,
	keybinding: Keybinding.single(logicalKey('e', { primaryKey: true, shiftKey: true })),
	when: codeFiles,
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.files.action.collapseExplorerFolders',
			title: localize2({ bundle: 'ash', key: 'sessions.files.collapseFolders' }, 'Collapse folders'),
			icon: Lxicon.chevronUp,
			precondition: canCollapseFolders,
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): void {
		if (!accessor.get(IContextKeyService).contextMatchesRules(canCollapseFolders)) return;
		const view = accessor.get(IViewsService).getViewWithId(SESSIONS_FILES_VIEW_ID);
		if (view instanceof SessionsExplorerView) {
			view.collapseAll();
		}
	}
});

export class DownloadRemoteFileAction extends Action2 {
	public static readonly ID = 'sessions.files.action.downloadRemoteFile';

	constructor() {
		const precondition = ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ResourceSchemeContext.isEqualTo(ASH_REMOTE_SCHEME));
		super({
			id: DownloadRemoteFileAction.ID,
			title: localize2({ bundle: 'ash', key: 'workbench.downloadFile' }, 'Download File...'),
			icon: Lxicon.download,
			precondition,
			menu: { id: MenuId.EditorTitle, group: 'navigation', when: precondition },
		});
	}

	public override async run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
		const context = resolveCommandsContext(args, accessor.get(IEditorGroupsService));
		const commands = accessor.get(ICommandService);
		const notifications = accessor.get(INotificationService);
		try {
			for (const { editors } of context.groupedEditors) {
				for (const editor of editors) {
					if (editor.resource.scheme === ASH_REMOTE_SCHEME) {
						await commands.executeCommand(DOWNLOAD_COMMAND_ID, editor.resource);
					}
				}
			}
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}
}

registerAction2(DownloadRemoteFileAction);

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	name: 'sessionsFilesHelp',
	priority: 110,
	when: ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ContextKeyExpr.or(FocusedViewContext.isEqualTo(SESSIONS_FILES_VIEW_ID), ContextKeyExpr.has('sessionsFilesNavigationFocused'))),
	getProvider: accessor => {
		const view = accessor.get(IViewsService).getViewWithId(SESSIONS_FILES_VIEW_ID);
		if (!(view instanceof SessionsExplorerView)) { return undefined; }
		const focused = view.element.ownerDocument.activeElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.Explorer,
			{ type: AccessibleViewType.Help },
			() => localize('sessions.files.navigationHelp', 'Open Files from the editor tab list or the Command Palette to browse the file tree. Opening a file adds a document tab to the same group. Toggle details shows or hides the tree beside the active document. In a file editor, run Add File as Context from the Command Palette to attach the file to the current draft.') + '\n' + localize('sessions.files.help', "Files\nFiles and Changes are separate tabs in the same editor group. Browser and Terminal have their own editor groups. Drag a tab to move its editor. On Desktop, drag blank space or plain titles in the window title bar to move the window. When a group title is inside a card, drag empty title space to move the group, or Alt-drag to move the tool workspace. Drop at a group edge to split, or in its center to combine tabs. With a header action focused, Alt+Shift+Arrow moves the group beside its local neighbor, or moves the tool workspace at the group boundary. Separators resize tools and groups. Use Ctrl or Command+Shift+E to focus Files, arrow keys to navigate, Enter to open a file, and Shift+F10 for file actions. Ctrl or Command+F searches the tree; Escape clears Find and restores focus. Alt+F2 reads the visible files. Files follows the selected session directory. Run Collapse folders in the Command Palette to collapse all folders. Press Shift+F10 for file actions and Alt+F2 to read the visible files. Remote files can be downloaded from the editor title. On Desktop, choose a save location and use Cancel in the progress notification to stop the download. When there is no directory, Files shows an empty message. Use GitHub: Browse Repository Files in the Command Palette to choose a repository and branch, search filenames, and open read-only files without a local checkout. In GitHub file results, use Tab to reach Add to current Agent context, then Enter or Space to attach the captured file content without sending. Escape cancels a pending read.")
				+ '\n' + localize('sessions.files.editorNavigationHelp', 'Use <keybinding:ash.sessions.openSearchEditor> or choose Search in the Code layout toolbar’s More Actions menu to open the Search tool. Find in Folder opens a search scoped to the selected folder. From a file tab menu, Reveal in Explorer View opens the file tree and selects the file. Drag the file tree separator to the edge to collapse the tree, or activate Toggle details from the keyboard. Word Wrap is available under More Actions in a file editor.'),
			() => { if (focused instanceof HTMLElement) { focused.focus(); } },
			AccessibilityVerbositySettingId.Explorer,
		);
	},
});
