import assert from "node:assert/strict";
import { test } from "mocha";
import { type DiffComputationRequest, type IDiffComputationService } from "../../../../common/diff/diffComputationService.js";
import { DiffModel } from "../../../../common/diff/diffModel.js";
import { LineDiffKind, type LineDiff } from "../../../../common/diff/lineDiff.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";

test("DiffModel publishes only version-pinned computation results", async () => {
	using original = new TextModel("before");
	using modified = new TextModel("after");
	using computationService = new ControlledDiffComputationService();
	using model = new DiffModel({ original, modified, computationService });

	assert.equal(model.state.kind, "loading");
	const first = computationService.takeRequest();
	original.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (6) + 1)),
		text: "current",
	}]);
	const second = computationService.takeRequest();
	assert.equal(first.signal.aborted, true);
	first.resolve(createModifiedDiff());
	await Promise.resolve();
	assert.equal(model.state.kind, "loading");

	second.resolve(createModifiedDiff());
	await waitForReady(model);
	const readyState = model.state;
	assert.equal(readyState.kind, "ready");
	if (readyState.kind !== "ready") throw new Error("Expected a ready diff model");
	assert.equal(readyState.originalVersion, original.version);
	assert.equal(readyState.modifiedVersion, modified.version);
	assert.equal(model.diff?.rows[0]?.kind, "modified");
});

test("DiffModel exposes a computation result without owning its sources", async () => {
	using original = new TextModel("same\nold");
	using modified = new TextModel("same\nnew");
	using computationService = new ResolvedDiffComputationService();
	using model = new DiffModel({ original, modified, computationService });

	await waitForReady(model);

	assert.equal(model.original, original);
	assert.equal(model.modified, modified);
	assert.equal(model.diff?.rows.length, 1);
	model.dispose();
	assert.equal(original.getText(), "same\nold");
	assert.equal(modified.getText(), "same\nnew");
});

interface ControlledRequest {
	readonly request: DiffComputationRequest;
	readonly signal: AbortSignal;
	readonly resolve: (diff: LineDiff) => void;
}

class ControlledDiffComputationService implements IDiffComputationService {
	private readonly requests: ControlledRequest[] = [];

	compute(request: DiffComputationRequest, signal: AbortSignal): Promise<LineDiff> {
		return new Promise(resolve => this.requests.push({ request, signal, resolve }));
	}

	takeRequest(): ControlledRequest {
		const request = this.requests.shift();
		assert.ok(request);
		return request;
	}

	dispose(): void {}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

class ResolvedDiffComputationService implements IDiffComputationService {
	compute(_request: DiffComputationRequest, signal: AbortSignal): Promise<LineDiff> {
		signal.throwIfAborted();
		return Promise.resolve(createModifiedDiff());
	}

	dispose(): void {}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function createModifiedDiff(): LineDiff {
	return Object.freeze({
		rows: Object.freeze([Object.freeze({
			kind: LineDiffKind.Modified,
			originalLineIndex: 0,
			modifiedLineIndex: 0,
			originalChanges: Object.freeze([]),
			modifiedChanges: Object.freeze([]),
		})]),
		hunks: Object.freeze([Object.freeze({
			rowStart: 0,
			rowEnd: 1,
			originalStartLineIndex: 0,
			originalLineCount: 1,
			modifiedStartLineIndex: 0,
			modifiedLineCount: 1,
		})]),
	});
}

function waitForReady(model: DiffModel): Promise<void> {
	if (model.state.kind === "ready") return Promise.resolve();
	return new Promise((resolve, reject) => {
		const listener = model.onDidChange(state => {
			if (state.kind === "loading") return;
			listener.dispose();
			if (state.kind === "error") reject(state.error);
			else resolve();
		});
	});
}
