import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import "./views.css";
import { Emitter } from "../../../../base/common/event.js";
import { Pane, type IPaneOptions } from "../../../../base/browser/ui/splitview/paneview.js";
import type { IView } from "../../../common/views.js";
import { getWindow, h } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IViewContentDescriptor, WorkbenchViewRegistry } from '../../../common/views.js';
import { localize } from '../../../../nls.js';
import type { IAction } from '../../../../base/common/actions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { FilterWidget, type IFilterWidgetOptions } from './viewFilter.js';

/** Runtime inputs supplied by a browser view container to every pane. */
export type IViewPaneOptions = IPaneOptions;

export interface IFilterViewPaneOptions extends IViewPaneOptions {
	readonly filterOptions: IFilterWidgetOptions;
}

/** Optional title content and actions projected together into a hosting Part. */
export interface PartTitleProjection {
	readonly content?: HTMLElement;
	readonly actions?: HTMLElement;
}

/** A titled, independently managed view hosted inside a workbench view container. */
export abstract class ViewPane extends Pane implements IView {
	private readonly constraintsChanged = this._register(new Emitter<void>());
	readonly onDidChangeConstraints = this.constraintsChanged.event;

	/** Intrinsic horizontal content constraint, independent of the current Part allocation. */
	get minimumWidth(): number { return 0; }

	protected notifyConstraintsChanged(): void {
		this.constraintsChanged.fire();
	}

	private readonly titleAreaUpdate = this._register(new Emitter<void>());
	public readonly onDidChangeTitleArea = this.titleAreaUpdate.event;

	public getActions(): readonly IAction[] { return []; }
	public getSecondaryActions(): readonly IAction[] { return []; }

	protected updateTitleArea(): void {
		this.titleAreaUpdate.fire();
	}

	/** Includes fixed controls in the body constraint while retaining an independent content viewport. */
	protected trackBodyMinimum(scrollableContent: HTMLElement, minimumContentHeight: number, enabled: () => boolean = () => true): void {
		const minimumBodyHeight = this.minimumBodySize;
		const update = this._register(new AnimationFrameScheduler(getWindow(this.element), () => {
			if (!this.isBodyVisible()) { return; }
			const reservedHeight = enabled()
				? Math.max(0, Math.max(this.contentElement.clientHeight, this.contentElement.scrollHeight) - scrollableContent.offsetHeight)
				: 0;
			this.minimumBodySize = Math.max(minimumBodyHeight, minimumContentHeight + reservedHeight);
		}));
		// Apply constraints outside ResizeObserver delivery to avoid a resize/layout feedback loop.
		this._register(observeResize([this.contentElement, ...this.contentElement.children], () => update.schedule()));
		this._register(this.onDidChangeBodyVisibility(visible => { if (visible) { update.schedule(); } }));
	}

	public override setTitle(title: string): void {
		if (title === this.paneTitle) return;
		super.setTitle(title);
		this.updateTitleArea();
	}

	public override setHeaderActionsHost(host?: HTMLElement, actions?: HTMLElement): void {
		super.setHeaderActionsHost(host);
		if (!host || !actions) return;
		// The Part owns the renderer; this View keeps the scope and focus tracker on the lent action root.
		const focused = actions.contains(actions.ownerDocument.activeElement) ? actions.ownerDocument.activeElement as HTMLElement : undefined;
		this.headerActionsElement.append(actions);
		actions.setAttribute('aria-label', this.headerActionsElement.getAttribute('aria-label') ?? this.paneTitle);
		focused?.focus();
	}

	public captureTitleActionsFocus(): (() => void) | undefined {
		const activeElement = this.headerActionsElement.ownerDocument.activeElement;
		if (!this.headerActionsElement.contains(activeElement)) return undefined;
		const actionId = (activeElement as HTMLElement).closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		if (!actionId) return undefined;
		return () => {
			const entry = [...this.headerActionsElement.querySelectorAll<HTMLElement>('[data-action-id]')].find(element => element.dataset.actionId === actionId);
			// Revealing the pane's focus actions must precede focusing a control hidden until focus enters it.
			if (entry && this.isHeaderVisible()) this.element.focus();
			entry?.querySelector<HTMLElement>('button:not(:disabled), [tabindex]')?.focus();
		};
	}
	protected readonly viewWelcomeState = this._register(new Emitter<void>());
	public readonly onDidChangeViewWelcomeState = this.viewWelcomeState.event;

