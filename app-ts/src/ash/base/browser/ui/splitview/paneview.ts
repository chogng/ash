import { addDisposableListener, h } from "../../dom.js";
import { trackFocus } from "../../focus.js";
import { appendIcon } from "../lxicons/lxicon.js";
import { Emitter, type Event } from "../../../common/event.js";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";
import { RunOnceScheduler } from "../../../common/async.js";
import { isReducedMotion, UI_ANIMATION_DURATION } from "../animations/animations.js";
import { Lxicon } from "../../../common/lxicons.js";
import { SplitView, type ISplitViewView } from "./splitview.js";
import "./paneview.css";
import { localize } from "../../../../nls.js";

/** Construction inputs for a titled, collapsible pane. */
export interface IPaneOptions {
	readonly id: string;
	readonly title: string;
	readonly collapsed?: boolean;
	readonly headerActionsVisibility?: PaneViewHeaderActionsVisibility;
	readonly minimumBodySize?: number;
	readonly maximumBodySize?: number;
}

/** Determines whether a pane exposes its title actions while collapsed. */
export type PaneViewHeaderActionsVisibility = "always" | "whenExpanded";

/**
 * Domain-agnostic titled pane that owns its header geometry, collapse state,
 * accessibility semantics, and title interaction.
 *
 * Consumers append domain content to {@link contentElement}, may add a
 * stable root class for their outer presentation, and may project actions
 * through {@link headerActionsElement}. They must not recreate or style the
 * header interaction internals.
 */
export class Pane extends Disposable implements ISplitViewView {
	readonly element: HTMLElement;
	readonly id: string;
	protected readonly headerElement: HTMLDivElement;
	protected readonly headerActionsElement: HTMLDivElement;
	protected readonly contentElement: HTMLDivElement;
	private readonly headerButton: HTMLButtonElement;
	private readonly titleElement: HTMLHeadingElement;
	private readonly focusTracker;
	private readonly headerActionsVisibility: PaneViewHeaderActionsVisibility;
	private collapsed: boolean;
	private isClosing = false;
	private didLayout = false;
	private readonly closeAnimation = this._register(new RunOnceScheduler(() => {
		this.isClosing = false;
		this.renderCollapsedState();
	}, UI_ANIMATION_DURATION.normal));
	private readonly minimumBodySize: number;
	private readonly maximumBodySize: number;
	private readonly change = this._register(new Emitter<number | undefined>());
	readonly onDidChange = this.change.event;
	private readonly expansionChange = this._register(new Emitter<boolean>());
	readonly onDidChangeExpansionState = this.expansionChange.event;

	readonly onDidFocus: Event<void>;
	readonly onDidBlur: Event<void>;

	constructor(container: HTMLElement, options: IPaneOptions) {
		super();
		this.minimumBodySize = options.minimumBodySize ?? 120;
		this.maximumBodySize = options.maximumBodySize ?? Number.POSITIVE_INFINITY;
		if (!Number.isFinite(this.minimumBodySize) || this.minimumBodySize < 0 || this.maximumBodySize < this.minimumBodySize || Number.isNaN(this.maximumBodySize)) {
			throw new RangeError("Invalid pane body size constraints");
		}
		const { id, title } = options;
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "section");
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = "ash-pane-view";
		element.dataset.paneViewId = id;
		element.tabIndex = -1;
		this.id = id;
		this.headerActionsVisibility = options.headerActionsVisibility ?? "always";

		this.headerElement = h(ownerDocument, "div");
		this.headerElement.className = "ash-pane-view-header";
		this.headerButton = h(ownerDocument, "button");
		this.headerButton.className = "ash-pane-view-header-button";
		this.headerButton.type = "button";
		const twistyContainer = h(ownerDocument, "span");
		twistyContainer.className = "ash-pane-view-header-twisty-container";
		twistyContainer.setAttribute("aria-hidden", "true");
		const collapsedIcon = appendIcon(Lxicon.chevronRight, twistyContainer);
		collapsedIcon.classList.add("ash-pane-view-collapsed-icon");
		const expandedIcon = appendIcon(Lxicon.chevronDown, twistyContainer);
		expandedIcon.classList.add("ash-pane-view-expanded-icon");
		this.titleElement = h(ownerDocument, "h3");
		this.titleElement.className = "ash-pane-view-header-title";
		this.titleElement.textContent = title;
		this.headerButton.append(twistyContainer, this.titleElement);
		this.headerActionsElement = h(ownerDocument, "div");
		this.headerActionsElement.className = "ash-pane-view-header-actions";
		this.headerElement.append(this.headerButton, this.headerActionsElement);

