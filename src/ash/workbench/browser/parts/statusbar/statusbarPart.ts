import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { Disposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Emitter, type Event } from '../../../../base/common/event.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import "./statusbarpart.css";
import { addDisposableListener, isHTMLElement, isNode, h } from "../../../../base/browser/dom.js";
import { Part } from "../../part.js";
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { StatusbarViewModel } from './statusbarModel.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { StatusBarFocused } from '../../../common/contextkeys.js';
import { HideStatusbarEntryAction, ToggleStatusbarEntryVisibilityAction } from './statusbarActions.js';
import { localize } from '../../../../nls.js';
import { StatusbarHeight } from "../workbenchPartDimensions.js";
import { StatusbarEntryItem } from "./statusbarItem.js";
import {
	type IStatusbarEntry,
	type IStatusbarEntryAccessor,
	type IStatusbarEntryOptions,
	type IStatusbarStyleOverride,
	type IStatusbarEntryItem,
	IStatusbarService,
	StatusbarAlignment,
} from "../../../services/statusbar/browser/statusbar.js";

/** Operations on the status bar presentation owned by one window. */
export interface IStatusbarEntryContainer extends IDisposable {
	readonly onDidChangeEntryVisibility: Event<{ id: string; visible: boolean; }>;
	isEntryVisible(id: string): boolean;
	updateEntryVisibility(id: string, visible: boolean): void;
	focus(preserveEntryFocus?: boolean): void;
	focusNextEntry(): void;
	focusPreviousEntry(): void;
	isEntryFocused(): boolean;
}

// View identities only: content, placement and visibility stay with their existing owners.
const statusbarParts = new WeakMap<HTMLElement, StatusbarPart>();

/** Browser view of the window-scoped status bar entry service. */
export class StatusbarPart extends Part implements IStatusbarEntryContainer {
	private readonly statusbarService: IStatusbarService;
	private readonly leftItems: HTMLDivElement;
	private readonly rightItems: HTMLDivElement;
	private readonly items = new Map<string, StatusbarEntryItem>();
	private readonly compactGroupByItemId = new Map<string, string>();
	private readonly compactGroups = new Map<string, StatusbarEntryItem[]>();
	private readonly viewModel: StatusbarViewModel;
	private contextMenu: CancellationTokenSource | undefined;
	private lastFocusedEntryId: string | undefined;
	readonly onDidChangeEntryVisibility: Event<{ id: string; visible: boolean; }>;

	override get minimumHeight(): number { return StatusbarHeight; }
	override get maximumHeight(): number { return StatusbarHeight; }

