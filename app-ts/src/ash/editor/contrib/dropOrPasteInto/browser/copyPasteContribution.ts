import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { localize2 } from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import {
	EditorAction,
	EditorCommand,
	EditorContributionInstantiation,
	registerEditorAction,
	registerEditorCommand,
	registerEditorContribution,
	type ServicesAccessor,
} from '../../../browser/editorExtensions.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { CopyPasteController, changePasteTypeCommandId, pasteWidgetVisibleCtx } from './copyPasteController.js';

export const pasteAsCommandId = 'editor.action.pasteAs';

registerEditorContribution(
	CopyPasteController.ID,
	CopyPasteController,
	EditorContributionInstantiation.Eager,
);

registerEditorCommand(new class extends EditorCommand {
	constructor() {
		super({
			id: changePasteTypeCommandId,
			precondition: pasteWidgetVisibleCtx.isEqualTo(true),
			kbOpts: { weight: KeybindingWeight.EditorContrib, primary: KeyMod.CtrlCmd | KeyCode.Period },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		CopyPasteController.get(editor)?.changePasteType();
	}
});

registerEditorAction(class PasteAsAction extends EditorAction {
	constructor() {
		super({
			id: pasteAsCommandId,
			label: localize2('dropOrPaste.pasteAs', 'Paste As...'),
			precondition: EditorContextKeys.writable,
		});
	}
	run(_accessor: ServicesAccessor, editor: ICodeEditor, args: unknown): Promise<void> | undefined {
		const kind = typeof args === 'object' && args !== null && 'kind' in args && typeof args.kind === 'string'
			? new HierarchicalKind(args.kind)
			: undefined;
		return CopyPasteController.get(editor)?.pasteAs(kind);
	}
});

registerEditorCommand(new class extends EditorCommand {
	constructor() {
		super({
			id: 'editor.hidePasteWidget',
			precondition: pasteWidgetVisibleCtx.isEqualTo(true),
			kbOpts: { weight: KeybindingWeight.EditorContrib, primary: KeyCode.Escape },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		CopyPasteController.get(editor)?.clearWidgets();
	}
});
