import "./media/gotoSymbol.css";
import { addDisposableListener, stopEvent, h } from "../../../../base/browser/dom.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { Selection } from "../../../common/core/selection.js";
import { DocumentSymbolService } from '../../documentSymbols/common/languageDocumentSymbols.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { type LanguageDocumentSymbol } from '../../../common/languages.js';
import { Position } from '../../../common/core/position.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type View } from "../../../browser/view.js";
import { type IViewModel } from '../../../common/viewModel.js';

/** Owns editor-local document-symbol quick navigation (Ctrl/Cmd+Shift+O). */
export class GotoSymbolController extends Disposable {
	private readonly element: HTMLDivElement;
	private readonly queryInput: HTMLInputElement;
	private readonly list: HTMLDivElement;
	private readonly itemListeners = this._register(new DisposableStore());
	private readonly documentSymbols: DocumentSymbolService;
	private request: AbortController | undefined;
	private matches: readonly LanguageSymbolMatch[] = [];

	constructor(
		private readonly input: HTMLElement,
		private readonly viewport: View,
		private readonly viewModel: IViewModel,
		editor: ICodeEditor,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
	) {
		super();
		this.documentSymbols = this._register(new DocumentSymbolService(viewport.textModel, languageFeatures.documentSymbolProvider, { resource: viewport.textModel.uri }));
		if (viewport.textModel !== viewModel.model) throw new TypeError('Stanza goto symbol dependencies must share one text model');
		const ownerDocument = viewport.domNode.domNode.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "stanza-editor-goto-symbol";
		this.element.hidden = true;
		this.element.setAttribute("role", "dialog");
		this.element.setAttribute("aria-label", "Go to Symbol");
		this.queryInput = h(ownerDocument, "input");
		this.queryInput.className = "stanza-editor-goto-symbol-input";
		this.queryInput.type = "search";
		this.queryInput.placeholder = "Type a symbol name";
		this.queryInput.setAttribute("aria-label", "Symbol query");
		this.list = h(ownerDocument, "div");
		this.list.className = "stanza-editor-goto-symbol-list";
		this.list.setAttribute("role", "listbox");
		this.element.append(this.queryInput, this.list);
		viewport.domNode.domNode.append(this.element);
		this._register(toDisposable(() => {
			this.request?.abort();
			this.element.remove();
		}));
		this._register(addDisposableListener(input, "keydown", event => {
			if (event.defaultPrevented || event.isComposing || event.altKey || !event.shiftKey || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== "o") return;
			stopEvent(event);
			this.open();
		}));
		this._register(addDisposableListener(this.element, "keydown", event => {
			if (event.key !== "Escape") return;
			stopEvent(event);
			this.close();
		}));
		this._register(addDisposableListener(this.queryInput, "input", () => void this.refresh()));
		this._register(viewport.onDidChangeLayout(() => this.position()));
		this._register(viewport.textModel.onDidChangeContent(() => this.close(false)));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.close(false)));
		this._register(viewport.textModel.onWillDispose(() => this.close(false)));
		this._register(languageFeatures.documentSymbolProvider.onDidChange(() => this.close(false)));
		this._register(editor.onDidChangeCursorSelection(() => this.close(false)));
		this._register(editor.onDidBlurEditorWidget(() => this.close(false)));
	}

	private open(): void {
		this.element.hidden = false;
		this.queryInput.value = "";
		this.position();
		this.queryInput.focus({ preventScroll: true });
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		this.request?.abort();
		const request = this.request = new AbortController();
		try {
			const matches = await this.query(this.queryInput.value, request.signal);
			if (!request.signal.aborted && this.request === request) {
				this.matches = matches;
				this.render();
			}
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	private async query(query: string, signal: AbortSignal): Promise<readonly LanguageSymbolMatch[]> {
		const symbols = await this.documentSymbols.provideDocumentSymbols(this.viewport.textModel.getLanguageId(), signal);
		const normalizedQuery = query.trim().toLocaleLowerCase();
		const matches: LanguageSymbolMatch[] = [];
		for (const symbol of flattenSymbols(symbols)) {
			const score = symbol.name.toLocaleLowerCase().includes(normalizedQuery) ? symbol.name.toLocaleLowerCase() === normalizedQuery ? 2 : 1 : 0;
			if (normalizedQuery.length > 0 && score === 0) continue;
			matches.push(Object.freeze({ symbol, position: symbol.selectionRange.getStartPosition(), score }));
		}
		matches.sort((left, right) => right.score - left.score || Position.compare(left.position, right.position));
		return Object.freeze(matches);
	}

	private render(): void {
		this.itemListeners.clear();
		this.list.replaceChildren(...this.matches.map((match, index) => {
			const item = h(this.list.ownerDocument, "button");
			item.className = "stanza-editor-goto-symbol-item";
			item.type = "button";
			item.setAttribute("role", "option");
			item.textContent = match.symbol.detail ? `${match.symbol.name} — ${match.symbol.detail}` : match.symbol.name;
			item.tabIndex = index === 0 ? 0 : -1;
			this.itemListeners.add(addDisposableListener(item, "click", () => this.select(match)));
			return item;
		}));
	}

	private select(match: LanguageSymbolMatch): void {
		this.viewModel.setSelections('editor.action.gotoSymbol', [
			Selection.fromPositions(match.symbol.selectionRange.getStartPosition(), match.symbol.selectionRange.getEndPosition()),
		]);
		this.viewport.revealPosition(match.position);
		this.close();
	}

	private position(): void {
		if (this.element.hidden) return;
		const layout = this.viewport.viewportLayout;
		this.element.style.left = `${layout.scrollPosition.left + 8}px`;
		this.element.style.top = `${layout.scrollPosition.top + 8}px`;
	}

	private close(focus = true): void {
		this.request?.abort();
		this.request = undefined;
		this.element.hidden = true;
		this.itemListeners.clear();
		this.list.replaceChildren();
		if (focus) this.input.focus({ preventScroll: true });
	}
}

interface LanguageSymbolMatch {
	readonly symbol: LanguageDocumentSymbol;
	readonly position: Position;
	readonly score: number;
}

function flattenSymbols(symbols: readonly LanguageDocumentSymbol[]): readonly LanguageDocumentSymbol[] {
	const result: LanguageDocumentSymbol[] = [];
	const visit = (symbol: LanguageDocumentSymbol): void => {
		result.push(symbol);
		symbol.children?.forEach(visit);
	};
	symbols.forEach(visit);
	return result;
}
