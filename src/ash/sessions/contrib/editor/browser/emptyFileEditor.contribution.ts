import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { SessionsCodeEditorContext } from '../../../../workbench/common/contextkeys.js';
import { NEW_UNTITLED_FILE_COMMAND_ID } from '../../../../workbench/contrib/files/browser/fileConstants.js';
import { EmptyFileEditorInput, EmptyFileEditorSerializer } from '../../../../workbench/contrib/sessions/browser/emptyFileEditorInput.js';
import { EditorInputSerializers } from '../../../../workbench/services/editor/common/editorInputSerializer.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { EmptyFileEditor, EmptyFileEditorFocusedContext } from './emptyFileEditor.js';
import './emptyFileEditorAccessibility.js';

registerEditorPane({
	id: EmptyFileEditor.ID,
	get name() { return localize('sessions.files.title', 'Files'); },
	canOpen: input => input instanceof EmptyFileEditorInput ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(EmptyFileEditor),
});

const serializer = new EmptyFileEditorSerializer();
EditorInputSerializers.registerStatic(serializer);
// Saved working sets may contain the former New Tab input. Save it as Files after restoration.
EditorInputSerializers.registerStatic({
	typeId: 'sessions.editorInput.newTab',
	canSerialize: () => false,
	serialize: () => undefined,
	deserialize: value => serializer.deserialize(value),
});

registerAction2(class OpenFileInEmptyEditorAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.agentSessions.openFileInEmptyEditor',
			title: localize2('sessions.emptyFileEditor.openFile', 'Open File…'),
			icon: Lxicon.folder,
			keybinding: {
				weight: KeybindingWeight.SessionsContrib,
				primary: Keybinding.single(logicalKey('p', { primaryKey: true })),
				when: EmptyFileEditorFocusedContext.isEqualTo(true),
			},
			menu: { id: Menus.EmptyFileEditorActions, group: 'navigation', order: 0 },
		});
	}

	override run(accessor: ServicesAccessor, target?: unknown): void {
		const editor = target instanceof EmptyFileEditor ? target : accessor.get(IEditorService).activeEditorPane;
		if (editor instanceof EmptyFileEditor && editor.isVisible()) editor.openFile();
	}
});

const code = SessionsCodeEditorContext.isEqualTo(true);
MenusRegistry.appendMenuItem(Menus.EmptyFileEditorActions, {
	command: {
		id: NEW_UNTITLED_FILE_COMMAND_ID,
		title: localize2('sessions.emptyFileEditor.newFile', 'New File'),
		icon: Lxicon.add,
	},
	when: code,
	group: 'navigation',
	order: 0.5,
});

KeybindingsRegistry.registerKeybindingRule({
	command: NEW_UNTITLED_FILE_COMMAND_ID,
	keybinding: Keybinding.single(logicalKey('n', { primaryKey: true })),
	when: ContextKeyExpr.and(code, EmptyFileEditorFocusedContext.isEqualTo(true)),
	priority: KeybindingWeight.SessionsContrib,
});
