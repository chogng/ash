import { isMacintosh } from "../../../../base/common/platform.js";
import { BrowserContextMenuService } from "../../../../platform/contextview/browser/contextMenuService.js";
import type { WorkbenchContextMenuServiceOptions } from "../../../browser/workbenchInteractionServices.js";
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
import type { IMenuService } from "../../../../platform/actions/common/actions.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type {
	IKeybindingService,
} from "../../../../platform/keybinding/common/keybinding.js";
import type { INotificationService } from "../../../../platform/notification/common/notification.js";
import {
	type INativeContextMenuApi,
	type INativeContextMenuRequest,
	type NativeContextMenuItem,
} from "../../../../base/parts/contextmenu/common/contextmenu.js";
import type {
	ContextMenuAnchor,
	IContextMenuDelegate,
} from "../../../../base/browser/contextmenu.js";
import { transformContextMenuDelegate } from "../../../../platform/contextview/browser/contextMenuService.js";
import type {
	IContextMenuMenuDelegate,
	IContextMenuService,
} from "../../../../platform/contextview/browser/contextView.js";

/** macOS implementation backed by Electron's native Menu. */
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
		menuService: IMenuService,
		private readonly contextKeyService: IContextKeyService,
		keybindingService: IKeybindingService,
		private readonly notificationService: INotificationService,
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

		const point = anchorPoint(resolved.getAnchor());
		const request: INativeContextMenuRequest = {
			items: serialized.items,
			x: point.x,
			y: point.y,
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
): { readonly x: number; readonly y: number } {
	if (!isNode(anchor)) {
		return {
			x: normalizeCoordinate(anchor.x),
			y: normalizeCoordinate(anchor.y),
		};
	}
	const bounds = anchor.getBoundingClientRect();
	return {
		x: normalizeCoordinate(bounds.left),
		y: normalizeCoordinate(bounds.bottom),
	};
}

function normalizeCoordinate(value: number): number {
	return Math.max(-1_000_000, Math.min(1_000_000, Math.round(value)));
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Creates the Electron workbench context-menu service. */
export function createElectronWorkbenchContextMenuService(
	options: WorkbenchContextMenuServiceOptions,
	nativeApi: INativeContextMenuApi,
): NativeContextMenuService | BrowserContextMenuService {
	return isMacintosh
		? new NativeContextMenuService(
			nativeApi,
			options.menuService,
			options.contextKeyService,
			options.keybindingService,
			options.notificationService,
		)
		: new BrowserContextMenuService(
			options.menuService,
			options.contextKeyService,
			options.keybindingService,
			options.contextViewService,
			options.notificationService,
		);
}