	constructor(
		container: HTMLElement,
		@IStatusbarService statusbarService: IStatusbarService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(container, "statusbar", themeService, storageService);
		const ownerDocument = container.ownerDocument;
		this.statusbarService = statusbarService;
		this.viewModel = this._register(instantiationService.createInstance(StatusbarViewModel));
		this.onDidChangeEntryVisibility = this.viewModel.onDidChangeEntryVisibility;
		this.titleDomNode.remove();
		this.contentDomNode.remove();
		this.domNode.setAttribute("role", "status");
		this.domNode.setAttribute("aria-live", "off");
		this.domNode.setAttribute('aria-label', localize('statusbar.label', 'Status Bar'));
		this.domNode.tabIndex = 0;
		const scopedContext = this._register(contextKeyService.createScoped(this.domNode));
		StatusBarFocused.bindTo(scopedContext).set(true);
		statusbarParts.set(this.domNode, this);
		this._register(toDisposable(() => {
			statusbarParts.delete(this.domNode);
		}));
		this._register(addDisposableListener(this.domNode, 'focusin', event => {
			const item = this.itemForTarget(event.target);
			if (item) this.lastFocusedEntryId = item.id;
		}));
		this._register(addDisposableListener(this.domNode, 'contextmenu', event => this.showContextMenu(event)));
		this._register(addDisposableListener(this.domNode, "keydown", (event) => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)) {
				this.showContextMenu(event);
			}
		}));
		this._register(addDisposableListener(this.domNode, "mouseover", (event) => this.updateCompactHover(event.target)));
		this._register(addDisposableListener(this.domNode, "mouseout", (event) => this.updateCompactHover(event.relatedTarget)));

		this.leftItems = createItemsContainer(ownerDocument, "left");
		this.rightItems = createItemsContainer(ownerDocument, "right");
		this.domNode.append(this.leftItems, this.rightItems);

		this._register(toDisposable(() => this.disposeItems()));
		this._register(toDisposable(() => this.cancelContextMenu()));
		this._register(this.statusbarService.onDidChangeEntries(() => this.render()));
		this._register(this.onDidChangeEntryVisibility(({ id, visible }) => {
			const restoreFocus = !visible && this.items.get(id)?.isFocused();
			this.render();
			if (restoreFocus) this.domNode.focus();
		}));
		this._register(this.statusbarService.onDidChangeStyle(() => this.updateStyle()));
		this.updateStyle();
		this.render();
	}

	private updateStyle(): void {
		const style = this.statusbarService.style;
		for (const [property, color] of [['color', style?.foreground], ['background-color', style?.background]] as const) {
			if (color) this.domNode.style.setProperty(property, `var(${colorCssVariable(color)})`);
			else this.domNode.style.removeProperty(property);
		}
		if (style?.border) this.domNode.style.boxShadow = `inset 0 1px var(${colorCssVariable(style.border)})`;
		else this.domNode.style.removeProperty('box-shadow');
	}

	private render(): void {
		const document = this.domNode.ownerDocument;
		const activeElement = document.activeElement;
		const focused = isHTMLElement(activeElement) && this.domNode.contains(activeElement) ? activeElement : undefined;
		const leftEntries = this.visibleEntries(StatusbarAlignment.Left);
		const rightEntries = this.visibleEntries(StatusbarAlignment.Right);
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
		// Structural regrouping can move retained items. Respect focus moved by update callbacks.
		if (focused?.isConnected && this.domNode.contains(focused) && (document.activeElement === document.body || document.activeElement === focused)) {
			focused.focus();
		}
	}

	private renderItems(
		container: HTMLDivElement,
		entries: readonly IStatusbarEntryItem[],
	): void {
		const previousGroups = Array.from(container.querySelectorAll<HTMLDivElement>(":scope > .ash-statusbar-compact-group"));
		const groupChildren = new Map<HTMLDivElement, HTMLElement[]>();
		const children: HTMLElement[] = [];
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
					compactGroupDomNode = previousGroups.find(group => group.dataset.compactGroup === entry.compactGroup && !groupChildren.has(group))
						?? h(container.ownerDocument, "div");
					compactGroupDomNode.className = "ash-statusbar-compact-group";
					compactGroupDomNode.dataset.compactGroup = entry.compactGroup;
					compactGroupId = entry.compactGroup;
					children.push(compactGroupDomNode);
					groupChildren.set(compactGroupDomNode, []);
				}
				groupChildren.get(compactGroupDomNode)!.push(item.domNode);
			} else {
				compactGroupDomNode = undefined;
				compactGroupId = undefined;
				children.push(item.domNode);
			}
		}
		for (const [group, items] of groupChildren) reconcileChildren(group, items);
		reconcileChildren(container, children);
	}

	isEntryVisible(id: string): boolean {
		return !this.viewModel.isHidden(id);
	}

	updateEntryVisibility(id: string, visible: boolean): void {
		if (visible) this.viewModel.show(id);
		else this.viewModel.hide(id);
	}

	private visibleEntries(alignment: StatusbarAlignment): readonly IStatusbarEntryItem[] {
		return this.statusbarService.getEntries(alignment).filter(({ id }) => this.isEntryVisible(id));
	}

	focus(preserveEntryFocus = true): void {
		if (this.isDisposed || this.domNode.closest('[hidden]')) return;
		const remembered = preserveEntryFocus && this.lastFocusedEntryId ? this.items.get(this.lastFocusedEntryId) : undefined;
		if (remembered?.isFocusable()) remembered.focus();
		else this.domNode.focus();
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
		if (this.isDisposed || this.domNode.closest('[hidden]')) return;
		const items = this.focusableItems();
		if (items.length === 0) return;
		const focusedIndex = items.findIndex((item) => item.isFocused());
		const targetIndex = focusedIndex === -1
			? delta === 1 ? 0 : items.length - 1
			: focusedIndex + delta;
		const target = items[targetIndex];
		if (!target) return;
		items[focusedIndex]?.hideHover();
		target.focus();
	}

	private showContextMenu(event: MouseEvent | KeyboardEvent): void {
		if (this.isDisposed || event.defaultPrevented) return;
		event.preventDefault();
		event.stopPropagation();
		const focused = this.domNode.ownerDocument.activeElement;
		const target = this.itemForTarget(event.target);
		const entries = [
			...this.statusbarService.getEntries(StatusbarAlignment.Left),
			...this.statusbarService.getEntries(StatusbarAlignment.Right),
		];
		const name = (item: IStatusbarEntryItem): string => item.entry.ariaLabel || item.entry.text || item.entry.tooltip || item.id;
		const actions: IAction[] = entries.map(item => new ToggleStatusbarEntryVisibilityAction(item.id, name(item), this.viewModel));
		const entry = target && entries.find(item => item.id === target.id);
		if (entry) actions.push(new Separator(), new HideStatusbarEntryAction(entry.id, name(entry), this.viewModel));
		for (const item of this.items.values()) item.hideHover();
		this.cancelContextMenu();
		const source = this.contextMenu = new CancellationTokenSource();
		try {
			this.contextMenuService.showContextMenu({
				getAnchor: () => event.type === 'contextmenu'
					? { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, targetWindow: this.domNode.ownerDocument.defaultView ?? undefined }
					: target?.domNode ?? this.domNode,
				getActions: () => actions,
				getCheckedActionsRepresentation: () => 'checkbox',
				autoSelectFirstItem: true,
				cancellationToken: source.token,
				onHide: () => {
					if (this.contextMenu !== source) return;
					this.contextMenu = undefined;
					source.dispose();
					if (this.isDisposed) return;
					if (isHTMLElement(focused) && focused.isConnected && this.domNode.contains(focused)) focused.focus();
					else this.focus(false);
				},
			});
		} catch (error) {
			this.cancelContextMenu();
			throw error;
		}
	}

	private cancelContextMenu(): void {
		const source = this.contextMenu;
		this.contextMenu = undefined;
		source?.cancel();
		source?.dispose();
	}

	private focusableItems(): StatusbarEntryItem[] {
		const entries = [
			...this.visibleEntries(StatusbarAlignment.Left),
			...this.visibleEntries(StatusbarAlignment.Right).slice().reverse(),
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

/** Keep unchanged entries connected so their progress animations and focus survive updates. */
function reconcileChildren(container: HTMLElement, children: readonly HTMLElement[]): void {
	const retained = new Set<Element>(children);
	for (const child of Array.from(container.children)) {
		if (!retained.has(child)) child.remove();
	}
	let next = container.firstChild;
	for (const child of children) {
		if (child === next) next = next.nextSibling;
		else container.insertBefore(child, next);
	}
}

function createItemsContainer(ownerDocument: Document, alignment: "left" | "right"): HTMLDivElement {
	const container = h(ownerDocument, "div");
	container.className = `ash-statusbar-items ash-statusbar-items-${alignment}`;
	return container;
}

interface IStoredStatusbarEntry extends IStatusbarEntryItem {
	readonly order: number;
}

/** Default window-scoped status bar entry service. */
export class StatusbarService extends Disposable
	implements IStatusbarService {
	private readonly _onDidChangeEntries = this._register(new Emitter<void>());
	private readonly entries = new Map<string, IStoredStatusbarEntry>();
	private nextOrder = 0;
	private readonly styles = new Set<IStatusbarStyleOverride>();
	private readonly styleChanges = this._register(new Emitter<void>());
	readonly onDidChangeStyle = this.styleChanges.event;

	get style(): IStatusbarStyleOverride | undefined {
		return [...this.styles].sort((left, right) => left.priority - right.priority).at(0);
	}

	overrideStyle(style: IStatusbarStyleOverride): IDisposable {
		this.assertNotDisposed();
		const stored = { ...style };
		this.styles.add(stored);
		this.styleChanges.fire();
		return toDisposable(() => { if (this.styles.delete(stored)) this.styleChanges.fire(); });
	}

	readonly onDidChangeEntries = this._onDidChangeEntries.event;

	constructor(private readonly parent?: IStatusbarService) {
		super();
		if (parent) this._register(parent.onDidChangeEntries(() => this._onDidChangeEntries.fire()));
		this._register(toDisposable(() => {
			this.entries.clear();
			this.styles.clear();
		}));
	}

	getPart(container: HTMLElement): IStatusbarEntryContainer {
		const element = container.matches('[data-part="statusbar"]')
			? container : container.querySelector<HTMLElement>('[data-part="statusbar"]');
		const part = element && statusbarParts.get(element);
		if (!part) throw new Error('No status bar is registered in this container');
		return part;
	}

	addEntry(
		entry: IStatusbarEntry,
		options: IStatusbarEntryOptions,
	): IStatusbarEntryAccessor {
		if (this.isDisposed) {
			throw new ReferenceError("StatusbarService is already disposed");
		}
		if (!options.id) {
			throw new Error("A status bar entry requires a non-empty id");
		}
		if (this.entries.has(options.id)) {
			throw new Error(`Status bar entry already exists: ${options.id}`);
		}

		const priority = options.priority ?? 0;
		if (!Number.isFinite(priority)) {
			throw new Error("Status bar entry priority must be finite");
		}

		let stored: IStoredStatusbarEntry = {
			id: options.id,
			alignment: options.alignment,
			priority,
			compactGroup: options.compactGroup,
			entry: { ...entry },
			order: this.nextOrder++,
		};
		this.entries.set(stored.id, stored);
		this._onDidChangeEntries.fire();

		return new StatusbarEntryAccessor(
			(nextEntry) => {
				if (this.isDisposed || this.entries.get(stored.id) !== stored) return;
				stored = {
					...stored,
					entry: { ...nextEntry },
				};
				this.entries.set(stored.id, stored);
				this._onDidChangeEntries.fire();
			},
			() => {
				if (this.isDisposed || this.entries.get(stored.id) !== stored) return;
				this.entries.delete(stored.id);
				this._onDidChangeEntries.fire();
			},
		);
	}

	getEntries(
		alignment: StatusbarAlignment,
	): readonly IStatusbarEntryItem[] {
		const shared = this.parent?.getEntries(alignment).filter(item => item.entry.showInAllWindows) ?? [];
		const local = [...this.entries.values()]
			.filter((item) => item.alignment === alignment)
			.sort(compareEntries)
			.map(({ id, entry, priority, compactGroup, alignment: itemAlignment }) => ({
				id,
				entry,
				priority,
				compactGroup,
				alignment: itemAlignment,
			}));
		return [...shared, ...local].sort((a, b) => b.priority - a.priority);
	}
}

class StatusbarEntryAccessor extends Disposable
	implements IStatusbarEntryAccessor {
	private readonly _update: (entry: IStatusbarEntry) => void;
	private active = true;

	constructor(
		update: (entry: IStatusbarEntry) => void,
		remove: () => void,
	) {
		super();
		this._update = update;
		this._register(toDisposable(() => {
			this.active = false;
			remove();
		}));
	}

	update(entry: IStatusbarEntry): void {
		if (!this.active) return;
		this._update(entry);
	}
}

function compareEntries(
	first: IStoredStatusbarEntry,
	second: IStoredStatusbarEntry,
): number {
	return second.priority - first.priority || first.order - second.order;
}
