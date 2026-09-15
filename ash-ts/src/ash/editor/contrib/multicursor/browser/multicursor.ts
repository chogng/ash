import { localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { operatingSystem, OperatingSystem } from '../../../../base/common/platform.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { CursorMoveCommands } from '../../../common/cursor/cursorMoveCommands.js';
import { CursorChangeReason } from '../../../common/cursorEvents.js';
import { Position } from '../../../common/core/position.js';
import { addOccurrenceSelection, EditorOccurrenceDirection, selectAllOccurrences } from '../common/occurrenceSelection.js';
import { EditorAction, registerEditorAction, type ServicesAccessor, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { Selection } from '../../../common/core/selection.js';
import { Range } from '../../../common/core/range.js';
import { USUAL_WORD_SEPARATORS } from '../../../common/core/wordHelper.js';
import { TextDecorationCollection } from '../../../common/model/decorationCollection.js';
import { type TextModel } from '../../../common/model/textModel.js';

import type { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { TrackedRangeStickiness, type ITextModel } from '../../../common/model.js';

const MAX_SELECTION_HIGHLIGHTS = 10_000;

interface SelectionHighlighterOptions {
	readonly languageId: string;
	readonly languageFeaturesService: ILanguageFeaturesService;
	readonly enabled?: boolean;
	readonly multiline?: boolean;
	readonly maxLength?: number;
	readonly occurrenceHighlights?: boolean;
}

/** Owns textual matches for non-empty editor selections. */
export class SelectionHighlighter extends Disposable {
	public static readonly ID = 'editor.contrib.selectionHighlighter';

	private readonly enabled: boolean;
	private readonly multiline: boolean;
	private readonly maxLength: number;
	private readonly occurrenceHighlights: boolean;
	private readonly languageId: string;
	private readonly languageFeaturesService: ILanguageFeaturesService;
	private readonly model: TextModel;
	private lastKey = '';

	constructor(
		private readonly editor: ICodeEditor,
		private readonly decorations: TextDecorationCollection<boolean>,
		options: SelectionHighlighterOptions,
	) {
		super();
		this.model = validateSelectionHighlighter(editor, decorations, options);
		this.enabled = options.enabled ?? true;
		this.multiline = options.multiline ?? false;
		this.maxLength = options.maxLength ?? 200;
		this.occurrenceHighlights = options.occurrenceHighlights ?? true;
		this.languageId = options.languageId;
		this.languageFeaturesService = options.languageFeaturesService;
		this._register(editor.onDidChangeCursorSelection(() => this.update()));
		this._register(this.model.onDidChangeContent(() => this.update()));
		this.update();
	}

	public override dispose(): void {
		if (this.isDisposed) return;
		this.decorations.clear();
		this.lastKey = '';
		super.dispose();
	}

	private update(): void {
		const ranges = this.findRanges();
		const hasSemanticHighlights = this.occurrenceHighlights && this.languageFeaturesService.documentHighlightProvider.has(this.model);
		const key = `${hasSemanticHighlights}:${ranges.map(range => `${this.model.offsetAt(range.getStartPosition())}-${this.model.offsetAt(range.getEndPosition())}`).join(',')}`;
		if (key === this.lastKey) return;
		this.lastKey = key;
		this.decorations.replaceAll(ranges.map(range => ({
			range,
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: {
				description: hasSemanticHighlights ? 'selection-highlight' : 'selection-highlight-overview',
				className: 'selection-highlight',
			},
			metadata: hasSemanticHighlights,
		})));
	}

	private findRanges(): readonly Range[] {
		if (!this.enabled) return Object.freeze([]);
		const selected = this.editor.getSelections() ?? [];
		if (selected.some(selection => selection.isEmpty())) return Object.freeze([]);
		const source = selected[0]!;
		if (!this.multiline && source.getStartPosition().lineNumber !== source.getEndPosition().lineNumber) return Object.freeze([]);
		const text = this.model.getTextInRange(source);
		if (!text || /^\s+$/u.test(text) || (this.maxLength > 0 && text.length > this.maxLength)) return Object.freeze([]);
		if (!selectionsContainSameText(this.model, selected, text)) return Object.freeze([]);
		const word = this.model.getWordAtPosition(source.getStartPosition());
		const wholeWord = word !== null && source.startLineNumber === source.endLineNumber && source.startColumn === word.startColumn && source.endColumn === word.endColumn;
		const matches = this.model.findMatches(text, true, false, true, wholeWord ? USUAL_WORD_SEPARATORS : null, false, MAX_SELECTION_HIGHLIGHTS);
		return Object.freeze(matches.flatMap(match => {
			if (selected.some(selection => rangesIntersect(this.model, match.range, selection))) return [];
			return [match.range];
		}));
	}
}

function validateSelectionHighlighter(editor: ICodeEditor, decorations: TextDecorationCollection<boolean>, options: SelectionHighlighterOptions): TextModel {
	const model = editor.getModel();
	if (!model || model !== decorations.textModel) throw new TypeError('Selection highlighter dependencies must share one text model');
	if (!options || typeof options !== 'object' || !options.languageId || !options.languageFeaturesService) throw new TypeError('Selection highlighter requires language services');
	if (options.enabled !== undefined && typeof options.enabled !== 'boolean') throw new TypeError('Selection highlighter enabled option must be boolean');
	if (options.multiline !== undefined && typeof options.multiline !== 'boolean') throw new TypeError('Selection highlighter multiline option must be boolean');
	if (options.occurrenceHighlights !== undefined && typeof options.occurrenceHighlights !== 'boolean') throw new TypeError('Selection highlighter semantic option must be boolean');
	if (options.maxLength !== undefined && (!Number.isSafeInteger(options.maxLength) || options.maxLength < 0)) throw new RangeError('Selection highlighter maximum length must be a non-negative integer');
	return decorations.textModel;
}

function selectionsContainSameText(model: TextModel, selections: readonly Selection[], text: string): boolean {
	return selections.every(selection => model.getTextInRange(selection) === text);
}

function rangesIntersect(model: TextModel, left: Range, right: Range): boolean {
	const leftStart = model.offsetAt(left.getStartPosition());
	const leftEnd = model.offsetAt(left.getEndPosition());
	const rightStart = model.offsetAt(right.getStartPosition());
	const rightEnd = model.offsetAt(right.getEndPosition());
	return leftStart < rightEnd && rightStart < leftEnd;
}

class InsertCursorAbove extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.insertCursorAbove',
			label: localize2('multicursor.AddCursorAbove', 'Add Cursor Above'),
			precondition: undefined,
			kbOpts: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.UpArrow, weight: KeybindingWeight.EditorContrib, linux: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.UpArrow } },
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const viewModel = editor._getViewModel();
		if (!viewModel) {
			return;
		}
		viewModel.setCursorStates(this.id, CursorChangeReason.Explicit, CursorMoveCommands.addCursorUp(viewModel, viewModel.getCursorStates(), false));
		editor.revealRange(Range.fromPositions(viewModel.getPrimaryCursorState().modelState.position));
	}
}

