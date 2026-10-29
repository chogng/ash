export const GLOBAL_KEYBINDING_UPDATE_CHANNEL = 'ash:global-keybinding:update';
export const GLOBAL_KEYBINDING_TRIGGER_CHANNEL = 'ash:global-keybinding:trigger';

/** A trusted renderer's named lease; window identity comes from the IPC router. */
export interface GlobalKeybindingRequest {
	readonly id: string;
	readonly commandId: string;
	readonly accelerator: string;
	readonly label: string;
	readonly global: boolean;
}
export interface GlobalKeybindingResult {
	readonly available: boolean;
	readonly activeLabel: string;
}

export function validateGlobalKeybindingRequest(value: unknown): GlobalKeybindingRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid global keybinding');
	const request = value as Record<string, unknown>;
	if (
		Object.keys(request).sort().join(',') !== 'accelerator,commandId,global,id,label' ||
		typeof request.id !== 'string' ||
		!/^[a-zA-Z0-9._-]{1,256}$/u.test(request.id) ||
		typeof request.commandId !== 'string' ||
		!/^[a-zA-Z0-9._-]{1,256}$/u.test(request.commandId) ||
		typeof request.global !== 'boolean' ||
		typeof request.label !== 'string' ||
		request.label.length > 256 ||
		typeof request.accelerator !== 'string' ||
		request.accelerator.length > 128 ||
		(request.accelerator !== '' &&
			!/^(?:(?:Command|Control|Alt|Shift)\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Down|Left|Right|Up|Backspace|Delete|End|Enter|Escape|Home|PageDown|PageUp|Tab)$/u.test(
				request.accelerator,
			))
	) {
		throw new TypeError('Invalid global keybinding');
	}
	return request as unknown as GlobalKeybindingRequest;
}

export function validateGlobalKeybindingResult(value: unknown): GlobalKeybindingResult {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('Invalid global keybinding result');
	const result = value as Record<string, unknown>;
	if (
		Object.keys(result).sort().join(',') !== 'activeLabel,available' ||
		typeof result.available !== 'boolean' ||
		typeof result.activeLabel !== 'string' ||
		result.activeLabel.length > 256
	)
		throw new TypeError('Invalid global keybinding result');
	return result as unknown as GlobalKeybindingResult;
}
