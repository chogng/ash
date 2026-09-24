import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import * as nls from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, EditorContributionInstantiation, registerEditorAction, registerEditorContribution, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { Selection } from '../../../common/core/selection.js';
import { type IEditorContribution } from '../../../common/editorCommon.js';

class CursorState {
	constructor(readonly selections: readonly Selection[]) {}

	equals(other: CursorState): boolean {
		return this.selections.length === other.selections.length
			&& this.selections.every((selection, index) => selection.equalsSelection(other.selections[index]!));
	}
}

class StackElement {
	constructor(
		readonly cursorState: CursorState,
		readonly scrollTop: number,
		readonly scrollLeft: number,
	) {}
}

/** Owns bounded cursor-only undo and redo for one editor instance. */
export class CursorUndoRedoController extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.cursorUndoRedoController';

	public static get(editor: ICodeEditor): CursorUndoRedoController | null {
		return editor.getContribution<CursorUndoRedoController>(CursorUndoRedoController.ID);
	}

	private isCursorUndoRedo = false;
	private undoStack: StackElement[] = [];
	private redoStack: StackElement[] = [];

	constructor(private readonly editor: ICodeEditor) {
		super();
		this._register(editor.onDidChangeCursorSelection(event => this.recordCursorState(event.oldSelections, event.oldModelVersionId, event.modelVersionId)));
		const model = editor.getModel();
		if (model) this._register(model.onDidChangeContent(() => this.clearHistory()));
	}

	public cursorUndo(): void {
		if (!this.editor.hasModel() || this.undoStack.length === 0) return;
		this.redoStack.push(this.captureState());
		this.applyState(this.undoStack.pop()!);
	}

	public cursorRedo(): void {
		if (!this.editor.hasModel() || this.redoStack.length === 0) return;
		this.undoStack.push(this.captureState());
		this.applyState(this.redoStack.pop()!);
	}

	private recordCursorState(oldSelections: readonly Selection[] | null, oldModelVersionId: number, modelVersionId: number): void {
		if (this.isCursorUndoRedo || !oldSelections || oldModelVersionId !== modelVersionId) return;
		const previous = new CursorState(oldSelections);
		if (this.undoStack[this.undoStack.length - 1]?.cursorState.equals(previous)) return;
		this.undoStack.push(this.captureState(previous));
		this.redoStack = [];
		if (this.undoStack.length > 50) this.undoStack.shift();
	}

	private clearHistory(): void {
		this.undoStack = [];
		this.redoStack = [];
	}

	private captureState(cursorState = new CursorState(this.editor.getSelections() ?? [])): StackElement {
		return new StackElement(cursorState, this.editor.getScrollTop(), this.editor.getScrollLeft());
	}

	private applyState(stackElement: StackElement): void {
		this.isCursorUndoRedo = true;
		try {
			this.editor.setSelections(stackElement.cursorState.selections);
			this.editor.setScrollPosition({ scrollTop: stackElement.scrollTop, scrollLeft: stackElement.scrollLeft });
		} finally {
			this.isCursorUndoRedo = false;
		}
	}
}

export class CursorUndo extends EditorAction {
	constructor() {
		super({
			id: 'cursorUndo',
			label: nls.localize2('cursor.undo', 'Cursor Undo'),
			precondition: undefined,
			kbOpts: {
				weight: KeybindingWeight.EditorContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyU,
			},
		});
	}

	run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		CursorUndoRedoController.get(editor)?.cursorUndo();
	}
}

export class CursorRedo extends EditorAction {
	constructor() {
		super({ id: 'cursorRedo', label: nls.localize2('cursor.redo', 'Cursor Redo'), precondition: undefined });
	}

	run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		CursorUndoRedoController.get(editor)?.cursorRedo();
	}
}

registerEditorContribution(CursorUndoRedoController.ID, CursorUndoRedoController, EditorContributionInstantiation.Eager);
registerEditorAction(CursorUndo);
registerEditorAction(CursorRedo);
