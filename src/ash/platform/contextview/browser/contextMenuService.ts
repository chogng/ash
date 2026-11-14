import type { IContextMenuDelegate } from '../../../base/browser/contextmenu.js';
import { Separator, type IAction } from '../../../base/common/actions.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import {
	getFlatContextMenuActions,
} from '../../actions/browser/menuEntryActionViewItem.js';
import { MenuId, IMenuService } from '../../actions/common/actions.js';
import { IContextKeyService } from '../../contextkey/browser/contextKeyService.js';
import { IKeybindingService } from '../../keybinding/common/keybinding.js';
import { INotificationService } from '../../notification/common/notification.js';
import { ContextMenuHandler } from './contextMenuHandler.js';
import { type IContextMenuMenuDelegate, type IContextMenuService, IContextViewService } from './contextView.js';

/** Transforms menu contributions and delegates browser rendering to one handler. */
export class BrowserContextMenuService extends Disposable
	implements IContextMenuService {
	readonly contextMenuStyle = 'custom';
	private readonly _onDidShowContextMenu = this._register(new Emitter<void>());
	private readonly _onDidHideContextMenu = this._register(new Emitter<void>());
	private readonly handler: ContextMenuHandler;

	readonly onDidShowContextMenu = this._onDidShowContextMenu.event;
	readonly onDidHideContextMenu = this._onDidHideContextMenu.event;

	constructor(
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextViewService contextViewService: IContextViewService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		this.handler = new ContextMenuHandler(
			contextViewService,
			keybindingService,
			notificationService,
		);
		this._register(this.handler);
	}

	showContextMenu(
		delegate: IContextMenuDelegate | IContextMenuMenuDelegate,
	): void {
		const resolved = transformContextMenuDelegate(
			delegate,
			this.menuService,
			this.contextKeyService,
		);
		let didShow = false;
		this.handler.showContextMenu({
			...resolved,
			onHide: (didCancel, reason) => {
				try {
					resolved.onHide?.(didCancel, reason);
				} finally {
					if (didShow) this._onDidHideContextMenu.fire();
				}
			},
		}, () => {
			didShow = true;
			this._onDidShowContextMenu.fire();
		});
	}

	hideContextMenu(): void {
		this.handler.hideContextMenu();
	}
}

export function transformContextMenuDelegate(
	delegate: IContextMenuDelegate | IContextMenuMenuDelegate,
	menuService: IMenuService,
	globalContextKeyService: IContextKeyService,
): IContextMenuDelegate {
	return {
		...delegate,
		getActions: () => {
			const explicit = delegate.getActions?.() ?? [];
			if (!('menuId' in delegate) || !(delegate.menuId instanceof MenuId)) {
				return trimSeparators(explicit);
			}
			const contributed = getFlatContextMenuActions(
				menuService.getMenuActions(
					delegate.menuId,
					delegate.menuActionOptions,
					delegate.contextKeyService ?? globalContextKeyService,
				),
			);
			return trimSeparators(Separator.join([...explicit], [...contributed]));
		},
	};
}

function trimSeparators(actions: readonly IAction[]): readonly IAction[] {
	const result: IAction[] = [];
	for (const action of actions) {
		if (
			action instanceof Separator &&
			(result.length === 0 || result[result.length - 1] instanceof Separator)
		) continue;
		result.push(action);
	}
	if (result[result.length - 1] instanceof Separator) result.pop();
	return result;
}
