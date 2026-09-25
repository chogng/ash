/** Available only to a parent renderer with a dedicated child window. */
export interface IOpenDedicatedWindowApi {
	openDedicatedWindow(): Promise<void>;
}

/** Available only to a dedicated child renderer. */
export interface IReturnToParentWindowApi {
	returnToParentWindow(): Promise<void>;
}

export const OPEN_DEDICATED_WINDOW_CHANNEL = 'ash:dedicated-window:open';
export const RETURN_TO_PARENT_WINDOW_CHANNEL = 'ash:dedicated-window:return-to-parent';

export function validateDedicatedWindowCommand(value: unknown): undefined {
	if (value !== undefined) {
		throw new TypeError('Dedicated window commands do not accept parameters');
	}
	return undefined;
}
