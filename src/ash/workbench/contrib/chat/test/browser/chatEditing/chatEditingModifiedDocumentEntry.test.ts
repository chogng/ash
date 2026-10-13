import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
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
