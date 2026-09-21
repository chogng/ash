import { Disposable } from "../../../../base/common/lifecycle.js";
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";
import { type IBracketPairsTextModelPart } from "../../../common/textModelBracketPairs.js";
import { Range } from "../../../common/core/range.js";
import { TrackedRangeStickiness } from '../../../common/model.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { localize2 } from '../../../../nls.js';
import { jumpToMatchingBrackets } from '../common/bracketNavigation.js';
import { createRemoveMatchingBracketsCommand } from '../common/bracketEditing.js';


/** Projects current collapsed-cursor bracket matches into caller-owned decorations. */
export class BracketMatchingController extends Disposable {
	public static readonly ID = 'editor.contrib.bracketMatchingController';

	public static get(editor: ICodeEditor): BracketMatchingController | null {
		return editor.getContribution<BracketMatchingController>(BracketMatchingController.ID);
	}

	constructor(
		private readonly editor: ICodeEditor,
		private readonly bracketPairs: IBracketPairsTextModelPart,
		private readonly decorations: TextDecorationCollection<void>,
		private readonly mode: "never" | "near" | "always",
	) {
		super();
		try {
			if (editor.getModel()?.bracketPairs !== bracketPairs || editor.getModel() !== decorations.textModel) {
				throw new TypeError("Stanza bracket matching dependencies must share one text model");
			}
			this._register(editor.onDidChangeCursorSelection(() => this.update()));
			this._register(decorations.textModel.onDidChangeContent(() => this.update()));
			this._register(bracketPairs.onDidChange(() => this.update()));
			this.update();
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	private update(): void {
		if (this.mode === "never") {
			this.decorations.replaceAll([]);
			return;
		}
		const ranges = new Map<string, Range>();
		for (const selection of this.editor.getSelections()!) {
			if (!selection.isEmpty()) continue;
			const match = this.bracketPairs.matchBracket(selection.getPosition())
				?? (this.mode === "always" ? this.bracketPairs.findEnclosingBrackets(selection.getPosition()) : undefined);
			if (!match) continue;
			ranges.set(rangeKey(match[0]), match[0]);
			ranges.set(rangeKey(match[1]), match[1]);
		}
		this.decorations.replaceAll([...ranges.values()].map(range => ({
			range,
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: { description: 'bracket-match', className: 'bracket-match' },
			metadata: undefined,
		})));
	}

	public jumpToBracket(): void {
		const selections = this.editor.getSelections();
		if (!selections) return;
		const next = jumpToMatchingBrackets(this.bracketPairs, selections);
		this.editor.setSelections([...next], 'editor.action.jumpToBracket');
		if (next[0]) this.editor.revealRange(Range.fromPositions(next[0].getPosition()));
	}

	public removeBrackets(editSource?: string): void {
		if (this.editor.getOption(EditorOption.readOnly)) return;
		const selections = this.editor.getSelections();
		if (!selections) return;
		const commands = createRemoveMatchingBracketsCommand(this.bracketPairs, selections);
		if (!commands) return;
		this.editor.pushUndoStop();
		this.editor.executeCommands(editSource, commands);
		this.editor.pushUndoStop();
		const position = this.editor.getPosition();
		if (position) this.editor.revealRange(Range.fromPositions(position));
	}
}

class JumpToBracketAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.jumpToBracket',
			label: localize2('smartSelect.jumpBracket', 'Go to Bracket'),
			precondition: undefined,
			kbOpts: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backslash, weight: KeybindingWeight.EditorContrib },
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		BracketMatchingController.get(editor)?.jumpToBracket();
	}
}

class RemoveBracketsAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.removeBrackets',
			label: localize2('smartSelect.removeBrackets', 'Remove Brackets'),
			precondition: undefined,
			kbOpts: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Backspace, weight: KeybindingWeight.EditorContrib },
			canTriggerInlineEdits: true,
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		BracketMatchingController.get(editor)?.removeBrackets(this.id);
	}
}

registerEditorAction(JumpToBracketAction);
registerEditorAction(RemoveBracketsAction);

function rangeKey(range: Range): string {
	return `${range.startLineNumber}:${range.startColumn}-${range.endLineNumber}:${range.endColumn}`;
}
