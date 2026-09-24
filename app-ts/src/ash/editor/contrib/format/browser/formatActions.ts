import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, registerEditorContribution, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { IVersionedEditorWorkerClient } from '../../../browser/services/editorWorkerService.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { formatEditor, FormattingKind, FormattingMode } from './format.js';

class FormatDocumentAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.formatDocument',
			label: localize2('formatDocument.label', 'Format Document'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasDocumentFormattingProvider.isEqualTo(true)),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	public async run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		if (!editor.getModel()) {
			return;
		}
		await formatEditor(editor, accessor.get(ILanguageFeaturesService), accessor.get(IVersionedEditorWorkerClient), FormattingKind.File);
	}
}

const formatDocumentAction = registerEditorAction(FormatDocumentAction);

class FormatSelectionAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.formatSelection',
			label: localize2('formatSelection.label', 'Format Selection'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasDocumentSelectionFormattingProvider.isEqualTo(true)),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyF),
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	public async run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		if (!editor.getModel()) {
			return;
		}
		await formatEditor(editor, accessor.get(ILanguageFeaturesService), accessor.get(IVersionedEditorWorkerClient), FormattingKind.Selection);
	}
}

registerEditorAction(FormatSelectionAction);

registerEditorContribution({ id: 'editor.contrib.format', install: context => {
	if (context.kind !== 'text') {
		return;
	}
	context.register(context.editor.onKeyDown(event => {
		if (event.browserEvent.defaultPrevented || event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'i') return;
		const action = context.editor.getAction(formatDocumentAction.id);
		if (!action?.isSupported()) return;
		event.stop();
		void action.run().catch(context.onLanguageError);
	}));
	if (!context.options.formatOnSave || !context.registerBeforeSave) {
		return;
	}
	context.register(context.registerBeforeSave(() => formatEditor(
		context.editor, context.languageFeaturesService, context.editorWorker, FormattingKind.File, FormattingMode.Silent,
	).catch(context.onLanguageError)));
} });
