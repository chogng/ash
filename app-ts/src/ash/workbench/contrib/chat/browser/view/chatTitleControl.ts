import "./chatTitleControl.css";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { AnchorPosition } from "../../../../../base/common/layout.js";
import { MenuWorkbenchToolBar } from "../../../../../platform/actions/browser/toolbar.js";
import { type IMenuService, MenuId } from "../../../../../platform/actions/common/actions.js";
import type { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import { ChatTabsControl, type ChatTab, type ChatTabsDelegate } from "./chatTabsControl.js";
import { MultiChatTabsControl } from "./multiChatTabsControl.js";
import type { PartTitleProjection } from "../../../../browser/parts/views/viewPane.js";
import { h } from "../../../../../base/browser/dom.js";

/** Owns Chat's title content and action projections. */
export class ChatTitleControl extends Disposable {
	private readonly tabs: ChatTabsControl;
	private readonly actionsElement: HTMLDivElement;
	private readonly layoutToolbar: MenuWorkbenchToolBar;

	constructor(container: HTMLElement, idPrefix: string, delegate: ChatTabsDelegate, menuService: IMenuService, contextMenuService: IContextMenuService) {
		super();
		const ownerDocument = container.ownerDocument;
		this.tabs = this._register(new MultiChatTabsControl(container, idPrefix, delegate, "pane-title"));
		this.actionsElement = h(ownerDocument, "div");
		this.actionsElement.className = "ash-chat-title-actions";
		container.append(this.actionsElement);
		const toolbar = this._register(new MenuWorkbenchToolBar(
			this.actionsElement,
			menuService,
			contextMenuService,
			MenuId.ChatTitle,
			{ hoverAnchorPosition: AnchorPosition.Below },
		));
		toolbar.element.setAttribute("aria-label", "Chat actions");
		this.layoutToolbar = this._register(new MenuWorkbenchToolBar(
			this.actionsElement,
			menuService,
			contextMenuService,
			MenuId.ChatTitleLayout,
			{ highlightToggledItems: true, hoverAnchorPosition: AnchorPosition.Below },
		));
		this.layoutToolbar.element.setAttribute("aria-label", "Chat layout");
		this.layoutToolbar.element.classList.add("ash-chat-title-layout-actions");
		this._register(toDisposable(() => this.actionsElement.remove()));
	}

	get partTitleProjection(): PartTitleProjection {
		return { content: this.tabs.element, actions: this.actionsElement };
	}

	captureFocus(): (() => void) | undefined {
		if (!this.layoutToolbar.element.contains(this.actionsElement.ownerDocument.activeElement)) return undefined;
		return () => this.layoutToolbar.focus();
	}

	setTabs(entries: readonly ChatTab[], activeTabId: string | undefined): ReadonlyMap<string, string> {
		return this.tabs.setTabs(entries, activeTabId);
	}
}
