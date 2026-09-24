export const WORKSPACE_CONTEXT_READ_CHANNEL =
	"ash:workspace:context:read";
export const WORKSPACE_CONTEXT_CHANGED_CHANNEL =
	"ash:workspace:context:changed";

export interface IWorkspaceContextSubscription {
	dispose(): void;
}

/** Narrow host capability that exposes one serialized window workspace. */
export interface IWorkspaceContextApi {
	getWorkspace(): Promise<unknown>;
	onDidChange(
		listener: (workspace: unknown) => void,
	): IWorkspaceContextSubscription;
}

export function validateWorkspaceContextRead(value: unknown): undefined {
	if (value !== undefined) {
		throw new Error("workspace context read does not accept parameters");
	}
	return undefined;
}
