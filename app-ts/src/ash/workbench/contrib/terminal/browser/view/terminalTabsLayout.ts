import { SplitView, type ISplitViewView } from "../../../../../base/browser/ui/splitview/splitview.js";
import { h } from "../../../../../base/browser/dom.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";

const TerminalTabsListSizes = {
	narrow: 46,
	wideMinimum: 80,
	default: 120,
	midpoint: 63,
	maximum: 500,
} as const;
const MIN_TERMINAL_WIDTH = 120;
const TERMINAL_VIEW_INDEX = 0;
const TABS_VIEW_INDEX = 1;

/** Owns the VS Code-style horizontal split between terminal widgets and their right-side instance list. */
export class TerminalTabsLayout extends Disposable {
	readonly element: HTMLElement;
	private readonly splitView: SplitView;
	private readonly tabsElement: HTMLElement;
	private snapping = false;

	constructor(widgetsElement: HTMLElement, tabsElement: HTMLElement) {
		super();
		this.tabsElement = tabsElement;
		const host = h(widgetsElement.ownerDocument, "div");
		this.splitView = this._register(new SplitView(host, "horizontal"));
		this.element = this.splitView.element;
		this.element.classList.add("ash-terminal-tabs-layout");
		this.splitView.addView(splitViewItem(widgetsElement, MIN_TERMINAL_WIDTH, Number.POSITIVE_INFINITY, "high"), { type: "distribute" });
		this.splitView.addView(splitViewItem(tabsElement, TerminalTabsListSizes.narrow, TerminalTabsListSizes.maximum, "low"), TerminalTabsListSizes.default);
		this.splitView.getSash(TERMINAL_VIEW_INDEX)?.element.setAttribute("aria-label", "Resize terminal instance list");
		this._register(this.splitView.onDidChangeViewSizes(() => this.updateTabsWidth()));
		this.updateTabsWidth();
	}

	layout(width: number, height: number): void {
		this.splitView.layout(width, height);
		this.updateTabsWidth();
	}

	setInstanceListPresentation(presentation: "hidden" | "visible"): void {
		this.splitView.setViewVisible(TABS_VIEW_INDEX, presentation === "visible");
	}

	private updateTabsWidth(): void {
		if (this.snapping || !this.splitView.isViewVisible(TABS_VIEW_INDEX)) return;
		const width = this.splitView.getViewSize(TABS_VIEW_INDEX);
		const snappedWidth = width < TerminalTabsListSizes.midpoint
			? TerminalTabsListSizes.narrow
			: width < TerminalTabsListSizes.wideMinimum
				? TerminalTabsListSizes.wideMinimum
				: width;
		if (snappedWidth !== width) {
			this.snapping = true;
			this.splitView.resizeView(TABS_VIEW_INDEX, snappedWidth);
			this.snapping = false;
		}
		this.updateTabsPresentation(snappedWidth);
	}

	private updateTabsPresentation(width: number): void {
		this.tabsElement.classList.toggle("ash-terminal-tabs-narrow", width < TerminalTabsListSizes.midpoint);
	}
}

function splitViewItem(element: HTMLElement, minimumSize: number, maximumSize: number, priority: "high" | "low"): ISplitViewView {
	return {
		element,
		minimumSize,
		maximumSize,
		priority,
		layout() {},
	};
}
