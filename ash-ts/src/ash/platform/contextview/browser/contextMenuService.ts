import type { IContextMenuDelegate } from "../../../base/browser/contextmenu.js";
import { isNode } from "../../../base/browser/dom.js";
import { Separator, type IAction } from "../../../base/common/actions.js";
import { Emitter } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import {
	getFlatContextMenuActions,
	resolveAlternativeMenuActions,
	shouldUseAlternativeMenuActions,
} from "../../actions/browser/menuEntryActionViewItem.js";
import { MenuId } from "../../actions/common/actions.js";
import type { IMenuService } from "../../actions/common/menuService.js";
import type { IContextKeyService } from "../../contextkey/browser/contextKeyService.js";
import type { IKeybindingService } from "../../keybinding/common/keybinding.js";
import type { INotificationService } from "../../notification/common/notification.js";
import { ContextMenuHandler } from "./contextMenuHandler.js";
import type {
	IContextMenuMenuDelegate,
	IContextMenuService,
	IContextViewService,
} from "./contextView.js";

/** Transforms menu contributions and delegates browser rendering to one handler. */
export class BrowserContextMenuService extends Disposable
	implements IContextMenuService {
	private readonly _onDidShowContextMenu = this._register(new Emitter<void>());
	private readonly _onDidHideContextMenu = this._register(new Emitter<void>());
	private readonly handler: ContextMenuHandler;

	readonly onDidShowContextMenu = this._onDidShowContextMenu.event;
	readonly onDidHideContextMenu = this._onDidHideContextMenu.event;

	constructor(
		private readonly menuService: IMenuService,
		private readonly contextKeyService: IContextKeyService,
		keybindingService: IKeybindingService,
		contextViewService: IContextViewService,
		notificationService: INotificationService,
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
			onHide: (didCancel) => {
				resolved.onHide?.(didCancel);
				if (didShow) this._onDidHideContextMenu.fire();
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
			const targetWindow = getAnchorWindow(delegate.getAnchor());
			const explicit = delegate.getActions
				? resolveAlternativeMenuActions(
					delegate.getActions(),
					shouldUseAlternativeMenuActions(targetWindow),
				)
				: [];
			if (!("menuId" in delegate) || !(delegate.menuId instanceof MenuId)) {
				return trimSeparators(explicit);
			}
			const contributed = getFlatContextMenuActions(
				menuService.getMenuActions(
					delegate.menuId,
					delegate.menuActionOptions,
					delegate.contextKeyService ?? globalContextKeyService,
				),
				undefined,
				targetWindow,
			);
			return trimSeparators(Separator.join([...explicit], [...contributed]));
		},
	};
}

function getAnchorWindow(anchor: ReturnType<IContextMenuDelegate["getAnchor"]>): Window {
	if (isNode(anchor)) return anchor.ownerDocument.defaultView ?? window;
	return anchor.targetWindow ?? window;
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
