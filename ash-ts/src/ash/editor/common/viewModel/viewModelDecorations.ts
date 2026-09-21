import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Range } from '../core/range.js';
import { IEditorConfiguration } from '../config/editorConfiguration.js';
import { ITextModel } from '../model.js';
import { IViewModelLines } from './viewModelLines.js';
import { ViewModelDecoration } from './viewModelDecoration.js';
import { IViewDecorationsCollection, IInlineModelDecorationsComputerContext, InlineModelDecorationsComputer } from './inlineDecorations.js';
import { ICoordinatesConverter } from '../coordinatesConverter.js';
import { EditorOption, filterFontDecorations, filterValidationDecorations } from '../config/editorOptions.js';

export class ViewModelDecorations extends Disposable {

	private readonly editorId: number;
	private readonly configuration: IEditorConfiguration;
	private readonly _linesCollection: IViewModelLines;

	private readonly _inlineDecorationsComputer: InlineModelDecorationsComputer;

	private _cachedModelDecorationsResolver: IViewDecorationsCollection | null;
	private _cachedModelDecorationsResolverViewRange: Range | null;

	constructor(editorId: number, model: ITextModel, configuration: IEditorConfiguration, linesCollection: IViewModelLines, coordinatesConverter: ICoordinatesConverter) {
		super();
		this.editorId = editorId;
		this.configuration = configuration;
		this._linesCollection = linesCollection;
		const context: IInlineModelDecorationsComputerContext = {
			getModelDecorations: (viewRange: Range, onlyMinimapDecorations: boolean, onlyMarginDecorations: boolean) => {
				const decorations = this._linesCollection.getDecorationsInRange(viewRange, this.editorId, filterValidationDecorations(this.configuration.options), filterFontDecorations(this.configuration.options), onlyMinimapDecorations, onlyMarginDecorations);
				return this.configuration.options.get(EditorOption.bracketPairColorization).enabled
					? decorations
					: decorations.filter(decoration => decoration.options.description !== 'BracketPairColorization');
			},
		};
		this._inlineDecorationsComputer = new InlineModelDecorationsComputer(context, model, coordinatesConverter);
		this._cachedModelDecorationsResolver = null;
		this._cachedModelDecorationsResolverViewRange = null;
		this._register(toDisposable(() => this.reset()));
		this._register(configuration.onDidChangeFast(event => {
			if (event.hasChanged(EditorOption.bracketPairColorization)) {
				this.reset();
			}
		}));
	}

	private _clearCachedModelDecorationsResolver(): void {
		this._cachedModelDecorationsResolver = null;
		this._cachedModelDecorationsResolverViewRange = null;
	}

	public reset(): void {
		this._inlineDecorationsComputer.reset();
		this._clearCachedModelDecorationsResolver();
	}

	public onModelDecorationsChanged(): void {
		this._inlineDecorationsComputer.onModelDecorationsChanged();
		this._clearCachedModelDecorationsResolver();
	}

	public onLineMappingChanged(): void {
		this._inlineDecorationsComputer.onLineMappingChanged();

		this._clearCachedModelDecorationsResolver();
	}

	public getMinimapDecorationsInRange(range: Range): ViewModelDecoration[] {
		return this._inlineDecorationsComputer.getDecorations(range, true, false).decorations;
	}

	public getDecorationsViewportData(viewRange: Range): IViewDecorationsCollection {
		let cacheIsValid = (this._cachedModelDecorationsResolver !== null);
		cacheIsValid = cacheIsValid && (viewRange.equalsRange(this._cachedModelDecorationsResolverViewRange));
		if (!cacheIsValid) {
			this._cachedModelDecorationsResolver = this._inlineDecorationsComputer.getDecorations(viewRange, false, false);
			this._cachedModelDecorationsResolverViewRange = viewRange;
		}
		return this._cachedModelDecorationsResolver!;
	}

	public getDecorationsOnLine(lineNumber: number, onlyMinimapDecorations: boolean = false, onlyMarginDecorations: boolean = false): IViewDecorationsCollection {
		const range = new Range(lineNumber, this._linesCollection.getViewLineMinColumn(lineNumber), lineNumber, this._linesCollection.getViewLineMaxColumn(lineNumber));
		return this._inlineDecorationsComputer.getDecorations(range, onlyMinimapDecorations, onlyMarginDecorations);
	}
}
