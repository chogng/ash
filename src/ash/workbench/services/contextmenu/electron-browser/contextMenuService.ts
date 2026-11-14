import { isMacintosh } from '../../../../base/common/platform.js';
import { BrowserContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { isNode, ModifierKeyEmitter } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import {
	Disposable,
	DisposableMap,
	DisposableStore,
	toDisposable,
} from '../../../../base/common/lifecycle.js';
import {
	type IAction,
	getActionForAltMode,
	Separator,
	SubmenuAction,
} from '../../../../base/common/actions.js';
import { toElectronAccelerator } from '../../../../platform/keybinding/common/electronAccelerator.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { hasSystemContextMenu, MenuSettings } from '../../../../platform/window/common/window.js';
import {
	IKeybindingService,
} from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import {
	type INativeContextMenuApi,
	type INativeContextMenuRequest,
	type NativeContextMenuItem,
} from '../../../../base/parts/contextmenu/common/contextmenu.js';
import type {
	ContextMenuAnchor,
	IContextMenuDelegate,
} from '../../../../base/browser/contextmenu.js';
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition, ContextViewHideReason } from '../../../../base/browser/ui/contextview/contextview.js';
import { transformContextMenuDelegate } from '../../../../platform/contextview/browser/contextMenuService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import type {
	IContextMenuMenuDelegate,
	IContextMenuService,
} from '../../../../platform/contextview/browser/contextView.js';
import { ContextMenuWindow } from './contextMenuWindow.js';

interface ISystemMenuPopup {
	readonly delegate: IContextMenuDelegate;
	readonly actions: ReadonlyMap<string, IAction>;
	closed: boolean;
	wasShown: boolean;
	closeOperation?: Promise<boolean>;
}

