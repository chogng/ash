import './media/compositepart.css';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { DisposableMap, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Part } from '../part.js';
import type { IComposite } from '../../common/composite.js';
import type { Composite } from '../composite.js';
import { WorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { addDisposableListener, Dimension, type IDimension } from '../../../base/browser/dom.js';
import type { IContextMenuProvider } from '../../../base/browser/contextmenu.js';
import { ProgressBar } from '../../../base/browser/ui/progressbar/progressbar.js';
import { defaultProgressBarStyles } from '../../../platform/theme/browser/defaultStyles.js';
import type { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { ScopedProgressIndicator } from '../../services/progress/browser/progressIndicator.js';
import { h } from '../../../base/browser/dom.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';

/**
 * Workbench Part that retains and activates one PaneComposite at a time.
 *
 * The shared content area hosts the active Composite. Pane-like subclasses
 * add their standard title and CompositeBar through PaneCompositePart.
 */
export abstract class CompositePart<T extends Composite> extends Part {
	private readonly composites = this._register(new DisposableMap<string, T>());
	private readonly progressIndicators = this._register(new DisposableMap<string, IDisposable & { readonly indicator: IProgressIndicator; }>());
	private activeComposite: T | undefined;
	private lastLayout: { readonly composite: T; readonly dimension: IDimension; } | undefined;
	private readonly titleAreaListener = this._register(new MutableDisposable());
	private readonly constraintsListener = this._register(new MutableDisposable());

	override get minimumWidth(): number {
		return this.activeComposite?.minimumWidth ?? super.minimumWidth;
	}
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
		this.contentDomNode.classList.add('ash-composite-content');
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

	public getProgressIndicator(id: string): IProgressIndicator | undefined {
		const composite = this.composites.get(id);
		if (!composite) return undefined;
		const existing = this.progressIndicators.get(id);
		if (existing) return existing.indicator;
		const host = h(this.domNode.ownerDocument, 'div');
		host.className = 'ash-composite-progress';
		this.titleDomNode.after(host);
		const bar = new ProgressBar(host, defaultProgressBarStyles);
		bar.element.classList.add('thin');
		bar.element.setAttribute('aria-label', composite.getTitle() ?? id);
		const part = this;
		const indicator = new ScopedProgressIndicator(bar, {
			get isActive() { return part.activeComposite === composite && composite.isVisible(); },
			onDidChangeActive: Event.any(
				Event.map(this.onDidCompositeOpen, () => undefined),
				Event.map(this.onDidCompositeClose, () => undefined),
			),
		});
		this.progressIndicators.set(id, Object.assign(toDisposable(() => {
			indicator.dispose(); bar.dispose(); host.remove();
		}), { indicator }));
		return indicator;
	}

	protected createCompositeToolBar(container: HTMLElement, contextMenus: IContextMenuProvider, ariaLabel: string): void {
		this.compositeToolBarContainer = container;
		this.compositeToolBarAriaLabel = ariaLabel;
		this.compositeToolBar = this._register(new WorkbenchToolBar(container, contextMenus, {
			ariaLabel,
			highlightToggledItems: true,
			actionViewItemProvider: (action, options) => this.activeComposite?.getActionViewItem(action, options),
		}));
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
		// Scope feature-owned title styling to the active composite.
		this.domNode.dataset.activeComposite = this.activeComposite?.getId() ?? '';
		const toolbar = this.compositeToolBar;
		if (!toolbar) return;
		const activeElement = toolbar.element.ownerDocument.activeElement;
		const focusedAction = toolbar.element.contains(activeElement)
			? toolbar.getItemAction(activeElement as HTMLElement)?.id
			: undefined;
		// A merged View lends its scoped action host; return the Part-owned renderer before switching hosts.
		this.compositeToolBarContainer!.append(toolbar.element);
		// The retained renderer must release the previous View's accessible name before its next host lends one.
		toolbar.setAriaLabel(this.activeComposite?.getTitle() ?? this.compositeToolBarAriaLabel);
		const primary = this.activeComposite?.getActions() ?? [];
		const secondary = this.activeComposite?.getSecondaryActions() ?? [];
		toolbar.setActions(primary, secondary);
		toolbar.element.hidden = primary.length === 0 && secondary.length === 0;
		if (focusedAction) {
			for (let index = 0; index < toolbar.getItemsLength(); index++) {
				if (toolbar.getItemAction(index)?.id === focusedAction) { toolbar.focus(index); break; }
			}
		}
	}

	protected removeComposite(compositeId: string): boolean {
		const composite = this.composites.get(compositeId);
		if (!composite) { return false; }
		if (this.activeComposite === composite) {
			const previousMinimumWidth = this.minimumWidth;
			const visible = composite.isVisible();
			this.activeComposite = undefined;
			this.lastLayout = undefined;
			this.titleAreaListener.clear();
			this.constraintsListener.clear();
			if (this.minimumWidth !== previousMinimumWidth) this.notifyConstraintsChanged();
			this.updateTitleArea();
			composite.setVisible(false);
			if (visible) { this.compositeClosed.fire(composite); }
		}
		this.progressIndicators.deleteAndDispose(compositeId);
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
			this.layoutActiveComposite();
			if (focus && composite.isVisible()) {
				this.pendingFocus = false;
				composite.focus();
			}
			return;
		}
		const previousMinimumWidth = this.minimumWidth;
		if (this.activeComposite) {
			const previous = this.activeComposite;
			const visible = previous.isVisible();
			previous.setVisible(false);
			previous.getContainer()!.remove();
			this.activeComposite = undefined;
			if (visible) { this.compositeClosed.fire(previous); }
		}
		this.activeComposite = composite;
		this.lastLayout = undefined;
		this.titleAreaListener.value = composite.onTitleAreaUpdate(() => this.updateTitleArea());
		this.constraintsListener.value = composite.onDidChangeConstraints(() => this.notifyConstraintsChanged());
		this.contentDomNode.append(composite.getContainer()!);
		composite.setVisible(!this.domNode.hidden);
		this.updateTitleArea();
		// Only a changed constraint requires Grid to redistribute the Workbench.
		// Publish title changes first so that pass measures the final content area.
		if (this.minimumWidth !== previousMinimumWidth) this.notifyConstraintsChanged();
		this.layoutActiveComposite();
		if (!this.domNode.hidden) {
			this.compositeOpened.fire({ composite, focus });
			this.pendingFocus = false;
			if (focus) { composite.focus(); }
		}
	}

	override setVisible(visible: boolean): void {
		const changed = this.domNode.hidden === visible;
		super.setVisible(visible);
		if (!visible) this.lastLayout = undefined;
		this.activeComposite?.setVisible(visible);
		if (visible) { this.layoutActiveComposite(); }
		if (changed && this.activeComposite) {
			if (visible) { this.compositeOpened.fire({ composite: this.activeComposite, focus: this.pendingFocus }); }
			else { this.compositeClosed.fire(this.activeComposite); }
		}
		if (visible && this.pendingFocus) { this.activeComposite?.focus(); }
		this.pendingFocus = false;
	}

	public override layout(_dimension: IDimension): void {
		this.layoutActiveComposite();
	}

	private layoutActiveComposite(): void {
		if (!this.activeComposite?.isVisible() || this.domNode.hidden) { return; }
		// Flex owns the space left by borders, title slots and activity bars. Publish it
		// during the host layout, before focus or paint can use the previous pane size.
		const { clientWidth, clientHeight } = this.contentDomNode;
		if (clientWidth > 0 && clientHeight > 0) {
			const previous = this.lastLayout;
			if (previous?.composite === this.activeComposite && previous.dimension.width === clientWidth && previous.dimension.height === clientHeight) return;
			const dimension = new Dimension(clientWidth, clientHeight);
			this.lastLayout = { composite: this.activeComposite, dimension };
			this.activeComposite.layout(dimension);
		}
	}

	public getActiveComposite(): IComposite | undefined { return this.activeComposite; }

	get activeCompositeId(): string | undefined {
		return this.activeComposite?.getId();
	}
}
