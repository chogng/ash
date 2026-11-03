import { addDisposableListener, h, isHTMLElement, isNode, stopEvent } from '../../../base/browser/dom.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { ContextView, ContextViewFocusRestore, type ContextViewAnchor } from '../../../base/browser/ui/contextview/contextview.js';
import { TabList, type TabListItem } from '../../../base/browser/ui/tablist/tabList.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { AnchorAxisAlignment, AnchorPosition } from '../../../base/common/layout.js';
import type { Icon } from '../../../base/common/icon.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IContextViewService } from '../../contextview/browser/contextView.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../theme/browser/defaultStyles.js';
import { ActionList, type IActionListDelegate, type IActionListItem, type IActionListOptions } from './actionList.js';
import { ACTION_WIDGET_ANIMATED_CLASS, finishActionWidgetOpeningAnimation } from './actionWidgetMotion.js';
import './tabbedActionListWidget.css';

export interface ITabDescriptor {
	readonly id: string;
	readonly label: string;
	readonly icon?: Icon;
}

export interface ITabbedActionListBuildResult<T> {
	readonly items: readonly IActionListItem<T>[];
	readonly listOptions?: IActionListOptions;
}

export interface ITabbedActionListShowOptions<T> {
	readonly user: string;
	readonly anchor: ContextViewAnchor;
	/** Empty for a single ungrouped list with no tab navigation. */
	readonly tabs: readonly ITabDescriptor[];
	readonly initialTab: string;
	readonly delegate: IActionListDelegate<T>;
	readonly width?: number;
	readonly supportsPreview?: boolean;
	createActionList(activeTab: string): ITabbedActionListBuildResult<T>;
	renderWidget?(container: HTMLElement): IDisposable;
	renderHeader?(container: HTMLElement): IDisposable;
	renderFooter?(container: HTMLElement, activeTab: string, sidePanel: ContextView | undefined): IDisposable;
	renderHover?(item: T, container: HTMLElement): IDisposable | undefined;
	openItemDetails?(item: IActionListItem<T>): boolean;
	readonly isBodyCollapsed?: () => boolean;
	focusFooter?(): void;
}

export interface ITabbedActionListDetailsOptions {
	readonly label: string;
	readonly backLabel: string;
	render(container: HTMLElement): IDisposable;
	focus?(container: HTMLElement): void;
}

/** Owns one anchored popup; changing pages retains the list's filter, scroll and pending action. */
export class TabbedActionListWidget extends Disposable {
	private readonly popup = new MutableDisposable<DisposableStore>();
	private refresh: (() => void) | undefined;
	private openDetails: ((options: ITabbedActionListDetailsOptions) => void) | undefined;
	private back: (() => void) | undefined;
	private detailsVisible = false;

	constructor(
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(toDisposable(() => this.hide()));
		this._register(this.popup);
	}

	public get isVisible(): boolean { return this.popup.value !== undefined; }
	public get isShowingDetails(): boolean { return this.detailsVisible; }

