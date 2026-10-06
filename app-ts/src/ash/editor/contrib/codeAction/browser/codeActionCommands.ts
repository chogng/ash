import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { CodeActionAutoApply, CodeActionCommandArgs, CodeActionKind, CodeActionTriggerSource } from '../common/types.js';
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
		await CodeActionController.get(editor)?.manualTriggerAtCurrentPosition(localize('codeAction.empty', 'No code actions available.'), CodeActionTriggerSource.QuickFix);
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
		await CodeActionController.get(editor)?.manualTriggerAtCurrentPosition(localize('codeAction.empty', 'No code actions available.'), CodeActionTriggerSource.Refactor, { include: CodeActionKind.Refactor });
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
		await CodeActionController.get(editor)?.manualTriggerAtCurrentPosition(localize('codeAction.empty', 'No code actions available.'), CodeActionTriggerSource.SourceAction, { include: CodeActionKind.Source });
	}
}

registerEditorAction(RefactorAction);
registerEditorAction(SourceAction);

class CodeActionCommand extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.codeAction', label: localize2('codeAction.genericLabel', 'Code Action...'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider.isEqualTo(true)),
		});
	}
	async run(_accessor: ServicesAccessor, editor: ICodeEditor, arg: unknown): Promise<void> {
		editor.focus();
		const args = CodeActionCommandArgs.fromUser(arg, { kind: HierarchicalKind.Empty, apply: CodeActionAutoApply.IfSingle });
		await CodeActionController.get(editor)?.manualTriggerAtCurrentPosition(
			localize('codeAction.empty', 'No code actions available.'), CodeActionTriggerSource.Default,
			{ include: args.kind, onlyIncludePreferredActions: args.preferred }, args.apply);
	}
}
registerEditorAction(CodeActionCommand);

class OrganizeImportsAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.organizeImports', label: localize2('codeAction.organizeImports', 'Organize Imports'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider.isEqualTo(true)),
		});
	}
	async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await CodeActionController.get(editor)?.manualTriggerAtCurrentPosition(
			localize('codeAction.empty', 'No code actions available.'), CodeActionTriggerSource.OrganizeImports,
			{ include: CodeActionKind.SourceOrganizeImports }, CodeActionAutoApply.IfSingle);
	}
}
registerEditorAction(OrganizeImportsAction);

class FixAllAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.fixAll', label: localize2('codeAction.fixAll', 'Fix All'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider.isEqualTo(true)),
		});
	}
	async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await CodeActionController.get(editor)?.manualTriggerAtCurrentPosition(
			localize('codeAction.empty', 'No code actions available.'), CodeActionTriggerSource.FixAll,
			{ include: CodeActionKind.SourceFixAll }, CodeActionAutoApply.IfSingle);
	}
}
registerEditorAction(FixAllAction);
