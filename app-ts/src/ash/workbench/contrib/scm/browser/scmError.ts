import { AppServerRemoteError } from "../../../../platform/app-server/common/appServerError.js";
import { localize } from '../../../../nls.js';
import { GitWorkspaceError } from '../../../services/git/common/gitService.js';

export function gitErrorMessage(error: unknown): string {
	if (error instanceof GitWorkspaceError) {
		return error.reason === 'noFolder'
			? localize('git.noFolder', 'Open a folder to use Git.')
			: localize('git.noRepository', 'No Git repository found in the open folder.');
	}
	const message = error instanceof Error ? error.message : String(error);
	const errorName = error instanceof AppServerRemoteError ? error.errorName : message;
	if (/GitNotRepository/.test(errorName)) return localize('git.notRepository', 'The open folder is not a Git repository.');
	if (/GitUnavailable/.test(errorName)) {
		return localize('git.unavailable', 'Git is unavailable for this workspace. Check folder access and retry.');
	}
	return error instanceof Error ? error.message : localize('git.operationFailed', 'Git operation failed.');
}
