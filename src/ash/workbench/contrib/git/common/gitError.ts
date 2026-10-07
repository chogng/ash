import { AppServerRemoteError } from "../../../../platform/app-server/common/appServerError.js";
import { localize } from '../../../../nls.js';
import { GitWorkspaceError } from './gitService.js';

export function gitErrorMessage(error: unknown): string {
	if (error instanceof GitWorkspaceError) {
		return error.reason === 'noFolder'
			? localize('git.noFolder', 'Open a folder to use Git.')
			: localize('git.noRepository', 'No Git repository found in the open folder.');
	}
	const message = error instanceof Error ? error.message : String(error);
	const errorName = error instanceof AppServerRemoteError ? error.errorName : message;
	if (/GitNotRepository/.test(errorName)) return localize('git.notRepository', 'The open folder is not a Git repository.');
	if (errorName === 'GitIndexChanged') return localize('git.indexChanged', 'The comparison changed. Reopen the current Source Control comparison and select changes again.');
	if (/GitConflictChanged/.test(errorName)) return localize({ bundle: 'ash', key: 'git.mergeIndexChanged' }, 'The conflict changed in Git. Reopen this merge editor to review the new versions.');
	if (/GitUnavailable/.test(errorName)) {
		return localize('git.unavailable', 'Git is unavailable for this workspace. Check folder access and retry.');
	}
	return error instanceof Error ? error.message : localize('git.operationFailed', 'Git operation failed.');
}
