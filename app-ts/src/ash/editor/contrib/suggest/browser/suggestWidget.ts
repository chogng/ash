import "./media/suggest.css";
import { Position } from "../../../common/core/position.js";
import { URI } from '../../../../base/common/uri.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import type { ILanguageService } from '../../../common/languages/language.js';
import { getIconClasses } from '../../../common/services/getIconClasses.js';
import { addDisposableListener, fragment as createFragment, h, isElement, reset, stopEvent } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type ICodeEditor } from "../../../browser/editorBrowser.js";
import { LanguageCompletionDetailsStatus, type LanguageCompletionSessionState, SuggestModel } from "./suggestModel.js";
import { LanguageCompletionItemKind } from '../../../common/languages.js';
import { type ViewController } from '../../../browser/view/viewController.js';
import { type View } from "../../../browser/view.js";

let nextCompletionWidgetId = 1;

/** Displays one completion session in Stanza-owned browser UI. */
export class CompletionWidget extends Disposable {
	readonly element: HTMLDivElement;
	private readonly widgetId: string;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly view: ViewController,
		private readonly viewport: View,
		private readonly session: SuggestModel,
		private readonly languageService: ILanguageService,
		container: HTMLElement | undefined = undefined,
	) {
		super();
		try {
			if (
				viewport.textModel !== editor.getModel() ||
				viewport.textModel !== session.textModel
			) {
				throw new TypeError("Stanza completion widget dependencies must share one text model");
			}
		} catch (error) {
			this.dispose();
			throw error;
		}
		this.widgetId = `stanza-completion-${nextCompletionWidgetId++}`;
		const ownerDocument = viewport.domNode.domNode.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.id = this.widgetId;
		this.element.className = "stanza-editor-completion";
		this.element.setAttribute("role", "listbox");
		this.element.hidden = true;
		(container ?? viewport.domNode.domNode).append(this.element);
		this._register(toDisposable(() => {
			this.element.remove();
			this.viewport.setAriaOptions({ activeDescendant: undefined });
		}));
		this._register(session.onDidChange(() => this.render()));
		this._register(viewport.onDidChangeLayout(() => this.position()));
		this._register(addDisposableListener(view.element, "keydown", event => this.handleKeydown(event)));
		this._register(addDisposableListener(view.element, "blur", () => session.cancel()));
		this._register(addDisposableListener(view.element, "compositionstart", () => session.cancel()));
		this._register(addDisposableListener<MouseEvent>(this.element, "mousedown", event => {
			const index = this.readOptionIndex(event);
			if (index === undefined || event.button !== 0) return;
			stopEvent(event);
			session.selectIndex(index);
			this.accept();
		}));
		this.render();
	}

	get visible(): boolean {
		return this.element.classList.contains("visible");
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (
			event.defaultPrevented ||
			event.isComposing ||
			!this.readState() ||
			event.ctrlKey ||
			event.altKey ||
			event.metaKey
		) {
			return;
		}
		switch (event.key) {
			case "ArrowDown":
				stopEvent(event);
				this.session.selectNext();
				return;
			case "ArrowUp":
				stopEvent(event);
				this.session.selectPrevious();
				return;
			case "Enter":
				if (event.shiftKey) return;
				if (this.readState()?.selectedIndex === -1) return;
				stopEvent(event);
				this.accept();
				return;
			case "Tab":
				if (event.shiftKey) return;
				if (this.readState()?.selectedIndex === -1) return;
				stopEvent(event);
				this.accept();
				return;
			case "Escape":
				stopEvent(event);
				this.session.cancel();
				return;
		}
	}

	private accept(): void {
		if (!this.session.acceptSelected()) return;
		const position = this.editor.getPosition();
		if (position) this.viewport.revealPosition(Position.lift(position));
		this.viewport.focus();
	}

	private render(): void {
		const state = this.readState();
		if (!state) {
			reset(this.element);
			this.element.classList.remove("visible");
			this.element.hidden = true;
			this.viewport.setAriaOptions({ activeDescendant: undefined });
			return;
		}
		const ownerDocument = this.element.ownerDocument;
		const fragment = createFragment(ownerDocument);
		for (let index = 0; index < state.items.length; index += 1) {
			const item = state.items[index]!;
			const option = h(ownerDocument, "div");
			const kind = h(ownerDocument, "span");
			const label = h(ownerDocument, "span");
			const detail = h(ownerDocument, "span");
			const documentation = h(ownerDocument, "span");
			const focused = index === state.selectedIndex;
			const resolving = focused && state.detailsStatus === LanguageCompletionDetailsStatus.Loading;
			option.id = `${this.widgetId}-option-${index}`;
			option.className = "stanza-editor-completion-option";
			option.classList.toggle("focused", focused);
			option.classList.toggle("resolving", resolving);
			option.dataset.completionIndex = String(index);
			option.setAttribute("role", "option");
			option.setAttribute("aria-selected", String(focused));
			if (resolving) option.setAttribute("aria-busy", "true");
			kind.className = "stanza-editor-completion-kind";
			kind.setAttribute("aria-hidden", "true");
			kind.textContent = completionKindLabel(item.kind);
			if (item.kind === LanguageCompletionItemKind.File || item.kind === LanguageCompletionItemKind.Folder) {
				const fileKind = item.kind === LanguageCompletionItemKind.File ? FileKind.File : FileKind.Directory;
				const resource = URI.parse(`fake:///${encodeURIComponent(item.label)}`);
				const detail = item.detail ? URI.parse(`fake:///${encodeURIComponent(item.detail)}`) : undefined;
				const labelClasses = getIconClasses(undefined, this.languageService, resource, fileKind);
				const detailClasses = detail ? getIconClasses(undefined, this.languageService, detail, fileKind) : [];
				const iconClasses = fileKind === FileKind.File && detailClasses.length > labelClasses.length
					? detailClasses : labelClasses;
				kind.classList.add('ash-themed-file-icon', ...iconClasses, ...(fileKind === FileKind.Directory ? detailClasses : []));
			}
			label.className = "stanza-editor-completion-label";
			appendHighlightedText(label, item.label, item.labelMatchIndices);
			detail.className = "stanza-editor-completion-detail";
			const detailText = focused ? state.details.detail ?? "" : item.detail ?? "";
			appendHighlightedText(detail, detailText, detailText === item.detail ? item.detailMatchIndices : undefined);
			option.append(kind, label, detail);
			if (focused && state.details.documentation !== undefined) {
				documentation.className = "stanza-editor-completion-documentation";
				documentation.textContent = state.details.documentation;
				option.append(documentation);
			}
			fragment.append(option);
		}
		reset(this.element, fragment);
		this.element.hidden = false;
		this.element.classList.add("visible");
		this.viewport.setAriaOptions({ activeDescendant: state.selectedIndex < 0 ? undefined : `${this.widgetId}-option-${state.selectedIndex}` });
		this.position(state);
	}

	private position(state = this.readState()): void {
		if (!state) return;
		const coordinates = this.viewport.getPositionContentCoordinates(state.position);
		this.element.style.left = `${coordinates.left}px`;
		this.element.style.top = `${coordinates.top + coordinates.height}px`;
	}

	private readState(): LanguageCompletionSessionState | undefined {
		try {
			return this.session.state;
		} catch (error) {
			if (error instanceof ReferenceError) return undefined;
			throw error;
		}
	}

	private readOptionIndex(event: MouseEvent): number | undefined {
		const target = event.target;
		if (!isElement(target)) return undefined;
		const option = target.closest<HTMLElement>(".stanza-editor-completion-option");
		if (!option || !this.element.contains(option)) return undefined;
		const index = Number(option.dataset.completionIndex);
		return Number.isSafeInteger(index) ? index : undefined;
	}
}

