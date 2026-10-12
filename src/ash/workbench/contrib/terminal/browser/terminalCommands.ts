import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ITerminalGroupService } from '../../../services/terminal/browser/terminal.js';

/** Index commands resolve groups through the invoking window, including split panes. */
export function setupTerminalCommands(): void {
	for (let index = 0; index < 9; index++) {
		CommandsRegistry.register(`workbench.action.terminal.focusAtIndex${index + 1}`, async accessor => {
			const groups = accessor.get(ITerminalGroupService);
			groups.setActiveInstanceByIndex(index);
			await groups.showPanel(true);
		});
	}
}
