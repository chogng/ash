import {
	SubmenuAction,
	type IAction,
} from "../../../base/common/actions.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import type { Icon } from "../../../base/common/icon.js";
import type { Keybinding } from "../../../base/common/keybindings.js";
import {
	DisposableStore,
	type IDisposable,
	toDisposable,
} from "../../../base/common/lifecycle.js";
import { getOrSet } from "../../../base/common/map.js";
import { operatingSystem, OperatingSystem } from "../../../base/common/platform.js";
import {
	commandActionLabel,
	type CommandActionTitle,
	type ICommandAction,
	isCommandActionToggleInfo,
} from "../../action/common/action.js";
import {
	CommandsRegistry,
	type ICommandService,
} from "../../commands/common/commands.js";
import type {
	ContextKeyExpression,
	IContextKeyService,
} from "../../contextkey/common/contextkey.js";
import {
	ContextKeyExpr,
} from "../../contextkey/common/contextkey.js";
import {
	createServiceIdentifier,
	type ServicesAccessor,
} from "../../instantiation/common/instantiation.js";
import {
	KeybindingsRegistry,
	type KeybindingSource,
} from "../../keybinding/common/keybindingsRegistry.js";

export interface IMenuItem {
	readonly command: ICommandAction;
	readonly alt?: ICommandAction;
	readonly when?: ContextKeyExpression;
	readonly group?: "navigation" | string;
	readonly order?: number;
}

export interface ISubmenuItem {
	readonly title: CommandActionTitle;
	readonly submenu: MenuId;
	readonly when?: ContextKeyExpression;
	readonly group?: "navigation" | string;
	readonly order?: number;
}

export type MenuRegistryItem = IMenuItem | ISubmenuItem;

export function isMenuItem(item: MenuRegistryItem): item is IMenuItem {
	return "command" in item;
}

/** Identifies an action contribution location, regardless of its final UI. */
export class MenuId {
	private static readonly instances = new Map<string, MenuId>();

	static readonly CommandPalette = new MenuId("CommandPalette");
	static readonly CommandCenter = new MenuId("CommandCenter");
	static readonly GlobalActivity = new MenuId("GlobalActivity");
	static readonly SidebarTitle = new MenuId('SidebarTitle');
	static readonly TitleBar = new MenuId("TitleBar");
	static readonly TitleBarLeft = new MenuId("TitleBarLeft");
	static readonly TitleBarAdjacentCenter = new MenuId("TitleBarAdjacentCenter");
	static readonly EditorTitle = new MenuId("EditorTitle");
	static readonly EditorTitleContext = new MenuId("EditorTitleContext");
	static readonly TouchBarContext = new MenuId("TouchBarContext");
	static readonly EditorContext = new MenuId("EditorContext");
	static readonly StickyScrollContext = new MenuId("StickyScrollContext");
	static readonly SimpleEditorContext = new MenuId("SimpleEditorContext");
	static readonly EditorContextCopy = new MenuId("EditorContextCopy");
	static readonly EditorContextShare = new MenuId("EditorContextShare");
	static readonly ExplorerContext = new MenuId("ExplorerContext");
	static readonly ExplorerContextShare = new MenuId("ExplorerContextShare");
	static readonly MenubarCopy = new MenuId("MenubarCopy");
	static readonly MultiDiffEditorFileToolbar = new MenuId("MultiDiffEditorFileToolbar");
	static readonly ChatTitle = new MenuId("ChatTitle");
	static readonly ChatTitleLayout = new MenuId("ChatTitleLayout");
	static readonly AgentSidebarTitle = new MenuId("AgentSidebarTitle");
	static readonly GitGraphTitle = new MenuId("GitGraphTitle");
	static readonly SCMHistoryItemContext = new MenuId("SCMHistoryItemContext");
	static readonly SCMHistoryItemChangeContext = new MenuId("SCMHistoryItemChangeContext");
	static readonly PanelTitle = new MenuId("PanelTitle");
	static readonly TerminalTitle = new MenuId("TerminalTitle");
	static readonly MenubarMainMenu = new MenuId("MenubarMainMenu");
	static readonly MenubarFileMenu = new MenuId("MenubarFileMenu");
	static readonly MenubarEditMenu = new MenuId("MenubarEditMenu");
	static readonly MenubarSelectionMenu = new MenuId(
		"MenubarSelectionMenu",
	);
	static readonly MenubarViewMenu = new MenuId("MenubarViewMenu");
	static readonly MenubarGoMenu = new MenuId("MenubarGoMenu");
	static readonly MenubarRunMenu = new MenuId("MenubarRunMenu");
	static readonly MenubarTerminalMenu = new MenuId(
		"MenubarTerminalMenu",
	);
	static readonly MenubarHelpMenu = new MenuId("MenubarHelpMenu");

