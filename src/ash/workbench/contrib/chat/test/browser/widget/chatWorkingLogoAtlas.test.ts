import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ChatWorkingLogoAtlasCache, createChatWorkingLogoAtlas, type IChatWorkingLogoAtlas } from '../../../browser/widget/chatWorkingLogoAtlas.js';

const artwork = { font: '12px sans-serif', fontSize: 12, width: 12, height: 12, layers: [] };
const options = { width: 24, height: 24, color: 'white', artwork };
const atlas = (dispose: () => void = () => { }): IChatWorkingLogoAtlas => Object.assign(toDisposable(dispose), {
	url: 'blob:synthetic-atlas', width: 336, height: 336, frameWidth: 24, frameHeight: 24,
});

test('Working logo atlas shares pending and ready frames, then releases them with its window', async () => {
	const dom = new JSDOM();
	let renders = 0;
	let releases = 0;
	try {
		using cache = new ChatWorkingLogoAtlasCache(dom.window as unknown as Window, async () => { renders++; return atlas(() => releases++); });
		const first = cache.acquire(options);
		const second = cache.acquire({ color: 'white', height: 24, width: 24, artwork });
		assert.equal(first.object, second.object);
		await first.object;
		first.dispose();
		second.dispose();
		using reused = cache.acquire(options);
		assert.equal(await reused.object, await first.object);
		assert.equal(renders, 1);
		assert.equal(releases, 0);
		dom.window.dispatchEvent(new dom.window.Event('pagehide'));
		assert.equal(releases, 1);
		assert.throws(() => cache.acquire(options), isCancellationError);
	} finally { dom.window.close(); }
});

test('Working logo atlas evicts only unused entries when its memory budget is exceeded', async () => {
	const dom = new JSDOM();
	const released: number[] = [];
	try {
		using cache = new ChatWorkingLogoAtlasCache(dom.window as unknown as Window, async (_, value) => atlas(() => released.push(value.width)), 500_000);
		const first = cache.acquire(options);
		await first.object;
		using second = cache.acquire({ ...options, width: 25 });
		await second.object;
		assert.deepEqual(released, []);
		first.dispose();
		assert.deepEqual(released, [24]);
	} finally { dom.window.close(); }
});

test('Working logo atlas cancels the last pending consumer and disposes a late render', async () => {
	const dom = new JSDOM();
	let complete!: (value: IChatWorkingLogoAtlas) => void;
	let token!: CancellationToken;
	let releases = 0;
	try {
		using cache = new ChatWorkingLogoAtlasCache(dom.window as unknown as Window, (_, __, cancellation) => {
			token = cancellation;
			return new Promise(resolve => { complete = resolve; });
		});
		const reference = cache.acquire(options);
		await Promise.resolve();
		const rejection = assert.rejects(reference.object, isCancellationError);
		reference.dispose();
		assert.equal(token.isCancellationRequested, true);
		complete(atlas(() => releases++));
		await rejection;
		assert.equal(releases, 1);
	} finally { dom.window.close(); }
});

test('Working logo atlas retries failed generation and validates allocation boundaries', async () => {
	const dom = new JSDOM();
	let renders = 0;
	try {
		using cache = new ChatWorkingLogoAtlasCache(dom.window as unknown as Window, async () => {
			if (++renders === 1) throw new Error('Synthetic raster failure');
			return atlas();
		});
		using first = cache.acquire(options);
		await assert.rejects(first.object, /Synthetic raster failure/);
		using retry = cache.acquire(options);
		await retry.object;
		assert.equal(renders, 2);
		for (const width of [0, -1, 0.5, 129, NaN]) assert.throws(() => cache.acquire({ ...options, width }), RangeError);
		assert.throws(() => cache.acquire({ ...options, color: 'currentColor' }), TypeError);
		await assert.rejects(createChatWorkingLogoAtlas(dom.window as unknown as Window, options, CancellationToken.Cancelled), isCancellationError);
	} finally { dom.window.close(); }
});
