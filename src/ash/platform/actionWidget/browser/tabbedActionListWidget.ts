import { addDisposableListener, h, stopEvent } from '../../../base/browser/dom.js';
import { TabList, type TabListItem } from '../../../base/browser/ui/tablist/tabList.js';
import { localize } from '../../../nls.js';
import { ActionList, type IActionListDelegate, type IActionListItem, type IActionListOptions } from './actionList.js';
import './tabbedActionListWidget.css';

export interface ITabDescriptor {
	readonly id: string;
	readonly label: string;
}

export interface ITabbedActionListBuildResult<T> {
	readonly items: readonly IActionListItem<T>[];
}

export interface ITabbedActionListShowOptions<T> {
	readonly tabs: readonly ITabDescriptor[];
	readonly initialTab: string;
	createActionList(activeTab: string): ITabbedActionListBuildResult<T>;
}

/** Keeps one action list and pending execution while the selected tab changes its contents. */
export class TabbedActionListWidget<T> extends ActionList<T> {
	constructor(
		user: string,
		items: readonly IActionListItem<T>[],
		delegate: IActionListDelegate<T>,
		container: HTMLElement,
		ariaHint: string | undefined,
		supportsPreview: boolean,
		listOptions: IActionListOptions,
		options: ITabbedActionListShowOptions<T>,
	) {
		super(user, items, delegate, container, ariaHint, supportsPreview, listOptions);
		const panel = h(container.ownerDocument, 'div');
		panel.id = `${user}.action-panel`;
		panel.setAttribute('role', 'tabpanel');
		panel.append(...this.domNode.childNodes);
		const tabHost = h(container.ownerDocument, 'div');
		tabHost.className = 'ash-tabbed-action-list-tabbar';
		this.domNode.append(tabHost, panel);
		const descriptors: TabListItem<string>[] = options.tabs.map((tab, index) => ({
			id: tab.id,
			value: tab.id,
			label: tab.label,
			tabId: `${user}.action-tab.${index}`,
			panelId: panel.id,
		}));
		const tabs = this._register(new TabList<string>(tabHost, {
			ariaLabel: localize('actionWidget.tabs', 'Action categories'),
			presentation: 'inset',
			onActivate: id => {
				this.updateItems(options.createActionList(id).items);
				tabs.setTabs(descriptors, id);
				panel.setAttribute('aria-labelledby', descriptors.find(tab => tab.id === id)!.tabId);
			},
		}));
		tabs.setTabs(descriptors, options.initialTab);
		panel.setAttribute('aria-labelledby', descriptors.find(tab => tab.id === options.initialTab)!.tabId);
		this._register(addDisposableListener(tabHost, 'keydown', event => {
			if (!event.isComposing && event.key === 'ArrowDown') {
				stopEvent(event);
				this.focus();
			}
		}, true));
	}
}
