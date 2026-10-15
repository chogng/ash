import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { TestUriIdentityServices } from '../../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { BrowserTextModelService } from '../../../../../services/textmodelResolver/browser/browserTextModelService.js';
import type { ITextResourceStore } from '../../../../../services/textmodelResolver/common/textResourceStore.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../../editor/common/model/textModel.js';
import type { TextModelReference } from '../../../../../services/textmodelResolver/common/textModelResourceService.js';
import { ChatEditingModifiedDocumentEntry } from '../../../browser/chatEditing/chatEditingModifiedDocumentEntry.js';
import type { ISnapshotEntry } from '../../../common/editing/chatEditingService.js';

const resource = URI.file('/workspace/review.txt');

function fixture(text = 'original', snapshot?: ISnapshotEntry, unsaved?: string) {
	const lifetime = new DisposableStore();
	const model = lifetime.add(new TextModel(text, { resource }));
	const dirty = lifetime.add(new Emitter<void>());
	let disk = text;
	let failSave = false;
	let complete = 0;
	const reference: TextModelReference = {
		resource, model,
		get isDirty() { return model.getText() !== disk; },
		onDidChangeDirty: dirty.event,
		hasExternalChange: false, onDidChangeExternalChange: Event.None,
		async save() {
			if (failSave) { throw new Error('injected rejection save failure'); }
			disk = model.getText();
			dirty.fire();
		},
		async saveAs() { throw new Error('not used'); },
		async revert() { model.applyOperations([{ range: model.getFullModelRange(), text: disk }]); },
		dispose() { }, [Symbol.dispose]() { },
	};
	if (unsaved !== undefined) { model.applyOperations([{ range: model.getFullModelRange(), text: unsaved }]); }
	const entry = lifetime.add(new ChatEditingModifiedDocumentEntry(resource, reference, () => complete++, () => { }, snapshot));
	return {
		entry, model, reference,
		get disk() { return disk; },
		get complete() { return complete; },
		set failSave(value: boolean) { failSave = value; },
		async agent(text: string) {
			const edit = { range: model.getFullModelRange(), text };
			entry.beginAgentEdit([edit]);
			model.applyOperations([edit]);
			entry.endAgentEdit();
			await reference.save(new AbortController().signal);
		},
		dispose: () => lifetime.dispose(), [Symbol.dispose]: () => lifetime.dispose(),
	};
}

test('failed rejection preserves its review source through a restart and retries against the current file', async () => {
	using first = fixture();
	await first.agent('agent');
	first.failSave = true;
	await assert.rejects(first.entry.reject(), /injected rejection save failure/);
	assert.deepEqual({ disk: first.disk, text: first.model.getText(), completed: first.complete }, { disk: 'agent', text: 'original', completed: 0 });
	using reopened = fixture(first.disk, first.entry.createSnapshot());
	assert.equal(reopened.model.getText(), 'original');
	assert.deepEqual({ hunks: reopened.entry.hunks.length, pendingSave: reopened.entry.hasPendingSave }, { hunks: 0, pendingSave: true });
	assert.deepEqual(first.entry.createSnapshot(), { resource, original: 'original', current: 'original', pendingSaveSource: 'agent' });
	assert.equal(reopened.disk, 'agent');
	await reopened.entry.reject();
	assert.deepEqual({ disk: reopened.disk, text: reopened.model.getText(), completed: reopened.complete }, { disk: 'original', text: 'original', completed: 1 });
});

test('restoring the owning model backup keeps a failed rejection retryable even with no remaining hunks', async () => {
	using reopened = fixture('agent', { resource, original: 'original', current: 'original', pendingSaveSource: 'agent' }, 'original');
	assert.deepEqual({ hunks: reopened.entry.hunks.length, pendingSave: reopened.entry.hasPendingSave, disk: reopened.disk }, { hunks: 0, pendingSave: true, disk: 'agent' });
	await reopened.entry.reject();
	assert.equal(reopened.disk, 'original');
	assert.equal(reopened.complete, 1);
});

test('retrying a failed hunk save leaves the other hunk available for review', async () => {
	using current = fixture('first\nseparator\nlast');
	await current.agent('agent first\nseparator\nagent last');
	current.failSave = true;
	await assert.rejects(current.entry.reject(current.entry.hunks[0]), /injected rejection save failure/);
	assert.equal(current.entry.hunks.length, 1);
	current.failSave = false;
	await current.entry.retrySave();
	assert.deepEqual({ disk: current.disk, hunks: current.entry.hunks.length, pendingSave: current.entry.hasPendingSave, completed: current.complete }, { disk: 'first\nseparator\nagent last', hunks: 1, pendingSave: false, completed: 0 });
	await current.entry.accept();
	assert.equal(current.complete, 1);
});

