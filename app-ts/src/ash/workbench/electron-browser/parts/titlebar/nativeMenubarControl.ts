import {
	type IAction,
	Separator,
	SubmenuAction,
} from "../../../../base/common/actions.js";
import {
	Disposable,
	toDisposable,
} from "../../../../base/common/lifecycle.js";
import {
	MenuId,
	MenuItemAction,
} from "../../../../platform/actions/common/actions.js";
import type {
	IMenu,
	IMenuService,
} from "../../../../platform/actions/common/menuService.js";
import type {
	INativeMenubarApi,
	INativeMenubarData,
	NativeMenubarItem,
} from "../../../../platform/menubar/common/nativeMenubar.js";
import type {
	IMenubarControl,
} from "../../../browser/parts/titlebar/menubarControl.js";

/** Synchronizes the workbench menu model to the macOS application menu. */
export class NativeMenubarControl extends Disposable
	implements IMenubarControl {
	private readonly api: INativeMenubarApi;
	private readonly menu: IMenu;
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
		const serialized = serializeMenubar(
			this.menu.getActions().flatMap(([, actions]) => actions),
			revision,
		);

		this.updateTail = this.updateTail
			.then(async () => {
				if (this.isDisposed) return;
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

	return {
		data: {
			revision,
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
