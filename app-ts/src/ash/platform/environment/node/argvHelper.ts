import { type ILocalWorkspaceOpenTarget, type IWorkspaceOpenTarget, WorkspaceOpenTargetKind } from '../common/argv.js';

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
