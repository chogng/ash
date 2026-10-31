import { ActiveAuxiliaryContext } from '../../../../workbench/common/contextkeys.js';
import { SESSIONS_FILES_CONTAINER_ID } from '../../files/browser/files.contribution.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenusRegistry, MenuId } from '../../../../platform/actions/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { localize2 } from '../../../../nls.js';
import { Menus } from '../../../browser/menus.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import type { DesktopLayoutController, IDesktopLayoutContext } from '../../layout/browser/desktopLayoutController.js';
import { registerAddTabActions } from './addTabActions.js';

const editorVisibleContext = new RawContextKey<boolean>('sessions.editorContentVisible', false);
const detailsVisibleContext = new RawContextKey<boolean>('sessions.detailsVisible', false);
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
		const updateEditorMenu = (): void => {
			mirrored.clear();
			for (const item of MenusRegistry.getMenuItems(MenuId.EditorTitle)) {
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
		const code = codeContext.bindTo(contextKeys);
		const supportedDetails = supportedDetailsContext.bindTo(contextKeys);
		const updateContext = (): void =>
			contextKeys.bufferChangeEvents(() => {
				code.set(context.isDocumentContent);
				editorVisible.set(context.isDocumentContent && layout.isPartVisible('editor'));
				detailsVisible.set(layout.isPartVisible('auxiliarybar'));
				supportedDetails.set(context.isDocumentContent && controller.supportsDetails);
			});
		this._register(
			toDisposable(() => {
				for (const key of [editorVisible, detailsVisible, code, supportedDetails]) {
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
		for (const [id, operation] of [
			['ash.sessions.toggleDetails', () => controller.toggleDetails()],
			['ash.sessions.toggleFiles', () => controller.toggleFiles()],
			[
				'ash.sessions.closeDetails',
				async () => {
					layout.hidePart('auxiliarybar');
					layout.focus();
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
							toggled: ContextKeyExpr.and(
								detailsVisibleContext.isEqualTo(true),
								ActiveAuxiliaryContext.isEqualTo(SESSIONS_FILES_CONTAINER_ID),
							),
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
							id: 'workbench.agentSessions.action.viewChanges',
							title: localize2({ bundle: 'ash', key: 'sessions.changes.title' }, 'Changes'),
							icon: Lxicon.diffChanges,
						},
						when: codeWhen, group: 'navigation', order: 4,
					},
				},
				{
					id: MenuId.EditorTitle,
					item: {
						command: { ...toggleDetails, icon: Lxicon.files },
						when: codeWhen,
						group: 'navigation',
						order: 90,
					},
				},
				{
					id: MenuId.EditorTitle,
					item: {
						command: { ...hideEditor, icon: Lxicon.layoutSidebarRightOff2 },
						when: editorShown,
						group: 'navigation',
						order: 91,
					},
				},
				{
					id: MenuId.EditorTitle,
					item: {
						command: { ...showEditor, icon: Lxicon.layoutSidebarRight2 },
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
