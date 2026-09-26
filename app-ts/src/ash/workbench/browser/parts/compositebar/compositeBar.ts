import "./compositebar.css";
import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import type { ActionViewItem } from "../../../../base/browser/ui/actionbar/actionViewItems.js";
import { ActionBar, type ActionBarDropPosition, type ActionBarOrientation } from "../../../../base/browser/ui/actionbar/actionbar.js";
import { Separator, type IAction } from "../../../../base/common/actions.js";
import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { localize, type ILocalizationService } from "../../../services/localization/common/localizationService.js";
import { ViewContainerLocation, type IViewContainerDescriptor } from "../../../common/views.js";
import type { IViewDescriptorService } from "../../../services/views/common/viewDescriptorService.js";
import { CompositeBarAction, CompositeBarActionViewItem, CompositeBarOverflowViewItem } from "./compositeBarActionViewItem.js";
import { h } from "../../../../base/browser/dom.js";
import { observeResize } from "../../../../base/browser/observer.js";
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';

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
	readonly orientation?: ActionBarOrientation;
	/** Selects the View Containers represented as Composite Bar action items. */
	readonly containerFilter?: (container: IViewContainerDescriptor) => boolean;
	/** Host-owned menu surface used to reveal label tabs that do not fit. */
	readonly contextMenuProvider?: IContextMenuProvider;
	readonly storageService?: IStorageService;
}

/** Visual density selected by the Part hosting a CompositeBar. */
export type CompositeBarPresentation = "icon" | "label";

