import assert from 'node:assert/strict';
import { test } from 'mocha';
import { OperatingSystem } from '../../../../../../base/common/platform.js';
import { detectLinks } from '../../browser/terminalLinkParsing.js';

test('Terminal links parse compiler, stack trace and quoted Python locations', () => {
	for (const { text, path, row, col } of [
		{ text: 'src/main.ts:42:3: error TS2322', path: 'src/main.ts', row: 42, col: 3 },
		{ text: '    at render (/project/my files/view.ts:18:7)', path: '/project/my files/view.ts', row: 18, col: 7 },
		{ text: '  File "src/my module.py", line 9', path: 'src/my module.py', row: 9, col: undefined },
		{ text: '"src/my file.ts":12:4', path: 'src/my file.ts', row: 12, col: 4 },
		{ text: '/project/my files/main.ts:6:2: error', path: '/project/my files/main.ts', row: 6, col: 2 },
		{ text: 'C:\\my project\\main.cs(23,4): error', path: 'C:\\my project\\main.cs', row: 23, col: 4 },
	]) {
		const links = detectLinks(text, OperatingSystem.Windows);
		assert.equal(links.length, 1, text);
		const link = links[0]!;
		assert.equal(link.path.text, path, text);
		assert.equal(text.slice(link.path.index, link.path.index + path.length), path);
		assert.deepEqual([link.suffix?.row, link.suffix?.col], [row, col], text);
	}
});

test('Terminal links retain separate paths and exclude URLs and invalid locations', () => {
	assert.deepEqual(
		detectLinks('see ./src/a.ts:3:2 and ../b.rs:7', OperatingSystem.Linux).map(link => [
			link.path.text,
			link.suffix?.row,
			link.suffix?.col,
		]),
		[
			['./src/a.ts', 3, 2],
			['../b.rs', 7, undefined],
		],
	);
	assert.deepEqual(detectLinks('https://example.test/a.ts:40 command:run ordinary', OperatingSystem.Linux), []);
	assert.deepEqual(detectLinks('src/a.ts:0:2 src/b.ts:99999999999999', OperatingSystem.Linux), []);
	assert.deepEqual(detectLinks('x'.repeat(8193), OperatingSystem.Linux), []);
	assert.deepEqual(detectLinks('\u0000src/a.ts:4', OperatingSystem.Linux), []);
});
