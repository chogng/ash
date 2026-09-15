import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { Position } from '../../../common/core/position.js';
import { Selection } from '../../../common/core/selection.js';

export const enum CodeEditorStateFlag {
	Value = 1,
	Selection = 2,
	Position = 4,
	Scroll = 8,
}

/** Captures only the state an asynchronous editor operation needs to validate. */
export class EditorState {
	private readonly checks: readonly ((editor: ICodeEditor) => boolean)[];

	constructor(editor: ICodeEditor, flags: number) {
		const checks: ((editor: ICodeEditor) => boolean)[] = [];
		if (flags & CodeEditorStateFlag.Value) {
			const model = editor.getModel();
			const version = model?.getVersionId();
			checks.push(current => current.getModel() === model && current.getModel()?.getVersionId() === version);
		}
		if (flags & CodeEditorStateFlag.Selection) {
			const selection = editor.getSelection();
			checks.push(current => {
				const value = current.getSelection();
				return selection === value || (selection !== null && value !== null && Selection.selectionsEqual(selection, value));
			});
		}
		if (flags & CodeEditorStateFlag.Position) {
			const position = editor.getPosition();
			checks.push(current => Position.equals(position, current.getPosition()));
		}
		if (flags & CodeEditorStateFlag.Scroll) {
			const left = editor.getScrollLeft();
			const top = editor.getScrollTop();
			checks.push(current => current.getScrollLeft() === left && current.getScrollTop() === top);
		}
		this.checks = checks;
	}

	public validate(editor: ICodeEditor): boolean {
		return this.checks.every(check => check(editor));
	}
}
