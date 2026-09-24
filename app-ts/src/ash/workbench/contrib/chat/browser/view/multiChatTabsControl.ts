import "./multiChatTabsControl.css";
import { TabList } from "../../../../../base/browser/ui/tablist/tabList.js";
import { ChatTabsControl, type ChatTab, type ChatTabsDelegate, type ChatTabsPresentation } from "./chatTabsControl.js";

interface ChatTabDescriptor {
	readonly id: string;
	readonly label: string;
	readonly panelId: string;
	readonly tabId: string;
}

/** Maps untitled and durable Chat sessions onto one reorderable tab list. */
export class MultiChatTabsControl extends ChatTabsControl {
	private readonly tabList: TabList<string>;
	private readonly idPrefix: string;
	private readonly tabIds = new Map<string, string>();
	private draggedTabId: string | undefined;
	private nextTabId = 0;

	constructor(container: HTMLElement, idPrefix: string, delegate: ChatTabsDelegate, presentation: ChatTabsPresentation) {
		super(container, presentation);
		this.idPrefix = idPrefix;
		this.element.classList.add("ash-multi-chat-tabs-control");
		this.tabList = this._register(new TabList(this.element, {
			ariaLabel: "Open chats",
			presentation: "inset",
			draggable: true,
			dragAndDrop: {
				canDrop: () => this.draggedTabId !== undefined,
				onDragStart: (tabId) => {
					this.draggedTabId = tabId;
				},
				onDrop: (targetTabId, position) => {
					const sourceTabId = this.draggedTabId;
					if (sourceTabId) delegate.moveTab(sourceTabId, targetTabId, position);
				},
				onDragEnd: () => {
					this.draggedTabId = undefined;
				},
			},
			onActivate: (tabId) => delegate.selectTab(tabId),
			onClose: (tabId) => delegate.closeTab(tabId),
		}));
	}

	setTabs(entries: readonly ChatTab[], activeTabId: string | undefined): ReadonlyMap<string, string> {
		const tabs = entries.map(({ id, label, panelId }) => {
			let tabId = this.tabIds.get(id);
			if (!tabId) {
				tabId = `${this.idPrefix}-tab-${++this.nextTabId}`;
				this.tabIds.set(id, tabId);
			}
			return { id, label, panelId, tabId } satisfies ChatTabDescriptor;
		});
		this.tabList.setTabs(tabs.map((tab) => ({
			id: tab.id,
			value: tab.id,
			label: tab.label,
			tabId: tab.tabId,
			panelId: tab.panelId,
		})), activeTabId);
		this.element.hidden = tabs.length === 0;
		return new Map(tabs.map((tab) => [tab.id, tab.tabId]));
	}
}
