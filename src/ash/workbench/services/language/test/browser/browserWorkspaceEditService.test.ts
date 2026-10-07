import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { TestDialogService } from '../../../../contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { MemoryResourceStore, MemoryFileService } from '../../../../contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { isCancellationError } from "../../../../../base/common/errors.js";
import { Event } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { BrowserTextModelService } from "../../../textmodelResolver/browser/browserTextModelService.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { type TextResourceChangeEvent, type TextResourceContent, type TextResourceResolveRequest, type TextResourceSaveRequest, type ITextResourceStore } from "../../../textmodelResolver/common/textResourceStore.js";
import { BrowserWorkingCopyService } from "../../../workingCopy/browser/browserWorkingCopyService.js";
import { type IWorkingCopy } from "../../../workingCopy/common/workingCopyService.js";
import { BulkEditService } from '../../../../contrib/bulkEdit/browser/bulkEditService.js';
import { ResourceTextEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { FileKind, FileNotFoundError, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileService } from "../../../../../platform/files/common/files.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

test("workspace edits preflight every document before mutating and persist closed resources", async () => {
	const first = URI.file("C:\\project\\first.ts");
	const second = URI.file("C:\\project\\second.ts");
	using store = new MemoryResourceStore([[first, "alpha"], [second, "bravo"]]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	const files = new MemoryFileService([[first, "alpha"], [second, "bravo"]]);
	using service = new BulkEditService(models, workingCopies, files, configuration, dialogs);

	await service.apply({
		entries: [
			{ kind: "textDocument", resource: first, edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)), text: "one" }] },
			{ kind: "textDocument", resource: second, edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)), text: "two" }] },
		]
	});

	assert.equal(store.text(first), "one");
	assert.equal(store.text(second), "two");
	assert.deepEqual(store.saved, [first.toString(), second.toString()]);
});