		this.contentElement = h(ownerDocument, "div");
		this.contentElement.className = "ash-pane-view-content";
		this.contentElement.id = `ash-pane-view-content-${encodeURIComponent(id)}`;
		this.headerButton.setAttribute("aria-controls", this.contentElement.id);
		element.append(this.headerElement, this.contentElement);
		container.append(element);
		this.collapsed = options.collapsed === true;
		this.renderCollapsedState();
		this._register(addDisposableListener(this.headerButton, "click", () => {
			this.setCollapsed(!this.collapsed);
		}));
		this._register(addDisposableListener(this.headerButton, "keydown", event => {
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			event.preventDefault();
			this.setCollapsed(event.key === "ArrowLeft");
		}));
		this.focusTracker = this._register(trackFocus(element));
		this.onDidFocus = this.focusTracker.onDidFocus;
		this.onDidBlur = this.focusTracker.onDidBlur;
	}

	setTitle(title: string): void {
		this.titleElement.textContent = title;
		if (this.headerElement.hidden) this.element.setAttribute("aria-label", title);
	}

	get paneTitle(): string {
		return this.titleElement.textContent ?? "";
	}

	setHeaderVisible(visible: boolean): void {
		if (visible === this.isHeaderVisible()) return;
		if (!visible && this.headerElement.contains(this.element.ownerDocument.activeElement)) {
			this.focus();
		}
		this.headerElement.hidden = !visible;
		if (visible) this.element.removeAttribute("aria-label");
		else this.element.setAttribute("aria-label", this.paneTitle);
		if (visible) this.setHeaderActionsHost();
		this.change.fire(undefined);
	}

	isHeaderVisible(): boolean {
		return !this.headerElement.hidden;
	}

	get minimumSize(): number {
		return this.headerSize + (this.collapsed ? 0 : this.minimumBodySize);
	}

	get maximumSize(): number {
		return this.headerSize + (this.collapsed ? 0 : this.maximumBodySize);
	}

	private get headerSize(): number {
		return this.isHeaderVisible() ? 28 : 0;
	}

	layout(size: number, _offset: number, orthogonalSize: number): void {
		this.didLayout = true;
		if (!this.collapsed) {
			const bodyHeight = Math.max(0, size - this.headerSize);
			// Keep the body at its allocated size while the outer pane clips the transition.
			this.contentElement.style.height = `${bodyHeight}px`;
			this.layoutBody(bodyHeight, orthogonalSize);
		}
	}

	/** Subclasses lay out content here; the container owns the outer geometry. */
	protected layoutBody(_height: number, _width: number): void {}

	setHeaderActionsHost(host?: HTMLElement): void {
		const focused = this.element.ownerDocument.activeElement;
		const restoreFocus = this.headerActionsElement.contains(focused);
		(host ?? this.headerElement).append(this.headerActionsElement);
		if (restoreFocus) (focused as HTMLElement).focus();
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	setCollapsed(collapsed: boolean): void {
		if (this.collapsed === collapsed) return;
		if (collapsed && this.contentElement.contains(this.element.ownerDocument.activeElement)) {
			if (this.isHeaderVisible()) this.headerButton.focus();
			else this.focus();
		}
		this.collapsed = collapsed;
		this.closeAnimation.cancel();
		this.isClosing = collapsed && this.didLayout && !isReducedMotion(this.element);
		if (this.isClosing) this.closeAnimation.schedule();
		this.renderCollapsedState();
		this.change.fire(collapsed ? this.headerSize : undefined);
		this.expansionChange.fire(!collapsed);
	}

	focus(): void {
		this.element.focus();
	}

	private renderCollapsedState(): void {
		const expanded = !this.collapsed;
		this.element.classList.toggle("collapsed", this.collapsed);
		this.element.classList.toggle("closing", this.isClosing);
		this.headerButton.classList.toggle("expanded", expanded);
		this.headerButton.setAttribute("aria-expanded", String(expanded));
		this.contentElement.classList.toggle("collapsed", this.collapsed && !this.isClosing);
		// Closing content remains painted, but must leave focus and the accessibility tree immediately.
		this.contentElement.inert = this.collapsed;
		this.contentElement.setAttribute("aria-hidden", String(this.collapsed));
		this.contentElement.hidden = this.collapsed && !this.isClosing;
		this.headerActionsElement.hidden = this.collapsed && this.headerActionsVisibility === "whenExpanded";
	}
}

/** A collection of independent panes backed by the shared constrained SplitView. */
export class PaneView extends Disposable {
	readonly element: HTMLElement;
	private readonly splitView: SplitView;
	private readonly panes: Pane[] = [];
	private readonly animationReset = this._register(new RunOnceScheduler(() => {
		this.splitView.element.classList.remove("animated");
	}, UI_ANIMATION_DURATION.normal));
	private height = 0;
	private didLayout = false;
	readonly onDidSashChange: Event<void>;
	readonly onDidSashReset: Event<number>;

