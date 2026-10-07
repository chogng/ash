import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import * as nls from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { ReplaceCommand } from '../../../common/commands/replaceCommand.js';
import { MoveOperations } from '../../../common/cursor/cursorMoveOperations.js';
import { Range } from '../../../common/core/range.js';
import { type ICommand } from '../../../common/editorCommon.js';

class TransposeLettersAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.transposeLetters',
			label: nls.localize2('transposeLetters.label', 'Transpose Letters'),
			precondition: undefined,
			kbOpts: {
				weight: KeybindingWeight.EditorContrib,
				mac: { primary: KeyMod.WinCtrl | KeyCode.KeyT },
			},
			canTriggerInlineEdits: true,
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const model = editor.getModel();
		if (!model) return;
		const commands: (ICommand | null)[] = [];
		for (const selection of editor.getSelections() ?? []) {
			if (!selection.isEmpty()) {
				commands.push(null);
				continue;
			}

			const lineNumber = selection.startLineNumber;
			const column = selection.startColumn;
			const lastColumn = model.getLineMaxColumn(lineNumber);
			if (lineNumber === 1 && (column === 1 || (column === 2 && lastColumn === 2))) {
				commands.push(null);
				continue;
			}

			const endPosition = column === lastColumn
				? selection.getPosition()
				: MoveOperations.rightPosition(model, selection.positionLineNumber, selection.positionColumn);
			const middlePosition = MoveOperations.leftPosition(model, endPosition);
			const beginPosition = MoveOperations.leftPosition(model, middlePosition);
			const leftChar = model.getValueInRange(Range.fromPositions(beginPosition, middlePosition));
			const rightChar = model.getValueInRange(Range.fromPositions(middlePosition, endPosition));
			commands.push(new ReplaceCommand(Range.fromPositions(beginPosition, endPosition), rightChar + leftChar));
		}

		if (commands.some(command => command !== null)) {
			editor.pushUndoStop();
			editor.executeCommands(this.id, commands);
			editor.pushUndoStop();
		}
	}
}

registerEditorAction(TransposeLettersAction);