test("workspace edit undo restores multiple closed documents", async () => {
	const first = URI.file('C:\\project\\first.ts');
	const second = URI.file('C:\\project\\second.ts');
	using store = new MemoryResourceStore([[first, 'alpha'], [second, 'bravo']]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	using service = new BulkEditService(models, workingCopies, new MemoryFileService([[first, 'alpha'], [second, 'bravo']]), configuration, dialogs);

	const applied = await service.apply({
		entries: [
			{ kind: 'textDocument', resource: first, edits: [{ range: new Range(1, 1, 1, 6), text: 'one' }] },
			{ kind: 'textDocument', resource: second, edits: [{ range: new Range(1, 1, 1, 6), text: 'two' }] },
		]
	});
	assert.ok(applied.isApplied);
	await applied.undo();
	assert.deepEqual([store.text(first), store.text(second)], ['alpha', 'bravo']);
});

test('approved bulk edits still reject a document that changed during preview', async () => {
	const resource = URI.file('/workspace/stale.ts');
	using store = new MemoryResourceStore([[resource, 'original']]);
	using models = new BrowserTextModelService(store);
	using reference = await models.acquire({ resource }, new AbortController().signal);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();

	using bulkEdits = new BulkEditService(models, workingCopies, new MemoryFileService([[resource, 'original']]), configuration, dialogs);
	using handler = bulkEdits.setPreviewHandler(async edits => {
		reference.model.setValue('changed');
		return edits;
	});
	await assert.rejects(bulkEdits.apply({ entries: [{ kind: 'textDocument', resource, expectedText: 'original', edits: [{ range: new Range(1, 1, 1, 9), text: 'replacement' }] }] }, { showPreview: true }), /stale/);
	assert.deepEqual({ text: reference.model.getText(), saved: store.saved }, { text: 'changed', saved: [] });
});

test('bulk edit progress follows the committed operations and undo restores their real contents', async () => {
	const first = URI.file('/workspace/first.ts');
	const second = URI.file('/workspace/second.ts');
	using store = new MemoryResourceStore([[first, 'a'], [second, 'b']]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();

	using bulkEdits = new BulkEditService(models, workingCopies, new MemoryFileService([[first, 'a'], [second, 'b']]), configuration, dialogs);
	const progress: unknown[] = [];
	const applied = await bulkEdits.apply({
		entries: [
			{ kind: 'textDocument', resource: first, edits: [{ range: new Range(1, 1, 1, 2), text: 'A' }] },
			{ kind: 'textDocument', resource: second, edits: [{ range: new Range(1, 1, 1, 2), text: 'B' }] },
		]
	}, { progress: { report: update => progress.push(update) } });
	assert.deepEqual({ progress, text: [store.text(first), store.text(second)] }, { progress: [{ total: 2, increment: 0 }, { increment: 1 }, { increment: 1 }], text: ['A', 'B'] });
	if (!applied.isApplied) throw new Error('Expected the transaction to apply');
	assert.ok(applied.isApplied);
	await applied.undo();
	assert.deepEqual([store.text(first), store.text(second)], ['a', 'b']);
});

test('bulk edits with unchanged text and ignored file operations report no applied changes', async () => {
	const resource = URI.file('/workspace/unchanged.ts');
	const missing = URI.file('/workspace/missing.ts');
	using store = new MemoryResourceStore([[resource, 'original']]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	const files = new MemoryFileService([[resource, 'original']]);

	using bulkEdits = new BulkEditService(models, workingCopies, files, configuration, dialogs);
	const progress: unknown[] = [];
	const result = await bulkEdits.apply({
		entries: [
			{ kind: 'textDocument', resource, edits: [{ range: new Range(1, 1, 1, 9), text: 'original' }] },
			{ kind: 'create', resource, existing: 'ignore' },
			{ kind: 'delete', resource: missing, missing: 'ignore', mode: 'fileOrEmptyDirectory' },
		]
	}, { progress: { report: update => progress.push(update) } });
	assert.deepEqual({ applied: result.isApplied, saved: store.saved, text: files.text(resource), missing: files.has(missing), progress }, {
		applied: false, saved: [], text: 'original', missing: false, progress: [{ total: 0, increment: 0 }],
	});
});

test('bulk text edits against one resource use the original coordinate space', async () => {
	const resource = URI.file('C:\\project\\one.ts');
	using store = new MemoryResourceStore([[resource, 'abc def']]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();

	using bulkEdits = new BulkEditService(models, workingCopies, new MemoryFileService([[resource, 'abc def']]), configuration, dialogs);

	const result = await bulkEdits.apply([
		new ResourceTextEdit(resource, { range: new Range(1, 1, 1, 4), text: 'longword' }),
		new ResourceTextEdit(resource, { range: new Range(1, 5, 1, 8), text: 'XYZ' }),
	]);
	assert.equal(store.text(resource), 'longword XYZ');
	if (!result.isApplied) throw new Error('Expected the bulk edit to apply');
	assert.ok(result.isApplied);
	await result.undo();
	assert.equal(store.text(resource), 'abc def');
});

test('bulk language workspace edits preserve explicitly ordered document operations', async () => {
	const resource = URI.file('C:\\project\\one.ts');
	using store = new MemoryResourceStore([[resource, 'abc def']]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();

	using bulkEdits = new BulkEditService(models, workingCopies, new MemoryFileService([[resource, 'abc def']]), configuration, dialogs);

	const result = await bulkEdits.apply({
		entries: [
			{ kind: 'textDocument', resource, edits: [{ range: new Range(1, 1, 1, 4), text: 'longword' }] },
			{ kind: 'textDocument', resource, edits: [{ range: new Range(1, 10, 1, 13), text: 'XYZ' }] },
		]
	});
	assert.equal(store.text(resource), 'longword XYZ');
	if (!result.isApplied) throw new Error('Expected the bulk edit to apply');
	await result.undo();
	assert.equal(store.text(resource), 'abc def');
});

test("workspace edit undo reverses a created file and its inserted text", async () => {
	const resource = URI.file('C:\\project\\new.ts');
	using store = new MemoryResourceStore([]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	const files = new MemoryFileService([]);
	using service = new BulkEditService(models, workingCopies, files, configuration, dialogs);

	const applied = await service.apply({
		entries: [
			{ kind: 'create', resource, existing: 'error' },
			{ kind: 'textDocument', resource, edits: [{ range: new Range(1, 1, 1, 1), text: 'ready' }] },
		]
	});
	assert.ok(applied.isApplied);
	await applied.undo();
	assert.equal(files.has(resource), false);
});

test('workspace edit undo restores file creation, rename, and deletion together', async () => {
	const created = URI.file('C:\\project\\created.ts');
	const source = URI.file('C:\\project\\source.ts');
	const renamed = URI.file('C:\\project\\renamed.ts');
	const deleted = URI.file('C:\\project\\deleted.ts');
	using store = new MemoryResourceStore([]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	const files = new MemoryFileService([[source, 'source'], [deleted, 'deleted']]);
	using service = new BulkEditService(models, workingCopies, files, configuration, dialogs);

	const applied = await service.apply({
		entries: [
			{ kind: 'create', resource: created, existing: 'error' },
			{ kind: 'rename', source, target: renamed, existing: 'error' },
			{ kind: 'delete', resource: deleted, missing: 'error', mode: 'fileOrEmptyDirectory' },
		]
	});
	assert.ok(applied.isApplied);
	await applied.undo();
	assert.deepEqual({
		created: files.has(created),
		source: files.text(source),
		renamed: files.has(renamed),
		deleted: files.text(deleted),
	}, { created: false, source: 'source', renamed: false, deleted: 'deleted' });
});

test('workspace edit undo leaves all resources intact when another target changed', async () => {
	const first = URI.file('C:\\project\\first.ts');
	const second = URI.file('C:\\project\\second.ts');
	using store = new MemoryResourceStore([[first, 'alpha'], [second, 'bravo']]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	using service = new BulkEditService(models, workingCopies, new MemoryFileService([[first, 'alpha'], [second, 'bravo']]), configuration, dialogs);
	const secondReference = await models.acquire({ resource: second }, new AbortController().signal);

	const applied = await service.apply({
		entries: [
			{ kind: 'textDocument', resource: first, edits: [{ range: new Range(1, 1, 1, 6), text: 'one' }] },
			{ kind: 'textDocument', resource: second, edits: [{ range: new Range(1, 1, 1, 6), text: 'two' }] },
		]
	});
	secondReference.model.applyOperations([{ range: new Range(1, 4, 1, 4), text: '!' }]);
	assert.ok(applied.isApplied);
	await assert.rejects(applied.undo(), /changed before replacement/);
	assert.deepEqual([store.text(first), secondReference.model.getText()], ['one', 'two!']);
	secondReference.dispose();
});

test("workspace edits keep open working copies dirty instead of saving behind the editor", async () => {
	const resource = URI.file("C:\\project\\open.ts");
	using store = new MemoryResourceStore([[resource, "alpha"]]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	using service = new BulkEditService(models, workingCopies, new MemoryFileService([[resource, "alpha"]]), configuration, dialogs);
	const reference = await models.acquire({ resource }, new AbortController().signal);
	const registration = workingCopies.register(workingCopy(reference));

	await service.apply({ entries: [{ kind: "textDocument", resource, version: reference.model.version, edits: [{ range: Range.fromPositions(new Position((0) + 1, (5) + 1)), text: "!" }] }] });

	assert.equal(reference.model.getText(), "alpha!");
	assert.equal(reference.isDirty, true);
	assert.deepEqual(store.saved, []);
	registration.dispose();
	reference.dispose();
});

test("workspace edit preflight rejects stale or invalid edits without changing any document", async () => {
	const first = URI.file("C:\\project\\first.ts");
	const second = URI.file("C:\\project\\second.ts");
	using store = new MemoryResourceStore([[first, "alpha"], [second, "bravo"]]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	using service = new BulkEditService(models, workingCopies, new MemoryFileService([[first, "alpha"], [second, "bravo"]]), configuration, dialogs);
	const reference = await models.acquire({ resource: first }, new AbortController().signal);

	await assert.rejects(service.apply({
		entries: [
			{ kind: "textDocument", resource: first, version: reference.model.version, edits: [{ range: Range.fromPositions(new Position((0) + 1, (5) + 1)), text: "!" }] },
			{ kind: "textDocument", resource: second, edits: [{ range: Range.fromPositions(new Position((4) + 1, (0) + 1)), text: "invalid" }] },
		]
	}), /outside|line/i);

	assert.equal(reference.model.getText(), "alpha");
	assert.equal(store.text(second), "bravo");
	assert.deepEqual(store.saved, []);
	reference.dispose();
});

test("workspace edit preflight rejects a changed target content baseline atomically", async () => {
	const first = URI.file("C:\\workspace\\first.ts");
	const second = URI.file("C:\\workspace\\second.ts");
	using store = new MemoryResourceStore([[first, "first"], [second, "changed"]]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	using service = new BulkEditService(models, workingCopies, new MemoryFileService([[first, "first"], [second, "changed"]]), configuration, dialogs);

	await assert.rejects(service.apply({
		entries: [
			{ kind: "textDocument", resource: first, expectedText: "first", edits: [{ range: Range.fromPositions(new Position((0) + 1, (5) + 1)), text: "!" }] },
			{ kind: "textDocument", resource: second, expectedText: "second", edits: [{ range: Range.fromPositions(new Position((0) + 1, (6) + 1)), text: "!" }] },
		]
	}), /content.*stale/);
	assert.equal(store.text(first), "first");
	assert.equal(store.text(second), "changed");
});

test("workspace edit applies create then text edit in protocol order", async () => {
	const created = URI.file("C:\\workspace\\created.ts");
	using store = new MemoryResourceStore([]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	const files = new MemoryFileService([]);
	using service = new BulkEditService(models, workingCopies, files, configuration, dialogs);

	await service.apply({
		entries: [
			{ kind: "create", resource: created, existing: "error" },
			{ kind: "textDocument", resource: created, expectedText: "", edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "export const ready = true;" }] },
		]
	});

	assert.equal(files.has(created), true);
	assert.equal(store.text(created), "export const ready = true;");
});

test("workspace edit rolls back created resources when a later operation fails", async () => {
	const created = URI.file("C:\\workspace\\created.ts");
	const target = URI.file("C:\\workspace\\target.ts");
	using store = new MemoryResourceStore([]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	const files = new MemoryFileService([[target, "occupied"]]);
	files.failRename = true;
	using service = new BulkEditService(models, workingCopies, files, configuration, dialogs);

	await assert.rejects(service.apply({
		entries: [
			{ kind: "create", resource: created, existing: "error" },
			{ kind: "rename", source: created, target: URI.file("C:\\workspace\\moved.ts"), existing: "error" },
		]
	}), /injected rename failure/);

	assert.equal(files.has(created), false);
	assert.equal(files.text(target), "occupied");
});

test("workspace edits classify caller cancellation before mutating resources", async () => {
	const created = URI.file("C:\\workspace\\cancelled.ts");
	using store = new MemoryResourceStore([]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	const files = new MemoryFileService([]);
	using service = new BulkEditService(models, workingCopies, files, configuration, dialogs);
	const controller = new AbortController();
	controller.abort("superseded");

	await assert.rejects(service.apply({
		entries: [
			{ kind: "create", resource: created, existing: "error" },
		]
	}, { token: controller.signal }), error => isCancellationError(error) && error.reason === "superseded");

	assert.equal(files.has(created), false);
});

function workingCopy(reference: Awaited<ReturnType<BrowserTextModelService["acquire"]>>): IWorkingCopy {
	return {
		resource: reference.resource,
		backupKind: "text",
		get isDirty() { return reference.isDirty; },
		get hasExternalChange() { return reference.hasExternalChange; },
		onDidChangeDirty: reference.onDidChangeDirty,
		onDidChangeExternalChange: reference.onDidChangeExternalChange,
		onDidChangeContent: listener => reference.model.onDidChangeContent(() => listener()),
		backup: () => reference.model.getText(),
		restoreBackup: content => reference.model.reset(content),
		save: signal => reference.save(signal),
		saveAs: async () => { },
		revert: signal => reference.revert(signal),
		dispose() { },
		[Symbol.dispose]() { },
	};
}


test("workspace edit content checks accept the current CRLF document and preserve its EOL", async () => {
	const resource = URI.file("C:\\project\\crlf.ts");
	using store = new MemoryResourceStore([[resource, "alpha\r\nbravo"]]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	using service = new BulkEditService(models, workingCopies, new MemoryFileService([[resource, "alpha\r\nbravo"]]), configuration, dialogs);
	const result = await service.apply({
		entries: [{
			kind: "textDocument", resource, expectedText: "alpha\r\nbravo",
			edits: [{ range: new Range(1, 1, 1, 6), text: "updated" }],
		}]
	});
	assert.equal(store.text(resource), "updated\r\nbravo");
	assert.ok(result.isApplied);
	await result.undo();
	assert.equal(store.text(resource), "alpha\r\nbravo");
});

test("workspace edits recheck model versions after asynchronous file operations", async () => {
	const resource = URI.file("C:\\project\\version.ts");
	const created = URI.file("C:\\project\\created.ts");
	using store = new MemoryResourceStore([[resource, "original"]]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using configuration = new InMemoryConfigurationService();
	const dialogs = new TestDialogService();
	using reference = await models.acquire({ resource }, new AbortController().signal);
	const files = new class extends MemoryFileService {
		override async createFile(...args: Parameters<MemoryFileService['createFile']>) {
			const result = await super.createFile(...args);
			// The user can edit and undo while another resource is being written.
			reference.model.applyOperations([{ range: new Range(1, 1, 1, 1), text: "user " }]);
			reference.model.undo();
			return result;
		}
	}([[resource, "original"]]);
	using service = new BulkEditService(models, workingCopies, files, configuration, dialogs);
	await assert.rejects(service.apply({
		entries: [
			{ kind: "create", resource: created, existing: "error" },
			{ kind: "textDocument", resource, version: reference.model.version, edits: [{ range: new Range(1, 1, 1, 9), text: "agent" }] },
		]
	}), /stale/);
	assert.deepEqual({ text: reference.model.getText(), created: files.has(created) }, { text: "original", created: false });
});
