import './media/menuActivityBar.css';
import { addDisposableListener, isHTMLElement } from '../../../../base/browser/dom.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IMenuService, type MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

export interface IMenuActivityBarOptions {
	readonly menuId: MenuId;
	readonly contextMenuId: MenuId;
	readonly ariaLabel: string;
}

/** A vertical command rail. Its host owns placement and the menu owns its entries. */
export class MenuActivityBar extends Disposable {
	readonly element: HTMLElement;

	constructor(
		container: HTMLElement,
		options: IMenuActivityBarOptions,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const toolbar = this._register(new MenuWorkbenchToolBar(container, menuService, contextMenuService, options.menuId, {
			ariaLabel: options.ariaLabel,
			contextKeyService,
			orientation: 'vertical',
			highlightToggledItems: true,
			toolbarOptions: { primaryGroup: () => true, useSeparatorsInPrimaryActions: true },
		}));
		this.element = toolbar.element;
		this.element.classList.add('ash-menu-activity-bar');
		this._register(toolbar.actionRunner.onDidRun(({ error }) => {
			if (error !== undefined) notifications.error(toErrorMessage(error));
		}));
		const showContextMenu = (event: MouseEvent | KeyboardEvent): void => {
			if (event.defaultPrevented) return;
			const keyboard = !('clientX' in event);
			const anchor = keyboard ? (isHTMLElement(event.target) ? event.target : this.element) : {
				x: event.clientX,
				y: event.clientY,
				targetWindow: this.element.ownerDocument.defaultView ?? undefined,
			};
			event.preventDefault();
			event.stopPropagation();
			contextMenuService.showContextMenu({
				getAnchor: () => anchor,
				menuId: options.contextMenuId,
				contextKeyService,
				autoSelectFirstItem: keyboard,
			});
		};
		this._register(addDisposableListener(this.element, 'contextmenu', showContextMenu));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) showContextMenu(event);
		}));
	}
}
