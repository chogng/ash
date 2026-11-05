export const RETURN_TO_WORKBENCH_CHANNEL = 'ash:sessions:return-to-workbench';
export const AGENTS_WINDOW_RESTORE_ENTRY_CHANNEL = 'ash:sessions:restore-entry';
export const RETURN_TO_WORKBENCH_COMMAND_ID = 'ash.sessions.returnToWorkbench';
export function validateReturnToWorkbench(value: unknown): undefined {
	if (value !== undefined) throw new TypeError('Return to Workbench does not accept parameters');
	return undefined;
}
