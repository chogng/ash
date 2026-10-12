import "./media/multiChatTabsControl.css";
import type { TabListOptions } from "../../../../../../base/browser/ui/tablist/tabList.js";
import { WorkbenchTabsControl } from '../../../../../browser/parts/editor/workbenchTabsControl.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../../../nls.js';
import { ChatTabsControl, type ChatTab, type ChatTabsDelegate, type ChatTabsPresentation } from "./chatTabsControl.js";

interface ChatTabDescriptor {
	readonly id: string;
	readonly label: string;
	readonly panelId: string;
	readonly tabId: string;
}

/** Maps untitled and durable Chat sessions onto one reorderable tab list. */
export class MultiChatTabsControl extends ChatTabsControl {
	private readonly tabs: WorkbenchTabsControl<string>;
	private readonly idPrefix: string;
	private readonly tabIds = new Map<string, string>();
	private hasRenderedTabs = false;
	private renderedTabs: readonly ChatTab[] = [];
	private renderedActiveTabId: string | undefined;
	private renderedTabIds: ReadonlyMap<string, string> = new Map();
	private draggedTabId: string | undefined;
	private nextTabId = 0;

	constructor(container: HTMLElement, idPrefix: string, delegate: ChatTabsDelegate, presentation: ChatTabsPresentation, @IInstantiationService instantiationService: IInstantiationService) {
		super(container, presentation);
		this.idPrefix = idPrefix;
		this.element.classList.add("ash-multi-chat-tabs-control");
		this.tabs = this._register(instantiationService.createInstance(WorkbenchTabsControl<string>, this.element, {
			ariaLabel: localize("chat.tabs.openChats", "Open chats"),
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
		} satisfies TabListOptions<string>));
	}

	setTabs(entries: readonly ChatTab[], activeTabId: string | undefined): ReadonlyMap<string, string> {
		if (this.hasRenderedTabs && this.renderedActiveTabId === activeTabId && entries.length === this.renderedTabs.length
			&& entries.every((entry, index) => entry.id === this.renderedTabs[index]?.id
				&& entry.label === this.renderedTabs[index]?.label
				&& entry.panelId === this.renderedTabs[index]?.panelId)) {
			return this.renderedTabIds;
		}
		const tabs = entries.map(({ id, label, panelId }) => {
			let tabId = this.tabIds.get(id);
			if (!tabId) {
				tabId = `${this.idPrefix}-tab-${++this.nextTabId}`;
				this.tabIds.set(id, tabId);
			}
			return { id, label, panelId, tabId } satisfies ChatTabDescriptor;
		});
		this.tabs.setTabs(tabs.map((tab) => ({
			id: tab.id,
			value: tab.id,
			label: tab.label,
			tabId: tab.tabId,
			panelId: tab.panelId,
		})), activeTabId);
		this.element.hidden = tabs.length === 0;
		this.hasRenderedTabs = true;
		this.renderedTabs = entries.map(({ id, label, panelId }) => ({ id, label, panelId }));
		this.renderedActiveTabId = activeTabId;
		this.renderedTabIds = new Map(tabs.map((tab) => [tab.id, tab.tabId]));
		return this.renderedTabIds;
	}
}
