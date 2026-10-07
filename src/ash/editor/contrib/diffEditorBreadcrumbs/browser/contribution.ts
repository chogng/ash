import { onUnexpectedExternalError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IReader } from '../../../../base/common/observable.js';
import { LineRange } from '../../../common/core/ranges/lineRange.js';
import { type LanguageDocumentSymbol, type LanguageSymbolKind } from '../../../common/languages.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { HideUnchangedRegionsFeature, type IDiffEditorBreadcrumbsSource } from '../../../browser/widget/diffEditor/features/hideUnchangedRegionsFeature.js';
import { OutlineModel } from '../../documentSymbols/browser/outlineModel.js';

interface BreadcrumbItem {
	readonly name: string;
	readonly kind: LanguageSymbolKind;
	readonly startLineNumber: number;
}

/** Keeps the symbol outline tied to the modified model and current provider set. */
class DiffEditorBreadcrumbsSource extends Disposable implements IDiffEditorBreadcrumbsSource {
	private readonly outline = observableValue<OutlineModel | undefined>(this, undefined);
	private activeRequest: AbortController | undefined;

	constructor(
		private readonly textModel: TextModel,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();
		this._register(textModel.onDidChangeContent(() => this.refresh()));
		this._register(textModel.onDidChangeLanguage(() => this.refresh()));
		this._register(languageFeaturesService.documentSymbolProvider.onDidChange(() => this.refresh()));
		this._register(textModel.onWillDispose(() => this.dispose()));
		this._register(toDisposable(() => this.activeRequest?.abort()));
		this.refresh();
	}

	public getBreadcrumbItems(range: LineRange, reader: IReader): BreadcrumbItem[] {
		const symbols = this.outline.read(reader)?.asListOfDocumentSymbols() ?? [];
		return symbols.filter(symbol => range.contains(symbol.range.startLineNumber) && symbol.range.endLineNumber >= range.endLineNumberExclusive)
			.sort(byWiderRangeFirst)
			.map(toBreadcrumbItem);
	}

	public getAt(lineNumber: number, reader: IReader): BreadcrumbItem[] {
		const symbols = this.outline.read(reader)?.asListOfDocumentSymbols() ?? [];
		return symbols.filter(symbol => symbol.range.startLineNumber <= lineNumber && lineNumber < symbol.range.endLineNumber)
			.sort(byWiderRangeFirst)
			.map(toBreadcrumbItem);
	}

	private refresh(): void {
		this.activeRequest?.abort();
		const request = new AbortController();
		this.activeRequest = request;
		this.outline.set(undefined, undefined);
		void OutlineModel.create(
			this.languageFeaturesService.documentSymbolProvider,
			this.textModel,
			request.signal,
			onUnexpectedExternalError,
		).then(outline => {
			if (!request.signal.aborted && !this.isDisposed) this.outline.set(outline ?? undefined, undefined);
		}, error => {
			if (!request.signal.aborted && !this.isDisposed) onUnexpectedExternalError(error);
		});
	}
}

function byWiderRangeFirst(left: LanguageDocumentSymbol, right: LanguageDocumentSymbol): number {
	return (right.range.endLineNumber - right.range.startLineNumber) - (left.range.endLineNumber - left.range.startLineNumber);
}

function toBreadcrumbItem(symbol: LanguageDocumentSymbol): BreadcrumbItem {
	return { name: symbol.name, kind: symbol.kind, startLineNumber: symbol.range.startLineNumber };
}

HideUnchangedRegionsFeature.setBreadcrumbsSourceFactory((textModel, instantiationService) =>
	instantiationService.createInstance(DiffEditorBreadcrumbsSource, textModel));
