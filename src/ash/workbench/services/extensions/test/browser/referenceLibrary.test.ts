import '../../../../../editor/test/browser/testEditorDom.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { parseRis, RisParseError } from '../../../../../../../extensions/reference-manager/common/ris.js';
import { createLibraryEntry, emptyLibrary, importRecords, parseLibrary, replaceEntry, serializeLibrary } from '../../../../../../../extensions/reference-manager/common/library.js';
import { runLibraryCitationOperation } from '../../../../../../../extensions/academic/browser/contrib/citation/common/libraryCitationApi.js';
import { createAcademicDocumentSchema, createEmptyAcademicDocument } from '../../../../../../../extensions/academic/browser/contrib/academic/common/schema.js';
import { DocumentTextModel } from '../../../../../../../extensions/academic/common/model/documentTextModel.js';
import { textSelection } from '../../../../../../../extensions/academic/common/core/documentSelection.js';
import { buildReferenceIndex } from '../../../../../../../extensions/academic/browser/contrib/citation/common/references.js';
import { findDocumentNode } from '../../../../../../../extensions/academic/common/model/document.js';
import { ReferenceLibraryWorkingCopy } from '../../../../../../../extensions/reference-manager/browser/referenceLibraryWorkingCopy.js';
import { createTestEditorServices, createTestFileService } from '../../../../test/common/testEditorServices.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IWorkingCopyService } from '../../../workingCopy/common/workingCopyService.js';

import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { URI } from '../../../../../base/common/uri.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

const ris = 'TY  - JOUR\nTI  - A paper\nAU  - Smith, Jane\nPY  - 2024\nDO  - https://doi.org/10.1234/ABC\nER  -\n';
test('RIS parses record boundaries, Unicode, aliases, continuations and repeated/unknown fields', () => {
	const records = parseRis('\uFEFFTY  - JOUR\r\nT1  - 中文论文\r\nA1  - 王, 明\r\nAU  - Smith, Jane\r\nY1  - 2024/01/01\r\nN2  - First\r\n  second\r\nKW  - a\r\nKW  - b\r\nZZ  - retained\r\nER  -\r\n');
	assert.equal(records[0].title, '中文论文'); assert.deepEqual(records[0].authors, ['王, 明', 'Smith, Jane']);
	assert.equal(records[0].year, '2024'); assert.match(records[0].abstract, /First.*second/s); assert.deepEqual(records[0].keywords, ['a', 'b']);
	assert.ok(records[0].fields.some(field => field.tag === 'ZZ' && field.value === 'retained')); assert.ok(Object.isFrozen(records[0]));
	for (const value of ['', 'TI  - outside\n', 'TY  - JOUR\n', 'TY  - JOUR\nTY  - BOOK\nER  -\n', 'TY  - JOUR\ngarbage\nER  -\n']) assert.throws(() => parseRis(value), RisParseError);
	assert.equal(parseRis('TY  - GEN\nER  -\n')[0].title, '');
});
test('RIS import deduplicates DOI and metadata, preserves IDs and rejects malformed library persistence', () => {
	const first = importRecords(emptyLibrary(), parseRis(ris)); const id = first.library.entries[0].id;
	assert.equal(first.added, 1); assert.equal(first.library.entries[0].doi, '10.1234/abc');
	const repeated = importRecords(first.library, parseRis(ris.replace('https://doi.org/10.1234/ABC', 'doi:10.1234/abc')));
	assert.equal(repeated.added, 0); assert.equal(repeated.duplicates, 1); assert.equal(repeated.library.entries[0].id, id);
	const loaded = parseLibrary(serializeLibrary(first.library)); assert.equal(loaded.entries[0].id, id);
	assert.throws(() => parseLibrary('{"version":2}')); assert.throws(() => parseLibrary(JSON.stringify({ ...loaded, entries: [...loaded.entries, loaded.entries[0]] })));
});
test('Academy insertion, identity-based metadata/key update and missing records use one undo each', () => {
	const schema = createAcademicDocumentSchema(); using model = DocumentTextModel.create(schema, createEmptyAcademicDocument(schema));
	const paragraph = model.document.content.find(node => node.type === 'abstract')!.content[0];
	const selection = textSelection({ nodeId: paragraph.id, offset: 0 });
	const context = () => ({ model, blockId: paragraph.id, selection });
	const request = { version: 1, operation: 'insert', libraryId: 'library-1', references: [{ id: 'entry-1', key: 'Smith2024', text: 'Smith (2024). Original.' }] };
	const original = model.document;
	const inserted = runLibraryCitationOperation(context(), request); model.dispatch(inserted.command!.transaction);
	let index = buildReferenceIndex(model.document); assert.equal(index.citations.length, 1); assert.equal(index.references.length, 1);
	assert.equal(findDocumentNode(model.document, index.references[0].nodeId)!.node.attrs.libraryEntryId, 'entry-1');
	assert.ok(model.undoBlocks()); assert.deepEqual(model.document, original); assert.ok(model.redoBlocks());
	const previous = model.document;
	const updated = runLibraryCitationOperation(context(), { ...request, operation: 'update', references: [{ id: 'entry-1', key: 'Renamed2025', text: 'Corrected metadata.' }] }); model.dispatch(updated.command!.transaction);
	index = buildReferenceIndex(model.document); assert.equal(index.references[0].key, 'Renamed2025'); assert.equal(index.references[0].text, 'Corrected metadata.'); assert.equal(index.citations[0].key, 'Renamed2025');
	assert.ok(model.undoBlocks()); assert.deepEqual(model.document, previous);
	assert.deepEqual(runLibraryCitationOperation(context(), { ...request, operation: 'update', references: [] }).result.missing, ['Smith2024']);
	assert.throws(() => runLibraryCitationOperation(context(), { ...request, references: [{ id: 'other', key: 'Smith2024', text: 'Clobber' }] }));
	assert.deepEqual(model.document, previous);
});

