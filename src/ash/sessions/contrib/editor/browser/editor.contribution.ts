import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenusRegistry, MenuId } from '../../../../platform/actions/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import type { DesktopEditorParts } from '../../../browser/parts/desktopEditorParts.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { localize2 } from '../../../../nls.js';
import { Menus } from '../../../browser/menus.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import type { DesktopLayoutController, IDesktopLayoutContext } from '../../layout/browser/desktopLayoutController.js';
import { registerAddTabActions } from './addTabActions.js';
import { SessionChangesEditor } from '../../changes/browser/sessionChangesEditor.js';
import { isRecord } from '../../../../base/common/types.js';

const editorVisibleContext = new RawContextKey<boolean>('sessions.editorContentVisible', false);
const detailsVisibleContext = new RawContextKey<boolean>('sessions.detailsVisible', false);
const filesVisibleContext = new RawContextKey<boolean>('sessions.filesVisible', false);
const changesVisibleContext = new RawContextKey<boolean>('sessions.changesVisible', false);
const codeContext = new RawContextKey<boolean>('sessions.desktopCode', false);
const supportedDetailsContext = new RawContextKey<boolean>('sessions.supportedDetails', false);
/** Window-owned editor commands and menu state derive from the existing layout owner. */
export class EditorTitleMenuBridgeContribution extends Disposable {
	constructor(
		controller: DesktopLayoutController,
		context: IDesktopLayoutContext,
		@IContextKeyService contextKeys: IContextKeyService,
		@ILayoutService layout: IAgentWorkbenchLayoutService,
		@IEditorPart editor: IEditorPart,
	) {
		super();
		// Existing editor contributions keep their menu identity; Desktop groups consume its live projection.
		const mirrored = this._register(new DisposableStore());
		const layoutCommands = new Set(['ash.sessions.toggleDetails', 'ash.sessions.hideEditor', 'ash.sessions.showEditor', 'workbench.action.splitEditor']);
		const navigationCommands = new Set(['multiDiffEditor.goToPreviousChange', 'multiDiffEditor.goToNextChange']);
		const updateEditorMenu = (): void => {
			mirrored.clear();
			for (const item of MenusRegistry.getMenuItems(MenuId.EditorTitle)) {
				if ('command' in item && navigationCommands.has(item.command.id)) { continue; }
				// The dedicated layout toolbar owns card controls; group-layout commands remain available in overflow.
				const layoutItem = 'command' in item && layoutCommands.has(item.command.id);
				mirrored.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, layoutItem ? { ...item, group: '9_layout' } : item));
			}
		};
		this._register(MenusRegistry.onDidChangeMenu(event => {
			if (event.has(MenuId.EditorTitle)) { updateEditorMenu(); }
		}));
		updateEditorMenu();
		const editorVisible = editorVisibleContext.bindTo(contextKeys);
		const detailsVisible = detailsVisibleContext.bindTo(contextKeys);
		const fileEditorsVisible = filesVisibleContext.bindTo(contextKeys);
		const changesVisible = changesVisibleContext.bindTo(contextKeys);
		const code = codeContext.bindTo(contextKeys);
		const supportedDetails = supportedDetailsContext.bindTo(contextKeys);
		const updateContext = (): void =>
			contextKeys.bufferChangeEvents(() => {
				code.set(context.isDocumentContent);
				editorVisible.set(context.isDocumentContent && layout.isPartVisible('editor') &&
					(!(editor as DesktopEditorParts).filesDetailsVisible || (editor as DesktopEditorParts).filesPart.isEditorVisible));
				detailsVisible.set(context.isDocumentContent && layout.isPartVisible('editor') && (editor as DesktopEditorParts).filesDetailsVisible);
				fileEditorsVisible.set(context.isDocumentContent && layout.isPartVisible('editor') && (editor as DesktopEditorParts).fileEditorsVisible);
				changesVisible.set(context.isDocumentContent && layout.isPartVisible('editor') && editor.groups.some(group =>
					editor.isGroupVisible(group.id) && group.activeInput?.resource.scheme === 'ash-session-changes'));
				supportedDetails.set(context.isDocumentContent && controller.supportsDetails);
			});
		this._register(
			toDisposable(() => {
				for (const key of [editorVisible, detailsVisible, fileEditorsVisible, changesVisible, code, supportedDetails]) {
					key.reset();
				}
			}),
		);
		this._register(layout.onDidLayoutMainContainer(updateContext));
		this._register(editor.onDidChangeEditors(updateContext));
		this._register(
			autorun(reader => {
				context.documentContent.read(reader);
				updateContext();
			}),
		);
		const run = (operation: () => Promise<void>): Promise<void> | false =>
			context.isDocumentContent &&
			context.runOperation(async () => {
				await operation();
				updateContext();
			});
		const toolGroup = (arg: unknown): number => isRecord(arg) && typeof arg.groupId === 'number'
			&& editor.groups.some(group => group.id === arg.groupId) ? arg.groupId : editor.activeGroup.id;
		this._register(CommandsRegistry.register('ash.sessions.toggleChangesFileList', arg => {
			const pane = editor.groups.find(group => group.id === toolGroup(arg))?.activePane;
			if (pane instanceof SessionChangesEditor) { pane.toggleFileList(); }
		}));
		this._register(CommandsRegistry.register('ash.sessions.hideTool', arg => run(async () => {
			(editor as DesktopEditorParts).hideTool(toolGroup(arg));
			if (editor.groups.every(group => !editor.isGroupVisible(group.id))) layout.hidePart('editor');
		})));
		this._register(CommandsRegistry.register('ash.sessions.maximizeTool', arg => run(async () => {
			(editor as DesktopEditorParts).toggleMaximizeTool(toolGroup(arg));
		})));
		for (const [id, operation] of [
			['ash.sessions.toggleDetails', () => controller.toggleDetails()],
			['ash.sessions.toggleFiles', () => controller.toggleFiles()],
			['ash.sessions.toggleChanges', () => controller.toggleChanges()],
			[
				'ash.sessions.closeDetails',
				async () => {
					if ((editor as DesktopEditorParts).filesDetailsOpen) { await controller.toggleDetails(); }
				},
			],
			['ash.sessions.hideEditor', () => controller.hideEditor()],
			['ash.sessions.showEditor', () => controller.showEditor()],
			['ash.sessions.toggleSidePane', () => controller.toggleSidePane()],
		] as const) {
			this._register(CommandsRegistry.register(id, () => run(operation)));
		}
		this._register(
			registerAddTabActions(
				() => run(() => controller.openFiles()),
				() => run(() => controller.openChanges()),
				codeContext.isEqualTo(true),
			),
		);
		const codeWhen = codeContext.isEqualTo(true);
		const editorShown = ContextKeyExpr.and(codeWhen, editorVisibleContext.isEqualTo(true));
		const editorHidden = ContextKeyExpr.and(codeWhen, editorVisibleContext.isEqualTo(false));
		const toggleSidePane = {
			id: 'ash.sessions.toggleSidePane',
			title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleSidePane' }, 'Toggle Code side panel'),
			toggled: ContextKeyExpr.or(editorVisibleContext.isEqualTo(true), detailsVisibleContext.isEqualTo(true)),
		};
		const toggleDetails = {
			id: 'ash.sessions.toggleDetails',
			title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleDetails' }, 'Toggle details'),
			toggled: detailsVisibleContext.isEqualTo(true),
			precondition: supportedDetailsContext.isEqualTo(true),
		};
		const hideEditor = {
			id: 'ash.sessions.hideEditor',
			title: localize2({ bundle: 'ash', key: 'sessions.layout.hideEditor' }, 'Hide editor'),
		};
		const showEditor = {
			id: 'ash.sessions.showEditor',
			title: localize2({ bundle: 'ash', key: 'sessions.layout.showEditor' }, 'Show editor'),
		};
		this._register(
			MenusRegistry.appendMenuItems([
				{
					id: Menus.SessionsEditorHeaderLayout,
					item: {
						command: { ...toggleDetails, icon: Lxicon.listUnordered },
						when: ContextKeyExpr.and(codeWhen, ContextKeyExpr.equals('sessions.editorTool', 'files')),
						group: 'navigation',
						order: -1,
					},
				},
				{
					id: Menus.SessionsEditorHeaderLayout,
					item: {
						command: {
							id: 'ash.sessions.toggleChangesFileList',
							title: localize2({ bundle: 'ash', key: 'sessions.changes.toggleFileList' }, 'Toggle changed files list'),
							icon: Lxicon.listUnordered,
						},
						when: ContextKeyExpr.and(codeWhen, ContextKeyExpr.equals('sessions.editorTool', 'changes')),
						group: 'navigation',
						order: -1,
					},
				},
				{
					id: Menus.SessionsEditorHeaderLayout,
					item: {
						command: { id: 'ash.sessions.maximizeTool', title: localize2('sessions.layout.maximizeTool', 'Toggle tool size'), icon: Lxicon.screenFull },
						when: codeWhen, group: 'navigation', order: 1,
					},
				},
				{
					id: Menus.SessionsEditorHeaderLayout,
					item: {
						command: { id: 'ash.sessions.hideTool', title: localize2('sessions.layout.hideTool', 'Hide tool'), icon: Lxicon.close },
						when: codeWhen, group: 'navigation', order: 2,
					},
				},
				{
					id: MenuId.AuxiliaryBarTitle,
					item: {
						command: {
							id: 'ash.sessions.closeDetails',
							title: localize2({ bundle: 'ash', key: 'sessions.layout.closeDetails' }, 'Close details'),
							icon: Lxicon.close,
						},
						when: codeWhen,
						group: 'navigation',
						order: 100,
					},
				},
				{
					id: Menus.TitleBarRightLayout,
					item: {
						command: {
							id: 'ash.sessions.toggleFiles',
							title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleFiles' }, 'Toggle files'),
							icon: Lxicon.folder,
							toggled: filesVisibleContext.isEqualTo(true),
						},
						when: codeWhen,
						group: 'navigation',
						order: 5,
					},
				},
				{
					id: Menus.TitleBarRightLayout,
					item: {
						command: {
							id: 'ash.sessions.toggleChanges',
							title: localize2({ bundle: 'ash', key: 'sessions.changes.title' }, 'Changes'),
							icon: Lxicon.diffChanges,
							toggled: changesVisibleContext.isEqualTo(true),
						},
						when: codeWhen, group: 'navigation', order: 4,
					},
				},
				{
					id: MenuId.EditorTitle,
					item: {
						command: { ...toggleDetails, icon: Lxicon.listUnordered },
						when: codeWhen,
						group: 'navigation',
						order: 90,
					},
				},
				{
					id: MenuId.EditorTitle,
					item: {
						command: { ...hideEditor, icon: Lxicon.layoutSidebarRightOffSession },
						when: editorShown,
						group: 'navigation',
						order: 91,
					},
				},
				{
					id: MenuId.EditorTitle,
					item: {
						command: { ...showEditor, icon: Lxicon.layoutSidebarRightSession },
						when: editorHidden,
						group: 'navigation',
						order: 91,
					},
				},
			]),
		);
		const codeLayoutCommands = [
			{ command: toggleSidePane, when: codeWhen, order: 0 },
			{ command: toggleDetails, when: codeWhen, order: 1 },
			{ command: hideEditor, when: editorShown, order: 2 },
			{ command: showEditor, when: editorHidden, order: 2 },
		];
		this._register(
			MenusRegistry.appendMenuItems(
				codeLayoutCommands.flatMap(item =>
					[MenuId.CommandPalette, MenuId.MenubarViewMenu].map(id => ({
						id,
						item: { ...item, group: '2_code_layout' },
					})),
				),
			),
		);
		updateContext();
	}
}
