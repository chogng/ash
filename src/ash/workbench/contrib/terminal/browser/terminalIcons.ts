import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

export const newTerminalIcon = registerIcon('terminal-new', Lxicon.add, localize('terminal.icons.new', 'Create a terminal.'));
export const killTerminalIcon = registerIcon('terminal-kill', Lxicon.trash, localize('terminal.icons.kill', 'Close a terminal.'));
export const terminalDecorationIncomplete = registerIcon('terminal-decoration-incomplete', Lxicon.circle, localize('terminal.icons.commandIncomplete', 'Pending terminal command.'));
export const terminalDecorationSuccess = registerIcon('terminal-decoration-success', Lxicon.circleFilled, localize('terminal.icons.commandSuccess', 'Successful terminal command.'));
export const terminalDecorationError = registerIcon('terminal-decoration-error', Lxicon.errorSmall, localize('terminal.icons.commandError', 'Failed terminal command.'));