test('RIS conversion saves a separate library, reindexes working copies and never overwrites the RIS source', async () => {
	using memory = new InMemoryFileSystemProvider(); using files = createTestFileService(memory);
	await memory.createDirectory(URI.file('/library')); const source = URI.file('/library/source.ris'); const target = URI.file('/library/saved.ash-library');
	await memory.writeFile(source, new TextEncoder().encode(ris), { create: true, overwrite: false });
	using parent = new InstantiationService(); parent.registerInstance(IFileService, files); parent.registerInstance(IFileDialogService, {} as IFileDialogService);
	using services = createTestEditorServices(undefined, parent);
	const controller = new AbortController(); const copy = services.createInstance(ReferenceLibraryWorkingCopy, { resource: source }, controller.signal); using retained = copy.retain();
	await copy.ready; assert.equal(copy.isDirty, true); assert.equal(copy.library.entries.length, 1);
	const id = copy.library.entries[0].id; await copy.saveAs(target, new AbortController().signal);
	assert.equal(copy.isDirty, false); assert.equal(services.get(IWorkingCopyService).get(source).length, 0); assert.equal(services.get(IWorkingCopyService).get(target).length, 1);
	assert.equal(new TextDecoder().decode((await memory.readFile(source)).bytes), ris);
	assert.equal(parseLibrary(new TextDecoder().decode((await memory.readFile(target)).bytes)).entries[0].id, id);
	copy.replace(replaceEntry(copy.library, { ...copy.library.entries[0], title: 'Unsaved draft' })); const backup = copy.backup();
	controller.abort(); await assert.rejects(copy.save(new AbortController().signal), /read-only|unavailable/); assert.equal(copy.backup(), backup);
});

test('Academy batch key swaps remain atomic and preserve custom citation labels', () => {
	const schema = createAcademicDocumentSchema();
	const paragraph = schema.createNode('paragraph', { content: [schema.createText('Body'), schema.createNode('citation', { attrs: { key: 'A', label: 'Custom label' } }), schema.createNode('citation', { attrs: { key: 'B' } })] });
	const bibliography = schema.createNode('bibliography', { content: ['A', 'B'].map((key, index) => schema.createNode('reference', { attrs: { key, libraryId: 'library', libraryEntryId: String(index) }, content: [schema.createNode('paragraph', { content: [schema.createText(key)] })] })) });
	using model = DocumentTextModel.create(schema, schema.createDocument([bibliography, paragraph]));
	const before = model.document;
	const context = { model, blockId: paragraph.id, selection: undefined };
	const request = { version: 1, operation: 'update', libraryId: 'library', references: [{ id: '0', key: 'B', text: 'Updated A' }, { id: '1', key: 'A', text: 'Updated B' }] };
	const prepared = runLibraryCitationOperation(context, request); assert.deepEqual(model.document, before);
	model.dispatch(prepared.command!.transaction);
	const index = buildReferenceIndex(model.document); assert.deepEqual(index.references.map(value => value.key), ['B', 'A']);
	assert.deepEqual(index.citations.map(value => value.key), ['B', 'A']);
	assert.equal(findDocumentNode(model.document, index.citations[0].nodeId)!.node.attrs.label, 'Custom label');
	assert.equal(prepared.result.changed, 2); assert.ok(model.undoBlocks()); assert.deepEqual(model.document, before);
	assert.throws(() => runLibraryCitationOperation(context, { ...request, references: [...request.references, { id: '2', key: 'B', text: '' }] }));
	assert.deepEqual(model.document, before);
});

