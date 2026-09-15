import { registerEditorContribution } from '../../../browser/editorExtensions.js';
import { MultiCursorController } from './multiCursorController.js';
import { OccurrenceSelectionController } from './occurrenceSelectionController.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type Selection } from '../../../common/core/selection.js';
import { type Range } from '../../../common/core/range.js';
import { USUAL_WORD_SEPARATORS } from '../../../common/core/wordHelper.js';
import { TextDecorationCollection } from '../../../common/model/decorationCollection.js';
import { type TextModel } from '../../../common/model/textModel.js';

import type { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { TrackedRangeStickiness } from '../../../common/model.js';

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

registerEditorContribution({ id: "editor.contrib.multicursor", install: context => {
	if (context.kind !== "text") return;
	context.register(new MultiCursorController(context.controller.element, context.view, context.viewModel));
	context.register(new OccurrenceSelectionController(context.controller.element, context.view, context.viewModel));
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
