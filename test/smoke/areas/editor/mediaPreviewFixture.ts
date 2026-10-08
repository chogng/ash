import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { PlaywrightTarget } from '../../../automation/testTarget.js';
import type { Workbench } from '../../../automation/workbench.js';

interface PreviewProbe {
	readonly created: string[];
	readonly revoked: string[];
	readonly reads: string[];
	readonly completedReads: string[];
	readonly failedReads: Array<{ name: string; message: string; }>;
	readonly pending: Map<string, () => void>;
	readonly liveResources: Set<string>;
	readonly releasedResources: Set<string>;
	readonly fail: Set<string>;
	readonly hold: Set<string>;
	restore(): void;
}

declare global {
	interface Window {
		readonly mediaRetryProbe: PreviewProbe;
		readonly mediaRetryFolder: FileSystemDirectoryHandle;
	}
}

/** Real files and fault timing belong to the scenario; product services stay intact. */
export async function createMediaPreviewFixture(page: Page, target: PlaywrightTarget, directory: string, workbench: Workbench): Promise<{ repair(name: 'broken.png' | 'broken.webm'): Promise<void>; refresh(): Promise<void>; dispose(): Promise<void>; }> {
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 800; canvas.height = 600;
		const context = canvas.getContext('2d')!;
		context.fillStyle = '#2675a8'; context.fillRect(0, 0, 400, 600);
		return canvas.toDataURL('image/png').split(',')[1]!;
	});
	const wave = Buffer.alloc(44 + 8000 * 2 * 2);
	wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
	wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
	wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
	wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
	const video = await readFile(new URL('../../fixtures/media-preview.webm', import.meta.url));
	const files = [
		...['product.png', 'retry.png', 'pending.png'].map(name => ({ name, bytes: Buffer.from(png, 'base64') })),
		{ name: 'broken.png', bytes: Buffer.from(png, 'base64').subarray(0, 12) },
		...['retry.wav', 'pending.wav'].map(name => ({ name, bytes: wave })),
		{ name: 'retry.webm', bytes: video },
		{ name: 'broken.webm', bytes: Buffer.from('broken video') },
	];
	const browserFiles = target.kind === 'browser' && target.appServerMode === 'disabled';
	if (browserFiles) {
		await page.evaluate(async files => {
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(`media-retry-${crypto.randomUUID()}`, { create: true });
			for (const file of files) {
				const writer = await (await folder.getFileHandle(file.name, { create: true })).createWritable();
				await writer.write(Uint8Array.from(atob(file.encoded), character => character.charCodeAt(0)));
				await writer.close();
			}
			Object.defineProperty(window, 'mediaRetryFolder', { value: folder, configurable: true });
			Object.defineProperty(window, 'showDirectoryPicker', { value: async () => folder, configurable: true });
		}, files.map(file => ({ name: file.name, encoded: file.bytes.toString('base64') })));
		await workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Open folder', exact: true }).click();
	} else {
		for (const file of files) { await writeFile(join(directory, file.name), file.bytes); }
	}
	await page.evaluate(browserFiles => {
		const created: string[] = [];
		const revoked: string[] = [];
		const reads: string[] = [];
		const completedReads: string[] = [];
		const failedReads: Array<{ name: string; message: string; }> = [];
		const pending = new Map<string, () => void>();
		const liveResources = new Set<string>();
		const releasedResources = new Set<string>();
		const fail = new Set<string>();
		const hold = new Set<string>();
		const createURL = URL.createObjectURL;
		const revokeURL = URL.revokeObjectURL;
		URL.createObjectURL = blob => { const url = createURL(blob); created.push(url); return url; };
		URL.revokeObjectURL = url => { revoked.push(url); revokeURL(url); };
		const cleanups: Array<() => void> = [];
		if (browserFiles) {
			const arrayBuffer = File.prototype.arrayBuffer;
			File.prototype.arrayBuffer = async function (): Promise<ArrayBuffer> {
				reads.push(this.name);
				if (hold.delete(this.name)) { await new Promise<void>(resolve => pending.set(this.name, () => { pending.delete(this.name); resolve(); })); }
				if (fail.delete(this.name)) {
					const message = `Media fixture read denied: ${this.name}`;
					failedReads.push({ name: this.name, message });
					throw new Error(message);
				}
				try { return await arrayBuffer.call(this); } finally { completedReads.push(this.name); }
			};
			cleanups.push(() => { File.prototype.arrayBuffer = arrayBuffer; });
		} else {
			const requests = new Map<number | string, { method: string; name?: string; resourceId?: string; }>();
			const observedPorts = new Set<MessagePort>();
			const observedSockets = new Set<WebSocket>();
			const observe = (text: string): void => {
				const frame = JSON.parse(text) as { id?: string | number; error?: { message: string; }; result?: { resource?: { resourceId: string; }; }; };
				if (frame.id === undefined) { return; }
				const request = requests.get(frame.id);
				if (!request) { return; }
				requests.delete(frame.id);
				if (request.method === 'fs/readBinaryFile') {
					completedReads.push(request.name!);
					if (frame.error) { failedReads.push({ name: request.name!, message: frame.error.message }); }
					if (frame.result?.resource) { liveResources.add(frame.result.resource.resourceId); }
				} else if (request.method === 'resource/release' && !frame.error) {
					liveResources.delete(request.resourceId!); releasedResources.add(request.resourceId!);
				}
			};
			const outgoing = (text: string, send: (text: string) => void): void => {
				const frame = JSON.parse(text) as { id?: string | number; method?: string; params?: { path?: string; resourceId?: string; }; };
				if (frame.id !== undefined && frame.method) {
					const name = frame.params?.path?.split('/').at(-1);
					requests.set(frame.id, { method: frame.method, name, resourceId: frame.params?.resourceId });
					if (frame.method === 'fs/readBinaryFile' && name) {
						reads.push(name);
						// Request a missing sibling through the real authorized backend read boundary.
						if (fail.delete(name)) { frame.params!.path += '.unavailable'; text = JSON.stringify(frame); }
						if (hold.delete(name)) { pending.set(name, () => { pending.delete(name); send(text); }); return; }
					}
				}
				send(text);
			};
			const postMessage = MessagePort.prototype.postMessage;
			MessagePort.prototype.postMessage = function (message: { frame?: string; }, transfer: Transferable[] | StructuredSerializeOptions = []): void {
				if (!message?.frame) { Reflect.apply(postMessage, this, [message, transfer]); return; }
				if (!observedPorts.has(this)) {
					observedPorts.add(this);
					const listener = (event: MessageEvent<{ frame?: string; }>): void => { if (event.data?.frame) { observe(event.data.frame); } };
					this.addEventListener('message', listener);
					cleanups.push(() => this.removeEventListener('message', listener));
				}
				outgoing(message.frame, frame => Reflect.apply(postMessage, this, [{ ...message, frame }, transfer]));
			};
			cleanups.push(() => { MessagePort.prototype.postMessage = postMessage; });
			const send = WebSocket.prototype.send;
			WebSocket.prototype.send = function (data): void {
				if (typeof data !== 'string') { send.call(this, data); return; }
				if (!observedSockets.has(this)) {
					observedSockets.add(this);
					const listener = (event: MessageEvent<string>): void => observe(event.data);
					this.addEventListener('message', listener);
					cleanups.push(() => this.removeEventListener('message', listener));
				}
				outgoing(data, frame => send.call(this, frame));
			};
			cleanups.push(() => { WebSocket.prototype.send = send; });
		}
		Object.defineProperty(window, 'mediaRetryProbe', {
			configurable: true, value: {
				created, revoked, reads, completedReads, failedReads, pending, liveResources, releasedResources, fail, hold,
				restore() {
					for (const release of pending.values()) { release(); }
					for (const cleanup of cleanups.reverse()) { cleanup(); }
					URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL;
				},
			} satisfies PreviewProbe
		});
	}, browserFiles);
	return {
		async repair(name: 'broken.png' | 'broken.webm'): Promise<void> {
			const bytes = name === 'broken.png' ? Buffer.from(png, 'base64') : video;
			if (browserFiles) {
				await page.evaluate(async ({ name, encoded }) => {
					const writer = await (await window.mediaRetryFolder.getFileHandle(name)).createWritable();
					await writer.write(Uint8Array.from(atob(encoded), character => character.charCodeAt(0))); await writer.close();
				}, { name, encoded: bytes.toString('base64') });
			} else { await writeFile(join(directory, name), bytes); }
		},
		async refresh(): Promise<void> {
			if (browserFiles) {
				await page.evaluate(() => window.dispatchEvent(new Event('focus')));
			} else { await writeFile(join(directory, 'retry.wav'), wave); }
		},
		async dispose(): Promise<void> { await page.evaluate(() => window.mediaRetryProbe.restore()); },
	};
}

export async function mediaPreviewEvidence(page: Page): Promise<{ created: string[]; revoked: string[]; reads: string[]; completedReads: string[]; failedReads: Array<{ name: string; message: string; }>; pending: string[]; liveResources: string[]; releasedResources: string[]; }> {
	return page.evaluate(() => ({
		created: window.mediaRetryProbe.created,
		revoked: window.mediaRetryProbe.revoked,
		reads: window.mediaRetryProbe.reads,
		completedReads: window.mediaRetryProbe.completedReads,
		failedReads: window.mediaRetryProbe.failedReads,
		pending: [...window.mediaRetryProbe.pending.keys()],
		liveResources: [...window.mediaRetryProbe.liveResources],
		releasedResources: [...window.mediaRetryProbe.releasedResources],
	}));
}
