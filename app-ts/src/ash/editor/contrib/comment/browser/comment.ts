import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import * as nls from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, registerEditorContribution, type IActionOptions, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import { type ICommand } from '../../../common/editorCommon.js';
import { ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { BlockCommentCommand } from './blockCommentCommand.js';
import { LineCommentCommand, Type } from './lineCommentCommand.js';

abstract class CommentLineAction extends EditorAction {
	constructor(private readonly type: Type, options: IActionOptions) {
		super(options);
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		const model = editor.getModel();
		const selections = editor.getSelections();
		if (!model || !selections || selections.length === 0) return;
		const configuration = accessor.get(ILanguageConfigurationService);
		const comments = editor.getOption(EditorOption.comments);
		const modelOptions = model.getOptions();
		const ordered = selections
			.map((selection, index) => ({ selection, index, ignoreFirstLine: false }))
			.sort((left, right) => Range.compareRangesUsingStarts(left.selection, right.selection));
		for (let index = 1; index < ordered.length; index += 1) {
			const previous = ordered[index - 1]!;
			const current = ordered[index]!;
			if (previous.selection.endLineNumber !== current.selection.startLineNumber) continue;
			if (previous.index < current.index) current.ignoreFirstLine = true;
			else previous.ignoreFirstLine = true;
		}
		const commands = ordered.sort((left, right) => left.index - right.index).map<ICommand>(entry => new LineCommentCommand(
			configuration,
			entry.selection,
			modelOptions.indentSize,
			this.type,
			comments.insertSpace,
			comments.ignoreEmptyLines,
			entry.ignoreFirstLine,
		));
		editor.pushUndoStop();
		editor.executeCommands(this.id, commands);
		editor.pushUndoStop();
	}
}

class ToggleCommentLineAction extends CommentLineAction {
	constructor() {
		super(Type.Toggle, {
			id: 'editor.action.commentLine',
			label: nls.localize2('comment.line', 'Toggle Line Comment'),
			precondition: EditorContextKeys.writable,
			kbOpts: { primary: KeyMod.CtrlCmd | KeyCode.Slash, weight: KeybindingWeight.EditorContrib },
			canTriggerInlineEdits: true,
		});
	}
}

class AddLineCommentAction extends CommentLineAction {
	constructor() {
		super(Type.ForceAdd, {
			id: 'editor.action.addCommentLine',
			label: nls.localize2('comment.line.add', 'Add Line Comment'),
			precondition: EditorContextKeys.writable,
			kbOpts: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyC), weight: KeybindingWeight.EditorContrib },
			canTriggerInlineEdits: true,
		});
	}
}

class RemoveLineCommentAction extends CommentLineAction {
	constructor() {
		super(Type.ForceRemove, {
			id: 'editor.action.removeCommentLine',
			label: nls.localize2('comment.line.remove', 'Remove Line Comment'),
			precondition: EditorContextKeys.writable,
			kbOpts: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyU), weight: KeybindingWeight.EditorContrib },
			canTriggerInlineEdits: true,
		});
	}
}

class BlockCommentAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.blockComment',
			label: nls.localize2('comment.block', 'Toggle Block Comment'),
			precondition: EditorContextKeys.writable,
			kbOpts: {
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KeyA,
				linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA },
				weight: KeybindingWeight.EditorContrib,
			},
			canTriggerInlineEdits: true,
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		const selections = editor.getSelections();
		if (!editor.hasModel() || !selections || selections.length === 0) return;
		const configuration = accessor.get(ILanguageConfigurationService);
		const insertSpace = editor.getOption(EditorOption.comments).insertSpace;
		editor.pushUndoStop();
		editor.executeCommands(this.id, selections.map(selection => new BlockCommentCommand(selection, insertSpace, configuration)));
		editor.pushUndoStop();
	}
}

const toggleLineComment = registerEditorAction(ToggleCommentLineAction);
registerEditorAction(AddLineCommentAction);
registerEditorAction(RemoveLineCommentAction);
const toggleBlockComment = registerEditorAction(BlockCommentAction);

registerEditorContribution({ id: 'editor.contrib.comment', install: context => {
	if (context.kind !== 'text') {
		return;
	}
	context.register(context.editor.onKeyDown(event => {
		if (event.browserEvent.defaultPrevented || event.isComposing || event.browserEvent.getModifierState('AltGraph')) {
			return;
		}
		const line = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key === '/';
		const block = event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'a';
		if (!line && !block) {
			return;
		}
		const action = context.editor.getAction(line ? toggleLineComment.id : toggleBlockComment.id);
		if (!action?.isSupported()) {
			return;
		}
		const position = context.editor.getPosition();
		const model = context.editor.getModel();
		if (!position || !model) {
			return;
		}
		const languageId = model.getLanguageIdAtPosition(position.lineNumber, position.column);
		const comments = context.configurations.getLanguageConfiguration(languageId).comments;
		if (line ? !comments?.lineCommentToken : !comments?.blockCommentStartToken || !comments.blockCommentEndToken) {
			return;
		}
		event.stop();
		void action.run().catch(context.onLanguageError);
		const selection = context.editor.getSelection();
		if (selection) {
			context.view.revealPosition(selection.getPosition());
		}
	}));
} });
