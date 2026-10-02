import { parseLaunchArguments } from '../../platform/environment/node/argvHelper.js';
import type { IStartArguments } from '../../platform/launch/electron-main/launchMainService.js';

export type ElectronApplicationPackaging = "packaged" | "development";

export interface ElectronWindowLaunch extends IStartArguments {
	readonly agentsWindow: boolean;
}

/** Validates product window selection before startup can create a wait marker or acquire the instance lock. */
export function parseElectronWindowLaunch(arguments_: readonly string[], cwd: string, invalidAgentsArgumentsMessage: string): ElectronWindowLaunch {
	const separator = arguments_.indexOf('--');
	const switches = separator < 0 ? arguments_ : arguments_.slice(0, separator);
	const args = parseLaunchArguments(arguments_);
	const agentsWindow = switches.includes('--agents-window');
	if (agentsWindow && (args.paths.length > 0 || args.newWindow || args.reuseWindow || args.goto || args.wait)) {
		throw new Error(invalidAgentsArgumentsMessage);
	}
	return { args, cwd, agentsWindow };
}

export interface ElectronWorkspaceLaunchArgumentsOptions {
	readonly arguments: readonly string[];
	readonly packaging: ElectronApplicationPackaging;
	readonly appPath: string;
}

/** Removes Electron/process-only arguments while preserving the user Workspace target. */
export function electronWorkspaceLaunchArguments(options: ElectronWorkspaceLaunchArgumentsOptions): string[] {
	const executableArguments = options.arguments.slice(1);
	const workspaceArguments: string[] = [];
	let hasApplicationEntry = options.packaging === 'packaged';
	for (let index = 0; index < executableArguments.length; index += 1) {
		const argument = executableArguments[index]!;
		if (argument.startsWith("--user-data-dir=")) continue;
		if (argument === "--user-data-dir") {
			index += 1;
			continue;
		}
		// Electron accepts process switches before a development entry, so the entry has no fixed argv index.
		if (!hasApplicationEntry && !argument.startsWith('-')) {
			hasApplicationEntry = true;
			continue;
		}
		if (argument === options.appPath) continue;
		workspaceArguments.push(argument);
	}
	return workspaceArguments;
}

/** Quotes Windows process arguments, including quotes and trailing backslashes in paths. */
export function windowsCommandLine(arguments_: readonly string[]): string {
	return arguments_.map(argument => `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`).join(' ');
}
