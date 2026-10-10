import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { WorkspaceEditConflictError } from '../../../../../editor/browser/services/bulkEditService.js';
import { BulkEditTestServices } from '../../../bulkEdit/test/browser/bulkEditTestServices.js';
import { ReplaceService } from '../../browser/replaceService.js';
import { SearchResultImpl } from '../../browser/searchTreeModel/searchResult.js';
import type { IContentSearchQuery } from '../../../../../platform/search/common/search.js';
import { Event } from '../../../../../base/common/event.js';

const root = URI.file('/workspace');
const resource = URI.joinPath(root, 'main.ts');
const query: IContentSearchQuery = { text: '(needle)', patternKind: 'regex', caseSensitivity: 'insensitive', includePatterns: [], excludePatterns: [] };
const options = { preview: false, preserveCase: false, signal: new AbortController().signal };

function results(preview: string, ranges: readonly { start: number; end: number; }[]): SearchResultImpl {
	const result = new SearchResultImpl([{ id: 'workspace', index: 0, name: 'workspace', uri: root }]);
	result.add([{ dirId: 'workspace', path: 'main.ts', lineNumber: 1, preview, ranges }]);
	return result;
}

test('replacement applies capture groups to every occurrence and saves through shared models', async () => {
	using fixture = new BulkEditTestServices([[resource, '中文😀 needle needle']]);
	const result = results('中文😀 needle needle', [{ start: 5, end: 11 }, { start: 12, end: 18 }]);
	const replace = new ReplaceService(fixture.models, fixture.service, fixture.workingCopies);
	const applied = await replace.replace(result.files[0]!.matches, query, '$1!', options);
	assert.deepEqual({ applied: applied.isApplied, text: fixture.store.text(resource), errors: applied.saveErrors }, { applied: true, text: '中文😀 needle! needle!', errors: [] });
	assert.equal(applied.isApplied, true);
	if (applied.isApplied) { await applied.undo(); }
	assert.equal(fixture.store.text(resource), '中文😀 needle needle');
});

test('replacement rejects stale ranges before changing any resource', async () => {
	using fixture = new BulkEditTestServices([[resource, 'changed']]);
	const result = results('needle', [{ start: 0, end: 6 }]);
	await assert.rejects(new ReplaceService(fixture.models, fixture.service, fixture.workingCopies).replace(result.files[0]!.matches, query, 'value', options), WorkspaceEditConflictError);
	assert.deepEqual({ text: fixture.store.text(resource), saved: fixture.store.saved }, { text: 'changed', saved: [] });
});

test('multiline replacement compares normalized previews with CRLF files and undo preserves their EOL', async () => {
	const original = '中文😀 first\r\nsecond tail\r\n';
	using fixture = new BulkEditTestServices([[resource, original]]);
	const matches = results('中文😀 first\nsecond tail', [{ start: 5, end: 17 }]);
	const applied = await new ReplaceService(fixture.models, fixture.service, fixture.workingCopies).replace(
		matches.files[0]!.matches,
		{ ...query, text: 'first\nsecond', patternKind: 'literal' },
		'value',
		options,
	);
	assert.equal(applied.isApplied, true);
	assert.equal(fixture.store.text(resource), '中文😀 value tail\r\n');
	if (applied.isApplied) { await applied.undo(); }
	assert.equal(fixture.store.text(resource), original);
});

test('replacement preview applies only accepted occurrences and cancellation leaves files unchanged', async () => {
	using fixture = new BulkEditTestServices([[resource, 'needle needle']]);
	const result = results('needle needle', [{ start: 0, end: 6 }, { start: 7, end: 13 }]);
	const replace = new ReplaceService(fixture.models, fixture.service, fixture.workingCopies);
	using preview = fixture.service.setPreviewHandler(async edits => [edits[1]!]);
	const applied = await replace.replace(result.files[0]!.matches, query, 'value', { ...options, preview: true });
	assert.deepEqual({ applied: applied.isApplied, text: fixture.store.text(resource) }, { applied: true, text: 'needle value' });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(replace.replace(result.files[0]!.matches, query, 'other', { ...options, signal: controller.signal }), { name: 'CancellationError' });
	assert.equal(fixture.store.text(resource), 'needle value');
});

