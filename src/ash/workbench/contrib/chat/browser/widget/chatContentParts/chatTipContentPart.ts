import './media/chatTipContent.css';
import { addDisposableListener, getWindow, h } from '../../../../../../base/browser/dom.js';
import { IMarkdownRendererService } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { createActionViewItem } from '../../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { MenuWorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { Action2, MenuId, IMenuService, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { DomWidget } from '../../../../../../platform/domWidget/browser/domWidget.js';
import type { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../../../nls.js';
import { ChatConfiguration } from '../../../common/constants.js';
import type { IChatTip } from '../../chatTipService.js';

const multipleChatTips = new RawContextKey<boolean>('multipleChatTips', false);

/** Renders one tip; the presenter owns visibility and the service owns dismissal. */
export class ChatTipContentPart extends DomWidget {
	public readonly domNode: HTMLElement;
	private readonly toolbar: MenuWorkbenchToolBar;

	static {
		for (const [order, direction, id, title, icon] of [
			[1, -1, 'workbench.action.chat.previousTip', () => localize2('chat.tip.previous', 'Previous tip'), Lxicon.chevronLeft],
			[2, 1, 'workbench.action.chat.nextTip', () => localize2('chat.tip.next', 'Next tip'), Lxicon.chevronRight],
			[3, undefined, 'workbench.action.chat.dismissTipToolbar', () => localize2('chat.tip.dismiss', 'Dismiss tip'), Lxicon.close],
		] as const) {
			registerAction2(class extends Action2 {
				constructor() {
					super({
						id, get title() { return title(); }, icon,
						menu: { id: MenuId.ChatTipToolbar, group: 'navigation', order, when: direction === undefined ? undefined : multipleChatTips.isEqualTo(true) },
					});
				}

				override run(_accessor: ServicesAccessor, target: unknown): void {
					if (!(target instanceof ChatTipContentPart) || target.isDisposed) return;
					if (direction === undefined) target.dismiss();
					else target.navigate?.(direction);
				}
			});
		}
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.chat.dismissTip',
					get title() { return localize2('chat.tip.dismissCurrent', 'Dismiss This Tip'); },
					menu: { id: MenuId.ChatTipContext, group: 'navigation', order: 1 },
				});
			}

			override run(_accessor: ServicesAccessor, target: unknown): void {
				if (target instanceof ChatTipContentPart && !target.isDisposed) target.dismiss();
			}
		});
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.chat.disableTips',
					get title() { return localize2('chat.tip.disableAll', 'Disable All Tips'); },
					menu: { id: MenuId.ChatTipContext, group: 'navigation', order: 2 },
				});
			}

			override run(accessor: ServicesAccessor): Promise<void> {
				return accessor.get(IConfigurationService).updateValue(ChatConfiguration.TipsEnabled, false);
			}
		});
	}

	public get element(): HTMLElement {
		return this.domNode;
	}

	constructor(
		document: Document,
		tip: IChatTip,
		private readonly dismiss: () => void,
		private readonly navigate: ((direction: -1 | 1) => void) | undefined,
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
		this.toolbar = this._register(new MenuWorkbenchToolBar(actions, menus, contextMenus, MenuId.ChatTipToolbar, {
			ariaLabel: localize('chat.tip.actions', 'Tip actions'),
			tabNavigation: 'each-action',
			contextKeyService: context,
			menuOptions: { arg: this },
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
				menuActionOptions: { arg: this },
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
