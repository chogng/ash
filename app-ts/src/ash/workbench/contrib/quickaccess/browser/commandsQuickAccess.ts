import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Action2, IMenuService, MenuId, MenuItemAction, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IQuickAccessController, QuickAccessRegistry, type IQuickAccessProvider } from '../../../../platform/quickinput/common/quickAccess.js';
import type { IQuickPick, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { localize, localize2 } from '../../../../nls.js';
import { EditorGroupWatermarkEntries } from '../../../browser/parts/editor/editorGroupWatermark.js';
import { ShowAllCommandsCommandId } from '../../../browser/quickaccess.js';

EditorGroupWatermarkEntries.register({
	id: ShowAllCommandsCommandId,
	get label() { return localize('quickAccess.showAllCommands', 'Show All Commands'); },
	command: ShowAllCommandsCommandId,
});

interface ICommandQuickPickItem extends IQuickPickItem {
	readonly commandId: string;
}

class CommandsQuickAccessProvider implements IQuickAccessProvider {
	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IMenuService private readonly menuService: IMenuService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {}

	provide(picker: IQuickPick<IQuickPickItem>): DisposableStore {
		const disposables = new DisposableStore();
		const menu = disposables.add(this.menuService.createMenu(MenuId.CommandPalette));
		const updateItems = (): void => {
			picker.items = menu.getActions()
				.flatMap(([, actions]) => actions)
				.filter((action): action is MenuItemAction => action instanceof MenuItemAction && action.enabled)
				.map(action => {
					const keybinding = this.keybindingService.lookupKeybinding(action.id);
					return {
						commandId: action.id,
						label: action.label,
						description: action.id,
						keybinding: keybinding ? getKeybindingLabel(keybinding) : undefined,
					};
				});
		};
		disposables.add(menu.onDidChange(updateItems));
		disposables.add(this.keybindingService.onDidUpdateKeybindings(updateItems));
		disposables.add(picker.onDidAccept(item => {
			picker.hide();
			const commandId = (item as ICommandQuickPickItem).commandId;
			void this.commandService.executeCommand(commandId).catch((error: unknown) => {
				console.error(`Command Palette command failed: ${commandId}`, error);
			});
		}));
		updateItems();
		return disposables;
	}
}

QuickAccessRegistry.register({
	prefix: '',
	get placeholder() { return localize('quickAccess.searchCommands', 'Search commands (type >, @, or ? for modes)'); },
	get helpLabel() { return localize('quickAccess.commands', 'Commands'); },
	ctor: CommandsQuickAccessProvider,
});
QuickAccessRegistry.register({
	prefix: '>',
	get placeholder() { return localize('quickAccess.commandPlaceholder', 'Type the name of a command to run'); },
	get helpLabel() { return localize('quickAccess.commands', 'Commands'); },
	ctor: CommandsQuickAccessProvider,
});

registerAction2(class ShowAllCommandsAction extends Action2 {
	constructor() {
		super({
			id: ShowAllCommandsCommandId,
			get title() { return localize2('quickAccess.showAllCommands', 'Show All Commands'); },
			menu: [
				{ id: MenuId.MenubarViewMenu, group: '1_commands', order: 1 },
				{ id: MenuId.MenubarHelpMenu, group: '1_commands', order: 1 },
			],
			keybinding: {
				primary: Keybinding.single(logicalKey('p', { primaryKey: true, shiftKey: true })),
				secondary: [Keybinding.single(logicalKey('F1'))],
			},
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IQuickAccessController).show('>');
	}
});