test('saving in the editor finishes a failed rejection without a second review decision', async () => {
	using current = fixture();
	await current.agent('agent');
	current.failSave = true;
	await assert.rejects(current.entry.reject());
	current.failSave = false;
	await current.reference.save(new AbortController().signal);
	assert.deepEqual({ disk: current.disk, pendingSave: current.entry.hasPendingSave, completed: current.complete }, { disk: 'original', pendingSave: false, completed: 1 });
});

test('user edits after a failed rejection survive retry and retain the recovery baseline', async () => {
	using current = fixture();
	await current.agent('agent');
	current.failSave = true;
	await assert.rejects(current.entry.reject());
	current.model.applyOperations([{ range: current.model.getFullModelRange(), text: 'user replacement' }]);
	assert.equal(current.complete, 0);
	assert.deepEqual(current.entry.createSnapshot(), { resource, original: 'user replacement', current: 'user replacement', pendingSaveSource: 'agent' });
	current.failSave = false;
	await current.entry.reject();
	assert.equal(current.disk, 'user replacement');
	assert.equal(current.complete, 1);
});

test('accepting cannot release a failed rejection until its current text is saved', async () => {
	using current = fixture();
	await current.agent('agent');
	current.failSave = true;
	await assert.rejects(current.entry.reject());
	await assert.rejects(current.entry.accept(), /injected rejection save failure/);
	assert.equal(current.complete, 0);
	assert.equal(current.entry.hasPendingSave, true);
	current.failSave = false;
	await current.entry.accept();
	assert.equal(current.disk, 'original');
	assert.equal(current.complete, 1);
});

test('accepting dirty Agent changes saves user edits and keeps the review retryable after a save failure', async () => {
	using current = fixture();
	await current.agent('agent');
	const end = current.model.getPositionAt(current.model.getText().length);
	current.model.applyOperations([{ range: new Range(end.lineNumber, end.column, end.lineNumber, end.column), text: '\nuser note' }]);
	assert.equal(current.entry.hunks.length, 1);
	current.failSave = true;
	await assert.rejects(current.entry.accept(), /injected rejection save failure/);
	assert.deepEqual({ disk: current.disk, text: current.model.getText(), completed: current.complete, hunks: current.entry.hunks.length, busy: current.entry.isBusy }, {
		disk: 'agent', text: 'agent\nuser note', completed: 0, hunks: 1, busy: false,
	});
	current.failSave = false;
	await current.entry.accept();
	assert.deepEqual({ disk: current.disk, text: current.model.getText(), completed: current.complete }, { disk: 'agent\nuser note', text: 'agent\nuser note', completed: 1 });
});


test('restarting a failed hunk rejection restores only that unsaved decision', async () => {
	using first = fixture('first\nseparator\nlast');
	await first.agent('agent first\nseparator\nagent last');
	first.failSave = true;
	await assert.rejects(first.entry.reject(first.entry.hunks[0]));
	using reopened = fixture(first.disk, first.entry.createSnapshot());
	assert.deepEqual({ text: reopened.model.getText(), hunks: reopened.entry.hunks.length, pendingSave: reopened.entry.hasPendingSave, disk: reopened.disk }, { text: 'first\nseparator\nagent last', hunks: 1, pendingSave: true, disk: 'agent first\nseparator\nagent last' });
	await reopened.entry.retrySave();
	assert.equal(reopened.disk, 'first\nseparator\nagent last');
	assert.equal(reopened.entry.hunks.length, 1);
	assert.equal(reopened.complete, 0);
});

test('recovery never replaces an existing dirty model or a file changed after the failed decision', () => {
	const snapshot = { resource, original: 'original', current: 'original', pendingSaveSource: 'agent' };
	using dirty = fixture('agent', snapshot, 'user replacement');
	assert.equal(dirty.model.getText(), 'user replacement');
	assert.equal(dirty.entry.hasPendingSave, true);
	using changed = fixture('later file', snapshot);
	assert.equal(changed.model.getText(), 'later file');
	assert.equal(changed.entry.hasPendingSave, false);
});


test('rejecting all after a failed hunk save still rejects the remaining Agent changes', async () => {
	using current = fixture('first\nseparator\nlast');
	await current.agent('agent first\nseparator\nagent last');
	current.failSave = true;
	await assert.rejects(current.entry.reject(current.entry.hunks[0]));
	current.failSave = false;
	await current.entry.reject();
	assert.deepEqual({ disk: current.disk, hunks: current.entry.hunks.length, completed: current.complete }, { disk: 'first\nseparator\nlast', hunks: 0, completed: 1 });
});