function appendHighlightedText(element: HTMLElement, value: string, indices: readonly number[] | undefined): void {
	if (!indices?.length) {
		element.textContent = value;
		return;
	}
	const characters = [...value];
	const matched = new Set(indices);
	for (let index = 0; index < characters.length; index++) {
		const character = characters[index]!;
		if (matched.has(index)) {
			const strong = h(element.ownerDocument, 'strong');
			strong.textContent = character;
			element.append(strong);
		} else {
			element.append(character);
		}
	}
}

function completionKindLabel(kind: LanguageCompletionItemKind): string {
	switch (kind) {
		case LanguageCompletionItemKind.Text: return "Text";
		case LanguageCompletionItemKind.Method: return "Method";
		case LanguageCompletionItemKind.Function: return "Function";
		case LanguageCompletionItemKind.Constructor: return "Constructor";
		case LanguageCompletionItemKind.Field: return "Field";
		case LanguageCompletionItemKind.Variable: return "Variable";
		case LanguageCompletionItemKind.Class: return "Class";
		case LanguageCompletionItemKind.Interface: return "Interface";
		case LanguageCompletionItemKind.Module: return "Module";
		case LanguageCompletionItemKind.Property: return "Property";
		case LanguageCompletionItemKind.Unit: return "Unit";
		case LanguageCompletionItemKind.Value: return "Value";
		case LanguageCompletionItemKind.Enum: return "Enum";
		case LanguageCompletionItemKind.Keyword: return "Keyword";
		case LanguageCompletionItemKind.Snippet: return "Snippet";
		case LanguageCompletionItemKind.File: return "File";
		case LanguageCompletionItemKind.Folder: return "Folder";
		case LanguageCompletionItemKind.Reference: return "Reference";
		case LanguageCompletionItemKind.TypeParameter: return "Type";
	}
}
