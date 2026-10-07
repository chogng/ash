import type { IContextMenuDelegate } from "../../../base/browser/contextmenu.js";
import { isNode } from "../../../base/browser/dom.js";
import { Separator, type IAction } from "../../../base/common/actions.js";
import { Emitter } from "../../../base/common/event.js";
import { Disposable, type IDisposable } from "../../../base/common/lifecycle.js";
import {
	getFlatContextMenuActions,
	resolveAlternativeMenuActions,
	shouldUseAlternativeMenuActions,
} from "../../actions/browser/menuEntryActionViewItem.js";
import { MenuId, IMenuService } from "../../actions/common/actions.js";
import { IContextKeyService } from "../../contextkey/browser/contextKeyService.js";
import type { IConfigurationService } from "../../configuration/common/configuration.js";
import { IKeybindingService } from "../../keybinding/common/keybinding.js";
import { INotificationService } from "../../notification/common/notification.js";
import { ContextMenuHandler } from "./contextMenuHandler.js";
import { type IContextMenuMenuDelegate, type IContextMenuService, IContextViewService } from "./contextView.js";

/** Transforms menu contributions and delegates browser rendering to one handler. */
export class BrowserContextMenuService extends Disposable
	implements IContextMenuService {
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

export interface ContextMenuServiceOptions {
	readonly configurationService: IConfigurationService;
	readonly menuService: IMenuService;
	readonly contextKeyService: IContextKeyService;
	readonly keybindingService: IKeybindingService;
	readonly contextViewService: IContextViewService;
	readonly notificationService: INotificationService;
}

export type ContextMenuServiceFactory = (options: ContextMenuServiceOptions) => IContextMenuService & IDisposable;

export function createBrowserContextMenuService(options: ContextMenuServiceOptions): BrowserContextMenuService {
	return new BrowserContextMenuService(
		options.menuService,
		options.contextKeyService,
		options.keybindingService,
		options.contextViewService,
		options.notificationService,
	);
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
