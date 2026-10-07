import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../../browser/editorExtensions.js';
import type { ICodeEditor } from '../../../../browser/editorBrowser.js';
import { EditorContextKeys } from '../../../../common/editorContextKeys.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../../nls.js';
import { InlineCompletionsController } from './inlineCompletionsController.js';
import { InlineCompletionContextKeys } from './inlineCompletionContextKeys.js';

export class TriggerInlineSuggestionAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.inlineSuggest.trigger',
			label: localize2('inlineSuggest.trigger', 'Trigger Inline Suggestion'),
			precondition: EditorContextKeys.writable,
			kbOpts: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Space,
				mac: { primary: KeyMod.WinCtrl | KeyMod.Alt | KeyCode.Space },
				weight: KeybindingWeight.EditorContrib,
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
			},
		});
	}

	public async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await InlineCompletionsController.get(editor)?.trigger();
	}
}

export class AcceptInlineCompletion extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.inlineSuggest.commit',
			label: localize2('inlineSuggest.commit', 'Accept Inline Suggestion'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, InlineCompletionContextKeys.inlineSuggestionVisible.isEqualTo(true)),
			kbOpts: {
				primary: KeyMod.Alt | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib,
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
			},
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		InlineCompletionsController.get(editor)?.accept();
	}
}

export class HideInlineCompletion extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.inlineSuggest.hide',
			label: localize2('inlineSuggest.hide', 'Hide Inline Suggestion'),
			precondition: InlineCompletionContextKeys.inlineSuggestionVisible.isEqualTo(true),
			kbOpts: {
				primary: KeyCode.Escape,
				weight: KeybindingWeight.EditorContrib,
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
			},
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		InlineCompletionsController.get(editor)?.hide();
	}
}

registerEditorAction(TriggerInlineSuggestionAction);
registerEditorAction(AcceptInlineCompletion);
registerEditorAction(HideInlineCompletion);
