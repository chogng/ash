import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../base/common/async.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { TerminalWindowRecovery } from '../../electron-main/terminalWindowRecovery.js';

suite('Emergency terminal window recovery', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('hands only the prepared checkpoint credentials and lifetime to its replacement once', async () => {
		let closed = 0;
		using source = new TerminalWindowRecovery(resources => { resources.add(toDisposable(() => closed++)); return []; });
		await source.secrets.set('terminal.reload', 'synthetic reconnect capability');
		await source.secrets.set('unrelated', 'source only');
		const loaded = new DeferredPromise<void>();
		let target: TerminalWindowRecovery | undefined;
		let opens = 0;
		const first = source.reopen(async recovery => { opens++; target = recovery; await loaded.p; });
		const second = source.reopen(async () => { throw new Error('Duplicate replacement'); });
		assert.equal(first, second);
		await loaded.complete();
		await first;
		try {
			assert.equal(opens, 1);
			assert.equal(await target!.secrets.get('terminal.reload'), 'synthetic reconnect capability');
			assert.equal(await target!.secrets.get('unrelated'), undefined);
			assert.equal(await source.secrets.get('terminal.reload'), undefined);
			source.dispose();
			assert.equal(closed, 0);
		} finally { target?.dispose(); }
		assert.equal(closed, 1);
	});

	test('failed replacement startup keeps the source credentials and lifetime, and allows retry', async () => {
		let closed = 0;
		using source = new TerminalWindowRecovery(resources => { resources.add(toDisposable(() => closed++)); return []; });
		await source.secrets.set('terminal.reload', 'synthetic lease');
		await assert.rejects(source.reopen(async () => { throw new Error('load failed'); }), /load failed/);
		assert.equal(closed, 0);
		assert.equal(await source.secrets.get('terminal.reload'), 'synthetic lease');
		let target: TerminalWindowRecovery | undefined;
		await source.reopen(async recovery => { target = recovery; });
		target!.dispose();
		assert.equal(closed, 1);
	});

	test('a closed replacement cannot steal the source lifetime', async () => {
		let closed = 0;
		using source = new TerminalWindowRecovery(resources => { resources.add(toDisposable(() => closed++)); return []; });
		await source.secrets.set('terminal.reload', 'synthetic lease');
		await assert.rejects(source.reopen(async target => target.dispose()), /closed/);
		assert.equal(closed, 0);
		assert.equal(await source.secrets.get('terminal.reload'), 'synthetic lease');
	});

	test('source closure during replacement startup releases its lifetime and fails the handoff', async () => {
		let closed = 0;
		using source = new TerminalWindowRecovery(resources => { resources.add(toDisposable(() => closed++)); return []; });
		await source.secrets.set('terminal.reload', 'synthetic lease');
		await assert.rejects(source.reopen(async () => source.dispose()), /closed/);
		assert.equal(closed, 1);
	});

	test('windows without a prepared checkpoint reopen without sharing their old lifetime or credentials', async () => {
		let closed = 0;
		using source = new TerminalWindowRecovery(resources => { resources.add(toDisposable(() => closed++)); return []; });
		await source.secrets.set('unrelated', 'source only');
		let target: TerminalWindowRecovery | undefined;
		await source.reopen(async recovery => { target = recovery; });
		try {
			assert.equal(await target!.secrets.get('terminal.reload'), undefined);
			assert.equal(await target!.secrets.get('unrelated'), undefined);
			source.dispose();
			assert.equal(closed, 1);
		} finally { target?.dispose(); }
	});

	test('an unrelated window cannot read a prepared window checkpoint', async () => {
		using source = new TerminalWindowRecovery(() => []);
		using unrelated = new TerminalWindowRecovery(() => []);
		await source.secrets.set('terminal.reload', 'synthetic lease');
		assert.equal(await unrelated.secrets.get('terminal.reload'), undefined);
	});
});
