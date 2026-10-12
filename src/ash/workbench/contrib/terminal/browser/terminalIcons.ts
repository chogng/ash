import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

export const newTerminalIcon = registerIcon('terminal-new', Lxicon.add, localize('terminal.icons.new', 'Create a terminal.'));
export const killTerminalIcon = registerIcon('terminal-kill', Lxicon.trash, localize('terminal.icons.kill', 'Close a terminal.'));