	static for(identifier: string): MenuId {
		return this.instances.get(identifier) ?? new MenuId(identifier);
	}

	readonly id: string;

	constructor(identifier: string) {
		if (MenuId.instances.has(identifier)) {
			throw new TypeError(
				`MenuId '${identifier}' already exists; use MenuId.for()`,
			);
		}
		this.id = identifier;
		MenuId.instances.set(identifier, this);
	}
}

export interface IMenuRegistryChangeEvent {
	has(id: MenuId): boolean;
}

/** Keeps each placement's lifetime separate when callers reuse one menu item object. */
interface MenuContribution {
	readonly id: MenuId;
	readonly item: MenuRegistryItem;
}

/** Realm-wide registry of static and dynamic action placements. */
export class MenuRegistry {
	private readonly items = new Map<MenuId, MenuContribution[]>();
	private readonly _onDidChangeMenu = new Emitter<IMenuRegistryChangeEvent>();

	readonly onDidChangeMenu: Event<IMenuRegistryChangeEvent> =
		this._onDidChangeMenu.event;

	appendMenuItem(id: MenuId, item: MenuRegistryItem): IDisposable {
		return this.appendMenuItems([{ id, item }]);
	}

	appendMenuItems(
		entries: Iterable<{ readonly id: MenuId; readonly item: MenuRegistryItem }>,
	): IDisposable {
		const contributions = Array.from(entries, ({ id, item }) => ({ id, item }));
		const changed = new Set<MenuId>();
		for (const contribution of contributions) {
			getOrSet(this.items, contribution.id, []).push(contribution);
			changed.add(contribution.id);
		}
		if (changed.size > 0) this._onDidChangeMenu.fire(changed);

		return toDisposable(() => {
			const removed = new Set<MenuId>();
			for (const contribution of contributions) {
				const current = this.items.get(contribution.id);
				if (!current) continue;
				const index = current.indexOf(contribution);
				if (index < 0) continue;
				current.splice(index, 1);
				if (current.length === 0) this.items.delete(contribution.id);
				removed.add(contribution.id);
			}
			if (removed.size > 0) this._onDidChangeMenu.fire(removed);
		});
	}

	getMenuItems(id: MenuId): readonly MenuRegistryItem[] {
		return (this.items.get(id) ?? []).map(({ item }) => item);
	}
}

/** Realm-wide menu contributions populated by static contribution modules. */
export const MenusRegistry = new MenuRegistry();

export interface IMenuActionOptions {
	readonly arg?: unknown;
	readonly args?: readonly unknown[];
	readonly shouldForwardArgs?: boolean;
	readonly renderShortTitle?: boolean;
	readonly preserveEmptySubmenus?: boolean;
}

export type MenuActionGroup = readonly [
	group: string,
	actions: readonly IAction[],
];

export interface IMenuChangeEvent {
	readonly isStructuralChange: boolean;
	readonly isEnablementChange: boolean;
	readonly isToggleChange: boolean;
}

export interface IMenu extends IDisposable {
	readonly onDidChange: Event<IMenuChangeEvent>;

	getActions(options?: IMenuActionOptions): readonly MenuActionGroup[];
}

export interface IMenuService {
	createMenu(
		id: MenuId,
		contextKeyService?: IContextKeyService,
	): IMenu;

	getMenuActions(
		id: MenuId,
		options?: IMenuActionOptions,
		contextKeyService?: IContextKeyService,
	): readonly MenuActionGroup[];
}

export const IMenuService =
	createServiceIdentifier<IMenuService>("menuService");

/** A command contribution resolved into a runnable UI action. */
export class MenuItemAction implements IAction {
	readonly id: string;
	readonly label: string;
	readonly tooltip: string;
	readonly icon?: Icon;
	readonly enabled: boolean;
	readonly checked?: boolean;
	private readonly options: IMenuActionOptions | undefined;
	private readonly commandService: ICommandService;

	constructor(
		readonly item: ICommandAction,
		readonly alt: MenuItemAction | undefined,
		options: IMenuActionOptions | undefined,
		contextKeyService: IContextKeyService,
		commandService: ICommandService,
	) {
		this.options = options;
		this.commandService = commandService;
		this.id = item.id;
		this.label = options?.renderShortTitle && item.shortTitle
			? commandActionLabel(item.shortTitle)
			: commandActionLabel(item.title);
		this.tooltip = item.tooltip
			? commandActionLabel(item.tooltip)
			: this.label;
		this.icon = item.icon;
		this.enabled = contextKeyService.contextMatchesRules(item.precondition);

		if (item.toggled) {
			const toggled = isCommandActionToggleInfo(item.toggled)
				? item.toggled
				: { condition: item.toggled };
			this.checked = contextKeyService.contextMatchesRules(toggled.condition);
			if (this.checked) {
				if (toggled.title) this.label = commandActionLabel(toggled.title);
				if (toggled.tooltip) {
					this.tooltip = commandActionLabel(toggled.tooltip);
				}
				if (toggled.icon) this.icon = toggled.icon;
			}
		}
	}

