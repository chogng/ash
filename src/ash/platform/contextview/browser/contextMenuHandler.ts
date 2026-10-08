import {
	type ContextMenuAnchor,
	type IContextMenuDelegate,
} from "../../../base/browser/contextmenu.js";
import { isNode } from "../../../base/browser/dom.js";
import {
	AnchorPosition,
	ContextViewFocusRestore,
} from "../../../base/browser/ui/contextview/contextview.js";
import { Menu } from "../../../base/browser/ui/menu/menu.js";
import { ActionRunner, type IAction } from "../../../base/common/actions.js";
import { Disposable, DisposableMap, DisposableStore } from "../../../base/common/lifecycle.js";
import type { IRectangle } from "../../../base/common/layout.js";
import type { IKeybindingService } from "../../keybinding/common/keybinding.js";
import type { INotificationService } from "../../notification/common/notification.js";
import type { IContextViewService } from "./contextView.js";

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
		const finish = (): void => {
			if (didHide) { return; }
			didHide = true;
			if (this.activeMenu === request) { this.activeMenu = undefined; }
			if (!executingAction) { this.executions.deleteAndDispose(executionDisposables); }
			this.menus.deleteAndDispose(request);
			delegate.onHide?.(!executingAction);
		};
		const request = {
			hide: (): void => {
				if (this.activeMenu !== request || didHide) { return; }
				if (shown) { this.contextViewService.hide(); }
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
		const menu = new Menu(this.contextViewService.container, {
			actions,
			openSubmenusImmediatelyOnHover: delegate.openSubmenusImmediatelyOnHover,
			contextViewContainer: this.contextViewService.container,
			layer: delegate.layer ?? 10,
			className: delegate.getMenuClassName?.(),
			actionViewItemProvider: delegate.getActionViewItem,
			getCheckedActionsRepresentation: delegate.getCheckedActionsRepresentation,
			actionRunner,
			actionContext,
			getKeybinding: delegate.getKeyBinding ?? ((action) =>
				this.keybindingService.lookupKeybinding(action.id)),
			onDidRequestClose: () => request.hide(),
		});
		if (didHide) { menu.dispose(); return false; }
		disposables.add(menu);
		// Replacement callbacks can cancel this request or open a successor before it mounts.
		this.contextViewService.hide();
		if (didHide) { return false; }
		shown = this.contextViewService.show({
			anchor,
			content: menu.element,
			anchorAxisAlignment: delegate.anchorAxisAlignment,
			anchorAlignment: delegate.anchorAlignment,
			anchorPosition: delegate.anchorPosition ?? AnchorPosition.Below,
			presentation: "menu",
			focusRestore: ContextViewFocusRestore.Previous,
			layer: delegate.layer ?? 10,
			isTargetWithin: (target) => menu.contains(target),
			onHide: finish,
		});
		if (!shown) {
			finish();
			return false;
		}

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

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
