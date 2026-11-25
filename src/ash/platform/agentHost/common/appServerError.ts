import type { AppServerErrorData, AppServerErrorName } from '../../../../../.build/protocol/typescript/index.js';
import { localize } from '../../../nls.js';

/** Transport-independent error returned by an App Server request. */
export class AppServerRemoteError extends Error {
	readonly errorName: AppServerErrorName;

	constructor(readonly code: number, message: string, readonly data: AppServerErrorData) {
		super(appServerErrorMessage(data.kind, message));
		this.name = 'AppServerRemoteError';
		this.errorName = data.kind;
	}
}

function appServerErrorMessage(kind: AppServerErrorName, message: string): string {
	switch (kind) {
		case 'ServerShuttingDown':
			return localize('appServer.shuttingDown', 'App Server is stopping. Wait for it to finish, then reconnect.');
		case 'GitWorktreePathTooLong':
			return localize('appServer.worktreePathTooLong', 'A worktree path exceeds the file system limit. Choose a shorter workspace path or shorten the affected file or folder name. On Windows, Git long path support can help with long full paths.');
		case 'GitWorktreeLfsUnavailable':
			return localize('appServer.worktreeLfsUnavailable', 'This repository needs Git LFS. Install Git LFS on the workspace host and make sure git-lfs is on PATH, then retry.');
		case 'GitWorktreeLocked':
			return localize('appServer.worktreeLocked', 'A Git lock is blocking worktree setup. Wait for the other Git operation to finish, then retry. If no operation is running, check the Git diagnostic log for the stale lock.');
		default:
			return message;
	}
}

/** The peer withdrew authorization or changed scope; a fresh launch is required. */
export class AppServerConnectionStoppedError extends Error { }
