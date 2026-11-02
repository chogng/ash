import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { raceCancellationError, timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable, type IDisposable, type IReference } from '../../../../../base/common/lifecycle.js';
import { chatWorkingLogoDrawDuration, type IChatWorkingLogoDrawArtwork } from './chatWorkingLogoDraw.js';

export const chatWorkingLogoAtlasFrameCount = 144;
const columns = 12;
const padding = 2;
const maxCacheBytes = 8 * 1024 * 1024;

export interface IChatWorkingLogoAtlasOptions {
	/** Native pixel size of one frame, excluding its transparent gutter. */
	readonly width: number;
	readonly height: number;
	readonly color: string;
	readonly artwork: IChatWorkingLogoDrawArtwork;
}

export interface IChatWorkingLogoAtlas extends IDisposable {
	readonly url: string;
	readonly width: number;
	readonly height: number;
	readonly frameWidth: number;
	readonly frameHeight: number;
}

type AtlasFactory = (targetWindow: Window, options: IChatWorkingLogoAtlasOptions, token: CancellationToken) => Promise<IChatWorkingLogoAtlas>;

interface AtlasEntry {
	readonly source: CancellationTokenSource;
	readonly promise: Promise<IChatWorkingLogoAtlas>;
	readonly bytes: number;
	references: number;
	atlas?: IChatWorkingLogoAtlas;
}

/** Window-owned, bounded LRU. A pending render belongs only to its current consumers. */
export class ChatWorkingLogoAtlasCache extends Disposable {
	private readonly entries = new Map<string, AtlasEntry>();

	constructor(
		private readonly targetWindow: Window,
		private readonly factory: AtlasFactory = createChatWorkingLogoAtlas,
		private readonly byteBudget = maxCacheBytes,
	) {
		super();
		this._register(addDisposableListener(targetWindow, 'pagehide', () => this.dispose()));
		this._register(toDisposable(() => {
			for (const key of this.entries.keys()) this.remove(key);
		}));
	}

	acquire(options: IChatWorkingLogoAtlasOptions): IReference<Promise<IChatWorkingLogoAtlas>> {
		validateOptions(this.targetWindow.document, options);
		if (this.isDisposed) throw new CancellationError();
		const key = JSON.stringify([options.width, options.height, options.color, options.artwork]);
		let entry = this.entries.get(key);
		if (!entry) {
			const source = new CancellationTokenSource();
			const token = source.token;
			const promise = Promise.resolve().then(() => this.factory(this.targetWindow, options, token)).then(atlas => {
				if (token.isCancellationRequested) {
					atlas.dispose();
					throw new CancellationError();
				}
				entry!.atlas = atlas;
				this.trim();
				return atlas;
			}, error => {
				if (this.entries.get(key) === entry) this.remove(key);
				throw error;
			});
			entry = {
				source, promise, references: 0,
				bytes: (options.width + padding * 2) * (options.height + padding * 2) * chatWorkingLogoAtlasFrameCount * 4,
			};
			this.entries.set(key, entry);
		}
		const acquired = entry;
		acquired.references++;
		this.entries.delete(key);
		this.entries.set(key, acquired);
		return Object.assign(toDisposable(() => {
			acquired.references--;
			if (this.entries.get(key) !== acquired) return;
			if (!acquired.references && !acquired.atlas) this.remove(key);
			else this.trim();
		}), { object: acquired.promise });
	}

	private trim(): void {
		let bytes = [...this.entries.values()].reduce((total, entry) => total + entry.bytes, 0);
		for (const [key, entry] of this.entries) {
			if (bytes <= this.byteBudget) break;
			if (entry.references) continue;
			bytes -= entry.bytes;
			this.remove(key);
		}
	}

	private remove(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		entry.source.dispose(true);
		entry.atlas?.dispose();
	}
}

const caches = new WeakMap<Window, ChatWorkingLogoAtlasCache>();

export function acquireChatWorkingLogoAtlas(targetWindow: Window, options: IChatWorkingLogoAtlasOptions): IReference<Promise<IChatWorkingLogoAtlas>> {
	let cache = caches.get(targetWindow);
	if (!cache || cache.isDisposed) {
		cache = new ChatWorkingLogoAtlasCache(targetWindow);
		caches.set(targetWindow, cache);
	}
	return cache.acquire(options);
}

export async function loadChatWorkingLogoAtlasImage(image: HTMLImageElement, url: string, token: CancellationToken): Promise<void> {
	if (token.isCancellationRequested) throw new CancellationError();
	image.src = url;
	try {
		await raceCancellationError(image.decode(), token);
	} catch (error) {
		image.removeAttribute('src');
		throw error;
	}
}

