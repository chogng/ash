import { isMacintosh } from "../../../../base/common/platform.js";
import { BrowserContextMenuService } from "../../../../platform/contextview/browser/contextMenuService.js";
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { isNode } from "../../../../base/browser/dom.js";
import { Emitter } from "../../../../base/common/event.js";
import {
	Disposable,
	toDisposable,
} from "../../../../base/common/lifecycle.js";
import {
	type IAction,
	Separator,
	SubmenuAction,
} from "../../../../base/common/actions.js";
import { toElectronAccelerator } from "../../../../platform/keybinding/common/electronAccelerator.js";
import { IMenuService } from "../../../../platform/actions/common/actions.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { hasSystemContextMenu, MenuSettings } from "../../../../platform/window/common/window.js";
import {
	IKeybindingService,
} from "../../../../platform/keybinding/common/keybinding.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import {
	type INativeContextMenuApi,
	type INativeContextMenuRequest,
	type NativeContextMenuItem,
} from "../../../../base/parts/contextmenu/common/contextmenu.js";
import type {
	ContextMenuAnchor,
	IContextMenuDelegate,
} from "../../../../base/browser/contextmenu.js";
import { AnchorAlignment, AnchorAxisAlignment } from "../../../../base/browser/ui/contextview/contextview.js";
import { transformContextMenuDelegate } from "../../../../platform/contextview/browser/contextMenuService.js";
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import type {
	IContextMenuMenuDelegate,
	IContextMenuService,
} from "../../../../platform/contextview/browser/contextView.js";

/** Desktop implementation backed by Electron's system Menu. */
export class NativeContextMenuService extends Disposable
	implements IContextMenuService {
	private readonly _onDidShowContextMenu = this._register(new Emitter<void>());
	private readonly _onDidHideContextMenu = this._register(new Emitter<void>());
	private readonly api: INativeContextMenuApi;
	private readonly menuService: IMenuService;
	private readonly keybindingService: IKeybindingService;
	private open = false;

	readonly onDidShowContextMenu = this._onDidShowContextMenu.event;
	readonly onDidHideContextMenu = this._onDidHideContextMenu.event;

	constructor(
		api: INativeContextMenuApi,
		@IMenuService menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.api = api;
		this.menuService = menuService;
		this.keybindingService = keybindingService;
		this._register(toDisposable(() => this.hideContextMenu()));
	}

	showContextMenu(
		delegate: IContextMenuDelegate | IContextMenuMenuDelegate,
	): void {
		if (this.open) {
			delegate.onHide?.(true);
			return;
		}
		const resolved = transformContextMenuDelegate(
			delegate,
			this.menuService,
			this.contextKeyService,
		);
		const actions = resolved.getActions();
		const serialized = serializeActions(actions, this.keybindingService);
		if (serialized.items.length === 0) {
			resolved.onHide?.(true);
			return;
		}

		const point = anchorPoint(resolved.getAnchor(), resolved);
		const request: INativeContextMenuRequest = {
			items: serialized.items,
			...point,
			...(resolved.autoSelectFirstItem ? { positioningItem: 0 } : {}),
		};
		this.open = true;
		this._onDidShowContextMenu.fire();
		void this.popup(request, serialized.actions, resolved);
	}

	hideContextMenu(): void {
		if (!this.open) return;
		void this.api.close().catch((error: unknown) => {
			console.error("Failed to close native context menu", error);
		});
	}

	private async popup(
		request: INativeContextMenuRequest,
		actions: ReadonlyMap<string, IAction>,
		delegate: IContextMenuDelegate,
	): Promise<void> {
		let selected: IAction | undefined;
		try {
			const result = await this.api.popup(request);
			selected = result.selectedId
				? actions.get(result.selectedId)
				: undefined;
		} catch (error) {
			console.error("Failed to show native context menu", error);
		} finally {
			this.open = false;
			delegate.onHide?.(!selected);
			this._onDidHideContextMenu.fire();
		}
		if (selected) this.runAction(selected, delegate);
	}

	private runAction(action: IAction, delegate: IContextMenuDelegate): void {
		let operation: unknown;
		try {
			operation = delegate.actionRunner
				? delegate.actionRunner.run(action, delegate.getActionsContext?.())
				: action.run(delegate.getActionsContext?.());
		} catch (error) {
			this.notificationService.error(toErrorMessage(error));
			return;
		}
		Promise.resolve(operation).catch((error: unknown) => {
			this.notificationService.error(toErrorMessage(error));
		});
	}
}

interface ISerializedActions {
	readonly items: readonly NativeContextMenuItem[];
	readonly actions: ReadonlyMap<string, IAction>;
}

function serializeActions(
	actions: readonly IAction[],
	keybindingService: IKeybindingService,
): ISerializedActions {
	const actionMap = new Map<string, IAction>();
	let nextId = 1;

	const serialize = (
		source: readonly IAction[],
	): readonly NativeContextMenuItem[] => {
		const items: NativeContextMenuItem[] = [];
		for (const action of source) {
			if (action instanceof Separator) {
				items.push({ type: "separator" });
				continue;
			}
			if (action instanceof SubmenuAction) {
				const children = serialize(action.actions);
				if (children.length > 0) {
					items.push({
						type: "submenu",
						label: action.label,
						enabled: action.enabled,
						items: children,
					});
				}
				continue;
			}

			const id = `action-${nextId++}`;
			actionMap.set(id, action);
			const accelerator = toElectronAccelerator(
				keybindingService.lookupKeybinding(action.id),
			);
			items.push({
				type: "action",
				id,
				label: action.label,
				enabled: action.enabled,
				...(accelerator ? { accelerator } : {}),
				...(action.checked === undefined
					? {}
					: { checked: action.checked }),
			});
		}
		return trimSerializedSeparators(items);
	};

	return {
		items: serialize(actions),
		actions: actionMap,
	};
}

