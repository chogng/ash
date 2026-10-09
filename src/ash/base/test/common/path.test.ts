import assert from 'node:assert/strict';
import * as nodePath from 'node:path';
import { suite, test } from 'mocha';
import { posix, win32 } from '../../common/path.js';

suite('target path operations', () => {
	test('preserves POSIX filename backslashes and normalizes dot segments', () => {
		for (const path of ['', '.', '..', '/', '/work/../notes/', '/work/.', '/work/..', 'a/../', '/part\\name/./notes', 'relative/../../notes']) {
			assert.deepEqual([posix.normalize(path), posix.isAbsolute(path)], [nodePath.posix.normalize(path), nodePath.posix.isAbsolute(path)], path);
		}
	});

	test('distinguishes extensions from dotfiles and uses the target separators', () => {
		for (const path of ['', '.', '..', '.hidden', '..hidden', 'file.', 'file.md', '/dir.with.dots/file', '/folder.md/', 'C:.hidden', '/file.md\\part', 'C:\\file.md\\part']) {
			assert.equal(posix.extname(path), nodePath.posix.extname(path), path);
			assert.equal(win32.extname(path), nodePath.win32.extname(path), path);
		}
	});

	test('normalizes Windows drive, rooted and UNC paths without crossing their roots', () => {
		for (const path of ['', '.', 'C:', 'C:relative/..', 'a/../', 'C:/work/.', '//server/share', '//server/share/../a', '///server//share//folder/../', 'C://work///../notes', 'C:\\', 'C:\\work\\..\\notes', 'C:relative\\..\\notes', '\\work\\..\\notes', '\\\\server\\share\\folder\\..\\notes', '\\\\server\\share\\..\\notes', 'C:/work/../notes/']) {
			assert.deepEqual([win32.normalize(path), win32.isAbsolute(path)], [nodePath.win32.normalize(path), nodePath.win32.isAbsolute(path)], path);
		}
	});
});
