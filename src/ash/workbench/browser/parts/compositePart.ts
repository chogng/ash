import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { Emitter } from "../../../base/common/event.js";
import { DisposableMap, MutableDisposable } from "../../../base/common/lifecycle.js";
import { Part } from "../part.js";
import type { IComposite } from '../../common/composite.js';
import type { Composite } from '../composite.js';
import { WorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { addDisposableListener } from '../../../base/browser/dom.js';
import type { IContextMenuProvider } from '../../../base/browser/contextmenu.js';

/**
 * Workbench Part that retains and activates one PaneComposite at a time.
 *
 * The shared content area hosts the active Composite. Pane-like subclasses
 * add their standard title and CompositeBar through PaneCompositePart.
 */
export abstract class CompositePart<T extends Composite> extends Part {
	private readonly composites = this._register(new DisposableMap<string, T>());
	private activeComposite: T | undefined;
	private readonly titleAreaListener = this._register(new MutableDisposable());
	protected compositeToolBar: WorkbenchToolBar | undefined;
	private compositeToolBarContainer: HTMLElement | undefined;
	private compositeToolBarAriaLabel = '';
	private pendingFocus = false;
	private readonly compositeOpened = this._register(new Emitter<{ composite: IComposite; focus: boolean; }>());
	private readonly compositeClosed = this._register(new Emitter<IComposite>());
	public readonly onDidCompositeOpen = this.compositeOpened.event;
	public readonly onDidCompositeClose = this.compositeClosed.event;

	protected constructor(
		container: HTMLElement,
		id: string,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(container, id, themeService, storageService);
		this.contentDomNode.classList.add("ash-composite-content");
	}

	addComposite(composite: T): void {
		const id = composite.getId();
		if (this.composites.has(id)) {
			throw new Error(`Composite already exists in Part: ${id}`);
		}
		this.composites.set(id, composite);
		composite.setVisible(false);
	}

	getComposite(compositeId: string): T | undefined {
		return this.composites.get(compositeId);
	}

	protected createCompositeToolBar(container: HTMLElement, contextMenus: IContextMenuProvider, ariaLabel: string): void {
		this.compositeToolBarContainer = container;
		this.compositeToolBarAriaLabel = ariaLabel;
		this.compositeToolBar = this._register(new WorkbenchToolBar(container, contextMenus, { ariaLabel, highlightToggledItems: true }));
		this.compositeToolBar.element.classList.add('ash-pane-composite-title-menu-actions');
		this._register(addDisposableListener(this.titleDomNode, 'contextmenu', event => {
			const actions = this.activeComposite?.getContextMenuActions() ?? [];
			if (actions.length === 0) return;
			event.preventDefault();
			event.stopPropagation();
			contextMenus.showContextMenu({
				getAnchor: () => ({ x: event.clientX, y: event.clientY, targetWindow: container.ownerDocument.defaultView ?? undefined }),
				getActions: () => actions,
			});
		}));
		this.updateTitleArea();
	}

	protected updateTitleArea(): void {
		const toolbar = this.compositeToolBar;
		if (!toolbar) return;
		const activeElement = toolbar.element.ownerDocument.activeElement;
		const focusedAction = toolbar.element.contains(activeElement)
			? (activeElement as HTMLElement).closest<HTMLElement>('[data-action-id]')?.dataset.actionId
			: undefined;
		// A merged View lends its scoped action host; return the Part-owned renderer before switching hosts.
		this.compositeToolBarContainer!.append(toolbar.element);
		// The retained renderer must release the previous View's accessible name before its next host lends one.
		toolbar.element.setAttribute('aria-label', this.activeComposite?.getTitle() ?? this.compositeToolBarAriaLabel);
		const primary = this.activeComposite?.getActions() ?? [];
		const secondary = this.activeComposite?.getSecondaryActions() ?? [];
		toolbar.setActions(primary, secondary);
		toolbar.element.hidden = primary.length === 0 && secondary.length === 0;
		if (focusedAction) {
			const entry = [...toolbar.element.querySelectorAll<HTMLElement>('[data-action-id]')].find(element => element.dataset.actionId === focusedAction);
			entry?.querySelector<HTMLElement>('button:not(:disabled), [tabindex]')?.focus();
		}
	}

	protected removeComposite(compositeId: string): boolean {
		const composite = this.composites.get(compositeId);
		if (!composite) { return false; }
		if (this.activeComposite === composite) {
			const visible = composite.isVisible();
			this.activeComposite = undefined;
			this.titleAreaListener.clear();
			this.updateTitleArea();
			composite.setVisible(false);
			if (visible) { this.compositeClosed.fire(composite); }
		}
		return this.composites.deleteAndDispose(compositeId);
	}

	showComposite(compositeId: string, focus = false): void {
		const composite = this.composites.get(compositeId);
		if (!composite) {
			throw new Error(`Composite is not available in Part: ${compositeId}`);
		}
		this.pendingFocus = focus;
		if (this.activeComposite === composite) {
			if (!composite.isVisible() && !this.domNode.hidden) {
				composite.setVisible(true);
				this.compositeOpened.fire({ composite, focus });
			}
			// Reopening the retained Composite must reattach its title renderer after the old host was restored.
			this.updateTitleArea();
			if (focus && composite.isVisible()) {
				this.pendingFocus = false;
				composite.focus();
			}
			return;
		}
		if (this.activeComposite) {
			const previous = this.activeComposite;
			const visible = previous.isVisible();
			previous.setVisible(false);
			previous.getContainer()!.remove();
			this.activeComposite = undefined;
			if (visible) { this.compositeClosed.fire(previous); }
		}
		this.activeComposite = composite;
		this.titleAreaListener.value = composite.onTitleAreaUpdate(() => this.updateTitleArea());
		this.contentDomNode.append(composite.getContainer()!);
		composite.setVisible(!this.domNode.hidden);
		this.updateTitleArea();
		if (!this.domNode.hidden) {
			this.compositeOpened.fire({ composite, focus });
			this.pendingFocus = false;
			if (focus) { composite.focus(); }
		}
	}

	override setVisible(visible: boolean): void {
		const changed = this.domNode.hidden === visible;
		super.setVisible(visible);
		this.activeComposite?.setVisible(visible);
		if (changed && this.activeComposite) {
			if (visible) { this.compositeOpened.fire({ composite: this.activeComposite, focus: this.pendingFocus }); }
			else { this.compositeClosed.fire(this.activeComposite); }
		}
		if (visible && this.pendingFocus) { this.activeComposite?.focus(); }
		this.pendingFocus = false;
	}

	public getActiveComposite(): IComposite | undefined { return this.activeComposite; }

	get activeCompositeId(): string | undefined {
		return this.activeComposite?.getId();
	}
}
