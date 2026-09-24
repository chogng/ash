import { toDisposable } from "../../../../base/common/lifecycle.js";
import "./statusbarpart.css";
import { addDisposableListener, isNode, h } from "../../../../base/browser/dom.js";
import { WorkbenchPart } from "../../part.js";
import { StatusbarHeight } from "../workbenchPartDimensions.js";
import { StatusbarEntryItem } from "./statusbarItem.js";
import { type IStatusbarEntryItem, type IStatusbarService, StatusbarAlignment } from "../../../services/statusbar/browser/statusbar.js";

/** Browser view of the window-scoped status bar entry service. */
export class StatusbarPart extends WorkbenchPart {
	private readonly statusbarService: IStatusbarService;
	private readonly leftItems: HTMLDivElement;
	private readonly rightItems: HTMLDivElement;
	private readonly items = new Map<string, StatusbarEntryItem>();
	private readonly compactGroupByItemId = new Map<string, string>();
	private readonly compactGroups = new Map<string, StatusbarEntryItem[]>();

	override get minimumHeight(): number { return StatusbarHeight; }
	override get maximumHeight(): number { return StatusbarHeight; }

	constructor(
		container: HTMLElement,
		statusbarService: IStatusbarService,
	) {
		super(container, "statusbar");
		const ownerDocument = container.ownerDocument;
		this.statusbarService = statusbarService;
		this.titleDomNode.remove();
		this.contentDomNode.remove();
		this.domNode.setAttribute("role", "status");
		this.domNode.setAttribute("aria-live", "polite");
		this.domNode.tabIndex = 0;
		this._register(addDisposableListener(this.domNode, "keydown", (event) => {
			if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			if (event.key === "ArrowRight") {
				this.focusNextEntry();
			} else if (event.key === "ArrowLeft") {
				this.focusPreviousEntry();
			} else {
				return;
			}
			this.itemForTarget(event.target)?.hideHover();
			event.preventDefault();
			event.stopPropagation();
		}));
		this._register(addDisposableListener(this.domNode, "mouseover", (event) => this.updateCompactHover(event.target)));
		this._register(addDisposableListener(this.domNode, "mouseout", (event) => this.updateCompactHover(event.relatedTarget)));

		this.leftItems = createItemsContainer(ownerDocument, "left");
		this.rightItems = createItemsContainer(ownerDocument, "right");
		this.domNode.append(this.leftItems, this.rightItems);

		this._register(toDisposable(() => this.disposeItems()));
		this._register(this.statusbarService.onDidChangeEntries(() => this.render()));
		this.render();
	}

	private render(): void {
		const leftEntries = this.statusbarService.getEntries(StatusbarAlignment.Left);
		const rightEntries = this.statusbarService.getEntries(StatusbarAlignment.Right);
		const visibleIds = new Set([...leftEntries, ...rightEntries].map(({ id }) => id));
		for (const [id, item] of this.items) {
			if (visibleIds.has(id)) continue;
			item.dispose();
			this.items.delete(id);
		}
		this.clearCompactHover();
		this.compactGroupByItemId.clear();
		this.compactGroups.clear();
		this.renderItems(this.leftItems, leftEntries);
		this.renderItems(this.rightItems, rightEntries);
	}

	private renderItems(
		container: HTMLDivElement,
		entries: readonly IStatusbarEntryItem[],
	): void {
		container.replaceChildren();
		let compactGroupDomNode: HTMLDivElement | undefined;
		let compactGroupId: string | undefined;
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index];
			if (!entry) continue;
			let item = this.items.get(entry.id);
			if (item) {
				item.update(entry.entry);
			} else {
				item = new StatusbarEntryItem(container, entry.id, entry.entry);
				this.items.set(entry.id, item);
			}
			item.setCompactNeighbors({
				left: entry.compactGroup !== undefined && entries[index - 1]?.compactGroup === entry.compactGroup,
				right: entry.compactGroup !== undefined && entries[index + 1]?.compactGroup === entry.compactGroup,
			});
			if (entry.compactGroup) {
				this.compactGroupByItemId.set(entry.id, entry.compactGroup);
				const group = this.compactGroups.get(entry.compactGroup) ?? [];
				group.push(item);
				this.compactGroups.set(entry.compactGroup, group);
			}
			const belongsToCompactRun = entry.compactGroup !== undefined && (entries[index - 1]?.compactGroup === entry.compactGroup || entries[index + 1]?.compactGroup === entry.compactGroup);
			if (belongsToCompactRun) {
				if (!compactGroupDomNode || compactGroupId !== entry.compactGroup) {
					compactGroupDomNode = h(container.ownerDocument, "div");
					compactGroupDomNode.className = "ash-statusbar-compact-group";
					compactGroupDomNode.dataset.compactGroup = entry.compactGroup;
					compactGroupId = entry.compactGroup;
					container.append(compactGroupDomNode);
				}
				compactGroupDomNode.append(item.domNode);
			} else {
				compactGroupDomNode = undefined;
				compactGroupId = undefined;
				container.append(item.domNode);
			}
		}
	}

	focusNextEntry(): void {
		this.focusEntry(1);
	}

	focusPreviousEntry(): void {
		this.focusEntry(-1);
	}

	isEntryFocused(): boolean {
		return this.focusableItems().some((item) => item.isFocused());
	}

	private focusEntry(delta: 1 | -1): void {
		const items = this.focusableItems();
		if (items.length === 0) return;
		const focusedIndex = items.findIndex((item) => item.isFocused());
		const targetIndex = focusedIndex === -1
			? delta === 1 ? 0 : items.length - 1
			: focusedIndex + delta;
		const target = items[targetIndex];
		if (!target) return;
		target.focus();
	}

	private focusableItems(): StatusbarEntryItem[] {
		const entries = [
			...this.statusbarService.getEntries(StatusbarAlignment.Left),
			...this.statusbarService.getEntries(StatusbarAlignment.Right),
		];
		return entries
			.map(({ id }) => this.items.get(id))
			.filter((item): item is StatusbarEntryItem => item?.isFocusable() === true);
	}

	private itemForTarget(target: EventTarget | null): StatusbarEntryItem | undefined {
		if (!isNode(target)) return undefined;
		return [...this.items.values()].find((item) => item.domNode.contains(target));
	}

	private updateCompactHover(target: EventTarget | null): void {
		const hoveredItem = this.itemForTarget(target);
		const compactGroup = hoveredItem && hoveredItem.isFocusable() ? this.compactGroupByItemId.get(hoveredItem.id) : undefined;
		this.clearCompactHover();
		if (!compactGroup || !hoveredItem) return;
		for (const item of this.compactGroups.get(compactGroup) ?? []) item.setCompactHoverState(item === hoveredItem ? "entry" : "group");
	}

	private clearCompactHover(): void {
		for (const item of this.items.values()) item.setCompactHoverState("none");
	}

	private disposeItems(): void {
		for (const item of this.items.values()) item.dispose();
		this.items.clear();
	}
}

function createItemsContainer(ownerDocument: Document, alignment: "left" | "right"): HTMLDivElement {
	const container = h(ownerDocument, "div");
	container.className = `ash-statusbar-items ash-statusbar-items-${alignment}`;
	return container;
}