test('multiline regex captures support both disk and normalized browser previews', async () => {
	for (const preview of ['first\r\nsecond', 'first\nsecond']) {
		using fixture = new BulkEditTestServices([[resource, 'first\r\nsecond\r\n']]);
		const matches = results(preview, [{ start: 0, end: preview.length }]);
		const applied = await new ReplaceService(fixture.models, fixture.service, fixture.workingCopies).replace(
			matches.files[0]!.matches,
			{ ...query, text: '(first)\n(second)' },
			'$2 $1',
			options,
		);
		assert.equal(applied.isApplied, true);
		assert.equal(fixture.store.text(resource), 'second first\r\n');
	}
});

test('literal replacement preserves dollar tokens and optionally preserves matched letter case', async () => {
	using fixture = new BulkEditTestServices([[resource, 'NEEDLE']]);
	const result = results('NEEDLE', [{ start: 0, end: 6 }]);
	await new ReplaceService(fixture.models, fixture.service, fixture.workingCopies).replace(result.files[0]!.matches, { ...query, text: 'needle', patternKind: 'literal' }, '$1 value', { ...options, preserveCase: true });
	assert.equal(fixture.store.text(resource), '$1 VALUE');
});

test('replacement retains an open dirty model on save failure and undo saves its restored text', async () => {
	using fixture = new BulkEditTestServices([[resource, 'needle']]);
	using reference = await fixture.models.acquire({ resource }, options.signal);
	using registration = fixture.workingCopies.register({
		resource, backupKind: 'text',
		get isDirty() { return reference.isDirty; },
		get hasExternalChange() { return reference.hasExternalChange; },
		onDidChangeDirty: reference.onDidChangeDirty, onDidChangeExternalChange: reference.onDidChangeExternalChange,
		onDidChangeContent: Event.None,
		backup: () => reference.model.getText(), restoreBackup: text => reference.model.setValue(text),
		save: signal => reference.save(signal), revert: signal => reference.revert(signal),
		saveAs: async () => { throw new Error('This test saves the existing file'); },
		dispose() { }, [Symbol.dispose]() { },
	});
	fixture.store.failNextSave = new Error('Saving failed');
	const matches = results('needle', [{ start: 0, end: 6 }]);
	const applied = await new ReplaceService(fixture.models, fixture.service, fixture.workingCopies).replace(matches.files[0]!.matches, query, 'value', options);
	assert.equal(applied.isApplied, true);
	assert.deepEqual({ errors: applied.saveErrors, model: reference.model.getText(), disk: fixture.store.text(resource), dirty: reference.isDirty }, { errors: ['Saving failed'], model: 'value', disk: 'needle', dirty: true });
	if (applied.isApplied) { await applied.undo(); }
	assert.deepEqual({ model: reference.model.getText(), disk: fixture.store.text(resource), dirty: reference.isDirty }, { model: 'needle', disk: 'needle', dirty: false });
});

test('untitled replacement and undo keep the draft dirty without saving or requesting Save As', async () => {
	const draft = URI.parse('untitled:/Untitled-1');
	using fixture = new BulkEditTestServices([]);
	using reference = await fixture.models.acquire({ resource: draft, initialText: 'needle' }, options.signal);
	using registration = fixture.workingCopies.register({
		resource: draft, backupKind: 'text',
		dispose() { }, [Symbol.dispose]() { },
		get isDirty() { return reference.isDirty; },
		get hasExternalChange() { return reference.hasExternalChange; },
		onDidChangeDirty: reference.onDidChangeDirty, onDidChangeExternalChange: reference.onDidChangeExternalChange,
		onDidChangeContent: Event.None,
		backup: () => reference.model.getText(), restoreBackup: text => reference.model.setValue(text),
		save: async () => { assert.fail('search cannot choose a draft destination'); },
		revert: signal => reference.revert(signal), saveAs: async () => { assert.fail('search cannot request Save As'); },
	});
	const result = new SearchResultImpl([]);
	const range = { startLineNumber: 0, startColumn: 0, endLineNumber: 0, endColumn: 6 };
	result.addFileMatch({ resource: draft, results: [{ previewText: 'needle', rangeLocations: [{ source: range, preview: range }] }] });
	const applied = await new ReplaceService(fixture.models, fixture.service, fixture.workingCopies).replace(result.files[0]!.matches, query, 'value', options);
	assert.deepEqual({ applied: applied.isApplied, text: reference.model.getText(), dirty: reference.isDirty, saved: fixture.store.saved, errors: applied.saveErrors }, { applied: true, text: 'value', dirty: true, saved: [], errors: [] });
	if (applied.isApplied) { await applied.undo(); }
	assert.deepEqual({ text: reference.model.getText(), dirty: reference.isDirty, saved: fixture.store.saved }, { text: 'needle', dirty: true, saved: [] });
});
