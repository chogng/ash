import { type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';

export const quadVertices = new Float32Array([
	1, 0,
	1, 1,
	0, 1,
	0, 0,
	0, 1,
	1, 0,
]);

export function ensureNonNullable<T>(value: T | null): T {
	if (value === null) throw new Error('Value cannot be null');
	return value;
}

/** Observes the physical canvas size without rounding through CSS pixels. */
export function observeDevicePixelDimensions(element: HTMLElement, ownerWindow: Window & typeof globalThis, callback: (deviceWidth: number, deviceHeight: number) => void): IDisposable {
	const ResizeObserverConstructor = (ownerWindow as Window & { readonly ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
	if (!ResizeObserverConstructor) throw new Error('WebGPU text rendering requires ResizeObserver');
	const observer = new ResizeObserverConstructor((entries: ResizeObserverEntry[]) => {
		const entry = entries.find(candidate => candidate.target === element);
		const size = entry?.devicePixelContentBoxSize?.[0];
		if (!size || size.inlineSize <= 0 || size.blockSize <= 0) return;
		callback(size.inlineSize, size.blockSize);
	});
	observer.observe(element, { box: 'device-pixel-content-box' });
	return toDisposable(() => observer.disconnect());
}
