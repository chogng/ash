import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { Position } from '../../../common/core/position.js';
import { Selection } from '../../../common/core/selection.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Range, type IRange } from '../../../common/core/range.js';
import { EditorKeybindingCancellationTokenSource } from './keybindingCancellation.js';

export const enum CodeEditorStateFlag {
	Value = 1,
	Selection = 2,
	Position = 4,
	Scroll = 8,
}

/** Cancels at the state-change event, including changes later reversed by the user. */
export class EditorStateCancellationTokenSource extends EditorKeybindingCancellationTokenSource {
	private readonly changes = new DisposableStore();

	constructor(editor: ICodeEditor, flags: CodeEditorStateFlag, range?: IRange, parent?: CancellationToken) {
		super(editor, parent);
		const allowedRange = range ? Range.lift(range) : undefined;
		if (flags & CodeEditorStateFlag.Value) {
			this.changes.add(editor.onDidChangeModel(() => this.cancel()));
			this.changes.add(editor.onDidChangeModelContent(() => this.cancel()));
		}
		if (flags & CodeEditorStateFlag.Position) {
			this.changes.add(editor.onDidChangeCursorPosition(event => {
				if (!allowedRange?.containsPosition(event.position)) {
					this.cancel();
				}
			}));
		}
		if (flags & CodeEditorStateFlag.Selection) {
			this.changes.add(editor.onDidChangeCursorSelection(event => {
				if (!allowedRange?.containsRange(event.selection)) {
					this.cancel();
				}
			}));
		}
		if (flags & CodeEditorStateFlag.Scroll) {
			const state = new EditorState(editor, CodeEditorStateFlag.Scroll);
			this.changes.add(editor.onDidLayoutChange(() => {
				if (!state.validate(editor)) {
					this.cancel();
				}
			}));
		}
		this.changes.add(this.token.onCancellationRequested(() => this.changes.dispose()));
		if (this.token.isCancellationRequested) {
			this.changes.dispose();
		}
	}

	public override dispose(cancel = false): void {
		this.changes.dispose();
		super.dispose(cancel);
	}
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
