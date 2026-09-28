export const RETURN_TO_WORKBENCH_CHANNEL = 'ash:sessions:return-to-workbench';
export const RETURN_TO_WORKBENCH_COMMAND_ID = 'ash.sessions.returnToWorkbench';
export const AGENTS_WINDOW_HANDOFF_AVAILABLE_CHANNEL = 'ash:sessions:handoff-available';
export const AGENTS_WINDOW_HANDOFF_TAKE_CHANNEL = 'ash:sessions:handoff-take';
export const AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL = 'ash:sessions:handoff-complete';

export interface IAgentsWindowHandoffResult {
	readonly id: string;
	readonly error?: string;
}

export function validateAgentsWindowHandoffTake(value: unknown): undefined {
	if (value !== undefined) throw new TypeError('Agents Window handoff take does not accept parameters');
	return undefined;
}

export function validateAgentsWindowHandoffComplete(value: unknown): IAgentsWindowHandoffResult {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Agents Window handoff result');
	const result = value as Record<string, unknown>;
	if (Object.keys(result).some(key => key !== 'id' && key !== 'error') || typeof result.id !== 'string' || !result.id || result.error !== undefined && typeof result.error !== 'string') throw new TypeError('Invalid Agents Window handoff result');
	return value as IAgentsWindowHandoffResult;
}

export function validateReturnToWorkbench(value: unknown): undefined {
	if (value !== undefined) throw new TypeError('Return to Workbench does not accept parameters');
	return undefined;
}
