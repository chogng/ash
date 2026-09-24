import "./compositebar.css";
import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import type { ActionViewItem } from "../../../../base/browser/ui/actionbar/actionViewItems.js";
import { ActionBar, type ActionBarDropPosition } from "../../../../base/browser/ui/actionbar/actionbar.js";
import type { IAction } from "../../../../base/common/actions.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { localize, type ILocalizationService } from "../../../services/localization/common/localizationService.js";
import { ViewContainerLocation, type IViewContainerDescriptor } from "../../../common/views.js";
import type { IViewDescriptorService } from "../../../services/views/common/viewDescriptorService.js";
import { CompositeBarAction, CompositeBarActionViewItem, CompositeBarOverflowViewItem } from "./compositeBarActionViewItem.js";
import { h } from "../../../../base/browser/dom.js";
import { observeResize } from "../../../../base/browser/observer.js";

/** Selection of an inactive Composite requested from a CompositeBar. */
export interface CompositeBarSelectionEvent {
	readonly compositeId: string;
}

/** Construction inputs for a location-specific Composite selector. */
export interface CompositeBarOptions {
	readonly viewDescriptorService: IViewDescriptorService;
	readonly localizationService?: ILocalizationService;
	readonly location: ViewContainerLocation;
	readonly ariaLabel: string;
	readonly presentation?: CompositeBarPresentation;
	/** Selects the View Containers represented as Composite Bar action items. */
	readonly containerFilter?: (container: IViewContainerDescriptor) => boolean;
	/** Host-owned menu surface used to reveal label tabs that do not fit. */
	readonly contextMenuProvider?: IContextMenuProvider;
}

/** Visual density selected by the Part hosting a CompositeBar. */
export type CompositeBarPresentation = "icon" | "label";

const OVERFLOW_BUTTON_WIDTH = 24;
const OVERFLOW_ACTION_ID = "ash.compositeBar.overflow";

/**
 * Maps registered workbench Composites onto an ActionBar tablist.
 *
 * Its containing Part owns construction, activation, visibility, and
 * persisted state for the selected Composite.
 */
export class CompositeBar extends Disposable {
	readonly domNode: HTMLElement;
	private readonly viewDescriptorService: IViewDescriptorService;
	private readonly localizationService: ILocalizationService | undefined;
	private readonly location: ViewContainerLocation;
	private readonly actionBar: ActionBar;
	private readonly contextMenuProvider: IContextMenuProvider | undefined;
	private readonly overflowEnabled: boolean;
	private readonly containerFilter: (container: IViewContainerDescriptor) => boolean;
	private readonly _onDidSelectComposite =
		this._register(new Emitter<CompositeBarSelectionEvent>());
	private containers: readonly IViewContainerDescriptor[] = [];
	private readonly tabWidths = new Map<string, number>();
	private actionBarInsetWidth = 0;
	private actionBarItemGap = 0;
	private renderedContainerIds: readonly string[] = [];
	private overflowingContainerIds = new Set<string>();
	private draggedCompositeId: string | undefined;
	private _activeCompositeId: string | undefined;

	readonly onDidSelectComposite: Event<CompositeBarSelectionEvent> =
		this._onDidSelectComposite.event;

	constructor(container: HTMLElement, options: CompositeBarOptions) {
		super();
		const presentation = options.presentation ?? "icon";
		this.viewDescriptorService = options.viewDescriptorService;
		this.localizationService = options.localizationService;
		this.location = options.location;
		this.contextMenuProvider = options.contextMenuProvider;
		this.overflowEnabled = presentation === "label" && this.contextMenuProvider !== undefined;
		this.containerFilter = options.containerFilter ?? (() => true);
		this.domNode = h(container.ownerDocument, "section");
		this.domNode.className = `ash-composite-bar ash-composite-bar-${presentation}`;
		this.domNode.setAttribute("aria-label", options.ariaLabel);
		this.domNode.dataset.viewContainerLocation = options.location;
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.actionBar = this._register(new ActionBar(this.domNode, {
			ariaLabel: options.ariaLabel,
			ariaRole: "tablist",
			actionViewItemProvider: (action): ActionViewItem => {
				if (action instanceof CompositeBarAction) {
					return new CompositeBarActionViewItem(action);
				}
				if (action instanceof CompositeBarOverflowAction) {
					return new CompositeBarOverflowViewItem(
						action,
						() => this.createOverflowActions(),
						this.contextMenuProvider!,
					);
				}
				throw new TypeError(`Unsupported CompositeBar action: ${action.id}`);
			},
			dragAndDrop: {
				canDrop: () => this.draggedCompositeId !== undefined,
				onDragStart: (action, event) => {
					if (action instanceof CompositeBarAction) this.onDragStart(action.id, event);
				},
				onDrop: (action, position) => this.onDrop(action instanceof CompositeBarAction ? action.id : undefined, position),
				onDragEnd: () => {
					this.draggedCompositeId = undefined;
				},
			},
		}));
		this._register(this.viewDescriptorService.onDidChangeViewContainers(() => {
			this.render();
		}));
		this._register(this.viewDescriptorService.onDidChangeViewContainerOrder((location) => {
			if (location === this.location) this.render();
		}));
		if (this.localizationService) this._register(this.localizationService.onDidChange(() => this.render()));
		if (this.overflowEnabled) this._register(observeResize(this.domNode, () => this.layout()));
		this.render();
	}

