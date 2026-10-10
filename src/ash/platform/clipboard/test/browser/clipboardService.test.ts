import { JSDOM } from 'jsdom';
import { getWindowId, registerWindow } from '../../../../base/browser/window.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { BrowserClipboardService } from '../../browser/clipboardService.js';

test('browser resource clipboard is shared across service instances and follows external writes', async () => {
	const previousClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
	class TestClipboardItem {
		readonly types: string[];
		constructor(private readonly data: Record<string, Blob>) {
			this.types = Object.keys(data);
		}
		async getType(type: string): Promise<Blob> {
			return this.data[type]!;
		}
	}
	Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
	try {
		let items: ClipboardItem[] = [];
		const clipboard = {
			read: async () => items,
			write: async (value: ClipboardItem[]) => { items = value; },
			readText: async () => '',
			writeText: async () => { items = []; },
		} as unknown as Clipboard;
		const first = new BrowserClipboardService(clipboard);
		const second = new BrowserClipboardService(clipboard);
		const resource = URI.file('/workspace/100% ready.txt');

		await first.writeResources([resource], 'move');
		assert.deepEqual(await second.readResources(), { resources: [resource], operation: 'move' });
		await second.writeText('different clipboard content');
		assert.equal(await first.hasResources(), false);
	} finally {
		if (previousClipboardItem) Object.defineProperty(globalThis, 'ClipboardItem', previousClipboardItem);
		else Reflect.deleteProperty(globalThis, 'ClipboardItem');
	}
});

test('browser image clipboard reads PNG bytes without consuming text or resource entries', async () => {
	const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
	const clipboard = {
		read: async () => [
			{ types: ['text/plain'], getType: async () => { throw new Error('Text should not be read'); } },
			{ types: ['image/png'], getType: async () => new Blob([bytes], { type: 'image/png' }) },
		],
	} as unknown as Clipboard;
	assert.deepEqual(await new BrowserClipboardService(clipboard).readImage(), bytes);
});

test('browser image clipboard distinguishes a missing image from denied access', async () => {
	assert.deepEqual(await new BrowserClipboardService({ read: async () => [] } as unknown as Clipboard).readImage(), new Uint8Array());
	const denied = new Error('Clipboard access denied');
	await assert.rejects(new BrowserClipboardService({ read: async () => { throw denied; } } as unknown as Clipboard).readImage(), error => error === denied);
});


test('browser find text belongs to its service scope and works without text clipboard permission', async () => {
	using first = new BrowserClipboardService(undefined);
	using second = new BrowserClipboardService(undefined);
	await first.writeFindText('find term');
	assert.equal(await first.readFindText(), 'find term');
	assert.equal(await second.readFindText(), '');
	await assert.rejects(first.readText(), /unavailable/);
	assert.equal(await first.readFindText(), 'find term');
});


test('browser typed text stays scoped and does not access or overwrite the system clipboard', async () => {
	let text = 'system';
	using first = new BrowserClipboardService({ readText: async () => text, writeText: async value => { text = value; } } as Clipboard);
	using second = new BrowserClipboardService(undefined);
	await first.writeText('selected', 'selection');
	await first.writeText('custom', 'private-type');
	await first.writeText('updated system');
	assert.deepEqual(await Promise.all([first.readText(), first.readText('selection'), first.readText('private-type'), second.readText('selection')]),
		['updated system', 'selected', 'custom', '']);
});

test('browser paste targets only registered windows and reports unsupported commands without a synthetic event', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using registered = registerWindow(dom.window as unknown as Window);
		using clipboard = new BrowserClipboardService(undefined);
		const id = getWindowId(dom.window as unknown as Window)!;
		const commands: string[] = [];
		dom.window.document.execCommand = command => { commands.push(command); return true; };
		await clipboard.triggerPaste(id);
		assert.deepEqual(commands, ['paste']);
		assert.equal(clipboard.triggerPaste(-1), undefined);
		dom.window.document.execCommand = () => false;
		assert.equal(clipboard.triggerPaste(id), undefined);
		dom.window.document.execCommand = () => { throw new Error('Unsupported'); };
		assert.equal(clipboard.triggerPaste(id), undefined);
		registered.dispose();
		assert.equal(clipboard.triggerPaste(id), undefined);
	} finally {
		dom.window.close();
	}
});


test('browser rich reads preserve text, HTML, custom formats and image bytes from the same read', async () => {
	const image = Uint8Array.of(137, 80, 78, 71);
	let reads = 0;
	const blobs: Record<string, Blob> = {
		'text/plain': new Blob(['plain'], { type: 'text/plain' }),
		'text/html': new Blob(['<b>rich</b>'], { type: 'text/html' }),
		'web application/x-ash-paste-provider-id': new Blob(['copied-id']),
		'image/png': new Blob([image], { type: 'image/png' }),
	};
	using clipboard = new BrowserClipboardService({
		read: async () => { reads++; return [{ types: Object.keys(blobs), getType: async (type: string) => blobs[type] }]; },
		readText: async () => { throw new Error('Rich reads must not downgrade to text'); },
	} as unknown as Clipboard);
	const items = await clipboard.read();
	assert.deepEqual(items.map(item => ({ type: item.type, data: [...item.data] })), [
		{ type: 'text/plain', data: [...new TextEncoder().encode('plain')] },
		{ type: 'text/html', data: [...new TextEncoder().encode('<b>rich</b>')] },
		{ type: 'application/x-ash-paste-provider-id', data: [...new TextEncoder().encode('copied-id')] },
		{ type: 'image/png', data: [...image] },
	]);
	assert.equal(reads, 1);
});

test('browser rich reads fall back only when the rich API is unavailable', async () => {
	using textOnly = new BrowserClipboardService({ readText: async () => 'plain' } as Clipboard);
	assert.deepEqual(await textOnly.read(), [{ type: 'text/plain', data: new TextEncoder().encode('plain') }]);
	const denied = new DOMException('denied', 'NotAllowedError');
	using blocked = new BrowserClipboardService({
		read: async () => { throw denied; },
		readText: async () => { throw new Error('Denied rich reads must not downgrade'); },
	} as unknown as Clipboard);
	await assert.rejects(blocked.read(), error => error === denied);
	using unavailable = new BrowserClipboardService(undefined);
	await assert.rejects(unavailable.read(), /unavailable/);
});
