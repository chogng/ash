import assert from 'node:assert/strict';
import * as nodePath from 'node:path';
import { suite, test } from 'mocha';
import { posix, win32 } from '../../common/path.js';

suite('target path operations', () => {
	for (const [rules, reference, base, paths] of [
		[
			posix,
			nodePath.posix,
			'/work/project',
			['src/../main.ts', '../part\\name ', '/C:/literal/file', '/other/./file'],
		],
		[
			win32,
			nodePath.win32,
			'C:\\work\\project',
			['src/../main.ts', '..\\notes', '\\rooted\\file', 'D:\\other\\file', '\\\\server\\share\\..\\file'],
		],
		[
			win32,
			nodePath.win32,
			'\\\\server\\share\\project',
			['..\\..\\file', '\\rooted\\file', '\\\\other\\share\\file'],
		],
	] as const) {
		test(`joins and resolves paths against explicit roots: ${base}`, () => {
			for (const path of paths) {
				assert.equal(rules.join(base, path), reference.join(base, path), `join ${path}`);
				const resolved = rules.resolve(base, path);
				assert.equal(resolved, reference.resolve(base, path), `resolve ${path}`);
				assert.equal(rules.relative(base, resolved), reference.relative(base, resolved), `relative ${path}`);
				assert.equal(rules.dirname(resolved), reference.dirname(resolved), `dirname ${path}`);
			}
		});
	}

	test('resolution never borrows the renderer process cwd or per-drive state', () => {
		assert.throws(() => posix.resolve('relative'));
		assert.throws(() => win32.resolve('C:relative'));
		assert.throws(() => win32.resolve('C:\\work', 'D:relative'));
		assert.equal(win32.relative('C:\\Work\\src', 'c:\\work\\Src\\main.ts'), 'main.ts');
		assert.equal(posix.relative('/Work/src', '/work/src/main.ts'), '../../work/src/main.ts');
	});

	test('dirname retains roots and the input spelling of separators', () => {
		for (const path of [
			'/',
			'.',
			'relative/file',
			'/C:/work\\name',
			'C:',
			'C:relative',
			'C:/work/file',
			'\\\\server\\share',
			'\\\\server\\share\\',
			'\\\\server\\share\\file',
		]) {
			assert.equal(posix.dirname(path), nodePath.posix.dirname(path), `POSIX ${path}`);
			assert.equal(win32.dirname(path), nodePath.win32.dirname(path), `Windows ${path}`);
		}
	});
	test('preserves POSIX filename backslashes and normalizes dot segments', () => {
		for (const path of [
			'',
			'.',
			'..',
			'/',
			'/work/../notes/',
			'/work/.',
			'/work/..',
			'a/../',
			'/part\\name/./notes',
			'relative/../../notes',
		]) {
			assert.deepEqual(
				[posix.normalize(path), posix.isAbsolute(path)],
				[nodePath.posix.normalize(path), nodePath.posix.isAbsolute(path)],
				path,
			);
		}
	});

	test('distinguishes extensions from dotfiles and uses the target separators', () => {
		for (const path of [
			'',
			'.',
			'..',
			'.hidden',
			'..hidden',
			'file.',
			'file.md',
			'/dir.with.dots/file',
			'/folder.md/',
			'C:.hidden',
			'/file.md\\part',
			'C:\\file.md\\part',
		]) {
			assert.equal(posix.extname(path), nodePath.posix.extname(path), path);
			assert.equal(win32.extname(path), nodePath.win32.extname(path), path);
			assert.equal(posix.basename(path), nodePath.posix.basename(path), path);
			assert.equal(win32.basename(path), nodePath.win32.basename(path), path);
			assert.equal(win32.basename(path, '.md'), nodePath.win32.basename(path, '.md'), path);
		}
	});

	test('normalizes Windows drive, rooted and UNC paths without crossing their roots', () => {
		for (const path of [
			'',
			'.',
			'C:',
			'C:relative/..',
			'a/../',
			'C:/work/.',
			'//server/share',
			'//server/share/../a',
			'///server//share//folder/../',
			'C://work///../notes',
			'C:\\',
			'C:\\work\\..\\notes',
			'C:relative\\..\\notes',
			'\\work\\..\\notes',
			'\\\\server\\share\\folder\\..\\notes',
			'\\\\server\\share\\..\\notes',
			'C:/work/../notes/',
		]) {
			assert.deepEqual(
				[win32.normalize(path), win32.isAbsolute(path)],
				[nodePath.win32.normalize(path), nodePath.win32.isAbsolute(path)],
				path,
			);
		}
	});
});
