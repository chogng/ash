import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { AbstractDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import type { TextModel } from '../../../common/model/textModel.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageDocumentSymbol, type LanguageDocumentSymbolProvider } from '../../../common/languages.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import type { EditorFoldingModel } from '../../folding/browser/foldingModel.js';
import { computeEditorIndentFoldingRanges } from '../../folding/browser/indentRangeProvider.js';
import { StickyElement, StickyModel, StickyRange } from './stickyScrollElement.js';

export interface IStickyModelProvider extends IDisposable {
	update(token: CancellationToken): Promise<StickyModel | null>;
}

/** Reads scope sources without taking ownership of text or fold state. */
export class StickyModelProvider extends AbstractDisposable implements IStickyModelProvider {
	private request: AbortController | undefined;
	private readonly providerIds = new WeakMap<LanguageDocumentSymbolProvider, string>();
	private nextProviderId = 0;
	private outlineProviderId: string | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly folding: EditorFoldingModel,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();
	}

	public async update(token: CancellationToken): Promise<StickyModel | null> {
		this.request?.abort();
		if (this.isDisposed || token.isCancellationRequested) {
			return null;
		}
		const model = this.folding.model;
		const version = model.getVersionId();
		if (model.getLineCount() < 2) {
			return new StickyModel(model.uri, version, undefined, undefined);
		}
		const languageId = model.getLanguageId();
		const source = this.editor.getOption(EditorOption.stickyScroll).defaultModel;
		const symbols = this.languageFeaturesService.documentSymbolProvider.ordered(model);
		let ranges: StickyRange[] | undefined;
		let outlineProviderId: string | undefined;
		if (source === 'outlineModel' && symbols.length > 0) {
			const controller = this.request = new AbortController();
			const cancellation = token.onCancellationRequested(() => controller.abort());
			try {
				const request = { ...createLanguageFeatureRequest(model, languageId, controller.signal), resource: model.uri };
				const groups = (await Promise.all(symbols.map(async provider => {
					let id = this.providerIds.get(provider);
					if (id === undefined) {
						id = String(this.nextProviderId++);
						this.providerIds.set(provider, id);
					}
					try {
						const result = await provider.provideDocumentSymbols(request, controller.signal);
						if (!isLanguageFeatureRequestCurrent(request) || result.length === 0) {
							return undefined;
						}
						const ranges: StickyRange[] = [];
						appendSymbolRanges(result, model, ranges);
						const coverage = ranges.reduce((total, range) => total + range.endLineNumber - range.startLineNumber, 0);
						return { id, ranges, coverage };
					} catch (error) {
						if (isLanguageFeatureRequestCurrent(request)) {
							this.onError(error);
						}
						return undefined;
					}
				}))).filter(group => group !== undefined);
				if (!isLanguageFeatureRequestCurrent(request)) {
					return null;
				}
				let selected = groups.find(group => group.id === this.outlineProviderId);
				if (!selected) {
					for (const group of groups) {
						if (!selected || group.coverage > selected.coverage) {
							selected = group;
						}
					}
				}
				ranges = selected?.ranges;
				if (selected) {
					outlineProviderId = groups.length > 1 ? selected.id : this.outlineProviderId;
				}
			} finally {
				cancellation.dispose();
				if (this.request === controller) {
					this.request = undefined;
				}
			}
		}
		if (!ranges) {
			ranges = [];
			const folds = source === 'indentationModel' || !this.editor.getOption(EditorOption.folding) || this.folding.regions.length === 0
				? computeEditorIndentFoldingRanges(model, { tabSize: model.getOptions().tabSize })
				: this.folding.regions;
			for (const fold of folds) {
				ranges.push(new StickyRange(fold.startLineIndex + 1, fold.endLineIndex + 2));
			}
		}
		const root = new StickyElement(undefined, [], undefined);
		const ancestors = [root];
		ranges.sort((left, right) => left.startLineNumber - right.startLineNumber || right.endLineNumber - left.endLineNumber);
		for (const range of ranges) {
			if (range.endLineNumber <= range.startLineNumber + 1) {
				continue;
			}
			while (ancestors.length > 1 && range.startLineNumber >= ancestors.at(-1)!.range!.endLineNumber) {
				ancestors.pop();
			}
			const parent = ancestors.at(-1)!;
			if (parent.range && (range.startLineNumber === parent.range.startLineNumber || range.endLineNumber > parent.range.endLineNumber)) {
				continue;
			}
			const element = new StickyElement(range, [], parent);
			parent.children.push(element);
			ancestors.push(element);
		}
		this.outlineProviderId = outlineProviderId;
		return new StickyModel(model.uri, version, root, outlineProviderId);
	}

	protected override disposeCore(): void {
		this.request?.abort();
	}
}

function appendSymbolRanges(symbols: readonly LanguageDocumentSymbol[], model: TextModel, ranges: StickyRange[]): void {
	for (const symbol of symbols) {
		if (!model.isValidRange(symbol.range) || !model.isValidRange(symbol.selectionRange) || !Range.lift(symbol.range).containsRange(symbol.selectionRange)) {
			throw new RangeError('Sticky scroll symbol range is outside its document scope');
		}
		ranges.push(new StickyRange(symbol.selectionRange.startLineNumber, symbol.range.endLineNumber));
		if (symbol.children) {
			appendSymbolRanges(symbol.children, model, ranges);
		}
	}
}