/** Bake the window's already loaded icon font, sampling the same effects as live playback. */
export async function createChatWorkingLogoAtlas(targetWindow: Window, options: IChatWorkingLogoAtlasOptions, token: CancellationToken): Promise<IChatWorkingLogoAtlas> {
	const document = targetWindow.document;
	validateOptions(document, options);
	if (token.isCancellationRequested) throw new CancellationError();
	const frameWidth = options.width;
	const frameHeight = options.height;
	const width = (frameWidth + padding * 2) * columns;
	const height = (frameHeight + padding * 2) * chatWorkingLogoAtlasFrameCount / columns;
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const image = document.createElement('img');
	const sampler = h(document, 'span', { className: 'ash-chat-working-logo-sampler' });
	sampler.setAttribute('aria-hidden', 'true');
	sampler.style.font = options.artwork.font;
	sampler.style.width = `${options.artwork.width}px`;
	sampler.style.height = `${options.artwork.height}px`;
	const animations: Animation[] = [];
	let url: string | undefined;
	try {
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Working logo atlas requires a 2D canvas');
		const { artwork } = options;
		const fonts = await raceCancellationError(document.fonts.load(artwork.font, artwork.layers.map(layer => layer.character).join('')), token);
		if (!fonts.length) throw new Error('Working logo icon font is not loaded');
		const layers = artwork.layers.map(layer => {
			const element = h(document, 'span');
			element.style.transformOrigin = layer.origin;
			sampler.append(element);
			const animation = element.animate(layer.keyframes, { duration: chatWorkingLogoDrawDuration, fill: 'both' });
			animation.pause();
			animations.push(animation);
			return element;
		});
		document.body.append(sampler);
		context.font = artwork.font;
		context.textBaseline = 'alphabetic';
		context.fillStyle = options.color;
		for (let index = 0; index < chatWorkingLogoAtlasFrameCount; index++) {
			if (index % 24 === 0) await raceCancellationError(timeout(0), token);
			for (const animation of animations) animation.currentTime = index / chatWorkingLogoAtlasFrameCount * chatWorkingLogoDrawDuration;
			context.save();
			context.translate(index % columns * (frameWidth + padding * 2) + padding, Math.floor(index / columns) * (frameHeight + padding * 2) + padding);
			context.beginPath();
			context.rect(0, 0, frameWidth, frameHeight);
			context.clip();
			context.scale(frameWidth / artwork.width, frameHeight / artwork.height);
			for (const [layerIndex, element] of layers.entries()) {
				const style = targetWindow.getComputedStyle(element);
				const origin = style.transformOrigin.split(' ').map(parseFloat);
				const translate = style.translate === 'none' ? [0, 0] : style.translate.split(' ').map(parseFloat);
				const scale = style.scale === 'none' ? [1, 1] : style.scale.split(' ').map(parseFloat);
				context.save();
				context.globalAlpha = Number(style.opacity);
				context.translate(origin[0] + translate[0], origin[1] + (translate[1] ?? 0));
				context.rotate(style.rotate === 'none' ? 0 : parseFloat(style.rotate) * Math.PI / 180);
				context.scale(scale[0], scale[1] ?? scale[0]);
				context.translate(-origin[0], -origin[1]);
				context.fillText(artwork.layers[layerIndex].character, 0, artwork.fontSize);
				context.restore();
			}
			context.restore();
		}
		const blob = await raceCancellationError(new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Working logo atlas encoding failed')));
		}), token);
		url = URL.createObjectURL(blob);
		await loadChatWorkingLogoAtlasImage(image, url, token);
		const atlasUrl = url;
		return Object.assign(toDisposable(() => URL.revokeObjectURL(atlasUrl)), { url: atlasUrl, width, height, frameWidth, frameHeight });
	} catch (error) {
		if (url) URL.revokeObjectURL(url);
		throw error;
	} finally {
		for (const animation of animations) animation.cancel();
		sampler.remove();
		image.removeAttribute('src');
		canvas.width = canvas.height = 0;
	}
}

export function getChatWorkingLogoAtlasKeyframes(atlas: IChatWorkingLogoAtlas, width: number, height: number): Keyframe[] {
	const frames: Keyframe[] = Array.from({ length: chatWorkingLogoAtlasFrameCount }, (_, index) => {
		const x = (index % columns * (atlas.frameWidth + padding * 2) + padding) * width / atlas.frameWidth;
		const y = (Math.floor(index / columns) * (atlas.frameHeight + padding * 2) + padding) * height / atlas.frameHeight;
		return { offset: index / chatWorkingLogoAtlasFrameCount, transform: `translate(${-x}px, ${-y}px)`, easing: 'steps(1, end)' };
	});
	frames.push({ ...frames[0], offset: 1 });
	return frames;
}

function validateOptions(document: Document, options: IChatWorkingLogoAtlasOptions): void {
	if (![options.width, options.height].every(value => Number.isInteger(value) && value > 0 && value <= 128)) {
		throw new RangeError('Working logo atlas dimensions must be integers between 1 and 128');
	}
	const color = document.createElement('span').style;
	color.color = options.color;
	if (!color.color || /currentcolor|var\(|url\(/i.test(options.color)) throw new TypeError('Working logo atlas requires a resolved color');
}