async function deferredSaveFixture() {
	const lifetime = new DisposableStore();
	const identity = lifetime.add(new TestUriIdentityServices());
	let disk = 'original';
	let revision = 0;
	let complete = 0;
	let nextWrite: { entered: DeferredPromise<string>; release: DeferredPromise<void>; } | undefined;
	const models = lifetime.add(identity.createInstance(BrowserTextModelService, {
		onDidChange: Event.None,
		resolve: async () => ({ resource, text: disk, revision: String(revision) }),
		async save(request) {
			const write = nextWrite;
			nextWrite = undefined;
			if (write) {
				await write.entered.complete(request.text);
				await write.release.p;
			}
			disk = request.text;
			return { revision: String(++revision) };
		},
	} satisfies ITextResourceStore, {}));
	// The editor keeps its model alive when completing a review releases its reference.
	const editor = lifetime.add(await models.acquire({ resource }, new AbortController().signal));
	const reference = await models.acquire({ resource }, new AbortController().signal);
	const entry = lifetime.add(new ChatEditingModifiedDocumentEntry(resource, reference, () => {
		complete++;
		entry.dispose();
	}, () => { }));
	return {
		entry, model: editor.model, reference,
		get disk() { return disk; },
		get complete() { return complete; },
		deferSave() {
			const write = { entered: new DeferredPromise<string>(), release: new DeferredPromise<void>() };
			nextWrite = write;
			return write;
		},
		async agent(text: string, save = true) {
			const edit = { range: editor.model.getFullModelRange(), text };
			entry.beginAgentEdit([edit]);
			editor.model.applyOperations([edit]);
			entry.endAgentEdit();
			if (save) { await reference.save(new AbortController().signal); }
		},
		append(text: string) {
			const end = editor.model.getPositionAt(editor.model.getText().length);
			editor.model.applyOperations([{ range: new Range(end.lineNumber, end.column, end.lineNumber, end.column), text }]);
		},
		dispose: () => lifetime.dispose(), [Symbol.dispose]: () => lifetime.dispose(),
	};
}

test('Accept retains a new Agent hunk delivered while its captured text is saving', async () => {
	using current = await deferredSaveFixture();
	await current.agent('agent A');
	current.append('\nuser note');
	const write = current.deferSave();
	const accepting = current.entry.accept();
	assert.equal(await write.entered.p, 'agent A\nuser note');
	await current.agent('agent B\nuser note', false);
	await write.release.complete();
	await accepting;
	assert.deepEqual({ completed: current.complete, disk: current.disk, text: current.model.getText(), dirty: current.reference.isDirty, hunks: current.entry.hunks.length }, {
		completed: 0, disk: 'agent A\nuser note', text: 'agent B\nuser note', dirty: true, hunks: 1,
	});
	assert.equal(current.entry.hunks[0].modifiedText, 'agent B\n');
	await current.entry.accept();
	assert.deepEqual({ completed: current.complete, disk: current.disk, dirty: current.reference.isDirty }, { completed: 1, disk: 'agent B\nuser note', dirty: false });
});

test('Accept retains newer unsaved user text when an older write completes', async () => {
	using current = await deferredSaveFixture();
	await current.agent('agent');
	current.append('\nfirst note');
	const write = current.deferSave();
	const accepting = current.entry.accept();
	assert.equal(await write.entered.p, 'agent\nfirst note');
	current.append('\nsecond note');
	await write.release.complete();
	await accepting;
	assert.deepEqual({ completed: current.complete, disk: current.disk, text: current.model.getText(), dirty: current.reference.isDirty, hunks: current.entry.hunks.length }, {
		completed: 0, disk: 'agent\nfirst note', text: 'agent\nfirst note\nsecond note', dirty: true, hunks: 1,
	});
	await current.entry.accept();
	assert.deepEqual({ completed: current.complete, disk: current.disk, dirty: current.reference.isDirty }, { completed: 1, disk: 'agent\nfirst note\nsecond note', dirty: false });
});


test('Accept cannot retire a new Agent operation that has not changed the model yet', async () => {
	using current = await deferredSaveFixture();
	await current.agent('agent A');
	current.append('\nuser note');
	const write = current.deferSave();
	const accepting = current.entry.accept();
	await write.entered.p;
	const edit = { range: current.model.getFullModelRange(), text: 'agent B\nuser note' };
	current.entry.beginAgentEdit([edit]);
	await write.release.complete();
	await accepting;
	assert.deepEqual({ completed: current.complete, busy: current.entry.isBusy, dirty: current.reference.isDirty }, { completed: 0, busy: true, dirty: false });
	current.model.applyOperations([edit]);
	current.entry.endAgentEdit();
	assert.equal(current.entry.hunks.length, 1);
	await current.entry.accept();
	assert.equal(current.disk, 'agent B\nuser note');
	assert.equal(current.complete, 1);
});

