export namespace EditContext {
	export function create(window: Window, options?: EditContextInit): globalThis.EditContext {
		const Constructor = window.EditContext;
		if (typeof Constructor !== 'function') throw new Error('The EditContext API is unavailable');
		return new Constructor(options);
	}
}
