import "./media/breadcrumbscontrol.css";
import { h } from "../../../../base/browser/dom.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { BreadcrumbsModel, FileElement, SymbolElement } from "./breadcrumbsModel.js";
import type { BreadcrumbsPathMode } from "./breadcrumbs.js";
import type { EditorInput } from "./editorInput.js";

/** Renders the active editor's resource path in one group title. */
export class EditorBreadcrumbsControl extends Disposable {
	readonly domNode: HTMLElement;
	private readonly items = this._register(new DisposableStore());
	private input: EditorInput | undefined;
	private symbols: readonly SymbolElement[] = [];
	private filePath: BreadcrumbsPathMode = "on";
	private symbolPath: BreadcrumbsPathMode = "on";

	constructor(container: HTMLElement, private readonly onSelect?: (element: FileElement) => void, private readonly onSelectSymbol?: (element: SymbolElement) => void) {
		super();
		this.domNode = h(container.ownerDocument, "nav");
		this.domNode.className = "ash-editor-breadcrumbs";
		this.domNode.setAttribute("aria-label", "Editor breadcrumbs");
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	focus(): boolean {
		if (this.domNode.hidden) return false;
		const item = this.domNode.querySelector<HTMLButtonElement>("button:last-of-type");
		if (!item) return false;
		item.focus();
		return true;
	}

	setInput(input: EditorInput | undefined): void {
		this.input = input;
		this.symbols = [];
		this.render();
	}

	setSymbols(symbols: readonly SymbolElement[]): void {
		this.symbols = symbols;
		this.render();
	}

	setPathModes(filePath: BreadcrumbsPathMode, symbolPath: BreadcrumbsPathMode): void {
		this.filePath = filePath;
		this.symbolPath = symbolPath;
		this.render();
	}

	private render(): void {
		this.items.clear();
		this.domNode.replaceChildren();
		if (!this.input) {
			this.domNode.hidden = true;
			return;
		}
		const files = this.filePath === "off" ? [] : new BreadcrumbsModel(this.input.resource, this.input.label).getElements();
		const visibleFiles = this.filePath === "last" ? files.slice(-1) : files;
		const visibleSymbols = this.symbolPath === "off" ? [] : this.symbolPath === "last" ? this.symbols.slice(-1) : this.symbols;
		const elements = [...visibleFiles, ...visibleSymbols];
		for (const [index, element] of elements.entries()) {
			if (index > 0) {
				const separator = h(this.domNode.ownerDocument, "span");
				separator.className = "ash-editor-breadcrumb-separator";
				separator.setAttribute("aria-hidden", "true");
				separator.textContent = "›";
				this.domNode.append(separator);
			}
			const select = element instanceof FileElement
				? this.onSelect ? () => this.onSelect?.(element) : undefined
				: this.onSelectSymbol ? () => this.onSelectSymbol?.(element) : undefined;
			const item = select
				? this.items.add(new Button(this.domNode, {
					label: element.label,
					onClick: select,
				})).domNode
				: h(this.domNode.ownerDocument, "span");
			item.classList.add("ash-editor-breadcrumb-item");
			if (!select) item.textContent = element.label;
			item.title = element.label;
			if (index === elements.length - 1) {
				item.classList.add("current");
				item.setAttribute("aria-current", "page");
			}
			this.domNode.append(item);
		}
		this.domNode.title = this.input.resource.toString();
		this.domNode.hidden = elements.length === 0;
	}
}
