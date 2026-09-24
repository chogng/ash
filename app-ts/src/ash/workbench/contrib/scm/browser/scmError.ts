import { AppServerRemoteError } from "../../../../platform/app-server/common/appServerError.js";

export function gitErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const errorName = error instanceof AppServerRemoteError ? error.errorName : message;
	if (/GitNotRepository/.test(errorName)) return "The open folder is not a Git repository.";
	if (/GitUnavailable/.test(errorName)) {
		return "Git is unavailable for this workspace. Trust the folder to enable Git changes.";
	}
	return error instanceof Error ? error.message : "Git operation failed.";
}
