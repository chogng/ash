import { localize, localize2 } from '../../../../../nls.js';
import { ActionViewItem, LabelActionViewItem } from "../../../../../base/browser/ui/actionbar/actionViewItems.js";
import type { IAction } from "../../../../../base/common/actions.js";
import { Lxicon } from "../../../../../base/common/lxicons.js";
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { DropdownWithPrimaryActionViewItem } from "../../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js";
import { MenuWorkbenchToolBar } from "../../../../../platform/actions/browser/toolbar.js";
import { type IMenuService, MenuId, MenusRegistry } from "../../../../../platform/actions/common/actions.js";
import { CommandsRegistry } from "../../../../../platform/commands/common/commands.js";
import { ContextKeyExpr, type IContextKey, RawContextKey } from "../../../../../platform/contextkey/common/contextkey.js";
import { type IContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import type { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import type { ITerminalInstance, ITerminalProfile } from "../terminal.js";
import { terminalProfileIcon } from "./terminalProfileIcon.js";
import { AppServerAvailableContext } from '../../../../../platform/renderer/common/rendererHost.js';

const ACTIVE_TERMINAL_COMMAND_ID = "ash.terminal.focusActive";
const NEW_TERMINAL_WITH_PROFILE_COMMAND_ID = "ash.terminal.newWithProfile";
const NEW_TERMINAL_COMMAND_ID = "ash.terminal.new";
const RELAUNCH_TERMINAL_COMMAND_ID = "ash.terminal.relaunch";
const KILL_TERMINAL_COMMAND_ID = "ash.terminal.kill";
const CLEAR_TERMINAL_COMMAND_ID = "ash.terminal.clear";
const TerminalCreatingContext = new RawContextKey<boolean>("terminalCreating", false);
const TerminalHasActiveInstanceContext = new RawContextKey<boolean>("terminalHasActiveInstance", false);
const TerminalActiveInstanceInTitleContext = new RawContextKey<boolean>("terminalActiveInstanceInTitle", false);
const TerminalActiveInstanceStateContext = new RawContextKey<ITerminalInstance["state"] | "none">("terminalActiveInstanceState", "none");

export interface TerminalTitleActionsOptions {
	readonly menuService: IMenuService;
	readonly contextMenuService: IContextMenuService;
	readonly contextKeyService: IContextKeyService;
	readonly createTerminal: (profileId?: string) => unknown;
	readonly focusActive: () => unknown;
	readonly relaunchActive: () => unknown;
	readonly killActive: () => unknown;
	readonly clearActive: () => unknown;
}

/** Owns the Terminal title Command, Menu, Context Key, and Toolbar projection. */
export class TerminalTitleActions extends Disposable {
	readonly element: HTMLElement;
	private readonly toolbar: MenuWorkbenchToolBar;
	private readonly creatingContext: IContextKey<boolean>;
	private readonly hasActiveInstanceContext: IContextKey<boolean>;
	private readonly activeInstanceInTitleContext: IContextKey<boolean>;
	private readonly activeInstanceStateContext: IContextKey<ITerminalInstance["state"] | "none">;
	private readonly createTerminal: (profileId?: string) => unknown;
	private profiles: readonly ITerminalProfile[] = [];
	private activeInstance: ITerminalInstance | undefined;

	constructor(container: HTMLElement, options: TerminalTitleActionsOptions) {
		super();
		this.createTerminal = options.createTerminal;
		this.creatingContext = TerminalCreatingContext.bindTo(options.contextKeyService);
		this.hasActiveInstanceContext = TerminalHasActiveInstanceContext.bindTo(options.contextKeyService);
		this.activeInstanceInTitleContext = TerminalActiveInstanceInTitleContext.bindTo(options.contextKeyService);
		this.activeInstanceStateContext = TerminalActiveInstanceStateContext.bindTo(options.contextKeyService);
		this._register(toDisposable(() => {
			this.activeInstanceStateContext.reset();
			this.activeInstanceInTitleContext.reset();
			this.hasActiveInstanceContext.reset();
			this.creatingContext.reset();
		}));
		this.registerCommandsAndMenu(options);
		this.toolbar = this._register(new MenuWorkbenchToolBar(
			container,
			options.menuService,
			options.contextMenuService,
			MenuId.TerminalTitle,
			{
				ariaLabel: localize('terminal.title.actions', "Terminal actions"),
				highlightToggledItems: true,
				menuOptions: { shouldForwardArgs: true },
				actionViewItemProvider: (action) => this.createActionViewItem(action, options.contextMenuService),
			},
		));
		this.element = this.toolbar.element;
		this.element.classList.add("ash-terminal-title-toolbar");
	}

	setProfiles(profiles: readonly ITerminalProfile[]): void {
		this.profiles = profiles;
		this.toolbar.refresh();
	}

	setCreating(creating: boolean): void {
		this.creatingContext.set(creating);
	}

	setActiveInstance(instance: ITerminalInstance | undefined, placement: "list" | "title"): void {
		this.activeInstance = instance;
		this.activeInstanceInTitleContext.set(instance !== undefined && placement === "title");
		this.hasActiveInstanceContext.set(instance !== undefined);
		this.activeInstanceStateContext.set(instance?.state ?? "none");
		this.toolbar.refresh();
	}

	private registerCommandsAndMenu(options: TerminalTitleActionsOptions): void {
		this._register(CommandsRegistry.register(ACTIVE_TERMINAL_COMMAND_ID, () => options.focusActive()));
		this._register(CommandsRegistry.register(NEW_TERMINAL_WITH_PROFILE_COMMAND_ID, (_accessor, profileId) => {
			return this.createTerminalWithProfile(profileId);
		}));
		this._register(CommandsRegistry.register(NEW_TERMINAL_COMMAND_ID, () => options.createTerminal()));
		this._register(CommandsRegistry.register(RELAUNCH_TERMINAL_COMMAND_ID, () => options.relaunchActive()));
		this._register(CommandsRegistry.register(KILL_TERMINAL_COMMAND_ID, () => options.killActive()));
		this._register(CommandsRegistry.register(CLEAR_TERMINAL_COMMAND_ID, () => options.clearActive()));
		this._register(MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
			command: {
				id: ACTIVE_TERMINAL_COMMAND_ID,
				title: localize2('terminal.title.focusActive', "Focus Active Terminal"),
				tooltip: localize('terminal.title.focusActive', "Focus Active Terminal"),
			},
			when: TerminalActiveInstanceInTitleContext.isEqualTo(true),
			group: "navigation",
			order: 0,
		}));
		this._register(MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
			command: {
				id: NEW_TERMINAL_COMMAND_ID,
				title: localize2('terminal.title.new', "New Terminal"),
				tooltip: localize('terminal.title.new', "New Terminal"),
				icon: Lxicon.add,
				precondition: ContextKeyExpr.and(AppServerAvailableContext.isEqualTo(true), TerminalCreatingContext.isEqualTo(false)),
			},
			group: "navigation",
			order: 10,
		}));
		this._register(MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
			command: {
				id: RELAUNCH_TERMINAL_COMMAND_ID,
				title: localize2('terminal.title.relaunch', "Relaunch Terminal"),
				tooltip: localize('terminal.title.relaunch', "Relaunch Terminal"),
				icon: Lxicon.history,
			},
			when: ContextKeyExpr.and(
				TerminalHasActiveInstanceContext.isEqualTo(true),
				ContextKeyExpr.notEquals(TerminalActiveInstanceStateContext.key, "running"),
			),
			group: "navigation",
			order: 20,
		}));
		this._register(MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
			command: {
				id: KILL_TERMINAL_COMMAND_ID,
				title: localize2('terminal.title.kill', "Kill Terminal"),
				tooltip: localize('terminal.title.kill', "Kill Terminal"),
				icon: Lxicon.trash,
			},
			when: TerminalHasActiveInstanceContext.isEqualTo(true),
			group: "navigation",
			order: 30,
		}));
		this._register(MenusRegistry.appendMenuItem(MenuId.TerminalTitle, {
			command: {
				id: CLEAR_TERMINAL_COMMAND_ID,
				title: localize2('terminal.title.clear', "Clear Terminal"),
				tooltip: localize('terminal.title.clear', "Clear Terminal"),
			},
			group: "1_terminal",
			order: 10,
		}));
	}

	private createActionViewItem(action: IAction, contextMenuService: IContextMenuService): ActionViewItem | undefined {
		switch (action.id) {
			case ACTIVE_TERMINAL_COMMAND_ID:
				if (!this.activeInstance) return undefined;
				return new ActiveTerminalActionViewItem(action, this.activeInstance);
			case NEW_TERMINAL_COMMAND_ID:
				return new DropdownWithPrimaryActionViewItem(
					action,
					new TerminalProfileSelectorAction(action.enabled && this.profiles.length > 0, (profileId) => this.createTerminalWithProfile(profileId)),
					() => this.profiles.map((profile) => terminalProfileMenuAction(profile, () => this.activeInstance?.profile.profileId, (profileId) => this.createTerminalWithProfile(profileId))),
					contextMenuService,
				);
			default:
				return undefined;
		}
	}

	private createTerminalWithProfile(profileId: unknown): unknown {
		if (typeof profileId !== "string" || !this.profiles.some((profile) => profile.profileId === profileId)) {
			throw new TypeError(`Unknown terminal profile: ${String(profileId)}`);
		}
		return this.createTerminal(profileId);
	}
}

