import "./media/breadcrumbscontrol.css";
import { h } from "../../../../base/browser/dom.js";
import { BreadcrumbsItem, BreadcrumbsWidget } from "../../../../base/browser/ui/breadcrumbs/breadcrumbsWidget.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { extUri } from "../../../../base/common/resources.js";
import { localize, onDidChangeNls } from "../../../../nls.js";
import { BreadcrumbsModel, FileElement, SymbolElement } from "./breadcrumbsModel.js";
import type { BreadcrumbsPathMode } from "./breadcrumbs.js";
import type { EditorInput } from "./editorInput.js";

/** Renders the active editor's resource path in one group title. */
export class EditorBreadcrumbsControl extends Disposable {
	readonly domNode: HTMLElement;
	private readonly widget: BreadcrumbsWidget;
	private input: EditorInput | undefined;
	private symbols: readonly SymbolElement[] = [];
	private filePath: BreadcrumbsPathMode = "on";
	private symbolPath: BreadcrumbsPathMode = "on";

	constructor(container: HTMLElement, private readonly onSelect?: (element: FileElement) => void, private readonly onSelectSymbol?: (element: SymbolElement) => void) {
		super();
		this.domNode = h(container.ownerDocument, "nav");
		this.domNode.className = "ash-editor-breadcrumbs empty";
		this.domNode.setAttribute("aria-label", localize('breadcrumbs.editorLabel', "Editor breadcrumbs"));
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.widget = this._register(new BreadcrumbsWidget(this.domNode, 3, undefined, Lxicon.chevronRight, {
			breadcrumbsBackground: undefined,
			breadcrumbsForeground: undefined,
			breadcrumbsHoverForeground: undefined,
			breadcrumbsFocusForeground: undefined,
			breadcrumbsFocusAndSelectionForeground: undefined,
		}));
		this._register(this.widget.onDidSelectItem(event => {
			if (!(event.item instanceof EditorBreadcrumbItem)) {
				return;
			}
			const element = event.item.element;
			if (element instanceof FileElement) {
				this.onSelect?.(element);
			} else {
				this.onSelectSymbol?.(element);
			}
		}));
		this._register(onDidChangeNls(() => {
			this.domNode.setAttribute("aria-label", localize('breadcrumbs.editorLabel', "Editor breadcrumbs"));
		}));
	}

	focus(): boolean {
		if (this.domNode.hidden) return false;
		const item = this.widget.getItems().at(-1);
		if (!item) return false;
		this.widget.setFocused(item);
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
		if (!this.input) {
			this.widget.setItems([]);
			this.domNode.classList.add("empty");
			this.domNode.hidden = true;
			return;
		}
		const files = this.filePath === "off" ? [] : new BreadcrumbsModel(this.input.resource, this.input.label).getElements();
		const visibleFiles = this.filePath === "last" ? files.slice(-1) : files;
		const visibleSymbols = this.symbolPath === "off" ? [] : this.symbolPath === "last" ? this.symbols.slice(-1) : this.symbols;
		const elements = [...visibleFiles, ...visibleSymbols];
		this.widget.setItems(elements.map((element, index) => new EditorBreadcrumbItem(element, index === elements.length - 1)));
		this.domNode.title = this.input.resource.toString();
		// Content emptiness is independent of configuration hiding a nonempty path.
		this.domNode.classList.toggle("empty", elements.length === 0);
		this.domNode.hidden = elements.length === 0;
		this.widget.revealLast();
	}
}

/** Keeps resource and outline identity in Workbench, outside the generic widget. */
class EditorBreadcrumbItem extends BreadcrumbsItem {
	constructor(public readonly element: FileElement | SymbolElement, private readonly current: boolean) {
		super();
	}

	public override dispose(): void {}

	public override equals(other: BreadcrumbsItem): boolean {
		if (!(other instanceof EditorBreadcrumbItem) || this.current !== other.current || this.element.label !== other.element.label) {
			return false;
		}
		if (this.element instanceof FileElement && other.element instanceof FileElement) {
			return extUri.isEqual(this.element.uri, other.element.uri);
		}
		return this.element instanceof SymbolElement && other.element instanceof SymbolElement && this.element.symbol === other.element.symbol;
	}

	public override render(container: HTMLElement): void {
		container.textContent = this.element.label;
		container.title = this.element.label;
		if (this.current) {
			container.classList.add("current");
			container.setAttribute("aria-current", "page");
		}
	}
}
