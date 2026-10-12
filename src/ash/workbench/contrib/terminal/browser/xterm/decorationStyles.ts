import { localize } from '../../../../../nls.js';
import type { ITerminalCommandStatusEvent } from '../../../../services/terminal/browser/terminal.js';

/** Status text comes from committed backend events; command text is never evaluated. */
export function getTerminalCommandDecorationTooltip(command: ITerminalCommandStatusEvent): string {
	switch (command.status) {
		case 'running': return localize('terminal.command.running', 'Command is running');
		case 'completed': return localize('terminal.command.completed', 'Command completed; exit code unavailable');
		case 'succeeded': return localize('terminal.command.succeeded', 'Command completed successfully');
		case 'failed': return command.exitCode === undefined
			? localize('terminal.command.failed', 'Command failed')
			: localize('terminal.command.failedCode', 'Command failed with exit code {0}', command.exitCode);
		case 'canceled': return localize('terminal.command.canceled', 'Command was canceled');
	}
}
