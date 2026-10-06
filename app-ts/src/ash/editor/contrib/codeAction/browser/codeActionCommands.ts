import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { CodeActionController } from './codeActionController.js';

class QuickFixAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.quickFix',
			label: localize2('quickfix.trigger.label', 'Quick Fix...'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider.isEqualTo(true)),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				primary: KeyMod.CtrlCmd | KeyCode.Period,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await CodeActionController.get(editor)?.manualTriggerAtCurrentPosition();
	}
}

registerEditorAction(QuickFixAction);

export class RefactorAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.refactor',
			label: localize2('refactor.label', 'Refactor...'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider.isEqualTo(true)),
			contextMenuOpts: { group: '1_modification', order: 2 },
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR,
				mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyR },
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await CodeActionController.get(editor)?.manualTriggerAtCurrentPosition(['refactor']);
	}
}

export class SourceAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.sourceAction',
			label: localize2('source.label', 'Source Action...'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider.isEqualTo(true)),
			contextMenuOpts: { group: '1_modification', order: 2.1 },
		});
	}

	async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await CodeActionController.get(editor)?.manualTriggerAtCurrentPosition(['source']);
	}
}

registerEditorAction(RefactorAction);
registerEditorAction(SourceAction);
