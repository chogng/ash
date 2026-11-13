import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { WorkbenchEditorToolsAvailable } from '../../../common/contextkeys.js';
import { ITerminalGroupService } from './terminal.js';

/** Index commands resolve groups through the invoking window, including split panes. */
export function setupTerminalCommands(): void {
	for (let index = 0; index < 9; index++) {
		CommandsRegistry.register(`workbench.action.terminal.focusAtIndex${index + 1}`, async accessor => {
			if (!accessor.get(IContextKeyService).contextMatchesRules(WorkbenchEditorToolsAvailable)) return;
			const groups = accessor.get(ITerminalGroupService);
			groups.setActiveInstanceByIndex(index);
			await groups.showPanel(true);
		});
	}
}