	public shouldShowWelcome(): boolean {
		return false;
	}
	private visible = false;
	private readonly bodyVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeBodyVisibility = this.bodyVisibility.event;
	private readonly visibility = this._register(new Emitter<boolean>());
	public readonly onDidChangeVisibility = this.visibility.event;

	protected constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.element.classList.add("ash-view-pane");
		this.element.dataset.viewId = options.id;
		this.element.hidden = true;
	}

	/** Optional title content and actions projected into the hosting Pane Composite Part. */
	get partTitleProjection(): PartTitleProjection | undefined {
		return undefined;
	}

	/** Views with intrinsic content widths report them independently of the current allocation. */
	getOptimalWidth(): number {
		return 0;
	}

	isVisible(): boolean {
		return this.visible;
	}

	isBodyVisible(): boolean {
		return this.visible && this.isExpanded();
	}

	isExpanded(): boolean {
		return !this.isCollapsed();
	}

	setExpanded(expanded: boolean): boolean {
		const changed = expanded !== this.isExpanded();
		this.setCollapsed(!expanded);
		return changed;
	}

	override setCollapsed(collapsed: boolean): void {
		if (collapsed === this.isCollapsed()) return;
		const bodyWasVisible = this.isBodyVisible();
		super.setCollapsed(collapsed);
		if (bodyWasVisible !== this.isBodyVisible()) this.bodyVisibility.fire(this.isBodyVisible());
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.element.hidden = !visible;
		this.visibility.fire(visible);
		if (this.isExpanded()) this.bodyVisibility.fire(visible);
	}
}

/** Keeps one filter owner while moving its input between the title and body. */
export abstract class FilterViewPane extends ViewPane {
	readonly filterWidget: FilterWidget;
	protected readonly filterContainer: HTMLElement;
	private bodyDimension: { height: number; width: number; } | undefined;

	constructor(container: HTMLElement, options: IFilterViewPaneOptions,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(container, options);
		this.element.classList.add('ash-filter-view-pane');
		this.filterWidget = this._register(instantiationService.createInstance(FilterWidget, options.filterOptions));
		this.filterContainer = h(container.ownerDocument, 'div');
		this.filterContainer.className = 'ash-view-pane-filter-container';
		this.contentElement.append(this.filterContainer);
		this.filterContainer.append(this.filterWidget.element);
		this._register(this.filterWidget.onDidAcceptFilterText(() => this.focusBodyContent()));
	}

	getFilterWidget(): FilterWidget { return this.filterWidget; }

	shouldShowFilterInHeader(): boolean {
		return this.bodyDimension !== undefined && (this.bodyDimension.width >= 600 || this.bodyDimension.height <= 100);
	}

	protected override layoutBody(height: number, width: number): void {
		this.bodyDimension = { height, width };
		const inHeader = this.shouldShowFilterInHeader();
		const host = inHeader ? this.headerActionsElement : this.filterContainer;
		const focused = this.filterWidget.hasFocus();
		const moved = this.filterWidget.element.parentElement !== host;
		if (moved) host.prepend(this.filterWidget.element);
		this.filterContainer.hidden = inHeader;
		this.filterWidget.element.classList.toggle('ash-view-filter-in-header', inHeader);
		this.filterWidget.layout(inHeader ? Math.min(400, Math.max(0, width - 160)) : Math.max(0, width - 16));
		// Reparenting can blur a focused input, including when its title is hosted by a Part.
		if (focused && moved) this.filterWidget.focus();
		this.layoutBodyContent(Math.max(0, height - (inHeader ? 0 : 44)), width);
		if (moved) this.updateTitleArea();
	}

	override captureTitleActionsFocus(): (() => void) | undefined {
		return this.filterWidget.hasFocus() ? () => this.filterWidget.focus() : super.captureTitleActionsFocus();
	}

	protected abstract layoutBodyContent(height: number, width: number): void;

	protected focusBodyContent(): void { this.focus(); }
}

/** Owns welcome DOM and listeners for the pane that creates it. */
export class ViewWelcomeController extends Disposable {
	private readonly renderedContent = this._register(new DisposableStore());
	private readonly domNode: HTMLElement;
	private readonly scrollable: ScrollableElement;
	private descriptors: readonly IViewContentDescriptor[] = [];
	private readonly buttons: { button: Button; descriptor: IViewContentDescriptor; }[] = [];
	private isEnabled = false;
	public get enabled(): boolean { return this.isEnabled; }

