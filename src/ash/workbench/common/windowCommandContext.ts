/** Identifies the window that owns the control invoking a command. */
export interface IWindowCommandContext {
	readonly windowId: number;
}

export function isWindowCommandContext(context: unknown): context is IWindowCommandContext {
	return typeof context === 'object' && context !== null && 'windowId' in context && typeof context.windowId === 'number';
}
