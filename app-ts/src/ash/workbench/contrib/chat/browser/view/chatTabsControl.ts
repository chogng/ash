import type { TabListDropPosition } from "../../../../../base/browser/ui/tablist/tabList.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { h } from "../../../../../base/browser/dom.js";

export interface ChatTab {
	readonly id: string;
	readonly label: string;
	readonly panelId: string;
}

export type ChatTabsPresentation = "pane-title";

/** Callbacks through which a Chat tab presentation requests Session mutations. */
export interface ChatTabsDelegate {
	selectTab(tabId: string): void;
	closeTab(tabId: string): void;
	moveTab(sourceTabId: string, targetTabId: string | undefined, position: TabListDropPosition): void;
}

/** Common lifecycle contract implemented by each Chat tab presentation mode. */
export abstract class ChatTabsControl extends Disposable {
	readonly element: HTMLDivElement;

	protected constructor(container: HTMLElement, presentation: ChatTabsPresentation) {
		super();
		this.element = h(container.ownerDocument, "div");
		this.element.className = "ash-chat-tabs-control";
		this.element.classList.add(`ash-chat-tabs-${presentation}`);
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
	}

	abstract setTabs(entries: readonly ChatTab[], activeTabId: string | undefined): ReadonlyMap<string, string>;
}
