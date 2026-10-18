import { localize } from '../../../../nls.js';
import type { ITerminalInstance } from './terminal.js';
import type { IEnvironmentVariableInfo } from '../common/environmentVariable.js';

/** Reads execution identity from the instance; the hover never queries or changes a Shell. */
export function getShellProcessTooltip(instance: ITerminalInstance, showDetailed: boolean, environmentVariableInfo?: IEnvironmentVariableInfo): string {
	const lines = [localize('terminal.tooltip.profile', 'Profile: {0}', instance.profile.title)];
	if (instance.processId > 0) lines.push(localize('terminal.tooltip.pid', 'Process ID (PID): {0}', instance.processId));
	if (showDetailed) {
		const cwd = instance.cwd ?? instance.initialCwd;
		if (cwd) lines.push(localize('terminal.tooltip.cwd', 'Working directory: {0}', cwd));
		if (instance.exitCode !== undefined) lines.push(localize('terminal.tooltip.exitCode', 'Exit code: {0}', instance.exitCode));
		for (const status of instance.statusList?.statuses ?? []) lines.push(status.tooltip);
		if (!instance.shellLaunchConfig?.customPtyImplementation) {
			const environment = environmentVariableInfo?.getStatus();
			if (environment) lines.push(environment.tooltip);
		}
	}
	return `\n${lines.join('\n')}`;
}