/** Desktop implementation backed by Electron's system Menu. */
export class NativeContextMenuService extends Disposable
	implements IContextMenuService {
	readonly contextMenuStyle = 'system';
	private readonly _onDidShowContextMenu = this._register(new Emitter<void>());
	private readonly _onDidHideContextMenu = this._register(new Emitter<void>());
	private readonly api: INativeContextMenuApi;
	private readonly menuService: IMenuService;
	private readonly keybindingService: IKeybindingService;
	private activePopup: ISystemMenuPopup | undefined;
	private readonly popupLifetimes = this._register(new DisposableMap<ISystemMenuPopup, DisposableStore>());

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
		if (this.isDisposed || delegate.cancellationToken?.isCancellationRequested || this.activePopup) {
			delegate.onHide?.(true);
			return;
		}
		const resolved = transformContextMenuDelegate(
			delegate,
			this.menuService,
			this.contextKeyService,
		);
		const anchor = resolved.getAnchor();
		const targetWindow = (isNode(anchor) ? anchor.ownerDocument?.defaultView : anchor.targetWindow) ?? globalThis.window;
		const modifiers = targetWindow ? ModifierKeyEmitter.getInstance(targetWindow).keyStatus : {};
		const actions = resolved.getActions();
		const serialized = serializeActions(actions, modifiers, resolved.getKeyBinding ?? (action => this.keybindingService.lookupKeybinding(action.id)));
		if (serialized.items.length === 0 || this.activePopup || this.isDisposed || resolved.cancellationToken?.isCancellationRequested) {
			resolved.onHide?.(true);
			return;
		}

		const point = anchorPoint(resolved.getAnchor(), resolved);
		const request: INativeContextMenuRequest = {
			items: serialized.items,
			...point,
			...(resolved.autoSelectFirstItem ? { positioningItem: 0 } : {}),
		};
		if (this.activePopup || this.isDisposed || resolved.cancellationToken?.isCancellationRequested) {
			resolved.onHide?.(true);
			return;
		}
		const popup: ISystemMenuPopup = { delegate: resolved, actions: serialized.actions, closed: false, wasShown: false };
		this.activePopup = popup;
		const lifetime = new DisposableStore();
		this.popupLifetimes.set(popup, lifetime);
		if (resolved.cancellationToken) { lifetime.add(resolved.cancellationToken.onCancellationRequested(() => this.requestClose(popup))); }
		void this.popup(request, popup);
		if (!popup.closed) {
			popup.wasShown = true;
			this._onDidShowContextMenu.fire();
		}
	}

	hideContextMenu(): void {
		if (this.activePopup) { this.requestClose(this.activePopup); }
	}

	private requestClose(popup: ISystemMenuPopup): void {
		if (this.activePopup !== popup || popup.closed) { return; }
		const operation = popup.closeOperation ??= this.closePopup();
		void operation.then(closed => {
			if (!closed && popup.closeOperation === operation) { popup.closeOperation = undefined; }
			// The IPC acknowledgment confirms only the request; the popup result releases its slot.
		});
	}

	private async closePopup(): Promise<boolean> {
		try {
			await this.api.close();
			return true;
		} catch (error) {
			console.error('Failed to close native context menu', error);
			return false;
		}
	}

	private async popup(
		request: INativeContextMenuRequest,
		popup: ISystemMenuPopup,
	): Promise<void> {
		let selected: IAction | undefined;
		try {
			const result = await this.api.popup(request);
			if (!popup.closed && !this.isDisposed && !popup.delegate.cancellationToken?.isCancellationRequested) {
				selected = result.selectedId ? popup.actions.get(result.selectedId) : undefined;
			}
		} catch (error) {
			console.error('Failed to show native context menu', error);
		} finally {
			this.finishPopup(popup, !selected);
		}
		if (selected && !this.isDisposed && !popup.delegate.cancellationToken?.isCancellationRequested) { this.runAction(selected, popup.delegate); }
	}

	private finishPopup(popup: ISystemMenuPopup, didCancel: boolean): void {
		if (popup.closed) { return; }
		popup.closed = true;
		if (this.activePopup === popup) { this.activePopup = undefined; }
		this.popupLifetimes.deleteAndDispose(popup);
		try {
			popup.delegate.onHide?.(didCancel);
		} finally {
			if (popup.wasShown) { this._onDidHideContextMenu.fire(); }
		}
	}

	private runAction(action: IAction, delegate: IContextMenuDelegate): void {
		let operation: unknown;
		try {
			operation = delegate.actionRunner
				? delegate.actionRunner.run(action, delegate.getActionsContext?.())
				: action.run(delegate.getActionsContext?.());
		} catch (error) {
			if (!this.isDisposed) { this.notificationService.error(toErrorMessage(error)); }
			return;
		}
		Promise.resolve(operation).catch((error: unknown) => {
			if (!this.isDisposed) { this.notificationService.error(toErrorMessage(error)); }
		});
	}
}

interface ISerializedActions {
	readonly items: readonly NativeContextMenuItem[];
	readonly actions: ReadonlyMap<string, IAction>;
}

