import { Lxicon } from '../../../../base/common/lxicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { localize } from '../../../../nls.js';

export const debugStart = registerIcon('debug-start', Lxicon.start, localize('debug.iconStart', 'Icon for starting debugging.'));
export const debugConfigure = registerIcon('debug-configure', Lxicon.gear, localize('debug.iconConfigure', 'Icon for opening debug configuration.'));