	get activeCompositeId(): string | undefined {
		return this._activeCompositeId;
	}

	setAriaLabel(label: string): void {
		this.domNode.setAttribute("aria-label", label);
		this.actionBar.element.setAttribute("aria-label", label);
	}

	setActiveComposite(compositeId: string): void {
		const available = this.viewDescriptorService
			.getViewContainers(this.location)
			.some((container) => container.id === compositeId);
		if (!available) {
			throw new Error(`Composite Bar item is not available: ${compositeId}`);
		}
		if (this._activeCompositeId === compositeId) return;
		this._activeCompositeId = compositeId;
		this.render();
	}

	/** Reconciles visible label tabs with the width assigned by the hosting Part. */
	layout(): void {
		if (!this.overflowEnabled || !this.measureTabWidths()) return;
		const availableWidth = this.domNode.clientWidth;
		if (availableWidth <= 0) return;

		const visibleContainers = this.visibleContainersForWidth(availableWidth, OVERFLOW_BUTTON_WIDTH + this.actionBarItemGap);
		const visibleContainerIds = visibleContainers.map((container) => container.id);
		const overflowingContainerIds = new Set(this.containers
			.filter((container) => !visibleContainerIds.includes(container.id))
			.map((container) => container.id));
		const overflowChanged = !sameIds([...this.overflowingContainerIds], [...overflowingContainerIds]);
		this.setOverflowingContainerIds(overflowingContainerIds);
		if (!sameIds(this.renderedContainerIds, visibleContainerIds) || overflowChanged) {
			this.renderTabs(visibleContainers);
		}
	}

	private render(): void {
		const availableContainers = this.viewDescriptorService.getViewContainers(this.location);
		this.containers = availableContainers.filter(this.containerFilter);
		if (
			this._activeCompositeId !== undefined &&
			!availableContainers.some((container) => container.id === this._activeCompositeId)
		) {
			this._activeCompositeId = undefined;
		}
		this.tabWidths.clear();
		this.setOverflowingContainerIds(new Set());
		this.renderTabs(this.containers);
		this.layout();
	}

	private onDragStart(compositeId: string, event: DragEvent): void {
		this.draggedCompositeId = compositeId;
		event.dataTransfer?.setData("text/plain", compositeId);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
	}

	private onDrop(targetCompositeId: string | undefined, position: ActionBarDropPosition): void {
		const sourceCompositeId = this.draggedCompositeId;
		this.draggedCompositeId = undefined;
		if (sourceCompositeId === undefined) return;
		this.viewDescriptorService.moveViewContainer(this.location, sourceCompositeId, targetCompositeId, position);
	}

	private renderTabs(containers: readonly IViewContainerDescriptor[]): void {
		this.renderedContainerIds = containers.map((container) => container.id);
		const showOverflow = this.overflowEnabled && this.overflowingContainerIds.size > 0;
		this.actionBar.setActions([
			...containers.map((container) => {
				const label = localize(this.localizationService, container.localizationKey, container.title);
				return new CompositeBarAction({
					id: container.id,
					label,
					tooltip: label,
					icon: container.icon,
					tabId: compositeTabId(this.location, container.id),
					panelId: compositePanelId(this.location, container.id),
					checked: container.id === this._activeCompositeId,
					onActivate: (compositeId) => {
						if (this._activeCompositeId === compositeId) return;
						this._onDidSelectComposite.fire({ compositeId });
					},
				});
			}),
			...(showOverflow ? [new CompositeBarOverflowAction(localize(this.localizationService, { bundle: "ash.regions", key: "additionalViews" }, "Additional views"))] : []),
		]);
		if (this.renderedContainerIds.includes(this._activeCompositeId ?? "")) {
			this.actionBar.setTabStop(this._activeCompositeId!);
		}
	}