	run(...args: readonly unknown[]): Promise<unknown> {
		const commandArgs: unknown[] = [];
		if (this.options?.args) {
			commandArgs.push(...this.options.args);
		} else if (this.options && "arg" in this.options) {
			commandArgs.push(this.options.arg);
		}
		if (this.options?.shouldForwardArgs) commandArgs.push(...args);
		return this.commandService.executeCommand(this.id, ...commandArgs);
	}
}

/** A submenu contribution resolved into a nested runtime action. */
export class SubmenuItemAction extends SubmenuAction {
	constructor(
		readonly item: ISubmenuItem,
		actions: readonly IAction[],
	) {
		super(`submenu.${item.submenu.id}`, commandActionLabel(item.title), actions);
	}
}

type OneOrMany<T> = T | readonly T[];

type ActionKeybinding = Keybinding | number | readonly number[];

interface IAction2PlatformKeybindingOptions {
	readonly primary: ActionKeybinding;
	readonly secondary?: readonly ActionKeybinding[];
}

export interface IAction2KeybindingOptions extends IAction2PlatformKeybindingOptions {
	readonly win?: IAction2PlatformKeybindingOptions;
	readonly linux?: IAction2PlatformKeybindingOptions;
	readonly mac?: IAction2PlatformKeybindingOptions;
	readonly when?: ContextKeyExpression;
	readonly args?: readonly unknown[];
	readonly source?: KeybindingSource;
	readonly priority?: number;
	readonly weight?: number;
}

export interface IAction2Options extends ICommandAction {
	readonly menu?: OneOrMany<{
		readonly id: MenuId;
		readonly when?: ContextKeyExpression;
		readonly group?: "navigation" | string;
		readonly order?: number;
	}>;
	readonly keybinding?: OneOrMany<IAction2KeybindingOptions>;
	readonly f1?: boolean;
}

/** Base class for a statically declared command and its UI contributions. */
export abstract class Action2 {
	constructor(readonly desc: Readonly<IAction2Options>) {}

	abstract run(
		accessor: ServicesAccessor,
		...args: readonly unknown[]
	): unknown;
}

/**
 * Registers a built-in action for the current JavaScript realm.
 *
 * Static contribution modules intentionally keep registrations for the realm
 * lifetime. Dynamic callers must retain and dispose the returned registration.
 */
export function registerAction2(
	ctor: new () => Action2,
): IDisposable {
	const action = new ctor();
	const registrations = new DisposableStore();

	try {
		registrations.add(CommandsRegistry.register(
			action.desc.id,
			(accessor, ...args) => action.run(accessor, ...args),
		));

		for (const contribution of toArray(action.desc.keybinding)) {
			const platformContribution = getPlatformKeybinding(contribution);
			const keybindings = [
				platformContribution?.primary ?? contribution.primary,
				...(platformContribution?.secondary ?? contribution.secondary ?? []),
			];
			const when = ContextKeyExpr.and(
				action.desc.precondition,
				contribution.when,
			);
			for (const keybinding of keybindings) {
				registrations.add(KeybindingsRegistry.registerKeybindingRule({
					command: action.desc.id,
					keybinding,
					when,
					args: contribution.args,
					source: contribution.source,
					priority: contribution.priority ?? contribution.weight,
				}));
			}
		}

		const menuItems: Array<{ id: MenuId; item: MenuRegistryItem }> = [];
		for (const placement of toArray(action.desc.menu)) {
			menuItems.push({
				id: placement.id,
				item: {
					command: action.desc,
					when: placement.when,
					group: placement.group,
					order: placement.order,
				},
			});
		}

		if (action.desc.f1) {
			menuItems.push({
				id: MenuId.CommandPalette,
				item: { command: action.desc, when: action.desc.precondition },
			});
		}
		if (menuItems.length > 0) {
			registrations.add(MenusRegistry.appendMenuItems(menuItems));
		}
	} catch (error) {
		registrations.dispose();
		throw error;
	}

	return registrations;
}

function toArray<T>(value: OneOrMany<T> | undefined): readonly T[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value as T];
}

function getPlatformKeybinding(options: IAction2KeybindingOptions): IAction2PlatformKeybindingOptions | undefined {
	if (operatingSystem === OperatingSystem.Windows) return options.win;
	if (operatingSystem === OperatingSystem.Macintosh) return options.mac;
	return options.linux;
}
