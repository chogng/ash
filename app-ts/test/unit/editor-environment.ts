class EditorTestResizeObserver implements ResizeObserver {
	constructor(_callback: ResizeObserverCallback) {}

	public observe(_target: Element, _options?: ResizeObserverOptions): void {}
	public unobserve(_target: Element): void {}
	public disconnect(): void {}
	public takeRecords(): ResizeObserverEntry[] { return []; }
}

Object.defineProperty(globalThis, 'ResizeObserver', {
	configurable: true,
	value: EditorTestResizeObserver,
});
