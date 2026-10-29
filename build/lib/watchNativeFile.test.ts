import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { watchNativeFile } from './watchNativeFile.ts';

async function eventually(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 4000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, 'native file change was not observed');
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

test('native file watch follows repeated atomic saves and delayed recreation', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-manifest-watch-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'Cargo.toml');
	await writeFile(file, 'original');
	const observed = new Set<string>();
	const errors: Error[] = [];
	const watcher = watchNativeFile(file, () => {
		try { observed.add(fs.readFileSync(file, 'utf8')); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') observed.add('missing'); else throw error; }
	}, error => errors.push(error));
	t.after(() => watcher.close());
	for (const content of ['first replacement', 'second replacement']) {
		const temporary = join(directory, 'replacement');
		await writeFile(temporary, content);
		await rename(temporary, file);
		await eventually(() => observed.has(content));
	}
	await writeFile(file, 'in-place save');
	await eventually(() => observed.has('in-place save'));
	await rm(file);
	await eventually(() => observed.has('missing'));
	await new Promise(resolve => setTimeout(resolve, 250));
	await writeFile(file, 'recreated');
	await eventually(() => observed.has('recreated'));
	watcher.close();
	await writeFile(file, 'after close');
	await new Promise(resolve => setTimeout(resolve, 150));
	assert.equal(observed.has('after close'), false);
	assert.deepEqual(errors, []);
});

test('an initially missing file is announced when its native watch becomes available', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-missing-manifest-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'Cargo.lock');
	let observed = false;
	const watcher = watchNativeFile(file, () => { observed = fs.readFileSync(file, 'utf8') === 'created'; }, error => { throw error; });
	t.after(() => watcher.close());
	await writeFile(file, 'created');
	await eventually(() => observed);
	watcher.close();
});

test('closing an absent file cancels registration retries and leaves its parent unwatched', t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const calls: string[] = [];
	t.mock.method(fs, 'watch', (file: string) => {
		calls.push(file);
		throw Object.assign(new Error('missing'), { code: 'ENOENT' });
	});
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	syncBuiltinESMExports();
	const watcher = watchNativeFile('/workspace/Cargo.lock', () => assert.fail('closed watch emitted'), error => { throw error; });
	watcher.close();
	t.mock.timers.tick(1000);
	assert.deepEqual(calls, ['/workspace/Cargo.lock']);
});

test('a failed rebind reports the error and releases the obsolete native handle', t => {
	const native = Object.assign(new EventEmitter(), { close: t.mock.fn() });
	const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
	let opens = 0;
	t.mock.method(fs, 'watch', () => { if (++opens > 1) throw failure; return native; });
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	syncBuiltinESMExports();
	const errors: Error[] = [];
	const watcher = watchNativeFile('/workspace/Cargo.toml', () => { }, error => errors.push(error));
	native.emit('error', new Error('old inode unavailable'));
	watcher.close();
	assert.deepEqual(errors, [failure]);
	assert.equal(native.close.mock.callCount(), 1);
});