	public show<T>(options: ITabbedActionListShowOptions<T>): void {
		this.hide();
		const lifetime = new DisposableStore();
		this.popup.value = lifetime;
		let activeTab = options.initialTab;
		const initial = options.createActionList(activeTab);
		const renderHover = options.renderHover;
		const sidePanel = renderHover ? lifetime.add(new ContextView(this.contextViewService.container)) : undefined;
		const hoverContent = lifetime.add(new MutableDisposable<IDisposable>());
		let pending: { item: T; row: HTMLElement; } | undefined;
		let shownRow: HTMLElement | undefined;
		let pointer: MouseEvent | undefined;
		let previousPointer: MouseEvent | undefined;
		let grace: { origin: MouseEvent; until: number; } | undefined;
		const showHover = lifetime.add(new RunOnceScheduler(() => {
			const target = pending;
			pending = undefined;
			grace = undefined;
			if (!target?.row.isConnected || !sidePanel || !renderHover || this.detailsVisible) return;
			const host = h(root.ownerDocument, 'div', { className: 'ash-action-widget-side-preview' });
			const rendered = renderHover(target.item, host);
			if (!rendered) { sidePanel.hide(); return; }
			sidePanel.hide();
			hoverContent.value = rendered;
			const row = target.row.getBoundingClientRect();
			const picker = root.getBoundingClientRect();
			const shown = sidePanel.show({
				anchor: { left: picker.left, width: picker.width, top: row.top, height: row.height },
				content: host,
				presentation: 'menu',
				anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
				anchorPosition: AnchorPosition.Above,
				gap: 4,
				onEscape: () => { this.hide(); return true; },
				onHide: () => {
					shownRow = undefined;
					hoverContent.clear();
				},
			});
			if (shown) { shownRow = target.row; }
			else { hoverContent.clear(); }
		}, 250));
		const cancelHover = (): void => {
			pending = undefined;
			grace = undefined;
			showHover.cancel();
		};
		const onHover = (item: T, row: HTMLElement): void => {
			if (!sidePanel || this.detailsVisible) return;
			if (row === shownRow) { cancelHover(); return; }
			let delay = 250;
			if (sidePanel.visible && pointer && previousPointer) {
				const now = Date.now();
				const origin = grace?.origin ?? previousPointer;
				const bounds = sidePanel.element.getBoundingClientRect();
				if (isMovingIntoPanel(origin, pointer, bounds)) {
					grace ??= { origin, until: now + 200 };
					delay = Math.max(0, grace.until - now);
				} else {
					grace = undefined;
					delay = 0;
				}
			} else if (pending?.row === row) {
				return;
			}
			pending = { item, row };
			showHover.schedule(delay);
		};

		const list = lifetime.add(this.instantiationService.createInstance(ActionList<T>, options.user, initial.items, {
			...options.delegate,
			onHover: renderHover ? onHover : options.delegate.onHover,
		}, this.contextViewService.container, undefined, options.supportsPreview ?? false, initial.listOptions ?? {}, sidePanel));
		const root = list.domNode;
		root.classList.add('ash-tabbed-action-list');
		if (sidePanel) {
			lifetime.add(addDisposableListener(root, 'mousemove', event => {
				previousPointer = pointer;
				pointer = event;
			}, true));
			lifetime.add(addDisposableListener(sidePanel.element, 'mouseenter', cancelHover));
			lifetime.add(addDisposableListener(root, 'mouseout', event => {
				if (pending?.row.contains(event.target as Node) && (!isNode(event.relatedTarget) || !pending.row.contains(event.relatedTarget))) {
					pending = undefined;
					showHover.cancel();
				}
			}));
			for (const type of ['input', 'keydown', 'pointerdown'] as const) {
				lifetime.add(addDisposableListener(root, type, () => {
					cancelHover();
					if (shownRow) { sidePanel.hide(); }
				}));
			}
		}

		const document = root.ownerDocument;
		const panel = h(document, 'div');
		panel.className = 'ash-tabbed-action-list-panel';
		panel.id = `${options.user}.action-panel`;
		panel.append(...root.childNodes);
		const tabHost = h(document, 'div');
		tabHost.className = 'ash-tabbed-action-list-tabbar';
		const details = h(document, 'div');
		details.className = 'ash-tabbed-action-list-details';
		details.hidden = true;
		const footer = h(document, 'div');
		footer.className = 'ash-tabbed-action-list-footer';
		const renderHeader = options.renderHeader;
		const header = renderHeader ? h(document, 'div') : undefined;
		root.append(tabHost, panel, details, footer);
		if (header && renderHeader) {
			root.insertBefore(header, panel);
			lifetime.add(renderHeader(header));
		}
		const footerLifetime = lifetime.add(new MutableDisposable<IDisposable>());
		const detailLifetime = lifetime.add(new MutableDisposable<DisposableStore>());
		const describeTabs = (): TabListItem<string>[] => options.tabs.map((tab, index) => ({
			id: tab.id, value: tab.id, label: tab.label, tooltip: tab.label,
			icon: tab.icon,
			tabId: `${options.user}.action-tab.${index}`, panelId: panel.id,
		}));
		let descriptors = describeTabs();
		const layout = (): void => {
			finishActionWidgetOpeningAnimation(root);
			const maximum = Math.max(100, document.defaultView!.innerWidth - 16);
			root.style.width = `${Math.min(maximum, options.width ?? list.layout(0))}px`;
			this.contextViewService.layout();
		};
		let renderedFooterTab: string | undefined;
		const refresh = (): void => {
			descriptors = describeTabs();
			if (!descriptors.some(tab => tab.id === activeTab)) { activeTab = descriptors[0]?.id ?? ''; }
			tabs.setTabs(descriptors, descriptors.length ? activeTab : undefined);
			const active = descriptors.find(tab => tab.id === activeTab);
			if (active) {
				panel.setAttribute('role', 'tabpanel');
				panel.setAttribute('aria-labelledby', active.tabId);
			} else {
				panel.removeAttribute('role');
				panel.removeAttribute('aria-labelledby');
			}
			cancelHover();
			if (shownRow) { sidePanel?.hide(); }
			const result = options.createActionList(activeTab);
			list.updateItems(result.items, result.listOptions);
			if (!this.detailsVisible) {
				panel.hidden = options.isBodyCollapsed?.() ?? false;
				tabHost.hidden = panel.hidden || descriptors.length === 0;
			}
			if (renderedFooterTab !== activeTab) {
				renderedFooterTab = activeTab;
				footerLifetime.clear();
				footer.replaceChildren();
				footerLifetime.value = options.renderFooter?.(footer, activeTab, sidePanel);
			}
			const focused = document.activeElement;
			if (focused instanceof document.defaultView!.HTMLElement && root.contains(focused) && focused.closest('[hidden]')) { list.focusFilter(); }
			layout();
		};
		const tabs = lifetime.add(new TabList<string>(tabHost, {
			ariaLabel: localize('actionWidget.tabs', 'Action categories'),
			presentation: 'underline',
			onActivate: id => {
				activeTab = id;
				tabs.setTabs(descriptors, id);
				panel.setAttribute('aria-labelledby', descriptors.find(tab => tab.id === id)!.tabId);
				refresh();
			},
		}));
		tabs.setTabs(descriptors, descriptors.length ? activeTab : undefined);
		let returnFocus: HTMLElement | undefined;
		this.back = () => {
			if (!this.detailsVisible) { return; }
			this.detailsVisible = false;
			details.hidden = true;
			panel.hidden = options.isBodyCollapsed?.() ?? false;
			tabHost.hidden = panel.hidden || descriptors.length === 0;
			footer.hidden = false;
			if (header) { header.hidden = false; }
			detailLifetime.clear();
			details.replaceChildren();
			if (returnFocus?.isConnected) { returnFocus.focus({ preventScroll: true }); }
			else { list.focus(); }
			layout();
		};
		this.openDetails = detailOptions => {
			if (!this.detailsVisible) { returnFocus = document.activeElement as HTMLElement; }
			this.detailsVisible = true;
			cancelHover();
			sidePanel?.hide();
			detailLifetime.value = new DisposableStore();
			const scope = detailLifetime.value;
			details.replaceChildren();
			tabHost.hidden = panel.hidden = footer.hidden = true;
			if (header) { header.hidden = true; }
			details.hidden = false;
			const back = scope.add(new Button(details, {
				...defaultButtonStyles, presentation: 'secondary', label: detailOptions.backLabel,
				onClick: () => this.hideDetails(),
			}));
			back.domNode.classList.add('ash-tabbed-action-list-back');
			const content = h(document, 'section');
			content.className = 'ash-tabbed-action-list-detail-content';
			content.setAttribute('aria-label', detailOptions.label);
			details.append(content);
			scope.add(detailOptions.render(content));
			layout();
			if (detailOptions.focus) { detailOptions.focus(content); }
			else { back.focus(); }
		};
		this.refresh = refresh;
		lifetime.add(toDisposable(() => {
			this.refresh = this.openDetails = this.back = undefined;
			this.detailsVisible = false;
		}));
		lifetime.add(list.onDidRequestLayout(layout));
		lifetime.add(addDisposableListener(document.defaultView!, 'resize', layout));
		lifetime.add(addDisposableListener(root, 'keydown', event => {
			if (event.isComposing) { return; }
			if (event.altKey && event.key === 'ArrowLeft' && this.detailsVisible) {
				stopEvent(event);
				this.hideDetails();
			} else if (event.key === 'ArrowDown' && tabHost.contains(event.target as Node)) {
				stopEvent(event);
				list.focus();
			} else if (event.key === 'ArrowRight' && panel.contains(event.target as Node) && !this.detailsVisible) {
				const item = list.getFocusedElement();
				if (item && options.openItemDetails?.(item)) { stopEvent(event); }
			}
		}, true));
		const extra = options.renderWidget?.(root);
		if (extra) { lifetime.add(extra); }
		refresh();
		const anchor = options.anchor;
		if (isHTMLElement(anchor) && anchor.hasAttribute('aria-expanded')) {
			anchor.setAttribute('aria-expanded', 'true');
			lifetime.add(toDisposable(() => anchor.setAttribute('aria-expanded', 'false')));
		}
		const shown = this.contextViewService.show({
			anchor: options.anchor, content: root, presentation: 'plain', gap: 4,
			focusRestore: ContextViewFocusRestore.Previous,
			blockOutsidePointer: true,
			isTargetWithin: target => sidePanel?.contains(target) ?? false,
			onHide: () => {
				if (this.popup.value === lifetime) { this.popup.clear(); }
				options.delegate.onHide();
			},
		});
		if (shown) {
			root.classList.add(ACTION_WIDGET_ANIMATED_CLASS);
			if (options.isBodyCollapsed?.()) { options.focusFooter?.(); }
			else if (initial.listOptions?.focusFilterOnOpen && initial.listOptions.filterVisible !== false) { list.focusFilter(); }
			else { list.focus(); }
		} else { this.popup.clear(); }
	}

	public refreshActiveList(): void { this.refresh?.(); }
	public showDetails(options: ITabbedActionListDetailsOptions): void { this.openDetails?.(options); }
	public hideDetails(): void { this.back?.(); }
	public hide(): void {
		if (this.isVisible) { this.contextViewService.hide(); }
	}
}

/** The near edge and the last pointer position bound the path into either side panel. */
function isMovingIntoPanel(origin: MouseEvent, pointer: MouseEvent, bounds: DOMRect): boolean {
	const edge = origin.clientX <= bounds.left ? bounds.left : bounds.right;
	const distance = edge - origin.clientX;
	if (distance === 0) return false;
	const progress = (pointer.clientX - origin.clientX) / distance;
	if (progress <= 0 || progress > 1) return false;
	const top = origin.clientY + (bounds.top - origin.clientY) * progress;
	const bottom = origin.clientY + (bounds.bottom - origin.clientY) * progress;
	return pointer.clientY >= top && pointer.clientY <= bottom;
}
