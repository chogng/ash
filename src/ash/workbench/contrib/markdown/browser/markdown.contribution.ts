import './media/markdown.css';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { MarkdownImageDropOrPaste } from './markdownImageDropOrPaste.js';
import { SelectAllCommand, UndoCommand, RedoCommand } from '../../../../editor/browser/editorExtensions.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { ArkdownEditor, ArkdownEditorFocused } from './arkdownEditor.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { isResourceDiffEditorInput } from '../../../common/editor.js';
import { localize } from '../../../../nls.js';
import { MARKDOWN_EDITOR_ID, MarkdownEditorPane, createMarkdownEditorInput } from './markdownEditorPane.js';
registerWorkbenchContribution('workbench.markdown.imageDropOrPaste', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(MarkdownImageDropOrPaste));

// The global keybinding service dispatches in capture phase. Route shared edit
// commands before its Code editor fallback reaches another visible editor.
for (const [command, operation] of [[SelectAllCommand, 'selectAll'], [UndoCommand, 'undo'], [RedoCommand, 'redo']] as const) {
	command.addImplementation(120, 'arkdown-editor', accessor => {
		const control = accessor.get(IEditorPart).activePane?.getControl();
		if (!(control instanceof ArkdownEditor) || !control.hasFocus()) return false;
		control[operation]();
		return true;
	});
}
for (const key of [KeyCode.KeyB, KeyCode.KeyI]) {
	KeybindingsRegistry.registerKeybindingPassThrough({
		keybinding: KeyMod.CtrlCmd | key, when: ArkdownEditorFocused.isEqualTo(true),
		priority: KeybindingWeight.WorkbenchContrib + 10,
	});
}


registerEditorPane({
	id: MARKDOWN_EDITOR_ID,
	get name() { return localize({ bundle: 'ash.markdown', key: 'editorName' }, 'Markdown document'); },
	canOpen: input => isResourceDiffEditorInput(input) ? EditorPaneMatch.None
		: input.editorId === MARKDOWN_EDITOR_ID ? EditorPaneMatch.Default
			: input.languageId === 'markdown' || /\.(?:md|markdown|mdown)$/iu.test(input.resource.path) ? EditorPaneMatch.Optional : EditorPaneMatch.None,
	createInput: createMarkdownEditorInput,
	create(options) {
		if (!options.instantiationService) throw new Error('Markdown editor requires an editor service scope');
		return options.instantiationService.createInstance(MarkdownEditorPane, { id: MARKDOWN_EDITOR_ID, onSave: options.onSave });
	},
});
