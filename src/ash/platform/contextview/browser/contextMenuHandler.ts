import {
	defaultMenuStyles,
	defaultButtonStyles,
	defaultKeybindingLabelStyles,
} from '../../theme/browser/defaultStyles.js';
import {
	type ContextMenuAnchor,
	type IContextMenuDelegate,
} from '../../../base/browser/contextmenu.js';
import { addDisposableListener, h, isNode } from '../../../base/browser/dom.js';
import {
	AnchorPosition,
	ContextView,
	ContextViewFocusRestore,
	type ContextViewHideReason,
	type IContextViewProvider,
} from '../../../base/browser/ui/contextview/contextview.js';
import { Menu } from '../../../base/browser/ui/menu/menu.js';
import { ActionRunner, type IAction } from '../../../base/common/actions.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IRectangle } from '../../../base/common/layout.js';
import type { IKeybindingService } from '../../keybinding/common/keybinding.js';
import type { INotificationService } from '../../notification/common/notification.js';
import type { IContextViewService } from './contextView.js';

/** Owns browser menu rendering and action lifecycle for one context-view host. */
export class ContextMenuHandler extends Disposable {
	private activeMenu: { hide(): void; } | undefined;
	private readonly menus = this._register(new DisposableMap<object, DisposableStore>());
	private readonly executions = this._register(new DisposableMap<DisposableStore, DisposableStore>());

	constructor(
		private readonly contextViewService: IContextViewService,
		private readonly keybindingService: IKeybindingService,
		private readonly notificationService: INotificationService,
	) {
		super();
	}

