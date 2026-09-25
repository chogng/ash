import {
	type IAction,
	Separator,
	SubmenuAction,
} from "../../../../base/common/actions.js";
import {
	Disposable,
	toDisposable,
} from "../../../../base/common/lifecycle.js";
import { isMacintosh } from "../../../../base/common/platform.js";
import {
	type IMenu,
	type IMenuService,
	MenuId,
	MenuItemAction,
} from "../../../../platform/actions/common/actions.js";
import type {
	INativeMenubarApi,
	INativeMenubarData,
	NativeMenubarItem,
	INativeTouchBarItem,
} from "../../../../platform/menubar/common/nativeMenubar.js";
import type {
	IMenubarControl,
} from "../../../browser/parts/titlebar/menubarControl.js";

/** Synchronizes the workbench menu model to the macOS application menu. */
export class NativeMenubarControl extends Disposable
	implements IMenubarControl {
	private readonly api: INativeMenubarApi;
	private readonly menu: IMenu;
	private readonly touchBarMenu: IMenu | undefined;
	private readonly touchBarIcons: Promise<readonly string[]> | undefined;
	private readonly actionsByRevision = new Map<
		number,
		ReadonlyMap<string, IAction>
	>();
	private revision = 0;
	private updateTail = Promise.resolve();

	readonly domNode = undefined;

	constructor(
		menuService: IMenuService,
		api: INativeMenubarApi,
	) {
		super();
		this.api = api;
		this.menu = this._register(menuService.createMenu(MenuId.MenubarMainMenu));
		this._register(this.menu.onDidChange(() => this.synchronize()));
		if (isMacintosh) {
			this.touchBarMenu = this._register(menuService.createMenu(MenuId.TouchBarContext));
			this._register(this.touchBarMenu.onDidChange(() => this.synchronize()));
			this.touchBarIcons = Promise.all([
				pngDataUrl(new URL("../../../browser/parts/editor/media/back-tb.png", import.meta.url).href),
				pngDataUrl(new URL("../../../browser/parts/editor/media/forward-tb.png", import.meta.url).href),
			]);
		}
		const selection = api.onDidSelect(({ revision, id }) => {
			const action = this.actionsByRevision.get(revision)?.get(id);
			if (action) runAction(action);
		});
		this._register(toDisposable(() => selection.dispose()));
		this._register(toDisposable(() => {
			this.actionsByRevision.clear();
		}));
		this.synchronize();
	}

	private synchronize(): void {
		const revision = this.nextRevision();
		const menuActions = this.menu.getActions().flatMap(([, actions]) => actions);
		const touchBarActions = this.touchBarMenu?.getActions().flatMap(([, actions]) => actions) ?? [];

		this.updateTail = this.updateTail
			.then(async () => {
				if (this.isDisposed) return;
				const icons = await this.touchBarIcons;
				const serialized = serializeMenubar(menuActions, revision, touchBarActions, icons);
				this.actionsByRevision.set(revision, serialized.actions);
				try {
					await this.api.update(serialized.data);
				} catch (error) {
					this.actionsByRevision.delete(revision);
					throw error;
				}
				while (this.actionsByRevision.size > 2) {
					const oldest = this.actionsByRevision.keys().next().value;
					if (oldest === undefined) break;
					this.actionsByRevision.delete(oldest);
				}
			})
			.catch((error: unknown) => {
				console.error("Failed to update native menubar", error);
			});
	}

	private nextRevision(): number {
		this.revision = this.revision === Number.MAX_SAFE_INTEGER
			? 1
			: this.revision + 1;
		return this.revision;
	}
}

interface ISerializedMenubar {
	readonly data: INativeMenubarData;
	readonly actions: ReadonlyMap<string, IAction>;
}

function serializeMenubar(
	actions: readonly IAction[],
	revision: number,
	touchBarActions: readonly IAction[] = [],
	touchBarIcons: readonly string[] = [],
): ISerializedMenubar {
	const actionMap = new Map<string, IAction>();
	let nextId = 1;

	const serializeItems = (
		source: readonly IAction[],
	): readonly NativeMenubarItem[] => {
		const items: NativeMenubarItem[] = [];
		for (const action of source) {
			if (action instanceof Separator) {
				items.push({ type: "separator" });
				continue;
			}
			if (action instanceof SubmenuAction) {
				const children = serializeItems(action.actions);
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
			const alternate = action instanceof MenuItemAction && action.alt?.enabled
				? action.alt
				: undefined;
			const altId = alternate
				? `action-${nextId++}`
				: undefined;
			if (altId && alternate) actionMap.set(altId, alternate);
			items.push({
				type: "action",
				id,
				...(altId ? { altId } : {}),
				label: action.label,
				enabled: action.enabled,
				...(action.checked === undefined
					? {}
					: { checked: action.checked }),
			});
		}
		return trimSeparators(items);
	};

	const touchBar: INativeTouchBarItem[] = touchBarActions.flatMap((action, index) => {
		if (action instanceof Separator || action instanceof SubmenuAction || !touchBarIcons[index]) return [];
		const id = `action-${nextId++}`;
		actionMap.set(id, action);
		return [{ id, label: action.label, enabled: action.enabled, icon: touchBarIcons[index]! }];
	});

	return {
		data: {
			revision,
			...(touchBar.length ? { touchBar } : {}),
			menus: actions
				.filter((action): action is SubmenuAction =>
					action instanceof SubmenuAction
				)
				.map((action) => ({
					label: action.label,
					items: serializeItems(action.actions),
				}))
				.filter(({ items }) => items.length > 0),
		},
		actions: actionMap,
	};
}

async function pngDataUrl(url: string): Promise<string> {
	if (url.startsWith("data:image/png;base64,")) return url;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Could not load Touch Bar icon: ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}

function trimSeparators(
	items: readonly NativeMenubarItem[],
): readonly NativeMenubarItem[] {
	const result: NativeMenubarItem[] = [];
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

function runAction(action: IAction): void {
	try {
		Promise.resolve(action.run()).catch((error: unknown) => {
			console.error(`Menubar action failed: ${action.id}`, error);
		});
	} catch (error) {
		console.error(`Menubar action failed: ${action.id}`, error);
	}
}
