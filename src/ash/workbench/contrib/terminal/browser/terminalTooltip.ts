import { localize } from '../../../../nls.js';
import type { ITerminalInstance } from '../../../services/terminal/browser/terminal.js';

/** Reads execution identity from the instance; the hover never queries or changes a Shell. */
export function getShellProcessTooltip(instance: ITerminalInstance, showDetailed: boolean): string {
	const lines = [localize('terminal.tooltip.profile', 'Profile: {0}', instance.profile.title)];
	if (instance.processId > 0) lines.push(localize('terminal.tooltip.pid', 'Process ID (PID): {0}', instance.processId));
	if (showDetailed) {
		const cwd = instance.cwd ?? instance.initialCwd;
		if (cwd) lines.push(localize('terminal.tooltip.cwd', 'Working directory: {0}', cwd));
		if (instance.exitCode !== undefined) lines.push(localize('terminal.tooltip.exitCode', 'Exit code: {0}', instance.exitCode));
	}
	return `\n${lines.join('\n')}`;
}