	constructor(
		private readonly container: HTMLElement,
		private readonly delegate: Pick<ViewPane, 'id' | 'shouldShowWelcome' | 'onDidChangeViewWelcomeState'>,
		private readonly registry: WorkbenchViewRegistry,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IOpenerService private readonly openerService: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-view-welcome hidden';
		this.domNode.hidden = true;
		this.domNode.tabIndex = -1;
		this.domNode.setAttribute('role', 'region');
		this.domNode.setAttribute('aria-label', localize('view.welcome', 'Welcome'));
		container.append(this.domNode);
		this.scrollable = this._register(new ScrollableElement(this.domNode, { direction: 'vertical', tabIndex: -1 }));
		this.scrollable.element.classList.add('ash-view-welcome-viewport');
		this.scrollable.contentElement.classList.add('ash-view-welcome-content');
		this._register(toDisposable(() => {
			container.classList.remove('welcome');
			this.domNode.remove();
		}));
		this._register(delegate.onDidChangeViewWelcomeState(() => this.update()));
		this._register(registry.onDidChangeViewWelcomeContent(id => {
			if (id === delegate.id) this.update();
		}));
		this._register(contextKeyService.onDidChangeContext(event => {
			const keys = new Set<string>();
			for (const descriptor of registry.getViewWelcomeContent(delegate.id)) {
				for (const expression of [descriptor.when, descriptor.precondition]) {
					if (expression && expression !== 'default') {
						for (const key of expression.keys()) keys.add(key);
					}
				}
			}
			if (event.affectsSome(keys)) this.update();
		}));
	}

	public focus(): void {
		(this.buttons.find(item => item.button.enabled)?.button.domNode ?? this.domNode).focus();
	}

	public update(): void {
		if (this.isDisposed) return;
		const contents = this.registry.getViewWelcomeContent(this.delegate.id);
		let selected = contents.filter(descriptor => descriptor.when !== 'default' && this.contextKeyService.contextMatchesRules(descriptor.when, this.container));
		if (selected.length === 0) selected = contents.filter(descriptor => descriptor.when === 'default');
		const enabled = this.delegate.shouldShowWelcome() && selected.length > 0;
		const hadFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
		this.isEnabled = enabled;
		this.domNode.hidden = !enabled;
		this.domNode.classList.toggle('hidden', !enabled);
		this.container.classList.toggle('welcome', enabled);
		if (!enabled) selected = [];
		if (selected.length !== this.descriptors.length || selected.some((descriptor, index) => descriptor !== this.descriptors[index])) {
			this.renderedContent.clear();
			this.buttons.length = 0;
			this.scrollable.replaceChildren();
			this.descriptors = selected;
			for (const descriptor of selected) {
				for (const line of descriptor.content.split('\n').map(line => line.trim()).filter(Boolean)) {
					const link = /^\[([^\]]+)\]\((command:[^\s)]+)\)$/u.exec(line);
					if (link) {
						const button = this.renderedContent.add(new Button(this.scrollable.contentElement, {
							...defaultButtonStyles,
							label: link[1],
							title: link[1],
							presentation: 'primary',
							onClick: () => { void this.open(link[2], descriptor); },
						}));
						this.buttons.push({ button, descriptor });
					} else {
						const paragraph = h(this.domNode.ownerDocument, 'p');
						paragraph.textContent = line;
						this.scrollable.contentElement.append(paragraph);
					}
				}
			}
		}
		for (const { button, descriptor } of this.buttons) {
			button.enabled = this.contextKeyService.contextMatchesRules(descriptor.precondition, this.container);
		}
		this.scrollable.layout();
		if (hadFocus) {
			if (enabled && !this.domNode.contains(this.domNode.ownerDocument.activeElement)) this.focus();
			if (!enabled) this.container.closest<HTMLElement>('.ash-view-pane')?.focus();
		}
	}

	private async open(target: string, descriptor: IViewContentDescriptor): Promise<void> {
		if (!this.enabled || !this.contextKeyService.contextMatchesRules(descriptor.precondition, this.container)) return;
		try {
			// Only registered product content reaches this renderer; command links retain their existing host owner.
			await this.openerService.open(target, { allowCommands: true, fromUserGesture: true });
		} catch (error) {
			this.notifications.error(localize('view.welcome.actionFailed', 'Could not complete the action: {0}', error instanceof Error ? error.message : String(error)));
		}
	}
}
