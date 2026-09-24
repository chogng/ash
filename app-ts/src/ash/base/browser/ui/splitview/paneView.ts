import { addDisposableListener, h } from "../../dom.js";
import { trackFocus } from "../../focus.js";
import { appendIcon } from "../icon/icon.js";
import type { Event } from "../../../common/event.js";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";
import { lxiconsLibrary } from "../../../common/lxiconsLibrary.js";

/** Construction inputs for a titled, collapsible pane. */
export interface PaneViewOptions {
	readonly id: string;
	readonly title: string;
	readonly collapsed?: boolean;
	readonly headerActionsVisibility?: PaneViewHeaderActionsVisibility;
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
export class PaneView extends Disposable {
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

	readonly onDidFocus: Event<void>;
	readonly onDidBlur: Event<void>;

	constructor(container: HTMLElement, options: PaneViewOptions) {
		super();
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
		const collapsedIcon = appendIcon(lxiconsLibrary.chevronRight, twistyContainer);
		collapsedIcon.classList.add("ash-pane-view-collapsed-icon");
		const expandedIcon = appendIcon(lxiconsLibrary.chevronDown, twistyContainer);
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
		this.focusTracker = this._register(trackFocus(element));
		this.onDidFocus = this.focusTracker.onDidFocus;
		this.onDidBlur = this.focusTracker.onDidBlur;
	}

	setTitle(title: string): void {
		this.titleElement.textContent = title;
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	setCollapsed(collapsed: boolean): void {
		if (this.collapsed === collapsed) return;
		this.collapsed = collapsed;
		this.renderCollapsedState();
	}

	focus(): void {
		this.element.focus();
	}

	private renderCollapsedState(): void {
		const expanded = !this.collapsed;
		this.element.classList.toggle("collapsed", this.collapsed);
		this.headerButton.classList.toggle("expanded", expanded);
		this.headerButton.setAttribute("aria-expanded", String(expanded));
		this.contentElement.classList.toggle("collapsed", this.collapsed);
		this.contentElement.hidden = this.collapsed;
		this.headerActionsElement.hidden = this.collapsed && this.headerActionsVisibility === "whenExpanded";
	}
}
