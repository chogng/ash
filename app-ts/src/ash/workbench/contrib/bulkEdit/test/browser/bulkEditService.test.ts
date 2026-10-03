import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IBulkEditService, ResourceEdit, ResourceFileEdit, ResourceTextEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import type { LanguageWorkspaceEdit } from '../../../../../editor/common/languages.js';
import { ITextModelResourceService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DialogResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import { toLanguageWorkspaceEdit } from '../../browser/bulkEditService.js';
import { BulkEditTestServices } from './bulkEditTestServices.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Event } from '../../../../../base/common/event.js';
import { EditSources } from '../../../../../editor/common/textModelEditSource.js';

ensureNoDisposablesAreLeakedInTestSuite();
const first = URI.file('/workspace/one.ts');
const second = URI.file('/workspace/two.ts');

function textEdit(resource: URI, text: string): LanguageWorkspaceEdit {
	return { entries: [{ kind: 'textDocument', resource, edits: [{ range: new Range(1, 1, 1, 1), text }] }] };
}

test('bulk edits apply a single entry through the shared model', async () => {
	using fixture = new BulkEditTestServices([[first, '']]);
	const result = await fixture.service.apply(textEdit(first, 'one'));
	assert.deepEqual({ applied: result.isApplied, text: fixture.store.text(first), saved: fixture.store.saved }, { applied: true, text: 'one', saved: [first.toString()] });
});

test('multi-entry edits apply directly when no preview handler is installed', async () => {
	using fixture = new BulkEditTestServices([[first, ''], [second, '']]);
	await fixture.service.apply({ entries: [...textEdit(first, 'one').entries, ...textEdit(second, 'two').entries] });
	assert.deepEqual([fixture.store.text(first), fixture.store.text(second)], ['one', 'two']);
});

test('multi-entry edits preview by default and apply the accepted subset', async () => {
	using fixture = new BulkEditTestServices([[first, ''], [second, '']]);
	using handler = fixture.service.setPreviewHandler(async edits => [edits[1]!]);
	await fixture.service.apply({ entries: [...textEdit(first, 'one').entries, ...textEdit(second, 'two').entries] });
	assert.deepEqual([fixture.store.text(first), fixture.store.text(second)], ['', 'two']);
});

test('cancelling preview leaves every resource unchanged', async () => {
	using fixture = new BulkEditTestServices([[first, ''], [second, '']]);
	using handler = fixture.service.setPreviewHandler(async () => []);
	const result = await fixture.service.apply({ entries: [...textEdit(first, 'one').entries, ...textEdit(second, 'two').entries] });
	assert.deepEqual({ applied: result.isApplied, saved: fixture.store.saved }, { applied: false, saved: [] });
});

test('a caller can force preview for a single entry', async () => {
	using fixture = new BulkEditTestServices([[first, '']]);
	let previews = 0;
	using handler = fixture.service.setPreviewHandler(async edits => { previews++; return edits; });
	await fixture.service.apply(textEdit(first, 'one'), { showPreview: true });
	assert.deepEqual({ previews, text: fixture.store.text(first) }, { previews: 1, text: 'one' });
});

test('approval commits every resource when the first mutation retires the originating request', async () => {
	using fixture = new BulkEditTestServices([[first, ''], [second, '']]);
	using reference = await fixture.models.acquire({ resource: first }, new AbortController().signal);
	const controller = new AbortController();
	using listener = reference.model.onDidChangeContent(() => controller.abort());
	using handler = fixture.service.setPreviewHandler(async edits => edits);
	await fixture.service.apply({ entries: [...textEdit(first, 'one').entries, ...textEdit(second, 'two').entries] }, { showPreview: true, token: controller.signal });
	assert.deepEqual([fixture.store.text(first), fixture.store.text(second)], ['one', 'two']);
});

test('preview preserves content checks and sequential snapshots', async () => {
	using fixture = new BulkEditTestServices([[first, 'a']]);
	const edit: LanguageWorkspaceEdit = { entries: [
		{ kind: 'textDocument', resource: first, expectedText: 'a', edits: [{ range: new Range(1, 1, 1, 2), text: 'long' }] },
		{ kind: 'textDocument', resource: first, expectedText: 'long', edits: [{ range: new Range(1, 5, 1, 5), text: '!' }] },
	] };
	using handler = fixture.service.setPreviewHandler(async edits => {
		const preview = await toLanguageWorkspaceEdit(edits);
		assert.deepEqual(preview, edit);
		return ResourceEdit.convert(preview);
	});
	await fixture.service.apply(edit, { showPreview: true });
	assert.equal(fixture.store.text(first), 'long!');
});

test('preview retains distinct sequential snapshots when steps reuse a text edit payload', async () => {
	using fixture = new BulkEditTestServices([[first, 'ab']]);
	const payload = { range: new Range(1, 1, 1, 1), text: '!' };
	using handler = fixture.service.setPreviewHandler(async edits => edits);
	await fixture.service.apply({ entries: [
		{ kind: 'textDocument', resource: first, expectedText: 'ab', edits: [payload] },
		{ kind: 'textDocument', resource: first, expectedText: '!ab', edits: [payload] },
	] }, { showPreview: true });
	assert.equal(fixture.store.text(first), '!!ab');
});

test('disposing replaced preview registrations does not restore a released handler', () => {
	using fixture = new BulkEditTestServices([]);
	const firstHandler = fixture.service.setPreviewHandler(async edits => edits);
	const secondHandler = fixture.service.setPreviewHandler(async edits => edits);
	firstHandler.dispose();
	secondHandler.dispose();
	assert.equal(fixture.service.hasPreviewHandler(), false);
});

test('cancelled requests cannot start preview or mutate files', async () => {
	using fixture = new BulkEditTestServices([[first, '']]);
	using handler = fixture.service.setPreviewHandler(async () => { throw new Error('Preview must not run'); });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(fixture.service.apply(textEdit(first, 'one'), { showPreview: true, token: controller.signal }), isCancellationError);
	assert.deepEqual(fixture.store.saved, []);
});

test('cancellation while file contents resolve prevents the transaction from starting', async () => {
	using fixture = new BulkEditTestServices([]);
	const controller = new AbortController();
	const contents = Promise.resolve().then(() => { controller.abort(); return VSBuffer.fromString('file'); });
	await assert.rejects(fixture.service.apply([new ResourceFileEdit(undefined, first, { contents })], { token: controller.signal }), isCancellationError);
	assert.equal(fixture.files.has(first), false);
});

test('confirmation metadata requests preview even when ordinary preview is disabled', async () => {
	using fixture = new BulkEditTestServices([[first, '']]);
	let previews = 0;
	using handler = fixture.service.setPreviewHandler(async edits => { previews++; return edits; });
	await fixture.service.apply([new ResourceTextEdit(first, { range: new Range(1, 1, 1, 1), text: 'one' }, undefined, { needsConfirmation: true })], { showPreview: false });
	assert.deepEqual({ previews, text: fixture.store.text(first) }, { previews: 1, text: 'one' });
});

test('registered bulk edits reject missing model and dialog dependencies before use', async () => {
	using fixture = new BulkEditTestServices([[first, '']]);
	using services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors().filter(([id]) => id === IBulkEditService)));
	assert.throws(() => services.get(IBulkEditService), /Unknown service: textModelResourceService/);
	services.registerInstance(ITextModelResourceService, fixture.models);
	services.registerInstance(IWorkingCopyService, fixture.workingCopies);
	services.registerInstance(IFileService, fixture.files);
	services.registerInstance(IConfigurationService, fixture.configuration);
	assert.throws(() => services.get(IBulkEditService), /Unknown service: dialogService/);
	services.registerInstance(IDialogService, fixture.dialogs);
	const service = services.get(IBulkEditService);
	await service.apply(textEdit(first, 'one'));
	assert.equal(fixture.store.text(first), 'one');
});

