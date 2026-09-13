import assert from "node:assert/strict";
import { test } from "mocha";
import { AppServerDiffComputationService } from "../../browser/appServerDiffComputationService.js";
import type { IDiffApi } from "../../../../../platform/diff/common/diffApi.js";

test("App Server diff adapter accepts UTF-16 columns for Unicode", async () => {
	let request: { readonly original: string; readonly modified: string } | undefined;
	const api: IDiffApi = {
		compute: async value => {
			request = value;
			return {
				rows: [{
					kind: "modified",
					originalLineIndex: 0,
					modifiedLineIndex: 0,
					originalChanges: [{ startColumn: 7, endColumn: 9 }],
					modifiedChanges: [{ startColumn: 7, endColumn: 9 }],
				}],
				hunks: [{
					rowStart: 0,
					rowEnd: 1,
					originalStartLineIndex: 0,
					originalLineCount: 1,
					modifiedStartLineIndex: 0,
					modifiedLineCount: 1,
				}],
				originalLineCount: 1,
				modifiedLineCount: 1,
			};
		},
	};
	using service = new AppServerDiffComputationService(api);
	const diff = await service.compute({
		original: { version: 1, text: "before 😀 after" },
		modified: { version: 1, text: "before 🤖 after" },
	}, new AbortController().signal);

	assert.equal(request?.original, "before 😀 after\n");
	assert.equal(request?.modified, "before 🤖 after\n");
	assert.deepEqual(diff.rows[0]?.originalChanges, [{ startColumn: 7, endColumn: 9 }]);
	assert.deepEqual(diff.rows[0]?.modifiedChanges, [{ startColumn: 7, endColumn: 9 }]);
	assert.deepEqual(diff.hunks, [{
		rowStart: 0,
		rowEnd: 1,
		originalStartLineIndex: 0,
		originalLineCount: 1,
		modifiedStartLineIndex: 0,
		modifiedLineCount: 1,
	}]);
});

test("App Server diff adapter preserves the editor's trailing empty line", async () => {
	const api: IDiffApi = {
		compute: async () => ({
			rows: [
				{ kind: "context", originalLineIndex: 0, modifiedLineIndex: 0, originalChanges: [], modifiedChanges: [] },
				{ kind: "removed", originalLineIndex: 1, modifiedLineIndex: null, originalChanges: [], modifiedChanges: [] },
			],
			hunks: [],
			originalLineCount: 2,
			modifiedLineCount: 1,
		}),
	};
	using service = new AppServerDiffComputationService(api);
	const diff = await service.compute({
		original: { version: 1, text: "same\n" },
		modified: { version: 1, text: "same" },
	}, new AbortController().signal);

	assert.deepEqual(diff.rows.map(row => [row.kind, row.originalLineIndex, row.modifiedLineIndex]), [
		["unchanged", 0, 0],
		["removed", 1, undefined],
	]);
});