function serializeActions(
	actions: readonly IAction[],
	modifiers: { readonly altKey?: boolean; readonly shiftKey?: boolean; },
	getKeybinding: NonNullable<IContextMenuDelegate['getKeyBinding']>,
): ISerializedActions {
	const actionMap = new Map<string, IAction>();
	let nextId = 1;

	const serialize = (
		source: readonly IAction[],
	): readonly NativeContextMenuItem[] => {
		const items: NativeContextMenuItem[] = [];
		for (const original of source) {
			const action = getActionForAltMode(original, modifiers);
			if (action instanceof Separator) {
				items.push({ type: 'separator' });
				continue;
			}
			if (action instanceof SubmenuAction) {
				const children = serialize(action.actions);
				if (children.length > 0) {
					items.push({
						type: 'submenu',
						label: action.label,
						enabled: action.enabled,
						items: children,
					});
				}
				continue;
			}

			const id = `action-${nextId++}`;
			actionMap.set(id, action);
			const keybinding = getKeybinding(action);
			const accelerator = toElectronAccelerator(keybinding);
			// Electron cannot render chords in its accelerator column.
			const shortcutLabel = keybinding && !accelerator ? getKeybindingLabel(keybinding) : undefined;
			items.push({
				type: 'action',
				id,
				label: shortcutLabel ? `${action.label} [${shortcutLabel}]` : action.label,
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
			item.type === 'separator' &&
			(result.length === 0 || result[result.length - 1]?.type === 'separator')
		) {
			continue;
		}
		result.push(item);
	}
	if (result[result.length - 1]?.type === 'separator') result.pop();
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
	if (!targetWindow) throw new Error('Context menu anchor has no window');
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

/** Uses the chosen menu style while keeping menus clear of right-hand triggers. */
export class ElectronContextMenuService extends Disposable implements IContextMenuService {
	get contextMenuStyle(): 'custom' | 'system' { return this.usesSystemMenu ? 'system' : 'custom'; }
	private readonly _onDidShowContextMenu = this._register(new Emitter<void>());
	private readonly _onDidHideContextMenu = this._register(new Emitter<void>());
	private readonly systemMenu: NativeContextMenuService;
	private readonly browserMenu: BrowserContextMenuService;
	private systemVisible = 0;
	private browserVisible = 0;
	private usesSystemMenu: boolean;
	private readonly menuWindowLifetimes = this._register(new DisposableMap<ContextMenuWindow, DisposableStore>());
	private menuWindow: { readonly host: ContextMenuWindow; hide(): void; } | undefined;
	private menuRequest = 0;

	readonly onDidShowContextMenu = this._onDidShowContextMenu.event;
	readonly onDidHideContextMenu = this._onDidHideContextMenu.event;

	constructor(
		private readonly api: INativeContextMenuApi,
		menuStyle: 'configuration' | 'custom',
		@IConfigurationService configurationService: IConfigurationService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@INotificationService private readonly windowNotifications: INotificationService,
	) {
		super();
		this.usesSystemMenu = menuStyle === 'configuration' && hasSystemContextMenu(configurationService);
		this.systemMenu = this._register(new NativeContextMenuService(api, menuService, contextKeyService, keybindingService, this.windowNotifications));
		this.browserMenu = this._register(new BrowserContextMenuService(menuService, contextKeyService, keybindingService, this.contextViews, this.windowNotifications));
		this._register(this.systemMenu.onDidShowContextMenu(() => this.setVisible('system', true)));
		this._register(this.systemMenu.onDidHideContextMenu(() => this.setVisible('system', false)));
		this._register(this.browserMenu.onDidShowContextMenu(() => this.setVisible('browser', true)));
		this._register(this.browserMenu.onDidHideContextMenu(() => this.setVisible('browser', false)));
		if (isMacintosh && menuStyle === 'configuration') {
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
		// Hide callbacks can open a successor before the previous hide event arrives.
		const wasVisible = this.systemVisible + this.browserVisible > 0;
		if (menu === 'system') { this.systemVisible += visible ? 1 : -1; }
		else { this.browserVisible += visible ? 1 : -1; }
		const isVisible = this.systemVisible + this.browserVisible > 0;
		if (!wasVisible && isVisible) this._onDidShowContextMenu.fire();
		else if (wasVisible && !isVisible) this._onDidHideContextMenu.fire();
	}

	showContextMenu(delegate: IContextMenuDelegate | IContextMenuMenuDelegate): void {
		const request = ++this.menuRequest;
		if (this.isDisposed || delegate.cancellationToken?.isCancellationRequested) {
			delegate.onHide?.(true);
			return;
		}
		const anchor = delegate.getAnchor();
		if (this.isDisposed || delegate.cancellationToken?.isCancellationRequested) {
			delegate.onHide?.(true);
			return;
		}
		if (delegate.useNativeWindow) {
			this.showMenuWindow(delegate, anchor, request);
			return;
		}
		this.menuWindow?.hide();
		if (request !== this.menuRequest) { delegate.onHide?.(true); return; }
		// Electron Menu.popup cannot align its right edge with an element on the right side of the window.
		const rightHandTrigger = isNode(anchor) && delegate.anchorAxisAlignment === AnchorAxisAlignment.Horizontal && delegate.anchorAlignment === AnchorAlignment.Left;
		// Custom styling and icon placement need the browser menu's DOM, including on macOS.
		const styledMenu = !!(delegate.getMenuClassName?.() || delegate.submenuClassName || (delegate.iconPlacement && delegate.iconPlacement !== 'leading'));
		const menu = this.usesSystemMenu && !rightHandTrigger && !styledMenu ? this.systemMenu : this.browserMenu;
		if (menu === this.browserMenu) this.systemMenu.hideContextMenu();
		else this.browserMenu.hideContextMenu();
		menu.showContextMenu({ ...delegate, getAnchor: () => anchor });
	}

	private showMenuWindow(delegate: IContextMenuDelegate | IContextMenuMenuDelegate, anchor: ContextMenuAnchor, request: number): void {
		this.hideContextMenu();
		if (this.isDisposed || this.menuWindow || request !== this.menuRequest || delegate.cancellationToken?.isCancellationRequested) {
			delegate.onHide?.(true);
			return;
		}
		let host: ContextMenuWindow;
		try {
			host = new ContextMenuWindow(anchor, this.contextViews.container, request => this.api.presentWindow(request));
		} catch (error) {
			delegate.onHide?.(true);
			this.windowNotifications.error(toErrorMessage(error));
			return;
		}
		const lifetime = this.menuWindowLifetimes.set(host, new DisposableStore());
		let closed = false;
		let mounted = false;
		let closingReason: ContextViewHideReason | undefined;
		const finish = (didCancel: boolean, reason?: ContextViewHideReason): void => {
			if (closed) return;
			closed = true;
			if (this.menuWindow?.host === host) this.menuWindow = undefined;
			try {
				this.menuWindowLifetimes.deleteAndDispose(host);
				// Match ContextView: restore before notifying a caller that may open or focus another surface.
				if (
					didCancel && reason === ContextViewHideReason.Escape &&
					request === this.menuRequest && !this.isDisposed
				) {
					host.restoreSourceFocus();
				}
			} finally {
				delegate.onHide?.(didCancel, reason);
			}
		};
		const hide = (reason = ContextViewHideReason.Programmatic): void => {
			if (closed) return;
			closingReason = reason;
			if (mounted) this.browserMenu.hideContextMenu();
			finish(true, reason);
		};
		this.menuWindow = { host, hide };
		lifetime.add(toDisposable(() => finish(true, ContextViewHideReason.Programmatic)));
		lifetime.add(host);
		if (delegate.cancellationToken) lifetime.add(delegate.cancellationToken.onCancellationRequested(() => hide()));
		host.onBlur(() => hide(ContextViewHideReason.WindowBlur));
		const fail = (error: unknown): void => {
			if (closed) return;
			hide();
			if (!this.isDisposed) this.windowNotifications.error(toErrorMessage(error));
		};
		void host.whenReady.then(() => {
			if (closed || this.isDisposed || delegate.cancellationToken?.isCancellationRequested) return;
			mounted = true;
			this.browserMenu.showContextMenu({
				...delegate,
				getAnchor: () => ({ x: 4, y: 0, targetWindow: host.window }),
				domForShadowRoot: undefined,
				contextViewContainer: host.container,
				anchorAlignment: AnchorAlignment.Left,
				anchorAxisAlignment: AnchorAxisAlignment.Vertical,
				anchorPosition: AnchorPosition.Below,
				gap: 4,
				onDidRenderMenu: async root => {
					await host.layout(root);
					if (!closed) await delegate.onDidRenderMenu?.(root);
				},
				onHide: (cancelled, reason) => finish(cancelled, closingReason ?? reason),
			});
		}).catch(fail);
	}

	hideContextMenu(): void {
		// Closing a host can synchronously open a successor through the caller's hide callback.
		const request = this.menuRequest;
		this.menuWindow?.hide();
		if (request !== this.menuRequest) return;
		this.systemMenu.hideContextMenu();
		if (request !== this.menuRequest) return;
		this.browserMenu.hideContextMenu();
	}
}
