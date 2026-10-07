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