test('library conflicts preserve dirty data and backups; a reload explicitly adopts the persisted version', async () => {
	using memory = new InMemoryFileSystemProvider(); using files = createTestFileService(memory);
	await memory.createDirectory(URI.file('/library')); const source = URI.file('/library/a.ash-library'); const original = emptyLibrary();
	await files.writeFile({ resource: source, content: serializeLibrary(original) });
	using parent = new InstantiationService(); parent.registerInstance(IFileService, files); parent.registerInstance(IFileDialogService, {} as IFileDialogService);
	using services = createTestEditorServices(undefined, parent);
	const copy = services.createInstance(ReferenceLibraryWorkingCopy, { resource: source }, new AbortController().signal); using retained = copy.retain(true); await copy.ready;
	assert.equal(copy.readOnly, true); assert.throws(() => copy.replace(replaceEntry(copy.library, createLibraryEntry())));
	using writer = copy.retain(); assert.equal(copy.readOnly, false);
	copy.replace(replaceEntry(copy.library, createLibraryEntry())); const backup = copy.backup();
	await files.writeFile({ resource: source, content: serializeLibrary({ ...original, entries: [{ ...createLibraryEntry(), title: 'Other window' }] }) });
	await assert.rejects(copy.save(new AbortController().signal)); assert.equal(copy.isDirty, true); assert.equal(copy.hasExternalChange, true); assert.equal(copy.backup(), backup);
	assert.throws(() => copy.restoreBackup('{')); assert.equal(copy.backup(), backup);
	await copy.revert(new AbortController().signal); assert.equal(copy.library.entries[0].title, 'Other window'); assert.equal(copy.isDirty, false);
	writer.dispose(); assert.equal(copy.readOnly, true); await assert.rejects(copy.save(new AbortController().signal));
});

test('concurrent Save As requests serialize snapshots and retain the final destination revision', async () => {
	using memory = new InMemoryFileSystemProvider(); using files = createTestFileService(memory);
	await memory.createDirectory(URI.file('/library'));
	const first = URI.file('/library/first.ash-library'); const second = URI.file('/library/second.ash-library');
	const started = new DeferredPromise<void>(); const release = new DeferredPromise<void>();
	const guarded = new Proxy(files, {
		get(target, key) {
			if (key === 'writeFile') return async (...args: Parameters<IFileService['writeFile']>) => { if (args[0].resource.toString() === first.toString()) { void started.complete(); await release.p; } return target.writeFile(...args); };
			const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	using parent = new InstantiationService(); parent.registerInstance(IFileService, guarded); parent.registerInstance(IFileDialogService, {} as IFileDialogService);
	using services = createTestEditorServices(undefined, parent);
	const copy = services.createInstance(ReferenceLibraryWorkingCopy, { resource: URI.parse('untitled:library.ash-library') }, new AbortController().signal); using retained = copy.retain(); await copy.ready;
	const signal = new AbortController().signal;
	const writingFirst = copy.saveAs(first, signal); await started.p;
	copy.replace(replaceEntry(copy.library, { ...createLibraryEntry(), title: 'Added during first save' }));
	const writingSecond = copy.saveAs(second, signal);
	try { await assert.rejects(files.readFile(second)); }
	finally { await release.complete(); await Promise.all([writingFirst, writingSecond]); }
	assert.equal(parseLibrary((await files.readFile(first)).content).entries.length, 0);
	assert.equal(parseLibrary((await files.readFile(second)).content).entries[0].title, 'Added during first save');
	copy.replace(replaceEntry(copy.library, { ...copy.library.entries[0], title: 'Saved to final destination' })); await copy.save(signal);
	assert.equal(parseLibrary((await files.readFile(second)).content).entries[0].title, 'Saved to final destination'); assert.equal(copy.isDirty, false);
});