test('registered bulk edits share the window dialog queue regardless of registration order', async () => {
	using fixture = new BulkEditTestServices([[first, 'a']]);
	const descriptors = getSingletonServiceDescriptors().filter(([id]) => id === IBulkEditService || id === IDialogService).reverse();
	using services = new InstantiationService(new ServiceCollection(...descriptors));
	services.registerInstance(ITextModelResourceService, fixture.models);
	services.registerInstance(IWorkingCopyService, fixture.workingCopies);
	services.registerInstance(IFileService, fixture.files);
	services.registerInstance(IConfigurationService, fixture.configuration);
	const service = services.get(IBulkEditService);
	const dialogs = services.get(IDialogService);
	assert.ok(dialogs instanceof DialogService);
	assert.equal(services.get(IBulkEditService), service);
	assert.equal(services.get(IDialogService), dialogs);
	const result = await service.apply(textEdit(first, '1'), { label: 'Rename symbol', confirmBeforeUndo: true });
	assert.ok(result.isApplied);
	const undo = result.undo();
	assert.equal(dialogs.model.dialogs[0]!.request.message, 'Undo Rename symbol?');
	dialogs.model.dialogs[0]!.close({ button: DialogResult.Primary });
	await undo;
	assert.deepEqual({ text: fixture.store.text(first), pendingDialogs: dialogs.model.dialogs.length }, { text: 'a', pendingDialogs: 0 });
});

test('standard workspace edits use original coordinates and expose an exact inverse', async () => {
	using fixture = new BulkEditTestServices([[first, 'abc def']]);
	const result = await fixture.service.apply({ edits: [
		{ resource: first, textEdit: { range: new Range(1, 1, 1, 4), text: 'long' } },
		{ resource: first, textEdit: { range: new Range(1, 5, 1, 8), text: 'XYZ' } },
	] });
	assert.equal(fixture.store.text(first), 'long XYZ');
	assert.ok(result.isApplied);
	await result.undo();
	assert.equal(fixture.store.text(first), 'abc def');
});