class InsertCursorBelow extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.insertCursorBelow',
			label: localize2('multicursor.AddCursorBelow', 'Add Cursor Below'),
			precondition: undefined,
			kbOpts: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.DownArrow, weight: KeybindingWeight.EditorContrib, linux: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.DownArrow } },
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const viewModel = editor._getViewModel();
		if (!viewModel) {
			return;
		}
		viewModel.setCursorStates(this.id, CursorChangeReason.Explicit, CursorMoveCommands.addCursorDown(viewModel, viewModel.getCursorStates(), false));
		editor.revealRange(Range.fromPositions(viewModel.getPrimaryCursorState().modelState.position));
	}
}

class InsertCursorAtEndOfEachLineSelected extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.insertCursorAtEndOfEachLineSelected',
			label: localize2('multicursor.AddCursorstoLineEnds', 'Add Cursors to Line Ends'),
			precondition: undefined,
			kbOpts: { primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KeyI, weight: KeybindingWeight.EditorContrib },
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const viewModel = editor._getViewModel();
		if (!viewModel) {
			return;
		}
		viewModel.setSelections(this.id, addCursorsToSelectedLineEnds(viewModel.model, viewModel.getSelections()), CursorChangeReason.Explicit);
		editor.revealRange(Range.fromPositions(viewModel.getPrimaryCursorState().modelState.position));
	}
}

class AddSelectionToNextFindMatchAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.addSelectionToNextFindMatch',
			label: localize2('multicursor.AddNextOccurrence', 'Add Next Occurrence'),
			precondition: undefined,
			kbOpts: { primary: KeyMod.CtrlCmd | KeyCode.KeyD, weight: KeybindingWeight.EditorContrib },
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const viewModel = editor._getViewModel();
		if (!viewModel) {
			return;
		}
		viewModel.setSelections(this.id, addOccurrenceSelection(viewModel.model, viewModel.getSelections(), EditorOccurrenceDirection.Next), CursorChangeReason.Explicit);
		editor.revealRange(Range.fromPositions(viewModel.getPrimaryCursorState().modelState.position));
	}
}

class SelectHighlightsAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.selectHighlights',
			label: localize2('multicursor.SelectAllOccurrences', 'Select All Occurrences'),
			precondition: undefined,
			kbOpts: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL, weight: KeybindingWeight.EditorContrib },
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const viewModel = editor._getViewModel();
		if (!viewModel) {
			return;
		}
		viewModel.setSelections(this.id, selectAllOccurrences(viewModel.model, viewModel.getSelections()), CursorChangeReason.Explicit);
		editor.revealRange(Range.fromPositions(viewModel.getPrimaryCursorState().modelState.position));
	}
}

const insertAbove = registerEditorAction(InsertCursorAbove);
const insertBelow = registerEditorAction(InsertCursorBelow);
const insertLineEnds = registerEditorAction(InsertCursorAtEndOfEachLineSelected);
const selectNext = registerEditorAction(AddSelectionToNextFindMatchAction);
const selectAll = registerEditorAction(SelectHighlightsAction);

registerEditorContribution({ id: "editor.contrib.multicursor", install: context => {
	if (context.kind !== "text") return;
	context.register(context.editor.onKeyDown(event => {
		if (event.browserEvent.defaultPrevented || event.isComposing || event.browserEvent.getModifierState('AltGraph')) return;
		let action: EditorAction | undefined;
		const direction = resolveStanzaAdjacentCursorDirection(event, operatingSystem);
		if (direction) action = direction === 'up' ? insertAbove : insertBelow;
		else if (event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'i') action = insertLineEnds;
		else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd') action = selectNext;
		else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'l') action = selectAll;
		if (!action) return;
		if (action === insertLineEnds && !context.viewModel.getSelections().some(selection => !selection.isEmpty())) return;
		event.stop();
		context.editor.invokeWithinContext(accessor => action.run(accessor, context.editor, {}));
	}));
} });

registerEditorContribution({ id: SelectionHighlighter.ID, install: context => {
	if (context.kind !== "text") return;
	const decorations = context.register(new TextDecorationCollection<boolean>(context.model));
	if (!context.model.largeFile.tooLargeForTokenization) {
		return new SelectionHighlighter(
			context.editor,
			decorations,
			{
				languageId: context.languageId,
				languageFeaturesService: context.languageFeaturesService,
				enabled: context.options.selectionHighlight,
				multiline: context.options.selectionHighlightMultiline,
				maxLength: context.options.selectionHighlightMaxLength,
				occurrenceHighlights: context.options.occurrencesHighlight !== "off",
			},
		);
	}
} });

/** Replaces non-empty selections with one caret at each selected physical line end. */
function addCursorsToSelectedLineEnds(model: ITextModel, selections: readonly Selection[]): readonly Selection[] {
	const next: Selection[] = [];
	for (const selection of selections) {
		if (selection.isEmpty()) continue;
		for (let lineNumber = selection.startLineNumber; lineNumber < selection.endLineNumber; lineNumber += 1) {
			appendUniqueCaret(next, new Position(lineNumber, model.getLineMaxColumn(lineNumber)));
		}
		if (selection.endColumn > 1) appendUniqueCaret(next, selection.getEndPosition());
	}
	return next.length === 0 ? selections : Object.freeze(next);
}

function appendUniqueCaret(selections: Selection[], position: Position): void {
	if (!selections.some(selection => selection.isEmpty() && selection.getPosition().equals(position))) selections.push(Selection.fromPositions(position));
}

/** Resolves the non-conflicting VS Code add-cursor chord for a host platform. */
export function resolveStanzaAdjacentCursorDirection(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>, targetOperatingSystem: OperatingSystem): 'up' | 'down' | undefined {
	const direction = event.key === "ArrowUp"
		? 'up'
		: event.key === "ArrowDown"
			? 'down'
			: undefined;
	if (!direction) return undefined;
	if (targetOperatingSystem === OperatingSystem.Macintosh) {
		return event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey ? direction : undefined;
	}
	if (targetOperatingSystem === OperatingSystem.Windows) {
		return event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey ? direction : undefined;
	}
	return event.ctrlKey && event.shiftKey && event.altKey && !event.metaKey ? direction : undefined;
}