const OVERFLOW_BUTTON_WIDTH = 24;
const OVERFLOW_ACTION_ID = "ash.compositeBar.overflow";
const HIDDEN_VIEW_CONTAINERS_KEY = 'workbench.activityBar.hiddenViewContainers';

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
	private orientation: ActionBarOrientation;
	private readonly actionBar: ActionBar;
	private readonly contextMenuProvider: IContextMenuProvider | undefined;
	private readonly storageService: IStorageService | undefined;
	private readonly overflowEnabled: boolean;
	private readonly containerFilter: (container: IViewContainerDescriptor) => boolean;
	private readonly _onDidSelectComposite =
		this._register(new Emitter<CompositeBarSelectionEvent>());
	private containers: readonly IViewContainerDescriptor[] = [];
	private displayedContainers: readonly IViewContainerDescriptor[] = [];
	private hiddenContainerIds = new Set<string>();
	private readonly tabWidths = new Map<string, number>();
	private readonly badges = new Map<string, { readonly count: number; readonly description: string }>();
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
		this.orientation = options.orientation ?? 'horizontal';
		this.contextMenuProvider = options.contextMenuProvider;
		this.storageService = this.orientation === 'vertical' ? options.storageService : undefined;
		this.hiddenContainerIds = this.readHiddenContainerIds();
		this.overflowEnabled = (presentation === 'label' || this.orientation === 'vertical') && this.contextMenuProvider !== undefined;
		this.containerFilter = options.containerFilter ?? (() => true);
		this.domNode = h(container.ownerDocument, "section");
		this.domNode.className = `ash-composite-bar ash-composite-bar-${presentation}`;
		this.domNode.classList.toggle('ash-composite-bar-vertical', options.orientation === 'vertical');
		this.domNode.classList.toggle('ash-composite-bar-horizontal', options.orientation !== 'vertical');
		this.domNode.setAttribute("aria-label", options.ariaLabel);
		this.domNode.dataset.viewContainerLocation = options.location;
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.actionBar = this._register(new ActionBar(this.domNode, {
			ariaLabel: options.ariaLabel,
			ariaRole: "tablist",
			orientation: options.orientation,
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
		if (this.storageService) this._register(this.storageService.onDidChangeValue(event => {
			if (event.key !== HIDDEN_VIEW_CONTAINERS_KEY || event.scope !== StorageScope.PROFILE || !event.external) return;
			this.hiddenContainerIds = this.readHiddenContainerIds();
			this.render();
		}));
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

	setBadge(containerId: string, count: number | undefined, description?: string): void {
		if (count === undefined) this.badges.delete(containerId);
		else this.badges.set(containerId, { count, description: description ?? String(count) });
		this.render();
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

	setOrientation(orientation: ActionBarOrientation): void {
		if (this.orientation === orientation) return;
		this.orientation = orientation;
		this.domNode.classList.toggle('ash-composite-bar-vertical', orientation === 'vertical');
		this.domNode.classList.toggle('ash-composite-bar-horizontal', orientation === 'horizontal');
		this.actionBar.setOrientation(orientation);
		this.render();
	}

	showContextMenu(event: MouseEvent | KeyboardEvent, additionalActions: readonly IAction[] = []): void {
		if (!this.contextMenuProvider) return;
		event.preventDefault();
		event.stopPropagation();
		const target = event.target && 'closest' in event.target ? (event.target as Element).closest<HTMLElement>('.ash-composite-bar-destination') : null;
		const containerId = target && this.domNode.contains(target) ? target.dataset.actionId : undefined;
		const anchor = event.type === 'contextmenu'
			? { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, targetWindow: this.domNode.ownerDocument.defaultView ?? undefined }
			: target ?? this.domNode;
		this.contextMenuProvider.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => Separator.join([...this.createContextMenuActions(containerId)], [...additionalActions]),
			getCheckedActionsRepresentation: () => 'checkbox',
			onHide: didCancel => {
				if (didCancel && target?.isConnected) target.focus();
			},
		});
	}

	/** Reconciles visible label tabs with the width assigned by the hosting Part. */
	layout(): void {
		if (!this.overflowEnabled) return;
		if (this.orientation === 'vertical') {
			this.layoutVertical();
			return;
		}
		if (!this.measureTabWidths()) return;
		const availableWidth = this.domNode.clientWidth;
		if (availableWidth <= 0) return;

		const visibleContainers = this.visibleContainersForWidth(availableWidth, OVERFLOW_BUTTON_WIDTH + this.actionBarItemGap);
		const visibleContainerIds = visibleContainers.map((container) => container.id);
		const overflowingContainerIds = new Set(this.displayedContainers
			.filter((container) => !visibleContainerIds.includes(container.id))
			.map((container) => container.id));
		const overflowChanged = !sameIds([...this.overflowingContainerIds], [...overflowingContainerIds]);
		this.setOverflowingContainerIds(overflowingContainerIds);
		if (!sameIds(this.renderedContainerIds, visibleContainerIds) || overflowChanged) {
			this.renderTabs(visibleContainers);
		}
	}

	private layoutVertical(): void {
		const availableHeight = this.domNode.clientHeight;
		if (availableHeight <= 0 || this.displayedContainers.length === 0) return;
		const firstItem = this.actionBar.element.querySelector<HTMLElement>(':scope > .ash-composite-bar-item');
		if (!firstItem) return;
		const itemHeight = firstItem.getBoundingClientRect().height;
		if (itemHeight <= 0) return;
		const gap = Number.parseFloat(getComputedStyle(this.actionBar.element).rowGap) || 0;
		const fit = Math.floor((availableHeight + gap) / (itemHeight + gap));
		const visibleCount = fit >= this.displayedContainers.length ? this.displayedContainers.length : Math.max(0, fit - 1);
		const visible = this.displayedContainers.slice(0, visibleCount);
		const active = this.displayedContainers.find(container => container.id === this._activeCompositeId);
		if (active && visibleCount > 0 && !visible.includes(active)) visible[visible.length - 1] = active;
		const visibleIds = new Set(visible.map(container => container.id));
		const overflowingIds = new Set(this.displayedContainers.filter(container => !visibleIds.has(container.id)).map(container => container.id));
		if (sameIds(this.renderedContainerIds, visible.map(container => container.id)) && sameIds([...this.overflowingContainerIds], [...overflowingIds])) return;
		this.setOverflowingContainerIds(overflowingIds);
		this.renderTabs(visible);
	}

	private render(): void {
		const availableContainers = this.viewDescriptorService.getViewContainers(this.location);
		this.containers = availableContainers.filter(this.containerFilter);
		this.displayedContainers = this.containers.filter(container => !this.hiddenContainerIds.has(container.id) || container.id === this._activeCompositeId);
		if (
			this._activeCompositeId !== undefined &&
			!availableContainers.some((container) => container.id === this._activeCompositeId)
		) {
			this._activeCompositeId = undefined;
		}
		this.tabWidths.clear();
		this.setOverflowingContainerIds(new Set());
		this.renderTabs(this.displayedContainers);
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
					badge: this.badges.get(container.id),
					onActivate: (compositeId) => this._onDidSelectComposite.fire({ compositeId }),
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
		if (!this.displayedContainers.every((container) => this.tabWidths.has(container.id))) {
			return false;
		}
		return true;
	}

	private visibleContainersForWidth(availableWidth: number, overflowWidth: number): readonly IViewContainerDescriptor[] {
		const totalWidth = this.containersWidth(this.displayedContainers);
		if (totalWidth <= availableWidth) return this.displayedContainers;

		const widthLimit = Math.max(0, availableWidth - overflowWidth);
		const visible: IViewContainerDescriptor[] = [];
		for (const container of this.displayedContainers) {
			if (this.containersWidth([...visible, container]) > widthLimit) break;
			visible.push(container);
		}

		const activeCompositeId = this._activeCompositeId;
		if (activeCompositeId && !visible.some((container) => container.id === activeCompositeId)) {
			const activeContainer = this.displayedContainers.find((container) => container.id === activeCompositeId);
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
		return this.displayedContainers
			.filter((container) => this.overflowingContainerIds.has(container.id))
			.map((container) => {
				const label = localize(this.localizationService, container.localizationKey, container.title);
				return {
					id: `ash.compositeBar.open.${this.location}.${encodeURIComponent(container.id)}`,
					label,
					tooltip: label,
					enabled: true,
					checked: container.id === this._activeCompositeId,
					run: () => this._onDidSelectComposite.fire({ compositeId: container.id }),
				};
			});
	}

	private createContextMenuActions(containerId: string | undefined): readonly IAction[] {
		const pinnedCount = this.containers.filter(container => !this.hiddenContainerIds.has(container.id)).length;
		const selected = this.containers.find(container => container.id === containerId);
		const toggleActions = this.containers.map(container => {
			const isPinned = !this.hiddenContainerIds.has(container.id);
			const label = localize(this.localizationService, container.localizationKey, container.title);
			return {
				id: `ash.activityBar.togglePinned.${encodeURIComponent(container.id)}`,
				label,
				tooltip: label,
				enabled: !isPinned || pinnedCount > 1,
				checked: isPinned,
				run: () => this.setPinned(container.id, !isPinned),
			};
		});
		if (!selected) return toggleActions;
		const isPinned = !this.hiddenContainerIds.has(selected.id);
		const name = localize(this.localizationService, selected.localizationKey, selected.title);
		const label = this.localizationService?.translate('ash', isPinned ? 'workbench.hideActivityBarView' : 'workbench.keepActivityBarView', isPinned ? "Hide '{0}'" : "Keep '{0}'", { '0': name }) ?? (isPinned ? `Hide '${name}'` : `Keep '${name}'`);
		return Separator.join([{
			id: `ash.activityBar.toggleSelected.${encodeURIComponent(selected.id)}`,
			label,
			tooltip: label,
			enabled: !isPinned || pinnedCount > 1,
			run: () => this.setPinned(selected.id, !isPinned),
		}], toggleActions);
	}

	private setPinned(containerId: string, pinned: boolean): void {
		if (pinned) this.hiddenContainerIds.delete(containerId);
		else this.hiddenContainerIds.add(containerId);
		this.storageService?.store(HIDDEN_VIEW_CONTAINERS_KEY, JSON.stringify([...this.hiddenContainerIds]), StorageScope.PROFILE, StorageTarget.USER);
		this.render();
	}

	private readHiddenContainerIds(): Set<string> {
		const stored = this.storageService?.get(HIDDEN_VIEW_CONTAINERS_KEY, StorageScope.PROFILE);
		if (!stored) return new Set();
		try {
			const ids: unknown = JSON.parse(stored);
			return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
		} catch {
			return new Set();
		}
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
	readonly icon = Lxicon.ellipsis;
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
