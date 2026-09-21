import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Range } from '../../core/range.js';
import type { IModelDecoration } from '../../model.js';
import type { DecorationProvider } from '../decorationProvider.js';
import type { TextModel } from '../textModel.js';

/** Computes bracket colors from the model's bracket tree without retaining a second index. */
export class ColorizedBracketPairsDecorationProvider extends Disposable implements DecorationProvider {
	private readonly changes = this._register(new Emitter<void>());
	private activeQueries = 0;
	public readonly onDidChange = this.changes.event;

	constructor(private readonly model: TextModel) {
		super();
		this._register(model.bracketPairs.onDidChange(() => {
			if (this.activeQueries === 0) {
				this.changes.fire();
			}
		}));
		let options = model.getOptions().bracketPairColorizationOptions;
		this._register(model.onDidChangeOptions(() => {
			const next = model.getOptions().bracketPairColorizationOptions;
			if (options.enabled !== next.enabled || options.independentColorPoolPerBracketType !== next.independentColorPoolPerBracketType) {
				options = next;
				this.changes.fire();
			}
		}));
	}

	public getDecorationsInRange(range: Range, ownerId?: number, _filterOutValidation?: boolean, _filterFontDecorations?: boolean, onlyMinimapDecorations = false): IModelDecoration[] {
		const options = this.model.getOptions().bracketPairColorizationOptions;
		if (ownerId === undefined || !options.enabled || onlyMinimapDecorations || this.model.largeFile.tooLargeForTokenization) {
			return [];
		}
		const lines = new Range(range.startLineNumber, 1, range.endLineNumber, this.model.getLineMaxColumn(range.endLineNumber));
		const decorations: IModelDecoration[] = [];
		// Lazily constructing the tree during a query must not invalidate that same query.
		this.activeQueries++;
		let brackets;
		try {
			brackets = this.model.bracketPairs.getBracketsInRange(lines, true).toArray();
		} finally {
			this.activeQueries--;
		}
		for (const bracket of brackets) {
			if (bracket.isInvalid) {
				continue;
			}
			const level = options.independentColorPoolPerBracketType ? bracket.nestingLevelOfEqualBracketType : bracket.nestingLevel;
			decorations.push({
				id: `${this.model.id};bracket${bracket.range.toString()}`,
				ownerId: 0,
				range: bracket.range,
				options: {
					description: 'BracketPairColorization',
					inlineClassName: `stanza-editor-bracket-level-${level % 6 + 1}`,
				},
			});
		}
		return decorations;
	}
}
