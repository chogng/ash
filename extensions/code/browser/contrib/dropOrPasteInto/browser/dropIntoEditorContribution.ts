import { KeyCode, KeyMod } from '../../../../../../src/ash/base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../../../src/ash/platform/keybinding/common/keybindingsRegistry.js';
import { type ICodeEditor } from '../../../../../../src/ash/editor/browser/editorBrowser.js';
import {
	EditorCommand,
	EditorContributionInstantiation,
	registerEditorCommand,
	registerEditorContribution,
	type ServicesAccessor,
} from '../../../registration.js';
import { DropIntoEditorController, changeDropTypeCommandId, dropWidgetVisibleCtx } from './dropIntoEditorController.js';

registerEditorContribution(
	DropIntoEditorController.ID,
	DropIntoEditorController,
	EditorContributionInstantiation.BeforeFirstInteraction,
);

registerEditorCommand(new class extends EditorCommand {
	constructor() {
		super({
			id: changeDropTypeCommandId,
			precondition: dropWidgetVisibleCtx.isEqualTo(true),
			kbOpts: { weight: KeybindingWeight.EditorContrib, primary: KeyMod.CtrlCmd | KeyCode.Period },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		DropIntoEditorController.get(editor)?.changeDropType();
	}
});

registerEditorCommand(new class extends EditorCommand {
	constructor() {
		super({
			id: 'editor.hideDropWidget',
			precondition: dropWidgetVisibleCtx.isEqualTo(true),
			kbOpts: { weight: KeybindingWeight.EditorContrib, primary: KeyCode.Escape },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		DropIntoEditorController.get(editor)?.clearWidgets();
	}
});

export type PreferredDropConfiguration = string;
