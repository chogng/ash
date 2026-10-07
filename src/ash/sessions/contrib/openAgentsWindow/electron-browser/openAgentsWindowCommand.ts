import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { validateOpenAgentsWindow } from '../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../../workbench/common/services.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../../../workbench/contrib/chat/common/constants.js';

/** Sessions exposes the handler without adding another palette entry or default shortcut. */
export function registerOpenAgentsWindowCommand(): IDisposable {
	return CommandsRegistry.register(OPEN_AGENTS_WINDOW_COMMAND_ID, (accessor, options) => {
		return accessor.get(INativeHostService).openAgentsWindow(validateOpenAgentsWindow(options));
	});
}
