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