class ActiveTerminalActionViewItem extends LabelActionViewItem {
	constructor(action: IAction, private readonly instance: ITerminalInstance) {
		const tooltip = instance.title === instance.profile.title
			? localize('terminal.title.active', 'Active terminal: {0}', instance.title)
			: localize('terminal.title.activeProfile', 'Active terminal: {0} ({1})', instance.title, instance.profile.title);
		super(action, {
			label: instance.title,
			icon: terminalProfileIcon(instance.profile),
			ariaLabel: tooltip,
			tooltip,
		});
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add("ash-terminal-active-action");
		container.dataset.state = this.instance.state;
	}
}

class TerminalProfileSelectorAction implements IAction {
	readonly id = NEW_TERMINAL_WITH_PROFILE_COMMAND_ID;
	readonly label = localize('terminal.title.selectProfile', "Select Terminal Profile");
	readonly tooltip = localize('terminal.title.selectProfile', "Select Terminal Profile");
	readonly checked = undefined;

	constructor(readonly enabled: boolean, private readonly createTerminalWithProfile: (profileId: unknown) => unknown) {}

	run(...args: readonly unknown[]): unknown {
		return this.createTerminalWithProfile(args[0]);
	}
}

function terminalProfileMenuAction(profile: ITerminalProfile, activeProfileId: () => string | undefined, createTerminalWithProfile: (profileId: unknown) => unknown): IAction {
	const label = profile.isDefault ? localize('terminal.title.defaultProfile', '{0} (Default)', profile.title) : profile.title;
	return {
		id: `${NEW_TERMINAL_WITH_PROFILE_COMMAND_ID}.${profile.profileId}`,
		label,
		tooltip: localize('terminal.title.useProfile', 'Use {0}', profile.title),
		icon: terminalProfileIcon(profile),
		enabled: true,
		checked: profile.profileId === activeProfileId(),
		run: () => createTerminalWithProfile(profile.profileId),
	};
}
