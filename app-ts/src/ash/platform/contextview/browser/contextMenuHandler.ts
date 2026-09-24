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
import { ActionRunner } from "../../../base/common/actions.js";
import { Disposable, DisposableStore, MutableDisposable } from "../../../base/common/lifecycle.js";
import type { IRectangle } from "../../../base/common/layout.js";
import type { IKeybindingService } from "../../keybinding/common/keybinding.js";
import type { INotificationService } from "../../notification/common/notification.js";
import type { IContextViewService } from "./contextView.js";

/** Owns browser menu rendering and action lifecycle for one context-view host. */
export class ContextMenuHandler extends Disposable {
	private readonly activeMenu = new MutableDisposable<DisposableStore>();
	private didSelect = false;

	constructor(
		private readonly contextViewService: IContextViewService,
		private readonly keybindingService: IKeybindingService,
		private readonly notificationService: INotificationService,
	) {
		super();
		this._register(this.activeMenu);
	}

	showContextMenu(
		delegate: IContextMenuDelegate,
		onDidShow?: () => void,
	): boolean {
		this.hideContextMenu();
		const actions = delegate.getActions();
		if (actions.length === 0) {
			delegate.onHide?.(true);
			return false;
		}

		const disposables = new DisposableStore();
		this.activeMenu.value = disposables;
		this.didSelect = false;
		const executionDisposables = this._register(new DisposableStore());
		const actionRunner = delegate.actionRunner ?? executionDisposables.add(new ActionRunner());
		let actionStarted = false;
		executionDisposables.add(actionRunner.onWillRun(() => {
			actionStarted = true;
			this.didSelect = true;
			this.contextViewService.hide();
		}));
		executionDisposables.add(actionRunner.onDidRun((event) => {
			if (event.error !== undefined) {
				this.notificationService.error(toErrorMessage(event.error));
			}
			executionDisposables.dispose();
		}));

		const menu = disposables.add(new Menu(this.contextViewService.container, {
			actions,
			contextViewContainer: this.contextViewService.container,
			layer: delegate.layer ?? 10,
			className: delegate.getMenuClassName?.(),
			actionViewItemProvider: delegate.getActionViewItem,
			getCheckedActionsRepresentation: delegate.getCheckedActionsRepresentation,
			actionRunner,
			actionContext: delegate.getActionsContext?.(),
			getKeybinding: delegate.getKeyBinding ?? ((action) =>
				this.keybindingService.lookupKeybinding(action.id)),
			onDidRequestClose: () => this.contextViewService.hide(),
		}));
		let didHide = false;
		const shown = this.contextViewService.show({
			anchor: toContextViewAnchor(delegate.getAnchor()),
			content: menu.element,
			anchorAxisAlignment: delegate.anchorAxisAlignment,
			anchorAlignment: delegate.anchorAlignment,
			anchorPosition: delegate.anchorPosition ?? AnchorPosition.Below,
			presentation: "menu",
			focusRestore: ContextViewFocusRestore.Previous,
			layer: delegate.layer ?? 10,
			isTargetWithin: (target) => menu.contains(target),
			onHide: () => {
				didHide = true;
				if (!actionStarted) executionDisposables.dispose();
				const didCancel = !this.didSelect;
				this.activeMenu.clear();
				this.didSelect = false;
				delegate.onHide?.(didCancel);
			},
		});
		if (!shown) {
			this.activeMenu.clear();
			if (!didHide) delegate.onHide?.(true);
			return false;
		}

		onDidShow?.();
		if (delegate.autoSelectFirstItem !== false) menu.focusFirst();
		return true;
	}

	hideContextMenu(): void {
		if (!this.activeMenu.value) return;
		this.contextViewService.hide();
	}

	override dispose(): void {
		this.hideContextMenu();
		super.dispose();
	}
}

function toContextViewAnchor(
	anchor: ContextMenuAnchor,
): Element | (IRectangle & { readonly targetWindow?: Window }) {
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