	private measureTabWidths(): boolean {
		const actionBar = this.actionBar.element;
		const tabs = [...actionBar.querySelectorAll<HTMLElement>(":scope > .ash-composite-bar-destination")];
		const tabBounds: DOMRect[] = [];
		let totalTabWidth = 0;
		for (const tab of tabs) {
			const id = tab.dataset.actionId;
			const bounds = tab.getBoundingClientRect();
			const width = bounds.width;
			if (!id || width <= 0) return false;
			this.tabWidths.set(id, width);
			tabBounds.push(bounds);
			totalTabWidth += width;
		}
		const firstTabBounds = tabBounds[0];
		const lastTabBounds = tabBounds.at(-1);
		if (firstTabBounds && lastTabBounds) {
			const actionBarBounds = actionBar.getBoundingClientRect();
			this.actionBarInsetWidth = Math.max(0, firstTabBounds.left - actionBarBounds.left) * 2;
			if (tabBounds.length > 1) {
				const itemSpan = lastTabBounds.right - firstTabBounds.left;
				this.actionBarItemGap = Math.max(0, (itemSpan - totalTabWidth) / (tabBounds.length - 1));
			}
		}
		if (!this.containers.every((container) => this.tabWidths.has(container.id))) {
			return false;
		}
		return true;
	}

	private visibleContainersForWidth(availableWidth: number, overflowWidth: number): readonly IViewContainerDescriptor[] {
		const totalWidth = this.containersWidth(this.containers);
		if (totalWidth <= availableWidth) return this.containers;

		const widthLimit = Math.max(0, availableWidth - overflowWidth);
		const visible: IViewContainerDescriptor[] = [];
		for (const container of this.containers) {
			if (this.containersWidth([...visible, container]) > widthLimit) break;
			visible.push(container);
		}

		const activeCompositeId = this._activeCompositeId;
		if (activeCompositeId && !visible.some((container) => container.id === activeCompositeId)) {
			const activeContainer = this.containers.find((container) => container.id === activeCompositeId);
			if (activeContainer) {
				while (visible.length > 0 && this.containersWidth([...visible, activeContainer]) > widthLimit) visible.pop();
				if (this.containersWidth([...visible, activeContainer]) <= widthLimit) visible.push(activeContainer);
			}
		}
		return visible;
	}

	private containersWidth(containers: readonly IViewContainerDescriptor[]): number {
		return this.actionBarInsetWidth + containers.reduce(
			(total, container, index) => total + this.tabWidths.get(container.id)! + (index > 0 ? this.actionBarItemGap : 0),
			0,
		);
	}

	private createOverflowActions(): readonly IAction[] {
		return this.containers
			.filter((container) => this.overflowingContainerIds.has(container.id))
			.map((container) => {
				const label = localize(this.localizationService, container.localizationKey, container.title);
				return {
					id: `ash.compositeBar.open.${this.location}.${encodeURIComponent(container.id)}`,
					label,
					tooltip: label,
					enabled: true,
					checked: container.id === this._activeCompositeId,
					run: () => {
						if (container.id === this._activeCompositeId) return;
						this._onDidSelectComposite.fire({ compositeId: container.id });
					},
				};
			});
	}

	private setOverflowingContainerIds(ids: Set<string>): void {
		if (sameIds([...this.overflowingContainerIds], [...ids])) return;
		this.overflowingContainerIds = ids;
	}
}

class CompositeBarOverflowAction implements IAction {
	readonly id = OVERFLOW_ACTION_ID;
	readonly label: string;
	readonly tooltip: string;
	readonly icon = lxiconsLibrary.ellipsis;
	readonly enabled = true;

	constructor(label: string) {
		this.label = label;
		this.tooltip = label;
	}

	run(): void {}
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function compositeTabId(
	location: ViewContainerLocation,
	compositeId: string,
): string {
	return `ash-${location}-composite-tab-${encodeURIComponent(compositeId)}`;
}

export function compositePanelId(location: ViewContainerLocation, compositeId: string): string {
	return `ash-${location}-composite-panel-${encodeURIComponent(compositeId)}`;
}
