import { toDisposable, type IReference } from '../../../base/common/lifecycle.js';

/** Owns WebGPU resources whose API exposes explicit destruction. */
export namespace GPULifecycle {
	export async function requestDevice(ownerWindow: Window, fallback?: (message: string) => void): Promise<IReference<GPUDevice>> {
		try {
			const gpu = ownerWindow.navigator.gpu;
			if (!gpu) throw new Error('This browser does not support WebGPU');
			const adapter = await gpu.requestAdapter();
			if (!adapter) throw new Error('WebGPU is disabled or no compatible adapter is available');
			return wrapDestroyableInDisposable(await adapter.requestDevice());
		} catch (error) {
			fallback?.(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	export function createBuffer(device: GPUDevice, descriptor: GPUBufferDescriptor, initialValues?: Float32Array<ArrayBuffer> | (() => Float32Array<ArrayBuffer>)): IReference<GPUBuffer> {
		const reference = wrapDestroyableInDisposable(device.createBuffer(descriptor));
		if (initialValues) device.queue.writeBuffer(reference.object, 0, typeof initialValues === 'function' ? initialValues() : initialValues);
		return reference;
	}

	export function createTexture(device: GPUDevice, descriptor: GPUTextureDescriptor): IReference<GPUTexture> {
		return wrapDestroyableInDisposable(device.createTexture(descriptor));
	}
}

function wrapDestroyableInDisposable<T extends { destroy(): void }>(object: T): IReference<T> {
	return Object.assign(toDisposable(() => object.destroy()), { object });
}