test('an Agent operation finishing during Accept does not unlock the pending review save', async () => {
	using current = await deferredSaveFixture();
	await current.agent('agent A');
	current.append('\nuser note');
	const write = current.deferSave();
	const accepting = current.entry.accept();
	await write.entered.p;
	await current.agent('agent B\nuser note', false);
	try {
		assert.equal(current.entry.isBusy, true);
		await current.entry.accept();
		assert.equal(current.complete, 0);
	} finally {
		await write.release.complete();
		await accepting;
	}
	assert.equal(current.entry.isBusy, false);
	assert.equal(current.complete, 0);
	await current.entry.accept();
	assert.equal(current.disk, 'agent B\nuser note');
	assert.equal(current.complete, 1);
});


test('Accept retains the review when a newer Agent operation preserves the same text', async () => {
	using current = await deferredSaveFixture();
	await current.agent('agent A');
	current.append('\nuser note');
	const write = current.deferSave();
	const accepting = current.entry.accept();
	await write.entered.p;
	current.entry.beginAgentEdit([]);
	current.entry.endAgentEdit();
	await write.release.complete();
	await accepting;
	assert.deepEqual({ completed: current.complete, dirty: current.reference.isDirty, hunks: current.entry.hunks.length }, { completed: 0, dirty: false, hunks: 1 });
	await current.entry.accept();
	assert.equal(current.complete, 1);
});

test('Accept of one hunk leaves the updated review intact when another Agent edit arrives during saving', async () => {
	using current = await deferredSaveFixture();
	await current.agent('agent first\nseparator\nagent last');
	current.append('\nuser note');
	const hunk = current.entry.hunks[0];
	const write = current.deferSave();
	const accepting = current.entry.accept(hunk);
	await write.entered.p;
	await current.agent('agent first\nseparator\nnew agent last\nuser note', false);
	await write.release.complete();
	await accepting;
	assert.equal(current.complete, 0);
	assert.equal(current.entry.createSnapshot().original, 'original\nuser note');
	assert.equal(current.entry.hunks[0].modifiedText, 'agent first\nseparator\nnew agent last\n');
	assert.equal(current.reference.isDirty, true);
	await current.entry.accept(current.entry.hunks[0]);
	assert.equal(current.disk, 'agent first\nseparator\nnew agent last\nuser note');
	assert.equal(current.complete, 1);
});


test('a rejected review stays retryable when user text arrives after its save captured the rejection', async () => {
	using current = await deferredSaveFixture();
	await current.agent('agent');
	const write = current.deferSave();
	const rejecting = current.entry.reject();
	assert.equal(await write.entered.p, 'original');
	current.append('\nnew user note');
	await write.release.complete();
	await rejecting;
	assert.deepEqual({ completed: current.complete, disk: current.disk, dirty: current.reference.isDirty, pending: current.entry.hasPendingSave, hunks: current.entry.hunks.length }, {
		completed: 0, disk: 'original', dirty: true, pending: true, hunks: 0,
	});
	assert.equal(current.entry.createSnapshot().pendingSaveSource, 'agent');
	await current.entry.retrySave();
	assert.deepEqual({ completed: current.complete, disk: current.disk, dirty: current.reference.isDirty }, { completed: 1, disk: 'original\nnew user note', dirty: false });
});

test('retrying a failed rejection keeps later user text pending until its own save is acknowledged', async () => {
	using current = await deferredSaveFixture();
	await current.agent('agent');
	const failedWrite = current.deferSave();
	const rejecting = current.entry.reject();
	const failure = assert.rejects(rejecting, /deferred rejection failed/);
	await failedWrite.entered.p;
	await failedWrite.release.error(new Error('deferred rejection failed'));
	await failure;
	const write = current.deferSave();
	const retrying = current.entry.retrySave();
	assert.equal(await write.entered.p, 'original');
	current.append('\nnew user note');
	await write.release.complete();
	await retrying;
	assert.deepEqual({ completed: current.complete, disk: current.disk, dirty: current.reference.isDirty, pending: current.entry.hasPendingSave }, {
		completed: 0, disk: 'original', dirty: true, pending: true,
	});
	await current.entry.retrySave();
	assert.deepEqual({ completed: current.complete, disk: current.disk, dirty: current.reference.isDirty }, { completed: 1, disk: 'original\nnew user note', dirty: false });
});
