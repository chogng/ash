import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { TerminalRecorder } from '../../common/terminalRecorder.js';

suite('Terminal display recorder', () => {
	test('retains geometry transitions and makes independent replay snapshots', async () => {
		const recorder = new TerminalRecorder(80, 24);
		recorder.handleResize(90, 30);
		recorder.handleData('中文');
		recorder.handleData('🙂');
		recorder.handleResize(100, 40);
		recorder.handleResize(110, 50);
		recorder.handleData('next');
		const replay = recorder.generateReplayEventSync();
		assert.deepEqual(replay.events, [{ cols: 90, rows: 30, data: '中文🙂' }, { cols: 110, rows: 50, data: 'next' }]);
		replay.events[0]!.data = 'outside';
		assert.equal((await recorder.generateReplayEvent()).events[0]!.data, '中文🙂');
	});

	test('bounds fragmented unseen output while retaining the newest complete segments', () => {
		const recorder = new TerminalRecorder(80, 24, { maxBytes: 32, maxChunks: 2 });
		recorder.handleData('first');
		recorder.handleResize(100, 30);
		recorder.handleData('second');
		recorder.handleData('中文🙂');
		assert.equal(recorder.isTruncated, true);
		assert.deepEqual(recorder.generateReplayEventSync().events, [{ cols: 100, rows: 30, data: 'second中文🙂' }]);
	});

	test('snapshots committed metadata without losing its ordering or retaining disabled command text', () => {
		const recorder = new TerminalRecorder(80, 24);
		const values = { CURRENT: 'committed' };
		recorder.handleData('', { type: 'environment', values, isTrusted: true });
		values.CURRENT = 'outside';
		recorder.handleData('prompt');
		recorder.handleData('', { type: 'commandLine', value: 'sensitive', isTrusted: true });
		recorder.handleData('', { type: 'commandExecuted', commandId: 'command', command: 'sensitive', isTrusted: true, cwd: undefined, timestampMillis: 1 });
		const first = recorder.generateReplayEventSync();
		const snapshot = first.events[0]!.shellIntegration;
		assert.equal(snapshot?.type, 'environment');
		if (snapshot?.type === 'environment') snapshot.values!.CURRENT = 'changed replay';
		recorder.handleData('', { type: 'commandStorageDisabled' });
		const events = recorder.generateReplayEventSync().events;
		assert.deepEqual(events[0]!.shellIntegration, { type: 'environment', values: { CURRENT: 'committed' }, isTrusted: true });
		assert.equal(events[1]!.data, 'prompt');
		assert.deepEqual(events[2]!.shellIntegration, { type: 'commandLine', value: '', isTrusted: false });
		assert.equal(JSON.stringify(events.slice(2)).includes('sensitive'), false);
	});
});
