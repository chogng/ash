export type ElectronApplicationPackaging = "packaged" | "development";

export interface ElectronWorkspaceLaunchArgumentsOptions {
	readonly arguments: readonly string[];
	readonly packaging: ElectronApplicationPackaging;
	readonly appPath: string;
}

/** Removes Electron/process-only arguments while preserving the user Workspace target. */
export function electronWorkspaceLaunchArguments(options: ElectronWorkspaceLaunchArgumentsOptions): string[] {
	const executableArguments = options.arguments.slice(options.packaging === "packaged" ? 1 : 2);
	const workspaceArguments: string[] = [];
	for (let index = 0; index < executableArguments.length; index += 1) {
		const argument = executableArguments[index]!;
		if (argument === options.appPath || argument.startsWith("--user-data-dir=")) continue;
		if (argument === "--user-data-dir") {
			index += 1;
			continue;
		}
		workspaceArguments.push(argument);
	}
	return workspaceArguments;
}
