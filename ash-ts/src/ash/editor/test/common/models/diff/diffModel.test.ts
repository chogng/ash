import assert from "node:assert/strict";
import { test } from "mocha";
import { type CancellationToken } from "../../../../../base/common/cancellation.js";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from "../../../../common/diff/documentDiffProvider.js";
import { DiffModel } from "../../../../common/diff/diffModel.js";
import { DefaultLinesDiffComputer } from "../../../../common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js";
import { DetailedLineRangeMapping } from "../../../../common/diff/rangeMapping.js";
import { LineRange } from "../../../../common/core/ranges/lineRange.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { type ITextModel } from "../../../../common/model.js";
import { TextModel } from "../../../../common/model/textModel.js";

const diffOptions: IDocumentDiffProviderOptions = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false };

test("DiffModel publishes only version-pinned computation results", async () => {
	using original = new TextModel("before");
	using modified = new TextModel("after");
	using computationService = new ControlledDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider: computationService, diffOptions });

	assert.equal(model.state.kind, "loading");
	const first = computationService.takeRequest();
	original.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (6) + 1)),
		text: "current",
	}]);
	const second = computationService.takeRequest();
	assert.equal(first.token.isCancellationRequested, true);
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
	using model = new DiffModel({ original, modified, diffProvider: computationService, diffOptions });

	await waitForReady(model);

	assert.equal(model.original, original);
	assert.equal(model.modified, modified);
	assert.equal(model.diff?.rows.length, 2);
	assert.equal(model.diff?.rows[0]?.kind, "unchanged");
	assert.equal(model.diff?.rows[1]?.kind, "modified");
	model.dispose();
	assert.equal(original.getText(), "same\nold");
	assert.equal(modified.getText(), "same\nnew");
});

test("DiffModel recomputes on provider changes and cancels when a source is disposed", async () => {
	using original = new TextModel("before");
	using modified = new TextModel("after");
	using diffProvider = new ControlledDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider, diffOptions });

	const first = diffProvider.takeRequest();
	diffProvider.changeSettings();
	const second = diffProvider.takeRequest();
	assert.equal(first.token.isCancellationRequested, true);
	first.resolve(createModifiedDiff());
	second.resolve(createModifiedDiff());
	await waitForReady(model);
	assert.equal(model.state.kind, "ready");

	diffProvider.changeSettings();
	const pending = diffProvider.takeRequest();
	original.dispose();
	assert.equal(pending.token.isCancellationRequested, true);
	assert.equal(model.isDisposed, true);
});

test('DiffModel cancels stale work when computation options change', async () => {
	using original = new TextModel('word');
	using modified = new TextModel('word ');
	using diffProvider = new ControlledDiffComputationService();
	using model = new DiffModel({ original, modified, diffProvider, diffOptions });
	const first = diffProvider.takeRequest();
	model.updateOptions({ ignoreTrimWhitespace: true, maxComputationTimeMs: 0, computeMoves: false });
	const second = diffProvider.takeRequest();
	assert.equal(first.token.isCancellationRequested, true);
	assert.equal(second.options.ignoreTrimWhitespace, true);
	first.resolve(createModifiedDiff());
	await Promise.resolve();
	assert.equal(model.state.kind, 'loading');
	second.resolve({ identical: false, quitEarly: false, changes: [], moves: [] });
	await waitForReady(model);
	assert.equal(model.diff?.rows[0]?.kind, 'unchanged');
});

interface ControlledRequest {
	readonly original: ITextModel;
	readonly modified: ITextModel;
	readonly token: CancellationToken;
	readonly options: IDocumentDiffProviderOptions;
	readonly resolve: (diff: IDocumentDiff) => void;
}

class ControlledDiffComputationService implements IDocumentDiffProvider {
	private readonly requests: ControlledRequest[] = [];
	private readonly changed = new Emitter<void>();
	readonly onDidChange = this.changed.event;

	computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, token: CancellationToken): Promise<IDocumentDiff> {
		return new Promise(resolve => this.requests.push({ original, modified, options, token, resolve }));
	}

	changeSettings(): void { this.changed.fire(undefined); }

	takeRequest(): ControlledRequest {
		const request = this.requests.shift();
		assert.ok(request);
		return request;
	}

	dispose(): void { this.changed.dispose(); }

	[Symbol.dispose](): void {
		this.dispose();
	}
}

class ResolvedDiffComputationService implements IDocumentDiffProvider {
	readonly onDidChange = Event.None;

	computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, token: CancellationToken): Promise<IDocumentDiff> {
		assert.equal(token.isCancellationRequested, false);
		const result = new DefaultLinesDiffComputer().computeDiff(original.getLinesContent(), modified.getLinesContent(), options);
		return Promise.resolve({
			identical: original.getValue() === modified.getValue(),
			quitEarly: result.hitTimeout,
			changes: result.changes,
			moves: result.moves,
		});
	}

	dispose(): void {}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function createModifiedDiff(): IDocumentDiff {
	return {
		identical: false,
		quitEarly: false,
		changes: [new DetailedLineRangeMapping(new LineRange(1, 2), new LineRange(1, 2), undefined)],
		moves: [],
	};
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