	showContextMenu(
		delegate: IContextMenuDelegate,
		onDidShow?: () => void,
	): boolean {
		if (this.isDisposed || delegate.cancellationToken?.isCancellationRequested) {
			delegate.onHide?.(true);
			return false;
		}
		this.hideContextMenu();
		// A hide callback may have opened a newer request.
		if (this.activeMenu || this.isDisposed || delegate.cancellationToken?.isCancellationRequested) {
			delegate.onHide?.(true);
			return false;
		}
		const actions = delegate.getActions();
		if (actions.length === 0 || this.activeMenu || this.isDisposed || delegate.cancellationToken?.isCancellationRequested) {
			delegate.onHide?.(true);
			return false;
		}

		const disposables = new DisposableStore();
		const executionDisposables = new DisposableStore();
		this.executions.set(executionDisposables, executionDisposables);
		const actionRunner = delegate.actionRunner ?? executionDisposables.add(new ActionRunner());
		let executingAction: IAction | undefined;
		let didHide = false;
		let shown = false;
		let mounting = false;
		let view: IContextViewProvider = this.contextViewService;
		let pendingHide: { readonly reason: ContextViewHideReason | undefined; } | undefined;
		const notifyHide = (reason?: ContextViewHideReason): void => {
			if (this.activeMenu === request) { this.activeMenu = undefined; }
			delegate.onHide?.(!executingAction, reason);
		};
		const finish = (reason?: ContextViewHideReason): void => {
			if (didHide) { return; }
			didHide = true;
			try {
				if (!executingAction) { this.executions.deleteAndDispose(executionDisposables); }
				this.menus.deleteAndDispose(request);
			} finally {
				// A successor must mount after the current host's synchronous show frame returns,
				// even when a custom view item's resource disposal fails.
				if (mounting) { pendingHide = { reason }; }
				else { notifyHide(reason); }
			}
		};
		const request = {
			hide: (): void => {
				if (this.activeMenu !== request || didHide) { return; }
				if (shown) { view.hide(); }
				else { finish(); }
			},
		};
		this.activeMenu = request;
		this.menus.set(request, disposables);
		if (delegate.cancellationToken) { disposables.add(delegate.cancellationToken.onCancellationRequested(() => request.hide())); }
		executionDisposables.add(actionRunner.onWillRun(event => {
			if (this.activeMenu !== request || executingAction) { return; }
			executingAction = event.action;
			request.hide();
		}));
		executionDisposables.add(actionRunner.onDidRun((event) => {
			if (event.action !== executingAction) { return; }
			if (!this.isDisposed && event.error !== undefined) {
				this.notificationService.error(toErrorMessage(event.error));
			}
			this.executions.deleteAndDispose(executionDisposables);
		}));

		const actionContext = delegate.getActionsContext?.();
		if (didHide) { return false; }
		const anchor = toContextViewAnchor(delegate.getAnchor());
		if (didHide) { return false; }
		const anchorDocument = isNode(anchor) ? anchor.ownerDocument : anchor.targetWindow?.document;
		const owner = delegate.domForShadowRoot;
		const shadowOwner = owner?.isConnected && (!anchorDocument || owner.ownerDocument === anchorDocument) ? owner : undefined;
		const dialogAnchor = shadowOwner ?? (isNode(anchor) ? anchor : undefined);
		const dialog = dialogAnchor && ContextView.getContainingDialog(dialogAnchor);
		let menuContainer = dialog?.element ?? this.contextViewService.container;
		let container: HTMLElement | ShadowRoot = menuContainer;
		if (shadowOwner) {
			const host = h(shadowOwner.ownerDocument, 'div');
			const root = host.attachShadow({ mode: 'open' });
			shadowOwner.append(host);
			disposables.add(toDisposable(() => host.remove()));
			// A menu click must not become a click on the editor behind it.
			for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'contextmenu', 'wheel', 'keydown', 'keyup']) {
				disposables.add(addDisposableListener(root, type, event => event.stopPropagation()));
			}
			container = root;
		}
		if (shadowOwner || dialog) {
			// A local menu can open without replacing the containing dialog.
			const localView = disposables.add(new ContextView(container));
			view = localView;
			if (shadowOwner) menuContainer = localView.element;
			if (dialog) disposables.add(dialog.onDidHide(() => request.hide()));
		}
		const menu = new Menu(menuContainer, actions, {
			buttonStyles: defaultButtonStyles,
			keybindingLabelStyles: defaultKeybindingLabelStyles,
			openSubmenusImmediatelyOnHover: delegate.openSubmenusImmediatelyOnHover,
			contextViewContainer: container,
			layer: delegate.layer ?? 10,
			className: delegate.getMenuClassName?.(),
			submenuClassName: delegate.submenuClassName,
			iconPlacement: delegate.iconPlacement,
			actionViewItemProvider: delegate.getActionViewItem,
			getCheckedActionsRepresentation: delegate.getCheckedActionsRepresentation,
			actionRunner,
			context: actionContext,
			enableMnemonics: true,
			getKeyBinding: delegate.getKeyBinding ?? ((action) =>
				this.keybindingService.lookupKeybinding(action.id))
		}, defaultMenuStyles);
		if (didHide) { menu.dispose(); return false; }
		disposables.add(menu);
		disposables.add(menu.onDidCancel(() => request.hide()));
		disposables.add(menu.onDidBlur(() => request.hide()));
		// Replacement callbacks can cancel this request or open a successor before it mounts.
		if (!dialog) this.contextViewService.hide();
		if (didHide) { return false; }
		// Mounting owns the host before synchronous layout callbacks can cancel this request.
		shown = true;
		mounting = true;
		try {
			shown = view.show({
				anchor,
				content: menu.getContainer(),
				anchorAxisAlignment: delegate.anchorAxisAlignment,
				anchorAlignment: delegate.anchorAlignment,
				anchorPosition: delegate.anchorPosition ?? AnchorPosition.Below,
				gap: delegate.gap,
				presentation: 'menu',
				focusRestore: ContextViewFocusRestore.Previous,
				layer: delegate.layer ?? 10,
				blockOutsidePointer: true,
				isTargetWithin: (target) => menu.contains(target),
				onHide: finish,
			});
		} catch (error) {
			request.hide();
			throw error;
		} finally {
			mounting = false;
			if (pendingHide) { notifyHide(pendingHide.reason); }
		}
		if (!shown) {
			finish();
			return false;
		}
		if (didHide || this.activeMenu !== request) { return false; }

		onDidShow?.();
		if (didHide || this.activeMenu !== request) { return false; }
		menu.focus(delegate.autoSelectFirstItem === true);
		return true;
	}

	hideContextMenu(): void {
		this.activeMenu?.hide();
	}

	protected override disposeCore(): void {
		this.hideContextMenu();
		super.disposeCore();
	}
}

function toContextViewAnchor(
	anchor: ContextMenuAnchor,
): Element | (IRectangle & { readonly targetWindow?: Window; }) {
	if (isNode(anchor)) return anchor;
	return {
		left: anchor.x,
		top: anchor.y,
		width: 0,
		height: 0,
		targetWindow: anchor.targetWindow,
	};
}
