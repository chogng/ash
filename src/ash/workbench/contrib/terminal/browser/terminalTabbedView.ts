import type { Event } from '../../../../base/common/event.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalTabList, TerminalTabsListSizes } from './terminalTabsList.js';
import { localize } from '../../../../nls.js';
import { ITerminalService } from './terminal.js';
import { SplitView, type ISplitViewView } from "../../../../base/browser/ui/splitview/splitview.js";
import { h } from "../../../../base/browser/dom.js";
import { Disposable } from "../../../../base/common/lifecycle.js";

const MIN_TERMINAL_WIDTH = 120;
const TERMINAL_VIEW_INDEX = 0;
const TABS_VIEW_INDEX = 1;

/** Owns the split geometry beside persistent screens; the terminal list owns row interactions. */
export class TerminalTabbedView extends Disposable {
	readonly element: HTMLElement;
	private readonly splitView: SplitView;
	private readonly tabList: TerminalTabList;
	readonly onDidFocusInstance: Event<void>;
	readonly terminalContainer: HTMLDivElement;
	private snapping = false;

	constructor(parentElement: HTMLElement, @ITerminalService private readonly terminalService: ITerminalService, @IInstantiationService instantiation: IInstantiationService) {
		super();
		this.tabList = this._register(instantiation.createInstance(TerminalTabList, parentElement));
		this.onDidFocusInstance = this.tabList.onDidFocusInstance;
		this.terminalContainer = h(parentElement.ownerDocument, 'div');
		this.terminalContainer.className = 'ash-terminal-widgets';
		const host = h(parentElement.ownerDocument, 'div');
		this.splitView = this._register(new SplitView(host, "horizontal"));
		this.element = this.splitView.element;
		this.element.classList.add("ash-terminal-tabs-layout");
		this.splitView.addView(splitViewItem(this.terminalContainer, MIN_TERMINAL_WIDTH, Number.POSITIVE_INFINITY, "high"), { type: "distribute" });
		this.splitView.addView(splitViewItem(this.tabList.element, TerminalTabsListSizes.NarrowViewWidth, TerminalTabsListSizes.MaximumWidth, "low"), TerminalTabsListSizes.DefaultWidth);
		this.splitView.getSash(TERMINAL_VIEW_INDEX)?.element.setAttribute("aria-label", localize('terminal.tabs.resize', 'Resize terminal instance list'));
		this._register(this.splitView.onDidChangeViewSizes(() => this.updateTabsWidth()));
		parentElement.append(this.element);
		this._register(terminalService.onDidChangeInstances(() => this.updateVisibility()));
		this.updateVisibility();
		this.updateTabsWidth();
	}

	layout(width: number, height: number): void {
		this.splitView.layout(width, height);
		this.updateTabsWidth();
	}

	private updateVisibility(): void {
		this.splitView.setViewVisible(TABS_VIEW_INDEX, this.terminalService.instances.length > 1);
	}

	private updateTabsWidth(): void {
		if (this.snapping || !this.splitView.isViewVisible(TABS_VIEW_INDEX)) return;
		const width = this.splitView.getViewSize(TABS_VIEW_INDEX);
		const snappedWidth = width < TerminalTabsListSizes.MidpointViewWidth
			? TerminalTabsListSizes.NarrowViewWidth
			: width < TerminalTabsListSizes.WideViewMinimumWidth
				? TerminalTabsListSizes.WideViewMinimumWidth
				: width;
		if (snappedWidth !== width) {
			this.snapping = true;
			this.splitView.resizeView(TABS_VIEW_INDEX, snappedWidth);
			this.snapping = false;
		}
		this.updateTabsPresentation(snappedWidth);
	}

	private updateTabsPresentation(width: number): void {
		this.tabList.layout(undefined, width);
	}
}

function splitViewItem(element: HTMLElement, minimumSize: number, maximumSize: number, priority: "high" | "low"): ISplitViewView {
	return {
		element,
		minimumSize,
		maximumSize,
		priority,
		layout() { },
	};
}