function trimSerializedSeparators(
	items: readonly NativeContextMenuItem[],
): readonly NativeContextMenuItem[] {
	const result: NativeContextMenuItem[] = [];
	for (const item of items) {
		if (
			item.type === "separator" &&
			(result.length === 0 || result[result.length - 1]?.type === "separator")
		) {
			continue;
		}
		result.push(item);
	}
	if (result[result.length - 1]?.type === "separator") result.pop();
	return result;
}

function anchorPoint(
	anchor: ContextMenuAnchor,
	delegate: IContextMenuDelegate,
): { readonly x: number; readonly y: number; readonly elementAnchor?: boolean; } {
	if (!isNode(anchor)) {
		return {
			x: normalizeCoordinate(anchor.x),
			y: normalizeCoordinate(anchor.y),
		};
	}
	const bounds = anchor.getBoundingClientRect();
	const targetWindow = anchor.ownerDocument.defaultView;
	if (!targetWindow) throw new Error("Context menu anchor has no window");
	const isClipped = bounds.left < 0 || bounds.top < 0 || bounds.right > targetWindow.innerWidth || bounds.bottom > targetWindow.innerHeight;
	const x = isClipped
		? Math.min(Math.max(bounds.right, 0), targetWindow.innerWidth)
		: delegate.anchorAlignment === AnchorAlignment.Right ? bounds.right : bounds.left;
	const y = isClipped
		? Math.min(Math.max(bounds.bottom, 0), targetWindow.innerHeight)
		: delegate.anchorAxisAlignment === AnchorAxisAlignment.Horizontal ? bounds.top : bounds.bottom;
	return {
		x: normalizeCoordinate(x),
		y: normalizeCoordinate(y),
		elementAnchor: true,
	};
}

function normalizeCoordinate(value: number): number {
	return Math.max(-1_000_000, Math.min(1_000_000, value));
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Uses the chosen menu style while keeping menus clear of right-hand triggers. */
export class ElectronContextMenuService extends Disposable implements IContextMenuService {
	private readonly _onDidShowContextMenu = this._register(new Emitter<void>());
	private readonly _onDidHideContextMenu = this._register(new Emitter<void>());
	private readonly systemMenu: NativeContextMenuService;
	private readonly browserMenu: BrowserContextMenuService;
	private systemVisible = false;
	private browserVisible = false;
	private usesSystemMenu: boolean;

	readonly onDidShowContextMenu = this._onDidShowContextMenu.event;
	readonly onDidHideContextMenu = this._onDidHideContextMenu.event;

	constructor(
		api: INativeContextMenuApi,
		@IConfigurationService configurationService: IConfigurationService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextViewService contextViewService: IContextViewService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		this.usesSystemMenu = hasSystemContextMenu(configurationService);
		this.systemMenu = this._register(new NativeContextMenuService(api, menuService, contextKeyService, keybindingService, notificationService));
		this.browserMenu = this._register(new BrowserContextMenuService(menuService, contextKeyService, keybindingService, contextViewService, notificationService));
		this._register(this.systemMenu.onDidShowContextMenu(() => this.setVisible('system', true)));
		this._register(this.systemMenu.onDidHideContextMenu(() => this.setVisible('system', false)));
		this._register(this.browserMenu.onDidShowContextMenu(() => this.setVisible('browser', true)));
		this._register(this.browserMenu.onDidHideContextMenu(() => this.setVisible('browser', false)));
		if (isMacintosh) {
			this._register(configurationService.onDidChangeConfiguration(event => {
				if (!event.affectsConfiguration(MenuSettings.MenuStyle)) return;
				const useSystemMenu = hasSystemContextMenu(configurationService);
				if (useSystemMenu === this.usesSystemMenu) return;
				this.hideContextMenu();
				this.usesSystemMenu = useSystemMenu;
			}));
		}
	}

	private setVisible(menu: 'system' | 'browser', visible: boolean): void {
		const wasVisible = this.systemVisible || this.browserVisible;
		if (menu === 'system') this.systemVisible = visible;
		else this.browserVisible = visible;
		const isVisible = this.systemVisible || this.browserVisible;
		if (!wasVisible && isVisible) this._onDidShowContextMenu.fire();
		else if (wasVisible && !isVisible) this._onDidHideContextMenu.fire();
	}

	showContextMenu(delegate: IContextMenuDelegate | IContextMenuMenuDelegate): void {
		const anchor = delegate.getAnchor();
		// Electron Menu.popup cannot align its right edge with an element on the right side of the window.
		const rightHandTrigger = isNode(anchor) && delegate.anchorAxisAlignment === AnchorAxisAlignment.Horizontal && delegate.anchorAlignment === AnchorAlignment.Left;
		const menu = this.usesSystemMenu && !rightHandTrigger ? this.systemMenu : this.browserMenu;
		if (menu === this.browserMenu) this.systemMenu.hideContextMenu();
		else this.browserMenu.hideContextMenu();
		menu.showContextMenu({ ...delegate, getAnchor: () => anchor });
	}

	hideContextMenu(): void {
		this.systemMenu.hideContextMenu();
		this.browserMenu.hideContextMenu();
	}
}
