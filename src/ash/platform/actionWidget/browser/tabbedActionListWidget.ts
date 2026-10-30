import { addDisposableListener, h, stopEvent } from '../../../base/browser/dom.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { ContextViewFocusRestore, type ContextViewAnchor } from '../../../base/browser/ui/contextview/contextview.js';
import { TabList, type TabListItem } from '../../../base/browser/ui/tablist/tabList.js';
import type { Icon } from '../../../base/common/icon.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IContextViewService } from '../../contextview/browser/contextView.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../theme/browser/defaultStyles.js';
import { ActionList, type IActionListDelegate, type IActionListItem, type IActionListOptions } from './actionList.js';
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
	readonly tabs: readonly ITabDescriptor[];
	readonly initialTab: string;
	readonly delegate: IActionListDelegate<T>;
	readonly width?: number;
	readonly supportsPreview?: boolean;
	createActionList(activeTab: string): ITabbedActionListBuildResult<T>;
	renderWidget?(container: HTMLElement): IDisposable;
	renderFooter?(container: HTMLElement, activeTab: string): IDisposable;
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
		const list = lifetime.add(this.instantiationService.createInstance(ActionList<T>, options.user, initial.items, {
			...options.delegate,
		}, this.contextViewService.container, undefined, options.supportsPreview ?? false, initial.listOptions ?? {}));
		const root = list.domNode;
		root.classList.add('ash-tabbed-action-list');
		const document = root.ownerDocument;
		const panel = h(document, 'div');
		panel.className = 'ash-tabbed-action-list-panel';
		panel.id = `${options.user}.action-panel`;
		panel.setAttribute('role', 'tabpanel');
		panel.append(...root.childNodes);
		const tabHost = h(document, 'div');
		tabHost.className = 'ash-tabbed-action-list-tabbar';
		const details = h(document, 'div');
		details.className = 'ash-tabbed-action-list-details';
		details.hidden = true;
		const footer = h(document, 'div');
		footer.className = 'ash-tabbed-action-list-footer';
		root.append(tabHost, panel, details, footer);
		const footerLifetime = lifetime.add(new MutableDisposable<IDisposable>());
		const detailLifetime = lifetime.add(new MutableDisposable<DisposableStore>());
		const describeTabs = (): TabListItem<string>[] => options.tabs.map((tab, index) => ({
			id: tab.id, value: tab.id, label: tab.label, tooltip: tab.label,
			icon: tab.icon,
			tabId: `${options.user}.action-tab.${index}`, panelId: panel.id,
		}));
		let descriptors = describeTabs();
		const layout = (): void => {
			const maximum = Math.max(100, document.defaultView!.innerWidth - 16);
			root.style.width = `${Math.min(maximum, options.width ?? list.layout(0))}px`;
			this.contextViewService.layout();
		};
		let renderedFooterTab: string | undefined;
		const refresh = (): void => {
			descriptors = describeTabs();
			if (!descriptors.some(tab => tab.id === activeTab)) { activeTab = descriptors[0]!.id; }
			tabs.setTabs(descriptors, activeTab);
			panel.setAttribute('aria-labelledby', descriptors.find(tab => tab.id === activeTab)!.tabId);
			const result = options.createActionList(activeTab);
			list.updateItems(result.items, result.listOptions);
			if (!this.detailsVisible) { tabHost.hidden = panel.hidden = options.isBodyCollapsed?.() ?? false; }
			if (renderedFooterTab !== activeTab) {
				renderedFooterTab = activeTab;
				footerLifetime.clear();
				footer.replaceChildren();
				footerLifetime.value = options.renderFooter?.(footer, activeTab);
			}
			const active = document.activeElement;
			if (active instanceof document.defaultView!.HTMLElement && root.contains(active) && active.closest('[hidden]')) { list.focusFilter(); }
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
		tabs.setTabs(descriptors, activeTab);
		panel.setAttribute('aria-labelledby', descriptors.find(tab => tab.id === activeTab)!.tabId);
		let returnFocus: HTMLElement | undefined;
		this.back = () => {
			if (!this.detailsVisible) { return; }
			this.detailsVisible = false;
			details.hidden = true;
			tabHost.hidden = panel.hidden = footer.hidden = false;
			detailLifetime.clear();
			details.replaceChildren();
			if (returnFocus?.isConnected) { returnFocus.focus({ preventScroll: true }); }
			else { list.focus(); }
			layout();
		};
		this.openDetails = detailOptions => {
			if (!this.detailsVisible) { returnFocus = document.activeElement as HTMLElement; }
			this.detailsVisible = true;
			detailLifetime.value = new DisposableStore();
			const scope = detailLifetime.value;
			details.replaceChildren();
			tabHost.hidden = panel.hidden = footer.hidden = true;
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
			} else if (event.key === 'ArrowRight' && !tabHost.contains(event.target as Node) && !this.detailsVisible) {
				const item = list.getFocusedElement();
				if (item && options.openItemDetails?.(item)) { stopEvent(event); }
			}
		}, true));
		const extra = options.renderWidget?.(root);
		if (extra) { lifetime.add(extra); }
		refresh();
		const shown = this.contextViewService.show({
			anchor: options.anchor, content: root, presentation: 'plain', gap: 4,
			focusRestore: ContextViewFocusRestore.Previous,
			onHide: () => {
				if (this.popup.value === lifetime) { this.popup.clear(); }
				options.delegate.onHide();
			},
		});
		if (shown) {
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
