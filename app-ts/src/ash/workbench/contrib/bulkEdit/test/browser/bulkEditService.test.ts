import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../../../base/common/uri.js";
import { BulkEditService, toLanguageWorkspaceEdit } from "../../browser/bulkEditService.js";
import { ResourceEdit, ResourceTextEdit, ResourceFileEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IWorkspaceEditService } from '../../../../services/language/common/workspaceEditService.js';
import { type WorkspaceEditResult } from "../../../../services/language/common/workspaceEditService.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { type LanguageWorkspaceEdit } from "../../../../../editor/common/languages.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

test("bulk edits apply directly for a single entry", async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BulkEditService(applier);
	const edit = textEdit("one.ts", "one");

	const result = await service.apply(edit);

	assert.equal(result.isApplied, true);
	assert.equal(applier.calls.length, 1);
	assert.deepEqual(applier.calls[0], edit);
});

test("multi-entry edits fall back to direct apply when preview is unavailable", async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BulkEditService(applier);
	const first = textEdit("one.ts", "one");
	const second = textEdit("two.ts", "two");

	const result = await service.apply({ entries: [first.entries[0]!, second.entries[0]!] });

	assert.equal(result.isApplied, true);
	assert.equal(applier.calls.length, 1);
});

test("multi-entry edits preview by default and apply the accepted subset", async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BulkEditService(applier);
	const first = textEdit("one.ts", "one");
	const second = textEdit("two.ts", "two");
	const edit: LanguageWorkspaceEdit = { entries: [...first.entries, ...second.entries] };
	using handler = service.setPreviewHandler(async value => [value[1]!]);

	const result = await service.apply(edit);

	assert.equal(result.isApplied, true);
	assert.deepEqual(applier.calls[0]?.entries, [second.entries[0]]);
});

test("cancelling the preview does not mutate through the lower-level applier", async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BulkEditService(applier);
	using handler = service.setPreviewHandler(async () => []);

	const result = await service.apply({ entries: [textEdit("one.ts", "one").entries[0]!, textEdit("two.ts", "two").entries[0]!] });

	assert.equal(result.isApplied, false);
	assert.equal(applier.calls.length, 0);
});

test("a caller can force preview for a single entry", async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BulkEditService(applier);
	let previewed = false;
	using handler = service.setPreviewHandler(async value => {
		previewed = true;
		return value;
	});

	const result = await service.apply(textEdit("one.ts", "one"), { showPreview: true });

	assert.equal(result.isApplied, true);
	assert.equal(previewed, true);
	assert.equal(applier.calls.length, 1);
});

class RecordingWorkspaceEditService implements IWorkspaceEditService {
	readonly calls: LanguageWorkspaceEdit[] = [];

	async apply(edit: LanguageWorkspaceEdit): Promise<WorkspaceEditResult> {
		this.calls.push(edit);
		return { resources: Object.freeze(edit.entries.map(entry => entry.kind === 'rename' ? entry.target : entry.resource)), undo: async () => {} };
	}
}

function textEdit(name: string, text: string): LanguageWorkspaceEdit {
	return {
		entries: [{
			kind: "textDocument",
			resource: URI.file(`C:\\workspace\\${name}`),
			edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text }],
		}],
	};
}

test('approval commits every resource when its first mutation retires the originating request', async () => {
	const controller = new AbortController();
	const committed: string[] = [];
	using service = new BulkEditService({ apply: async (edit, signal) => {
		for (const entry of edit.entries) {
			if (signal?.aborted) throw new Error('Transaction was cancelled by its own mutation');
			committed.push(entry.kind);
			controller.abort();
		}
		return { resources: [], undo: async () => {} };
	} });
	using handler = service.setPreviewHandler(async edits => edits);
	const first = textEdit('one.ts', 'one');
	const second = textEdit('two.ts', 'two');
	await service.apply({ entries: [...first.entries, ...second.entries] }, { showPreview: true, token: controller.signal });
	assert.deepEqual(committed, ['textDocument', 'textDocument']);
});

test('preview selection retains the source content checks and sequential snapshot boundaries', async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BulkEditService(applier);
	const resource = URI.file('/workspace/one.ts');
	const edit: LanguageWorkspaceEdit = { entries: [
		{ kind: 'textDocument', resource, expectedText: 'a', edits: [{ range: new Range(1, 1, 1, 2), text: 'long' }] },
		{ kind: 'textDocument', resource, expectedText: 'long', edits: [{ range: new Range(1, 5, 1, 5), text: '!' }] },
	] };
	using handler = service.setPreviewHandler(async edits => {
		const preview = await toLanguageWorkspaceEdit(edits);
		assert.deepEqual(preview, edit);
		return ResourceEdit.convert(preview);
	});
	await service.apply(edit, { showPreview: true });
	assert.deepEqual(applier.calls, [edit]);
});

test('disposing replaced preview registrations does not resurrect a released handler', () => {
	using service = new BulkEditService(new RecordingWorkspaceEditService());
	const first = service.setPreviewHandler(async edits => edits);
	const second = service.setPreviewHandler(async edits => edits);
	first.dispose();
	second.dispose();
	assert.equal(service.hasPreviewHandler(), false);
});

test('cancelled requests cannot start a preview', async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BulkEditService(applier);
	using handler = service.setPreviewHandler(async () => { throw new Error('Preview must not run'); });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(service.apply(textEdit('one.ts', 'one'), { showPreview: true, token: controller.signal }), isCancellationError);
	assert.deepEqual(applier.calls, []);
});

test('cancellation while file contents resolve prevents the transaction from starting', async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BulkEditService(applier);
	const controller = new AbortController();
	const contents = Promise.resolve().then(() => { controller.abort(); return VSBuffer.fromString('file'); });
	await assert.rejects(service.apply([new ResourceFileEdit(undefined, URI.file('/workspace/new.ts'), { contents })], { token: controller.signal }), isCancellationError);
	assert.deepEqual(applier.calls, []);
});

test('an edit marked for confirmation previews even when ordinary preview is disabled', async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BulkEditService(applier);
	let previews = 0;
	using handler = service.setPreviewHandler(async edits => { previews++; return edits; });
	await service.apply([new ResourceTextEdit(URI.file('/workspace/one.ts'), { range: new Range(1, 1, 1, 1), text: 'one' }, undefined, { needsConfirmation: true })], { showPreview: false });
	assert.equal(previews, 1);
});

test('bulk edit assembly resolves the workspace transaction through the registered owner', async () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(BulkEditService), /workspaceEditService/);
	const applier = new RecordingWorkspaceEditService();
	services.registerInstance(IWorkspaceEditService, applier);
	using service = services.createInstance(BulkEditService);
	await service.apply(textEdit('one.ts', 'one'));
	assert.equal(applier.calls.length, 1);
});
