/** Renderer capability for opening and returning from the dedicated Sessions window. */
export interface ISessionsWindowApi {
	openSessionsWindow(): Promise<void>;
	returnToWorkbench(): Promise<void>;
}

export const OPEN_SESSIONS_WINDOW_CHANNEL = "ash:sessions-window:open";
export const RETURN_TO_WORKBENCH_CHANNEL = "ash:sessions-window:return-to-workbench";
/** Validates a window command that deliberately carries no renderer-controlled data. */
export function validateSessionsWindowCommand(value: unknown): undefined {
	if (value !== undefined) {
		throw new TypeError("Sessions window commands do not accept parameters");
	}
	return undefined;
}
