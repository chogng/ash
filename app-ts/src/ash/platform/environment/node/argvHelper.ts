import { type ILocalWorkspaceOpenTarget, type IWorkspaceOpenTarget, type IParsedLaunchArguments, WorkspaceOpenTargetKind } from '../common/argv.js';
import { fileURLToPath } from 'node:url';

/** Keeps file requests separate from the single project target. */
export function parseLaunchArguments(args: readonly string[]): IParsedLaunchArguments {
	const paths: string[] = [];
	const workspaceArgs: string[] = [];
	let newWindow = false;
	let reuseWindow = false;
	let goto = false;
	let wait = false;
	let waitMarkerFilePath: string | undefined;
	let positionalOnly = false;
	const acceptUrl = (value: string, folder: boolean): void => {
		const uri = new URL(value);
		if (uri.protocol === 'ash:' && uri.hostname === 'file' && !folder && !uri.search && !uri.hash) {
			paths.push(fileURLToPath(new URL(`file://${uri.pathname}`)));
			goto = true;
			return;
		}
		if (uri.protocol !== 'file:' || uri.search || uri.hash) {
			throw new Error(`Unsupported launch URL: ${value}`);
		}
		if (folder) {
			workspaceArgs.push('--folder', fileURLToPath(uri));
		} else {
			paths.push(fileURLToPath(uri));
		}
	};
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (argument === '--' && !positionalOnly) {
			positionalOnly = true;
			continue;
		}
		if (positionalOnly || !argument.startsWith('-')) {
			if (argument.startsWith('ash://') || argument.startsWith('file://')) {
				acceptUrl(argument, false);
			} else {
				paths.push(argument);
			}
			continue;
		}
		const separator = argument.indexOf('=');
		const name = separator < 0 ? argument : argument.slice(0, separator);
		const takeValue = (): string => {
			const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
			if (!value || value.startsWith('--')) {
				throw new Error(`${name} requires a value`);
			}
			return value;
		};
		switch (name) {
			case '--new-window':
			case '-n':
				newWindow = true;
				break;
			case '--reuse-window':
			case '-r':
				reuseWindow = true;
				break;
			case '--goto':
			case '-g':
				goto = true;
				break;
			case '--wait':
			case '-w':
				wait = true;
				break;
			case '--waitMarkerFilePath':
				waitMarkerFilePath = takeValue();
				break;
			case '--folder':
			case '--workspace':
			case '--remote-ssh':
				workspaceArgs.push(name, takeValue());
				break;
			case '--file-uri':
			case '--folder-uri':
			case '--open-url': {
				if (name === '--open-url' && args[index + 1] === '--') {
					index++;
					positionalOnly = true;
				} else {
					acceptUrl(takeValue(), name === '--folder-uri');
				}
				break;
			}
		}
	}
	if (newWindow && reuseWindow) {
		throw new Error('--new-window and --reuse-window cannot be combined');
	}
	if (waitMarkerFilePath && !wait) {
		throw new Error('--waitMarkerFilePath requires --wait');
	}
	if (workspaceArgs.includes('--remote-ssh') && !workspaceArgs.includes('--folder') && !workspaceArgs.includes('--workspace')) {
		if (paths.length !== 1) {
			throw new Error('--remote-ssh requires one folder path');
		}
		workspaceArgs.push('--folder', paths.pop()!);
	}
	return { paths, workspace: parseWorkspaceLaunchArguments(workspaceArgs), newWindow, reuseWindow, goto, wait, waitMarkerFilePath };
}

/** Parses one project target from desktop launch arguments. */
export function parseWorkspaceLaunchArguments(args: readonly string[]): IWorkspaceOpenTarget | undefined {
	let target: ILocalWorkspaceOpenTarget | undefined;
	let remoteSshHost: string | undefined;
	let positionalOnly = false;

	const accept = (candidate: ILocalWorkspaceOpenTarget): void => {
		if (target) {
			throw new Error('Ash can open only one project per window');
		}
		if (candidate.path.trim().length === 0) {
			throw new Error('Workspace path must not be empty');
		}
		target = candidate;
	};

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (!positionalOnly && argument === '--') {
			positionalOnly = true;
			continue;
		}
		if (!positionalOnly && argument === '--folder') {
			const path = args[++index];
			if (path === undefined) {
				throw new Error('--folder requires a path');
			}
			accept({ kind: WorkspaceOpenTargetKind.Folder, path });
			continue;
		}
		if (!positionalOnly && argument === '--remote-ssh') {
			const host = args[++index];
			if (host === undefined) {
				throw new Error('--remote-ssh requires an OpenSSH config host');
			}
			if (remoteSshHost !== undefined) {
				throw new Error('--remote-ssh may be specified only once');
			}
			remoteSshHost = host;
			continue;
		}
		if (!positionalOnly && argument.startsWith('--remote-ssh=')) {
			if (remoteSshHost !== undefined) {
				throw new Error('--remote-ssh may be specified only once');
			}
			remoteSshHost = argument.slice('--remote-ssh='.length);
			continue;
		}
		if (!positionalOnly && argument.startsWith('--folder=')) {
			accept({ kind: WorkspaceOpenTargetKind.Folder, path: argument.slice('--folder='.length) });
			continue;
		}
		if (!positionalOnly && argument === '--workspace') {
			const path = args[++index];
			if (path === undefined) {
				throw new Error('--workspace requires a path');
			}
			accept({ kind: WorkspaceOpenTargetKind.Workspace, path });
			continue;
		}
		if (!positionalOnly && argument.startsWith('--workspace=')) {
			accept({ kind: WorkspaceOpenTargetKind.Workspace, path: argument.slice('--workspace='.length) });
			continue;
		}
		if (!positionalOnly && argument.startsWith('-')) {
			continue;
		}
		accept({ kind: WorkspaceOpenTargetKind.Automatic, path: argument });
	}

	if (!remoteSshHost) {
		return target;
	}
	if (!target) {
		throw new Error('--remote-ssh requires a Remote folder path');
	}
	if (target.kind === WorkspaceOpenTargetKind.Workspace) {
		throw new Error('Remote multi-root workspaces are not supported yet');
	}
	return { kind: WorkspaceOpenTargetKind.RemoteFolder, path: target.path, sshHost: remoteSshHost };
}
