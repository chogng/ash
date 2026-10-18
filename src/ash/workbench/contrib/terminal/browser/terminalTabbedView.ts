import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalStorageKeys } from '../common/terminalStorageKeys.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import type { Event } from '../../../../base/common/event.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalTabList, TerminalTabsListSizes } from './terminalTabsList.js';
import { localize } from '../../../../nls.js';
import { ITerminalService } from './terminal.js';
import { SplitView, type ISplitViewView } from "../../../../base/browser/ui/splitview/splitview.js";
import { h } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { TerminalContextKeys } from '../common/terminalContextKey.js';

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
	private initialized = false;
	private readonly tabsNarrow;

	constructor(parentElement: HTMLElement, @ITerminalService private readonly terminalService: ITerminalService, @IInstantiationService instantiation: IInstantiationService, @IStorageService private readonly storage: IStorageService, @IContextKeyService contextKeys: IContextKeyService) {
		super();
		this.tabsNarrow = TerminalContextKeys.tabsNarrow.bindTo(contextKeys);
		this._register(toDisposable(() => this.tabsNarrow.reset()));
		this.tabList = this._register(instantiation.createInstance(TerminalTabList, parentElement));
		this.onDidFocusInstance = this.tabList.onDidFocusInstance;
		this.terminalContainer = h(parentElement.ownerDocument, 'div');
		this.terminalContainer.className = 'ash-terminal-widgets';
		const host = h(parentElement.ownerDocument, 'div');
		this.splitView = this._register(new SplitView(host, "horizontal"));
		this.element = this.splitView.element;
		this.element.classList.add("ash-terminal-tabs-layout");
		this.splitView.addView(splitViewItem(this.terminalContainer, MIN_TERMINAL_WIDTH, Number.POSITIVE_INFINITY, "high"), { type: "distribute" });
		this.splitView.addView(splitViewItem(this.tabList.element, TerminalTabsListSizes.NarrowViewWidth, TerminalTabsListSizes.MaximumWidth, "low"), this.savedTabsWidth());
		this.splitView.getSash(TERMINAL_VIEW_INDEX)?.element.setAttribute("aria-label", localize('terminal.tabs.resize', 'Resize terminal instance list'));
		this._register(this.splitView.onDidChangeViewSizes(() => this.updateTabsWidth()));
		parentElement.append(this.element);
		this._register(terminalService.onDidChangeInstances(() => this.updateVisibility()));
		this.updateVisibility();
		this.updateTabsWidth();
		this.initialized = true;
	}

	layout(width: number, height: number): void {
		// Hidden panels report zero bounds; do not shrink and persist the user's tab width.
		if (width <= 0 || height <= 0) return;
		this.splitView.layout(width, height);
		this.updateTabsWidth();
	}

	private updateVisibility(): void {
		this.splitView.setViewVisible(TABS_VIEW_INDEX, this.terminalService.instances.filter(instance => instance.target !== TerminalLocation.Editor).length > 1);
		this.updateTabsWidth();
	}

	private updateTabsWidth(): void {
		if (this.snapping) return;
		if (!this.splitView.isViewVisible(TABS_VIEW_INDEX)) {
			this.tabsNarrow.set(false);
			return;
		}
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
		if (this.initialized) this.storage.store(TerminalStorageKeys.TabsListWidthHorizontal, Math.round(snappedWidth), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private savedTabsWidth(): number {
		const width = this.storage.getNumber(TerminalStorageKeys.TabsListWidthHorizontal, StorageScope.WORKSPACE);
		return width !== undefined && Number.isFinite(width) && width >= TerminalTabsListSizes.NarrowViewWidth && width <= TerminalTabsListSizes.MaximumWidth
			? width : TerminalTabsListSizes.DefaultWidth;
	}

	private updateTabsPresentation(width: number): void {
		this.tabList.layout(undefined, width);
		this.tabsNarrow.set(width < TerminalTabsListSizes.MidpointViewWidth);
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
