import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { AbstractDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import type { LanguageDocumentSymbol } from '../../../common/languages.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { OutlineModel } from '../../documentSymbols/browser/outlineModel.js';
import type { EditorFoldingModel } from '../../folding/browser/foldingModel.js';
import { computeEditorIndentFoldingRanges } from '../../folding/browser/indentRangeProvider.js';
import { StickyElement, StickyModel, StickyRange } from './stickyScrollElement.js';

export interface IStickyModelProvider extends IDisposable {
	update(token: CancellationToken): Promise<StickyModel | null>;
}

/** Reads scope sources without taking ownership of text or fold state. */
export class StickyModelProvider extends AbstractDisposable implements IStickyModelProvider {
	private request: AbortController | undefined;
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
		const source = this.editor.getOption(EditorOption.stickyScroll).defaultModel;
		const registry = this.languageFeaturesService.documentSymbolProvider;
		let ranges: StickyRange[] | undefined;
		let outlineProviderId: string | undefined;
		if (source === 'outlineModel' && registry.has(model)) {
			const controller = this.request = new AbortController();
			const cancellation = token.onCancellationRequested(() => controller.abort());
			try {
				const outline = await OutlineModel.create(registry, model, controller.signal, this.onError);
				if (!outline) return null;
				const groups = [...outline.children.values()].map(group => {
					const scopes: StickyRange[] = [];
					appendSymbolRanges([...group.children.values()].map(element => element.symbol), scopes);
					const coverage = scopes.reduce((total, range) => total + range.endLineNumber - range.startLineNumber, 0);
					return { id: group.id, ranges: scopes, coverage };
				});
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

function appendSymbolRanges(symbols: readonly LanguageDocumentSymbol[], ranges: StickyRange[]): void {
	for (const symbol of symbols) {
		ranges.push(new StickyRange(symbol.selectionRange.startLineNumber, symbol.range.endLineNumber));
		if (symbol.children) {
			appendSymbolRanges(symbol.children, ranges);
		}
	}
}
