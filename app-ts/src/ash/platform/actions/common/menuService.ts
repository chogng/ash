import {
	Separator,
	type IAction,
} from "../../../base/common/actions.js";
import { Emitter } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { isCommandActionToggleInfo } from "../../action/common/action.js";
import type {
	ICommandService,
} from "../../commands/common/commands.js";
import type {
	ContextKeyExpression,
	IContextKeyService,
} from "../../contextkey/common/contextkey.js";
import { onDidChangeNls } from "../../../nls.js";
import {
	type IMenuActionOptions,
	type IMenu,
	type IMenuChangeEvent,
	type IMenuRegistryChangeEvent,
	type IMenuService,
	isMenuItem,
	MenuId,
	MenuItemAction,
	type MenuActionGroup,
	MenusRegistry,
	type MenuRegistryItem,
	SubmenuItemAction,
} from "./actions.js";

/** Resolves registered menu contributions for one workbench context. */
export class MenuService implements IMenuService {
	private readonly commandService: ICommandService;
	private readonly contextKeyService: IContextKeyService;

	constructor(
		commandService: ICommandService,
		contextKeyService: IContextKeyService,
	) {
		this.commandService = commandService;
		this.contextKeyService = contextKeyService;
	}

	createMenu(
		id: MenuId,
		contextKeyService: IContextKeyService = this.contextKeyService,
	): IMenu {
		return new Menu(id, this.commandService, contextKeyService);
	}

	getMenuActions(
		id: MenuId,
		options?: IMenuActionOptions,
		contextKeyService: IContextKeyService = this.contextKeyService,
	): readonly MenuActionGroup[] {
		return resolveMenu(
			id,
			this.commandService,
			contextKeyService,
			options,
			new Set(),
		);
	}
}

class Menu extends Disposable implements IMenu {
	private readonly _onDidChange = this._register(new Emitter<IMenuChangeEvent>());
	readonly onDidChange = this._onDidChange.event;
	private readonly id: MenuId;
	private readonly commandService: ICommandService;
	private readonly contextKeyService: IContextKeyService;
	private readonly snapshot: MenuInfoSnapshot;

	constructor(
		id: MenuId,
		commandService: ICommandService,
		contextKeyService: IContextKeyService,
	) {
		super();
		this.id = id;
		this.commandService = commandService;
		this.contextKeyService = contextKeyService;
		this.snapshot = new MenuInfoSnapshot(this.id);
		this._register(MenusRegistry.onDidChangeMenu(
			(event: IMenuRegistryChangeEvent) => {
				let affected = false;
				for (const menuId of this.snapshot.menuIds) {
					if (event.has(menuId)) {
						affected = true;
						break;
					}
				}
				if (!affected) return;
				this.snapshot.refresh();
				this._onDidChange.fire({
					isStructuralChange: true,
					isEnablementChange: true,
					isToggleChange: true,
				});
			},
		));
		this._register(this.contextKeyService.onDidChangeContext((event) => {
			const isStructuralChange = event.affectsSome(
				this.snapshot.structureContextKeys,
			);
			const isEnablementChange = event.affectsSome(
				this.snapshot.enablementContextKeys,
			);
			const isToggleChange = event.affectsSome(
				this.snapshot.toggleContextKeys,
			);
			if (!isStructuralChange && !isEnablementChange && !isToggleChange) {
				return;
			}
			this._onDidChange.fire({
				isStructuralChange,
				isEnablementChange,
				isToggleChange,
			});
		}));
		this._register(onDidChangeNls(() => {
			this._onDidChange.fire({
				isStructuralChange: false,
				isEnablementChange: false,
				isToggleChange: false,
			});
		}));
	}

	getActions(options?: IMenuActionOptions): readonly MenuActionGroup[] {
		return resolveMenu(
			this.id,
			this.commandService,
			this.contextKeyService,
			options,
			new Set(),
		);
	}
}

class MenuInfoSnapshot {
	readonly menuIds = new Set<MenuId>();
	readonly structureContextKeys = new Set<string>();
	readonly enablementContextKeys = new Set<string>();
	readonly toggleContextKeys = new Set<string>();