test('one undo group reverses sequential edits to the same document and every touched resource', async () => {
	using fixture = new BulkEditTestServices([[first, 'a'], [second, 'b']]);
	const one = await fixture.service.apply(textEdit(first, '1'), { undoRedoGroupId: 42 });
	const two = await fixture.service.apply({ entries: [...textEdit(first, '2').entries, ...textEdit(second, '3').entries] }, { undoRedoGroupId: 42 });
	assert.deepEqual([fixture.store.text(first), fixture.store.text(second)], ['21a', '3b']);
	assert.ok(one.isApplied && two.isApplied);
	await one.undo();
	assert.deepEqual([fixture.store.text(first), fixture.store.text(second)], ['a', 'b']);
	await assert.rejects(two.undo(), /already reverted/);
});

test('group undo checks every latest snapshot before changing any resource', async () => {
	using fixture = new BulkEditTestServices([[first, 'a'], [second, 'b']]);
	const one = await fixture.service.apply(textEdit(first, '1'), { undoRedoGroupId: 7 });
	await fixture.service.apply(textEdit(second, '2'), { undoRedoGroupId: 7 });
	using reference = await fixture.models.acquire({ resource: second }, new AbortController().signal);
	reference.model.setValue('user edit');
	assert.ok(one.isApplied);
	await assert.rejects(one.undo(), /changed before replacement/);
	assert.equal(fixture.store.text(first), '1a');
});

test('declining undo confirmation preserves the transaction and permits a later undo', async () => {
	using fixture = new BulkEditTestServices([[first, 'a']]);
	const result = await fixture.service.apply(textEdit(first, '1'), { label: 'Rename symbol', confirmBeforeUndo: true });
	assert.ok(result.isApplied);
	fixture.dialogs.confirmed = false;
	await result.undo();
	assert.equal(fixture.store.text(first), '1a');
	assert.equal(fixture.dialogs.confirmations[0]!.message, 'Undo Rename symbol?');
	fixture.dialogs.confirmed = true;
	await result.undo();
	assert.equal(fixture.store.text(first), 'a');
});

for (const autoSave of [true, false, 'failure'] as const) {
	test(`refactoring autosave ${autoSave === 'failure' ? 'reports a save failure after commit' : autoSave ? 'saves' : 'keeps dirty'} open working copies according to configuration`, async () => {
		using fixture = new BulkEditTestServices([[first, 'a'], [second, 'b']]);
		await fixture.configuration.updateValue('files.refactoring.autoSave', autoSave !== false);
		using references = await fixture.models.acquire({ resource: first }, new AbortController().signal);
		using secondReference = await fixture.models.acquire({ resource: second }, new AbortController().signal);
		using saveListener = references.onDidChangeDirty(() => {
			if (autoSave === 'failure' && !references.isDirty && fixture.store.saved.length === 1) {
				fixture.store.failNextSave = new Error('injected autosave failure');
			}
		});
		const registrations = [references, secondReference].map(reference => fixture.workingCopies.register({
			resource: reference.resource, backupKind: 'text',
			get isDirty() { return reference.isDirty; },
			get hasExternalChange() { return reference.hasExternalChange; },
			onDidChangeDirty: reference.onDidChangeDirty, onDidChangeExternalChange: reference.onDidChangeExternalChange,
			onDidChangeContent: Event.None,
			backup: () => reference.model.getText(), restoreBackup: value => reference.model.setValue(value),
			save: signal => reference.save(signal), revert: signal => reference.revert(signal),
			saveAs: async () => { throw new Error('Save As is outside this scenario'); },
			dispose: () => {}, [Symbol.dispose]: () => {},
		}));
		try {
			const result = await fixture.service.apply({ entries: [...textEdit(first, '1').entries, ...textEdit(second, '2').entries] }, { respectAutoSaveConfig: true });
			assert.ok(result.isApplied);
			assert.deepEqual(fixture.store.saved, autoSave === 'failure' ? [first.toString()] : autoSave ? [first.toString(), second.toString()] : []);
			assert.deepEqual([references.isDirty, secondReference.isDirty], autoSave === 'failure' ? [false, true] : [!autoSave, !autoSave]);
			if (autoSave === 'failure') {
				assert.match(fixture.dialogs.errors[0]!, /changes were applied.*automatic saving failed/);
				await result.undo();
				assert.deepEqual([references.model.getText(), secondReference.model.getText()], ['a', 'b']);
			}
		} finally {
			for (const registration of registrations) { registration.dispose(); }
		}
	});
}

test('bulk text mutations retain the originating edit reason', async () => {
	using fixture = new BulkEditTestServices([[first, 'a']]);
	using reference = await fixture.models.acquire({ resource: first }, new AbortController().signal);
	const reason = EditSources.rename('a', 'newName');
	const reasons: unknown[] = [];
	using listener = reference.model.onDidChangeContent(event => reasons.push(...event.detailedReasons));
	await fixture.service.apply(textEdit(first, 'newName'), { reason });
	assert.ok(reasons.includes(reason));
});
