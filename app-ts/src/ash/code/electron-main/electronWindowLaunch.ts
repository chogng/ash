export type ElectronApplicationPackaging = "packaged" | "development";

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
