export const RETURN_TO_WORKBENCH_CHANNEL = 'ash:sessions:return-to-workbench';

export function validateReturnToWorkbench(value: unknown): undefined {
	if (value !== undefined) throw new TypeError('Return to Workbench does not accept parameters');
	return undefined;
}
