import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../../../base/common/uri.js";
import { BrowserBulkEditService } from "../../browser/bulkEditService.js";
import { type IWorkspaceEditService, type WorkspaceEditResult } from "../../../../services/language/common/workspaceEditService.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { type LanguageWorkspaceEdit } from "../../../../../editor/common/languages.js";

test("bulk edits apply directly for a single entry", async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BrowserBulkEditService(applier);
	const edit = textEdit("one.ts", "one");

	const result = await service.apply(edit);

	assert.equal(result.isApplied, true);
	assert.equal(applier.calls.length, 1);
	assert.deepEqual(applier.calls[0], edit);
});

test("multi-entry edits fall back to direct apply when preview is unavailable", async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BrowserBulkEditService(applier);
	const first = textEdit("one.ts", "one");
	const second = textEdit("two.ts", "two");

	const result = await service.apply({ entries: [first.entries[0]!, second.entries[0]!] });

	assert.equal(result.isApplied, true);
	assert.equal(applier.calls.length, 1);
});

test("multi-entry edits preview by default and apply the accepted subset", async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BrowserBulkEditService(applier);
	const first = textEdit("one.ts", "one");
	const second = textEdit("two.ts", "two");
	const edit: LanguageWorkspaceEdit = { entries: [...first.entries, ...second.entries] };
	service.setPreviewHandler(async value => [value[1]!]);

	const result = await service.apply(edit);

	assert.equal(result.isApplied, true);
	assert.deepEqual(applier.calls[0]?.entries, [second.entries[0]]);
});

test("cancelling the preview does not mutate through the lower-level applier", async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BrowserBulkEditService(applier);
	service.setPreviewHandler(async () => []);

	const result = await service.apply({ entries: [textEdit("one.ts", "one").entries[0]!, textEdit("two.ts", "two").entries[0]!] });

	assert.equal(result.isApplied, false);
	assert.equal(applier.calls.length, 0);
});

test("a caller can force preview for a single entry", async () => {
	const applier = new RecordingWorkspaceEditService();
	using service = new BrowserBulkEditService(applier);
	let previewed = false;
	service.setPreviewHandler(async value => {
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
		return { resources: Object.freeze([]) };
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
