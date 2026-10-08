import { TabList, type TabListDropPosition } from '../../../../base/browser/ui/tablist/tabList.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableMap, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { ITerminalService, type ITerminalInstance } from './terminal.js';
import { terminalProfileIcon } from './terminalIcon.js';
import { SplitView, type ISplitViewView } from "../../../../base/browser/ui/splitview/splitview.js";
import { h } from "../../../../base/browser/dom.js";
import { Disposable } from "../../../../base/common/lifecycle.js";

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

/** Owns the terminal list, its selection and drag interactions, and the split beside the screens. */
export class TerminalTabbedView extends Disposable {
	readonly element: HTMLElement;
	private readonly splitView: SplitView;
	private readonly tabList: TabList<ITerminalInstance>;
	private readonly instanceListeners = this._register(new DisposableMap<ITerminalInstance, IDisposable>());
	private readonly focusEmitter = this._register(new Emitter<void>());
	readonly onDidFocusInstance = this.focusEmitter.event;
	readonly terminalContainer: HTMLDivElement;
	private draggedTerminal: ITerminalInstance | undefined;
	private snapping = false;

	constructor(parentElement: HTMLElement, @ITerminalService private readonly terminalService: ITerminalService) {
		super();
		this.tabList = this._register(new TabList(parentElement, {
			ariaLabel: localize('terminal.tabs.instances', 'Terminal instances'),
			orientation: "vertical",
			draggable: true,
			dragAndDrop: {
				canDrop: () => this.draggedTerminal !== undefined,
				onDragStart: (instance) => {
					this.draggedTerminal = instance;
				},
				onDrop: (target, position) => {
					const source = this.draggedTerminal;
					if (source) this.moveTerminalTab(source, target, position);
				},
				onDragEnd: () => {
					this.draggedTerminal = undefined;
				},
			},
			closeActionIcon: Lxicon.trash,
			onActivate: (instance) => {
				this.terminalService.setActiveInstance(instance);
				this.focusEmitter.fire();
			},
			onClose: (instance) => {
				void this.terminalService.closeTerminal(instance).catch(() => { });
			},
		}));
		this.tabList.element.classList.add("ash-terminal-tabs");
		this.terminalContainer = h(parentElement.ownerDocument, 'div');
		this.terminalContainer.className = 'ash-terminal-widgets';
		const host = h(parentElement.ownerDocument, 'div');
		this.splitView = this._register(new SplitView(host, "horizontal"));
		this.element = this.splitView.element;
		this.element.classList.add("ash-terminal-tabs-layout");
		this.splitView.addView(splitViewItem(this.terminalContainer, MIN_TERMINAL_WIDTH, Number.POSITIVE_INFINITY, "high"), { type: "distribute" });
		this.splitView.addView(splitViewItem(this.tabList.element, TerminalTabsListSizes.narrow, TerminalTabsListSizes.maximum, "low"), TerminalTabsListSizes.default);
		this.splitView.getSash(TERMINAL_VIEW_INDEX)?.element.setAttribute("aria-label", localize('terminal.tabs.resize', 'Resize terminal instance list'));
		this._register(this.splitView.onDidChangeViewSizes(() => this.updateTabsWidth()));
		parentElement.append(this.element);
		this._register(terminalService.onDidChangeInstances(() => this.updateTabs()));
		this._register(terminalService.onDidChangeActiveInstance(() => this.updateTabs()));
		this.updateTabs();
		this.updateTabsWidth();
	}

	layout(width: number, height: number): void {
		this.splitView.layout(width, height);
		this.updateTabsWidth();
	}

	private updateTabs(): void {
		for (const instance of this.instanceListeners.keys()) {
			if (!this.terminalService.instances.includes(instance)) this.instanceListeners.deleteAndDispose(instance);
		}
		for (const instance of this.terminalService.instances) {
			if (!this.instanceListeners.has(instance)) {
				this.instanceListeners.set(instance, instance.onDidChangeState(() => this.updateTabs()));
			}
		}
		this.splitView.setViewVisible(TABS_VIEW_INDEX, this.terminalService.instances.length > 1);
		const active = this.terminalService.activeInstance;
		this.tabList.setTabs(this.terminalService.instances.map((instance) => ({
			id: instance.id,
			value: instance,
			label: instance.title,
			tooltip: instance.title,
			icon: terminalProfileIcon(instance.profile),
			state: instance.state,
			tabId: `${instance.id}-tab`,
		})), active?.id);
	}

	private moveTerminalTab(source: ITerminalInstance, target: ITerminalInstance | undefined, position: TabListDropPosition): void {
		if (source === target) return;
		const instances = this.terminalService.instances;
		const sourceIndex = instances.indexOf(source);
		if (sourceIndex < 0) return;
		const targetIndex = target === undefined
			? instances.length
			: instances.indexOf(target);
		const insertionIndex = targetIndex < 0
			? instances.length - 1
			: position === "before" ? targetIndex : targetIndex + 1;
		this.terminalService.moveTerminal(source, insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex);
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
		this.tabList.element.classList.toggle("ash-terminal-tabs-narrow", width < TerminalTabsListSizes.midpoint);
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
