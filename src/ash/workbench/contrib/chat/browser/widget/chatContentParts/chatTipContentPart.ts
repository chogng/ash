import './media/chatTipContent.css';
import { addDisposableListener, getWindow, h } from '../../../../../../base/browser/dom.js';
import { IMarkdownRendererService } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { createActionViewItem } from '../../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { MenuWorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { MenuId, IMenuService } from '../../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { DomWidget } from '../../../../../../platform/domWidget/browser/domWidget.js';
import { localize } from '../../../../../../nls.js';
import type { IChatTip } from '../../chatTipService.js';
import { ChatTipActionContext, multipleChatTips } from './chatTipActions.js';

/** Renders one tip; the presenter owns visibility and the service owns dismissal. */
export class ChatTipContentPart extends DomWidget {
	public readonly domNode: HTMLElement;
	private readonly toolbar: MenuWorkbenchToolBar;

	public get element(): HTMLElement {
		return this.domNode;
	}

	constructor(
		document: Document,
		tip: IChatTip,
		dismiss: () => void,
		navigate: ((direction: -1 | 1) => void) | undefined,
		@IMarkdownRendererService markdownRenderer: IMarkdownRendererService,
		@IMenuService menus: IMenuService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-chat-input-tip';
		this.domNode.setAttribute('role', 'note');
		const content = this._register(markdownRenderer.render(tip.content, { ownerDocument: document }));
		this.domNode.append(content.element);
		const actions = h(document, 'div', { className: 'ash-chat-input-tip-actions' });
		this.domNode.append(actions);
		const context = this._register(contextKeys.createScoped(actions));
		multipleChatTips.bindTo(context).set(!!navigate);
		const actionContext = new ChatTipActionContext(dismiss, navigate, () => this.isDisposed);
		this.toolbar = this._register(new MenuWorkbenchToolBar(actions, menus, contextMenus, MenuId.ChatTipToolbar, {
			ariaLabel: localize('chat.tip.actions', 'Tip actions'),
			tabNavigation: 'each-action',
			contextKeyService: context,
			menuOptions: { arg: actionContext },
			actionViewItemProvider: (action, options) => createActionViewItem(action, contextMenus, {
				...options, iconOnly: true, buttonPresentation: 'quiet',
			}),
		}));
		const showContextMenu = (event: MouseEvent | KeyboardEvent): void => {
			event.preventDefault();
			event.stopPropagation();
			const anchor = 'clientX' in event
				? { x: event.clientX, y: event.clientY, targetWindow: getWindow(this.domNode) }
				: this.domNode;
			contextMenus.showContextMenu({
				menuId: MenuId.ChatTipContext,
				menuActionOptions: { arg: actionContext },
				contextKeyService: context,
				getAnchor: () => anchor,
				autoSelectFirstItem: !('clientX' in event),
			});
		};
		this._register(addDisposableListener(this.domNode, 'contextmenu', showContextMenu));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showContextMenu(event);
		}));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	focusNavigation(direction: -1 | 1): void {
		this.toolbar.focus(direction === -1 ? 0 : 1);
	}
}
