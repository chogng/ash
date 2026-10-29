import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { DisposableTracker, installDisposableTracker } from '../../common/lifecycle.js';

test('IME can be first imported during tracking without leaking its realm-owned emitter', async () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const { IME } = await import('../../common/ime.js');
	tracker.assertNoLeaks();

	const initialState = IME.enabled;
	const changes: boolean[] = [];
	using listener = IME.onDidChange(enabled => changes.push(enabled));
	try {
		assert.deepEqual(tracker.leaks().map(leak => leak.disposable), [listener]);
		IME.disable();
		IME.disable();
		IME.enable();
		IME.enable();
		assert.deepEqual(changes, [false, true]);
		listener.dispose();
		tracker.assertNoLeaks();
	} finally {
		if (initialState) {
			IME.enable();
		} else {
			IME.disable();
		}
	}
});

test('ordinary IME instances own their emitter and release it idempotently', async () => {
	const { InputMethodEditorState } = await import('../../common/ime.js');
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	using state = new InputMethodEditorState();
	assert.deepEqual(tracker.leaks().map(leak => [leak.label, leak.ownerLabel]), [
		['InputMethodEditorState', undefined],
		['Emitter', 'InputMethodEditorState'],
	]);
	const changes: boolean[] = [];
	using listener = state.onDidChange(enabled => changes.push(enabled));
	state.disable();
	state.disable();
	state.enable();
	state.enable();
	assert.deepEqual(changes, [false, true]);

	state.dispose();
	state.dispose();
	assert.throws(() => state.disable(), ReferenceError);
	assert.throws(() => state.onDidChange(() => { }), ReferenceError);
	assert.deepEqual(tracker.leaks().map(leak => leak.disposable), [listener]);
	listener.dispose();
	tracker.assertNoLeaks();
});
