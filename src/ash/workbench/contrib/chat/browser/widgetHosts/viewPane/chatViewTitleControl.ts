import './media/chatViewTitleControl.css';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { AnchorPosition } from '../../../../../../base/common/layout.js';
import { MenuWorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { getFlatContextMenuActions } from '../../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import type { PartTitleProjection } from '../../../../../browser/parts/views/viewPane.js';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';

import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { localize } from '../../../../../../nls.js';
import { onUnexpectedError } from '../../../../../../base/common/errors.js';
import { cancelOnDispose } from '../../../../../../base/common/cancellation.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchTabsControl } from '../../../../../browser/parts/editor/workbenchTabsControl.js';
import type { TabListItem, TabListOptions } from '../../../../../../base/browser/ui/tablist/tabList.js';
import { ButtonActionViewItem, type ActionViewItemOptions } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { SHOW_CHAT_HISTORY_COMMAND_ID } from '../../../common/chat.js';

/** Shows the current conversation and delegates switching to the shared history picker. */
export class ChatViewTitleControl extends Disposable {
	private readonly menuCancellation = cancelOnDispose(this._store);
	readonly titleId: string;
	private readonly titleElement: HTMLDivElement;
	private readonly titleButton: HTMLButtonElement;
	private readonly titleLabel: HTMLSpanElement;
	private readonly actionsElement: HTMLDivElement;
	private readonly layoutToolbar: MenuWorkbenchToolBar;
	private tabs: WorkbenchTabsControl<string> | undefined;
	private tabsHost: HTMLElement | undefined;

	constructor(
		container: HTMLElement,
		idPrefix: string,
		private readonly showHistory: (anchor: HTMLElement) => Promise<unknown>,
		@IMenuService private readonly menuService: IMenuService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.titleId = `${idPrefix}-title`;
		this.titleElement = h(ownerDocument, 'div');
		this.titleElement.className = 'ash-chat-view-title';
		this.titleButton = h(ownerDocument, 'button');
		this.titleButton.className = 'ash-chat-view-title-button';
		this.titleButton.type = 'button';
		this.titleButton.setAttribute('aria-haspopup', 'dialog');
		this.titleButton.setAttribute('aria-expanded', 'false');
		this.titleLabel = h(ownerDocument, 'span');
		this.titleLabel.id = this.titleId;
		this.titleLabel.className = 'ash-chat-view-title-label';
		this.titleButton.append(this.titleLabel);
		const chevron = appendIcon(Lxicon.dropDownButton, this.titleButton);
		chevron.classList.add('ash-chat-view-title-chevron');
		chevron.setAttribute('aria-hidden', 'true');
		this.titleElement.append(this.titleButton);
		container.append(this.titleElement);
		this._register(toDisposable(() => this.titleElement.remove()));
		this._register(addDisposableListener(this.titleButton, 'click', () => {
			this.openHistory(this.titleButton);
		}));
		this._register(addDisposableListener(this.titleButton, 'contextmenu', event => this.showTitleContextMenu(event)));
		this._register(addDisposableListener(this.titleButton, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) this.showTitleContextMenu(event);
		}));
		this.update(undefined);

		this.actionsElement = h(ownerDocument, 'div');
		this.actionsElement.className = 'ash-chat-title-actions';
		container.append(this.actionsElement);
		const toolbar = this._register(new MenuWorkbenchToolBar(
			this.actionsElement,
			menuService,
			contextMenuService,
			MenuId.ChatTitle,
			{
				hoverAnchorPosition: AnchorPosition.Below,
				menuOptions: { renderShortTitle: true },
				actionViewItemProvider: (action, options) => action.id === SHOW_CHAT_HISTORY_COMMAND_ID
					? new ChatHistoryActionViewItem(action, options, anchor => this.openHistory(anchor))
					: undefined,
			},
		));
		toolbar.element.setAttribute('aria-label', localize('chat.title.actions', 'Chat actions'));
		this.layoutToolbar = this._register(new MenuWorkbenchToolBar(
			this.actionsElement,
			menuService,
			contextMenuService,
			MenuId.ChatTitleLayout,
			{ highlightToggledItems: true, hoverAnchorPosition: AnchorPosition.Below },
		));
		this.layoutToolbar.element.setAttribute('aria-label', localize('chat.title.layout', 'Chat layout'));
		this.layoutToolbar.element.classList.add('ash-chat-title-layout-actions');
		this._register(toDisposable(() => this.actionsElement.remove()));
	}

	get partTitleProjection(): PartTitleProjection {
		return { content: this.titleElement, actions: this.actionsElement };
	}

	private openHistory(anchor: HTMLElement): void {
		if (anchor.getAttribute('aria-expanded') === 'true') return;
		anchor.setAttribute('aria-expanded', 'true');
		void this.showHistory(anchor).catch(onUnexpectedError).finally(() => {
			anchor.setAttribute('aria-expanded', 'false');
			const ownerDocument = anchor.ownerDocument;
			if (ownerDocument.activeElement === ownerDocument.body && anchor.isConnected) anchor.focus();
		});
	}

	/** Shares editor tab presentation while the caller retains conversation identity and lifetime. */
	setTabs(items: readonly TabListItem<string>[], activeId: string | undefined, options: TabListOptions<string> | undefined): void {
		if (options && !this.tabs) {
			this.tabsHost = h(this.titleElement.ownerDocument, 'div', { className: 'ash-chat-view-tabs' });
			this.titleElement.prepend(this.tabsHost);
			this.tabs = this._register(this.instantiationService.createInstance(WorkbenchTabsControl<string>, this.tabsHost, options));
		}
		const focusInTitle = this.titleElement.contains(this.titleElement.ownerDocument.activeElement);
		this.titleButton.hidden = options !== undefined;
		this.titleElement.classList.toggle('has-session-tabs', options !== undefined);
		if (this.tabsHost) this.tabsHost.hidden = options === undefined;
		this.tabs?.setTabs(items, activeId);
		if (focusInTitle) {
			if (options === undefined) this.titleButton.focus();
			else if (this.titleElement.ownerDocument.activeElement === this.titleButton) {
				this.tabsHost?.querySelector<HTMLElement>('.ash-tab.checked .ash-tab-label')?.focus();
			}
		}
	}

	private showTitleContextMenu(event: MouseEvent | KeyboardEvent): void {
		event.preventDefault();
		event.stopPropagation();
		// A menu belongs to the conversation that opened it. An empty draft context
		// also stays explicit instead of falling back to a later active selection.
		const active = this.navigation.getActiveConversation();
		const context = active ? { sessionId: active.sessionId, threadId: active.threadId } : {};
		const actions = getFlatContextMenuActions(this.menuService.getMenuActions(MenuId.ChatTitle, { arg: context, renderShortTitle: true }), undefined, this.titleButton.ownerDocument.defaultView ?? undefined);
		this.contextMenuService.showContextMenu({
			cancellationToken: this.menuCancellation,
			getAnchor: () => event.type === 'contextmenu'
				? { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, targetWindow: this.titleButton.ownerDocument.defaultView ?? undefined }
				: this.titleButton,
			getActions: () => actions,
			onHide: () => { if (this.titleButton.isConnected) this.titleButton.focus(); },
		});
	}

	captureFocus(): (() => void) | undefined {
		if (!this.layoutToolbar.element.contains(this.actionsElement.ownerDocument.activeElement)) return undefined;
		return () => this.layoutToolbar.focus();
	}

	update(title: string | undefined, panelId?: string): void {
		const label = title?.trim() || localize('chat.title.default', 'Chat');
		this.titleLabel.textContent = label;
		this.titleButton.title = label;
		this.titleButton.setAttribute('aria-label', localize('chat.title.switch', 'Switch conversation: {0}', label));
		if (panelId) this.titleButton.setAttribute('aria-controls', panelId);
		else this.titleButton.removeAttribute('aria-controls');
	}
}

/** Keeps the history trigger in the shared toolbar while supplying its actual anchor. */
class ChatHistoryActionViewItem extends ButtonActionViewItem {
	constructor(action: IAction, options: ActionViewItemOptions, private readonly showHistory: (anchor: HTMLElement) => void) {
		super(action, options);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		this.button.domNode.setAttribute('aria-haspopup', 'dialog');
		this.button.domNode.setAttribute('aria-expanded', 'false');
	}

	protected override runAction(): void {
		this.showHistory(this.button.domNode);
	}
}