	constructor(container: HTMLElement) {
		super();
		this.element = h(container.ownerDocument, "div");
		this.element.className = "ash-pane-view-container";
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this.splitView = this._register(new SplitView(this.element, "vertical"));
		this.onDidSashChange = this.splitView.onDidChangeViewSizes;
		this.onDidSashReset = this.splitView.onDidSashReset;
		this._register(this.onDidSashReset(index => this.splitView.resetSash(index)));
		this._register(addDisposableListener(this.element, "keydown", event => {
			const index = this.panes.findIndex(pane => pane.element.querySelector(".ash-pane-view-header-button") === event.target);
			if (index < 0 || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
			const headers = this.panes.filter(pane => pane.isHeaderVisible());
			const current = headers.indexOf(this.panes[index]!);
			const target = event.key === "Home" ? 0 : event.key === "End" ? headers.length - 1 : Math.max(0, Math.min(headers.length - 1, current + (event.key === "ArrowUp" ? -1 : 1)));
			event.preventDefault();
			headers[target]?.element.querySelector<HTMLButtonElement>(".ash-pane-view-header-button")?.focus();
		}));
		this._register(toDisposable(() => {
			this.panes.length = 0;
		}));
	}

	addPane(pane: Pane, size: number, index = this.panes.length): void {
		if (this.panes.includes(pane)) throw new Error(`Pane is already in this container: ${pane.id}`);
		let wasCollapsed = pane.isCollapsed();
		let expandedSize = size;
		// Pane visibility belongs to its consumer, independently of SplitView geometry.
		this.splitView.addView({
			element: pane.element,
			get minimumSize() { return pane.minimumSize; },
			get maximumSize() { return pane.maximumSize; },
			onDidChange: listener => pane.onDidChange(preferredSize => {
				const collapsed = pane.isCollapsed();
				const requestedSize = wasCollapsed && !collapsed ? expandedSize : preferredSize;
				if (wasCollapsed !== collapsed && this.didLayout && !isReducedMotion(this.element)) {
					this.splitView.element.classList.add("animated");
					this.animationReset.schedule();
				}
				wasCollapsed = collapsed;
				if (this.didLayout) this.updateContentHeight();
				listener(requestedSize);
				this.updateSashLabels();
			}),
			layout: (height, offset, width) => {
				if (!pane.isCollapsed()) expandedSize = height;
				pane.layout(height, offset, width);
			},
		}, size, index);
		this.panes.splice(index, 0, pane);
		if (this.didLayout) this.updateContentHeight();
		this.updateSashLabels();
	}

	/** Removing a pane detaches it; its contribution remains responsible for disposal. */
	removePane(pane: Pane): void {
		const index = this.panes.indexOf(pane);
		if (index < 0) return;
		this.panes.splice(index, 1);
		this.splitView.removeView(index);
		pane.element.remove();
		if (this.didLayout) this.updateContentHeight();
		this.updateSashLabels();
	}

	movePane(from: Pane, to: Pane): void {
		const fromIndex = this.panes.indexOf(from);
		const toIndex = this.panes.indexOf(to);
		if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
		this.panes.splice(fromIndex, 1);
		this.panes.splice(toIndex, 0, from);
		this.splitView.moveView(fromIndex, toIndex);
		this.updateSashLabels();
	}

	resizePane(pane: Pane, size: number): void {
		this.animationReset.cancel();
		this.splitView.element.classList.remove("animated");
		const index = this.panes.indexOf(pane);
		if (index >= 0) this.splitView.resizeView(index, size);
	}

	getPaneSize(pane: Pane): number {
		const index = this.panes.indexOf(pane);
		return index < 0 ? -1 : this.splitView.getViewSize(index);
	}

	layout(height: number, width: number): void {
		this.height = height;
		this.didLayout = true;
		this.animationReset.cancel();
		this.splitView.element.classList.remove("animated");
		this.updateContentHeight();
		// SplitView fits the viewport; its constraints already retain overflowing minimum sizes.
		this.splitView.layout(height, width);
		this.updateSashLabels();
	}

	private updateContentHeight(): void {
		this.splitView.element.style.height = `${Math.max(this.height, this.splitView.minimumSize)}px`;
	}

	private updateSashLabels(): void {
		for (let index = 0; index < this.panes.length - 1; index += 1) {
			const sash = this.splitView.getSash(index);
			if (!sash) continue;
			sash.element.setAttribute("aria-label", localize("paneView.resize", "Resize panes"));
			sash.element.setAttribute("aria-description", localize("paneView.resizeHelp", "Use the arrow keys to resize panes. Double-click to reset their sizes."));
			sash.element.setAttribute("aria-controls", [this.panes[index]!, this.panes[index + 1]!].map(pane => `ash-pane-view-content-${encodeURIComponent(pane.id)}`).join(" "));
		}
	}
}
