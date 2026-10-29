/** Control messages are private to Ash's capture worklet, independent of the transcription transport. */
export const PCM_FLUSH_REQUEST = 'ash-pcm-flush';
export const PCM_FLUSH_ACK = 'ash-pcm-flushed';
export type IPcmCapturePort = Pick<MessagePort, 'postMessage' | 'onmessage'>;
export type IPcmCaptureTimers = Pick<Window & typeof globalThis, 'setTimeout' | 'clearTimeout'>;

/** The caller owns the port and clears onmessage when disconnecting its capture node. */
export function wirePcmCapturePort(
	port: IPcmCapturePort,
	timers: IPcmCaptureTimers,
	onChunk: (samples: Float32Array) => void,
): { flush(): Promise<void> } {
	let pending: Promise<void> | undefined;
	let acknowledge: (() => void) | undefined;
	port.onmessage = event => {
		const data = event.data;
		if (data?.type === PCM_FLUSH_ACK) {
			acknowledge?.();
			return;
		}
		// Treat worklet messages as a boundary, including malformed or detached buffers.
		const samples =
			data instanceof Float32Array
				? data
				: data instanceof ArrayBuffer && data.byteLength % 4 === 0
					? new Float32Array(data)
					: undefined;
		if (samples && samples.length > 0 && samples.length <= 16000 && samples.every(Number.isFinite))
			onChunk(samples);
	};
	return {
		flush: () => {
			if (pending) return pending;
			let request!: () => void;
			const promise = new Promise<void>(resolve => {
				const timeout = timers.setTimeout(() => acknowledge?.(), 250);
				acknowledge = () => {
					timers.clearTimeout(timeout);
					acknowledge = undefined;
					pending = undefined;
					resolve();
				};
				request = () => port.postMessage({ type: PCM_FLUSH_REQUEST });
			});
			pending = promise;
			request();
			return promise;
		},
	};
}

export interface IPcmCaptureNode {
	readonly node: AudioWorkletNode;
	flush(): Promise<void>;
}

/** Captures audio off the UI thread; the main-thread accumulator owns chunk sizing and the final tail. */
export async function createPcmCaptureNode(
	window: Window & typeof globalThis,
	context: AudioContext,
	chunkSize: number,
	onChunk: (samples: Float32Array) => void,
): Promise<IPcmCaptureNode> {
	if (!Number.isInteger(chunkSize) || chunkSize < 128 || chunkSize > 16000)
		throw new RangeError('Invalid PCM capture chunk size');
	const source = `class AshPcmTap extends AudioWorkletProcessor {
        constructor() {
            super();
            this.port.onmessage = message => {
                if (message.data?.type === '${PCM_FLUSH_REQUEST}') this.port.postMessage({ type: '${PCM_FLUSH_ACK}' });
            };
        }
        process(inputs) {
            const mono = inputs[0]?.[0];
            if (mono?.length) {
                const copy = mono.slice();
                this.port.postMessage(copy.buffer, [copy.buffer]);
            }
            return true;
        }
    }
    registerProcessor('ash-pcm-tap', AshPcmTap);`;
	const url = window.URL.createObjectURL(new window.Blob([source], { type: 'application/javascript' }));
	try {
		await context.audioWorklet.addModule(url);
	} finally {
		window.URL.revokeObjectURL(url);
	}
	const node = new window.AudioWorkletNode(context, 'ash-pcm-tap', {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [1],
	});
	let buffer = new Float32Array(chunkSize);
	let used = 0;
	const port = wirePcmCapturePort(node.port, window, samples => {
		let offset = 0;
		while (offset < samples.length) {
			const count = Math.min(chunkSize - used, samples.length - offset);
			buffer.set(samples.subarray(offset, offset + count), used);
			used += count;
			offset += count;
			if (used === chunkSize) {
				onChunk(buffer);
				buffer = new Float32Array(chunkSize);
				used = 0;
			}
		}
	});
	return {
		node,
		flush: async () => {
			await port.flush();
			if (used) {
				onChunk(buffer.slice(0, used));
				used = 0;
			}
		},
	};
}
