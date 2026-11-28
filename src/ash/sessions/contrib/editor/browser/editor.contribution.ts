import { status } from '../../../../base/browser/ui/aria/aria.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { runWithBufferedEvents } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenusRegistry, MenuId, isMenuItem, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import type { IEditorGroupViewOptions } from '../../../../workbench/browser/parts/editor/editor.js';
import { resolveCommandsContext } from '../../../../workbench/browser/parts/editor/editorCommandsContext.js';
import { CODE_EDITOR_ID } from '../../../../workbench/browser/parts/editor/textResourceEditor.js';
import { ActiveEditorContext, EditorPartModalVisibleContext, IsSessionsWindowContext, ResourceSchemeContext, SessionsCodeEditorContext } from '../../../../workbench/common/contextkeys.js';
import { IChatAttachmentResolveService } from '../../../../workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import { registerWorkbenchContribution2, WorkbenchPhase, type IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { Menus } from '../../../browser/menus.js';
import type { EditorParts } from '../../../browser/parts/editorParts.js';
import type { SessionsPart } from '../../../browser/parts/sessionsPart.js';
import { SessionsCategories } from '../../../../workbench/contrib/sessions/common/categories.js';
import { SessionsEditorToolContext } from '../../../common/contextkeys.js';
import { SESSIONS_EDITOR_WORD_WRAP } from '../../../services/configuration/common/editorConfiguration.js';
import { EmptyEditor } from './emptyEditor.js';

export const createSessionsEditorEmptyState: NonNullable<IEditorGroupViewOptions['createEmptyState']> =
	(context, instantiation) => instantiation.createInstance(EmptyEditor, context);

registerAction2(class ToggleSessionsEditorWordWrapAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.agentSessions.toggleEditorWordWrap',
			title: localize2('sessions.editor.toggleWordWrap', 'Word Wrap'),
			toggled: ContextKeyExpr.or(...['on', 'bounded', 'wordWrapColumn'].map(value => ContextKeyExpr.equals('config.editor.wordWrap', value))),
			menu: {
				id: Menus.SessionsEditorTitle,
				group: '1_view',
				when: ContextKeyExpr.and(SessionsCodeEditorContext.isEqualTo(true), SessionsEditorToolContext.isEqualTo('files'), ActiveEditorContext.isEqualTo(CODE_EDITOR_ID)),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		return configuration.updateValue(SESSIONS_EDITOR_WORD_WRAP, configuration.getValue('editor.wordWrap') === 'off' ? 'on' : 'off');
	}
});

// Tool cards supply their own navigation and cannot split an editor group.
const editorTitleCommandsHandledBySessions = new Set([
	'multiDiffEditor.goToPreviousChange',
	'multiDiffEditor.goToNextChange',
	'workbench.action.splitEditor',
]);

/** Projects shared Workbench and extension editor-title placements into the Agent Window. */
export class EditorTitleMenuBridgeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sessions.editorTitleMenuBridge';

	constructor() {
		super();
		const projection = this._register(new MutableDisposable());
		const update = (): void => runWithBufferedEvents(() => {
			const items = MenusRegistry.getMenuItems(MenuId.EditorTitle)
				.filter(item => !isMenuItem(item) || !editorTitleCommandsHandledBySessions.has(item.command.id));
			projection.value = MenusRegistry.appendMenuItems(items.map(item => ({ id: Menus.SessionsEditorTitle, item })));
		});
		this._register(MenusRegistry.onDidChangeMenu(event => {
			if (event.has(MenuId.EditorTitle)) update();
		}));
		update();
	}
}

registerWorkbenchContribution2(EditorTitleMenuBridgeContribution.ID, EditorTitleMenuBridgeContribution, WorkbenchPhase.BlockStartup);

/** Binds modal editor actions to the current Code entry. */
export function registerSessionsModalEditorActions(editor: EditorParts, isDocumentContent: () => boolean): IDisposable {
	const disposables = new DisposableStore();
	const codeWhen = SessionsCodeEditorContext.isEqualTo(true);
	const modalVisible = EditorPartModalVisibleContext.isEqualTo(true);
	const modalToEditor = ContextKeyExpr.and(codeWhen, modalVisible);
	disposables.add(registerAction2(class OpenModalEditorInEditorAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.agentSessions.openModalEditorInEditor',
				title: localize2({ bundle: 'ash.workbench', key: 'sessions.editor.openModalInEditor' }, 'Open in Editor Area'),
				icon: Lxicon.linkExternal,
				precondition: modalToEditor,
				menu: { id: MenuId.ModalEditorTitle, group: 'navigation', order: 98, when: modalToEditor },
			});
		}
		override async run(): Promise<void> {
			if (isDocumentContent()) await editor.moveModalEditorToMain();
		}
	}));
	const openInModal = ContextKeyExpr.and(codeWhen, EditorPartModalVisibleContext.isEqualTo(false),
		ContextKeyExpr.or(...[Schemas.file, Schemas.ashRemote, Schemas.untitled, 'ash-session-changes'].map(scheme => ResourceSchemeContext.isEqualTo(scheme))));
	disposables.add(registerAction2(class OpenActiveEditorInModalAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.agentSessions.openEditorInModal',
				title: localize2({ bundle: 'ash.workbench', key: 'sessions.editor.openInModal' }, 'Open in Modal Editor'),
				f1: true,
				precondition: openInModal,
			});
		}
		override async run(): Promise<void> {
			if (isDocumentContent()) await editor.openActiveEditorInModal();
		}
	}));
	return disposables;
}

/** Adds the selected editor contents to the draft that was active when invoked. */
export function registerAddFileAsContextAction(sessions: SessionsPart) {
	const schemes: ReadonlySet<string> = new Set([Schemas.file, Schemas.ashRemote, Schemas.untitled]);
	const when = ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ContextKeyExpr.notEquals('config.chat.disableAIFeatures', true),
		ContextKeyExpr.or(...Array.from(schemes, scheme => ResourceSchemeContext.isEqualTo(scheme))));
	return registerAction2(class AddFileAsContextAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.agentSessions.addFileAsContext',
				title: localize2({ bundle: 'ash.workbench', key: 'sessions.editor.addFileAsContext' }, 'Add File as Context'),
				category: SessionsCategories.Sessions,
				icon: Lxicon.paperclip,
				f1: true,
				precondition: when,
				menu: [
					{ id: Menus.SessionsEditorTitle, when, group: 'navigation', order: 100 },
					{ id: MenuId.EditorTitleContext, when, group: 'z_chat' },
				],
			});
		}

		override async run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
			const { groupedEditors } = resolveCommandsContext(args, accessor.get(IEditorGroupsService));
			const inputs = groupedEditors.flatMap(({ editors }) => editors).filter(input => schemes.has(input.resource.scheme));
			if (!inputs.length) return;
			const resolver = accessor.get(IChatAttachmentResolveService);
			const accepted = await sessions.acquireContext(async signal => {
				const attachments = await Promise.all(inputs.map(input => resolver.resolveEditorAttachContext(input, signal)));
				return attachments.filter(attachment => attachment !== undefined);
			}).catch(error => {
				if (!isCancellationError(error)) throw error;
				return [];
			});
			if (accepted.length) status(localize({ bundle: 'ash.workbench', key: 'sessions.editor.filesAttached' }, 'Added {0} file(s) to the conversation draft.', accepted.length));
		}
	});
}
