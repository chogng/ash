export const RETURN_TO_WORKBENCH_CHANNEL = 'ash:sessions:return-to-workbench';
export const AGENTS_WINDOW_RESTORE_ENTRY_CHANNEL = 'ash:sessions:restore-entry';
export const AGENTS_WINDOW_DISCARD_STARTUP_WORKSPACE_CHANNEL = 'ash:sessions:discard-startup-workspace';
export const AGENTS_WINDOW_READY_CHANNEL = 'ash:sessions:ready';
export const AGENTS_WINDOW_WORKSPACE_CHANNEL = 'agentsWindowWorkspace';
export const RETURN_TO_WORKBENCH_COMMAND_ID = 'ash.sessions.returnToWorkbench';
export function validateReturnToWorkbench(value: unknown): undefined {
	if (value !== undefined) throw new TypeError('Return to Workbench does not accept parameters');
	return undefined;
}
