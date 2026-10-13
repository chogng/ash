import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { watchRebuild } from './watchRebuild.ts';

function serverFixture() {
	const reloads: unknown[] = [];
	const errors: unknown[] = [];
	return {
		reloads, errors,
		watcher: new EventEmitter(),
		httpServer: new EventEmitter(),
		ws: { send(message: unknown) { reloads.push(message); } },
		config: { logger: { error(_message: string, options?: { error?: unknown; }) { errors.push(options?.error); } } },
	};
}

test('changes during a rebuild coalesce into one serial run reading the latest inputs', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const server = serverFixture();
	let input = 0;
	let output = -1;
	const reads: number[] = [];
	const runs: ReturnType<typeof Promise.withResolvers<boolean>>[] = [];
	const close = watchRebuild(server, path => path.endsWith('.ts'), async () => {
		const snapshot = input;
		reads.push(snapshot);
		const run = Promise.withResolvers<boolean>();
		runs.push(run);
		const changed = await run.promise;
		output = snapshot;
		return changed;
	});
	t.after(close);
	server.watcher.emit('all', 'change', 'first.ts');
	t.mock.timers.tick(50);
	assert.deepEqual(reads, [0]);
	for (let version = 1; version <= 8; version++) {
		input = version;
		server.watcher.emit('all', input % 2 ? 'add' : 'unlink', `${input}.ts`);
		t.mock.timers.tick(50);
	}
	assert.equal(runs.length, 1, 'generators must never overlap');
	runs[0]!.resolve(true);
	await runs[0]!.promise;
	await Promise.resolve();
	assert.deepEqual(reads, [0, 8]);
	runs[1]!.resolve(true);
	await runs[1]!.promise;
	await Promise.resolve();
	t.mock.timers.tick(1000);
	assert.equal(runs.length, 2, 'separate debounce windows must not queue redundant scans');
	assert.equal(output, input, 'the final output includes the latest input');
	assert.deepEqual(server.reloads, [{ type: 'full-reload' }, { type: 'full-reload' }]);
	assert.deepEqual(server.errors, []);
});

test('the trailing debounce still applies when generation finishes before the next timer', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const server = serverFixture();
	const first = Promise.withResolvers<boolean>();
	let calls = 0;
	t.after(watchRebuild(server, path => path.endsWith('.ts'), () => ++calls === 1 ? first.promise : Promise.resolve(false)));
	server.watcher.emit('all', 'addDir', 'folder.ts');
	server.watcher.emit('all', 'change', 'ignored.json');
	t.mock.timers.tick(100);
	assert.equal(calls, 0);
	server.watcher.emit('all', 'change', 'first.ts');
	t.mock.timers.tick(49);
	assert.equal(calls, 0);
	server.watcher.emit('all', 'change', 'second.ts');
	t.mock.timers.tick(50);
	assert.equal(calls, 1);
	server.watcher.emit('all', 'change', 'third.ts');
	t.mock.timers.tick(49);
	first.resolve(false);
	await first.promise;
	assert.equal(calls, 1);
	t.mock.timers.tick(1);
	assert.equal(calls, 2);
	await Promise.resolve();
	assert.deepEqual(server.reloads, [], 'unchanged outputs do not reload');
});

test('a failed generation reports its error and still processes pending and later edits', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const server = serverFixture();
	const first = Promise.withResolvers<boolean>();
	let calls = 0;
	t.after(watchRebuild(server, () => true, () => ++calls === 1 ? first.promise : Promise.resolve(true)));
	server.watcher.emit('all', 'change', 'first.ts');
	t.mock.timers.tick(50);
	server.watcher.emit('all', 'change', 'second.ts');
	t.mock.timers.tick(50);
	const failure = new Error('invalid source');
	first.reject(failure);
	await assert.rejects(first.promise, error => error === failure);
	assert.equal(calls, 2);
	assert.deepEqual(server.errors, [failure]);
	server.watcher.emit('all', 'change', 'third.ts');
	t.mock.timers.tick(50);
	await Promise.resolve();
	assert.equal(calls, 3);
	assert.equal(server.reloads.length, 2);
});

test('edits during a follow-up generation request another pass', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const server = serverFixture();
	const runs: ReturnType<typeof Promise.withResolvers<boolean>>[] = [];
	t.after(watchRebuild(server, () => true, () => {
		const run = Promise.withResolvers<boolean>();
		runs.push(run);
		return run.promise;
	}));
	server.watcher.emit('all', 'change', 'first.ts');
	t.mock.timers.tick(50);
	for (let index = 0; index < 2; index++) {
		server.watcher.emit('all', 'change', `${index}.ts`);
		t.mock.timers.tick(50);
		assert.equal(runs.length, index + 1);
		runs[index]!.resolve(false);
		await runs[index]!.promise;
		assert.equal(runs.length, index + 2);
	}
	runs[2]!.resolve(true);
	await runs[2]!.promise;
	assert.deepEqual(server.reloads, [{ type: 'full-reload' }]);
});

test('HTTP shutdown and middleware cleanup discard timers, queued work and late reloads', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	for (const shutdown of ['http', 'middleware'] as const) {
		for (const active of [false, true]) {
			const server = serverFixture();
			const first = Promise.withResolvers<boolean>();
			let calls = 0;
			const close = watchRebuild({ ...server, httpServer: shutdown === 'http' ? server.httpServer : null }, () => true, () => { calls++; return first.promise; });
			t.after(close);
			server.watcher.emit('all', 'change', 'first.ts');
			if (active) {
				t.mock.timers.tick(50);
				server.watcher.emit('all', 'change', 'second.ts');
				t.mock.timers.tick(50);
			}
			if (shutdown === 'http') { server.httpServer.emit('close'); } else { close(); }
			assert.equal(server.watcher.listenerCount('all'), 0);
			assert.equal(server.httpServer.listenerCount('close'), 0);
			server.watcher.emit('all', 'change', 'third.ts');
			t.mock.timers.tick(1000);
			first.resolve(true);
			await first.promise;
			assert.equal(calls, active ? 1 : 0);
			assert.deepEqual(server.reloads, []);
			assert.deepEqual(server.errors, []);
		}
	}
});