	constructor(private readonly id: MenuId) {
		this.refresh();
	}

	refresh(): void {
		this.menuIds.clear();
		this.structureContextKeys.clear();
		this.enablementContextKeys.clear();
		this.toggleContextKeys.clear();
		this.collectMenu(this.id);
	}

	private collectMenu(menuId: MenuId): void {
		if (this.menuIds.has(menuId)) return;
		this.menuIds.add(menuId);
		for (const item of MenusRegistry.getMenuItems(menuId)) {
			addExpressionKeys(item.when, this.structureContextKeys);
			if (!isMenuItem(item)) {
				this.collectMenu(item.submenu);
				continue;
			}
			for (const command of [item.command, item.alt]) {
				if (!command) continue;
				addExpressionKeys(command.precondition, this.enablementContextKeys);
				const toggled = command.toggled;
				addExpressionKeys(
					toggled && isCommandActionToggleInfo(toggled)
						? toggled.condition
						: toggled,
					this.toggleContextKeys,
				);
			}
		}
	}
}

function addExpressionKeys(expression: ContextKeyExpression | undefined, keys: Set<string>): void {
	if (!expression) return;
	for (const key of expression.keys()) keys.add(key);
}

function resolveMenu(
	id: MenuId,
	commandService: ICommandService,
	contextKeyService: IContextKeyService,
	options: IMenuActionOptions | undefined,
	ancestors: Set<MenuId>,
): readonly MenuActionGroup[] {
	if (ancestors.has(id)) {
		throw new Error(`Menu contribution cycle detected at '${id.id}'`);
	}

	const nextAncestors = new Set(ancestors);
	nextAncestors.add(id);
	const sorted = MenusRegistry.getMenuItems(id)
		.filter(item => contextKeyService.contextMatchesRules(item.when))
		.sort(compareMenuItems);
	const groups = new Map<string, IAction[]>();

	for (const item of sorted) {
		const action = resolveItem(
			item,
			commandService,
			contextKeyService,
			options,
			nextAncestors,
		);
		if (!action) continue;
		const group = item.group ?? "";
		const actions = groups.get(group);
		if (actions) actions.push(action);
		else groups.set(group, [action]);
	}

	return [...groups].map(([group, actions]) => [group, actions] as const);
}

function resolveItem(
	item: MenuRegistryItem,
	commandService: ICommandService,
	contextKeyService: IContextKeyService,
	options: IMenuActionOptions | undefined,
	ancestors: Set<MenuId>,
): IAction | undefined {
	if (isMenuItem(item)) {
		const alt = item.alt
			? new MenuItemAction(
				item.alt,
				undefined,
				options,
				contextKeyService,
				commandService,
			)
			: undefined;
		return new MenuItemAction(
			item.command,
			alt,
			options,
			contextKeyService,
			commandService,
		);
	}

	const groups = resolveMenu(
		item.submenu,
		commandService,
		contextKeyService,
		options,
		ancestors,
	);
	const actions = Separator.join(
		...groups.map(([, groupActions]) => [...groupActions]),
	);
	return actions.length > 0 || options?.preserveEmptySubmenus
		? new SubmenuItemAction(item, actions)
		: undefined;
}

function compareMenuItems(
	first: MenuRegistryItem,
	second: MenuRegistryItem,
): number {
	const groupComparison = compareGroups(first.group, second.group);
	if (groupComparison !== 0) return groupComparison;

	const orderComparison = (first.order ?? 0) - (second.order ?? 0);
	if (orderComparison !== 0) return orderComparison;

	return itemTitle(first).localeCompare(itemTitle(second));
}

function compareGroups(
	first: string | undefined,
	second: string | undefined,
): number {
	if (first === second) return 0;
	if (!first) return 1;
	if (!second) return -1;
	if (first === "navigation") return -1;
	if (second === "navigation") return 1;
	return first.localeCompare(second);
}

function itemTitle(item: MenuRegistryItem): string {
	if (!isMenuItem(item)) return typeof item.title === "string" ? item.title : item.title.original;
	return typeof item.command.title === "string"
		? item.command.title
		: item.command.title.original;
}
