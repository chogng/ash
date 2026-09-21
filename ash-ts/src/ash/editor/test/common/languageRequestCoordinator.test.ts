import { strict as assert } from "node:assert";
import { test } from "mocha";
import { LanguageRequestCancellationReason, LanguageRequestCoordinator, LanguageRequestStatus, LanguageWorkerResultDisposition, type LanguageWorker, type LanguageWorkerRequest, type LanguageWorkerResultSettler, type VersionedLanguageResult } from "../../common/languages/languageRequestCoordinator.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { type TextModelChange } from "../../common/core/textChange.js";
import { TextModel } from "../../common/model/textModel.js";

type TestLane = "diagnostics" | "tokens";

interface TestPayload {
	readonly label: string;
}

interface TestResult {
	readonly label: string;
	readonly text: string;
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

interface PendingWorkerRequest {
	readonly request: LanguageWorkerRequest<TestLane, TestPayload>;
	readonly signal: AbortSignal;
	readonly completion: Deferred<TestResult>;
}

class ControlledLanguageWorker implements LanguageWorker<TestLane, TestPayload, TestResult>, LanguageWorkerResultSettler {
	readonly requests: PendingWorkerRequest[] = [];
	readonly settlements: Array<{ readonly requestId: number; readonly disposition: LanguageWorkerResultDisposition }> = [];
	readonly synchronizedChanges: TextModelChange[] = [];
	readonly synchronizedAfterCancellation: boolean[] = [];
	disposed = false;

	run(request: LanguageWorkerRequest<TestLane, TestPayload>, signal: AbortSignal): Promise<TestResult> {
		if (this.disposed) {
			throw new ReferenceError("Controlled worker is already disposed");
		}
		const completion = createDeferred<TestResult>();
		this.requests.push({ request, signal, completion });
		return completion.promise;
	}

	synchronizeModel(change: TextModelChange): void {
		this.synchronizedChanges.push(change);
		this.synchronizedAfterCancellation.push(this.requests.every(request => request.signal.aborted));
	}

	settleResult(requestId: number, disposition: LanguageWorkerResultDisposition): void {
		this.settlements.push({ requestId, disposition });
	}

	dispose(): void {
		this.disposed = true;
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

class FailingSynchronizationWorker extends ControlledLanguageWorker {
	override synchronizeModel(_change: TextModelChange): void {
		throw new Error("synchronization failed");
	}
}

test("Language requests apply immutable values for the captured model version", async () => {
	using model = new TextModel("alpha");
	const workers: ControlledLanguageWorker[] = [];
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(
		model,
		() => {
			const worker = new ControlledLanguageWorker();
			workers.push(worker);
			return worker;
		},
	);
	const applied: VersionedLanguageResult<TestResult>[] = [];

	const first = coordinator.runLatest(
		"tokens",
		{ label: "first" },
		result => {
			applied.push(result);
		},
	);
	const worker = workers[0]!;
	const pending = worker.requests[0]!;
	assert.equal(Object.isFrozen(pending.request), true);
	assert.equal(pending.request.requestId, 1);
	assert.equal(pending.request.snapshot.version, 1);
	assert.equal(pending.request.snapshot.getText(), "alpha");
	pending.completion.resolve({
		label: pending.request.payload.label,
		text: pending.request.snapshot.getText(),
	});

	assert.deepEqual(await first, {
		status: LanguageRequestStatus.Applied,
		requestId: 1,
		modelVersion: 1,
	});
	assert.equal(Object.isFrozen(applied[0]), true);
	assert.deepEqual(applied, [{
		requestId: 1,
		textModel: model,
		modelVersion: 1,
		value: { label: "first", text: "alpha" },
	}]);

	const second = coordinator.runLatest(
		"tokens",
		{ label: "second" },
		result => {
			applied.push(result);
		},
	);
	assert.equal(workers.length, 1);
	worker.requests[1]!.completion.resolve({
		label: "second",
		text: "alpha",
	});
	assert.equal((await second).status, LanguageRequestStatus.Applied);
});

test("Latest language request wins within one lane", async () => {
	using model = new TextModel("text");
	const worker = new ControlledLanguageWorker();
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(
		model,
		() => worker,
	);
	const applied: string[] = [];

	const first = coordinator.runLatest("tokens", { label: "old" }, result => {
		applied.push(result.value.label);
	});
	const second = coordinator.runLatest("tokens", { label: "new" }, result => {
		applied.push(result.value.label);
	});
	assert.equal(worker.requests[0]!.signal.aborted, true);
	assert.equal(worker.requests[0]!.signal.reason, LanguageRequestCancellationReason.Superseded);
	assert.equal(worker.requests[1]!.signal.aborted, false);

	worker.requests[0]!.completion.resolve({ label: "old", text: "text" });
	worker.requests[1]!.completion.resolve({ label: "new", text: "text" });
	assert.deepEqual(await first, {
		status: LanguageRequestStatus.Cancelled,
		requestId: 1,
		modelVersion: 1,
		reason: LanguageRequestCancellationReason.Superseded,
	});
	assert.equal((await second).status, LanguageRequestStatus.Applied);
	assert.deepEqual(applied, ["new"]);
});

test("Independent language lanes may complete concurrently", async () => {
	using model = new TextModel("text");
	const worker = new ControlledLanguageWorker();
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(
		model,
		() => worker,
	);
	const applied: string[] = [];

	const tokens = coordinator.runLatest("tokens", { label: "tokens" }, result => {
		applied.push(result.value.label);
	});
	const diagnostics = coordinator.runLatest("diagnostics", { label: "diagnostics" }, result => {
		applied.push(result.value.label);
	});
	assert.equal(worker.requests.every(request => !request.signal.aborted), true);

	worker.requests[1]!.completion.resolve({ label: "diagnostics", text: "text" });
	worker.requests[0]!.completion.resolve({ label: "tokens", text: "text" });
	assert.equal((await diagnostics).status, LanguageRequestStatus.Applied);
	assert.equal((await tokens).status, LanguageRequestStatus.Applied);
	assert.deepEqual(applied, ["diagnostics", "tokens"]);
});

test("Model changes cancel every captured language version", async () => {
	using model = new TextModel("old");
	const worker = new ControlledLanguageWorker();
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(
		model,
		() => worker,
	);
	const applied: TestResult[] = [];

	const tokens = coordinator.runLatest("tokens", { label: "tokens" }, result => {
		applied.push(result.value);
	});
	const diagnostics = coordinator.runLatest("diagnostics", { label: "diagnostics" }, result => {
		applied.push(result.value);
	});
	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (3) + 1)),
		text: "!",
	}]);
	assert.equal(worker.requests.every(request => request.signal.aborted), true);
	assert.equal(worker.requests[0]!.request.snapshot.getText(), "old");
	assert.deepEqual(worker.synchronizedChanges.map(change => change.version), [2]);
	assert.deepEqual(worker.synchronizedAfterCancellation, [true]);

	worker.requests[0]!.completion.resolve({ label: "tokens", text: "old" });
	worker.requests[1]!.completion.resolve({ label: "diagnostics", text: "old" });
	assert.equal((await tokens).status, LanguageRequestStatus.Cancelled);
	assert.equal((await diagnostics).status, LanguageRequestStatus.Cancelled);
	assert.deepEqual(applied, []);
	assert.equal(model.getText(), "old!");
});

test("Model synchronization failure discards the worker and recovers from a full snapshot", async () => {
	using model = new TextModel("old");
	const workers: ControlledLanguageWorker[] = [];
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(
		model,
		() => {
			const worker = workers.length === 0
				? new FailingSynchronizationWorker()
				: new ControlledLanguageWorker();
			workers.push(worker);
			return worker;
		},
	);
	const first = coordinator.runLatest("tokens", { label: "old" }, () => assert.fail("Old result must not apply"));

	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (3) + 1)),
		text: "!",
	}]);

	assert.equal(workers[0]!.disposed, true);
	workers[0]!.requests[0]!.completion.resolve({ label: "old", text: "old" });
	assert.equal((await first).status, LanguageRequestStatus.Cancelled);
	const recovered = coordinator.runLatest("tokens", { label: "new" }, () => undefined);
	assert.equal(workers.length, 2);
	assert.equal(workers[1]!.requests[0]!.request.snapshot.getText(), "old!");
	workers[1]!.requests[0]!.completion.resolve({ label: "new", text: "old!" });
	assert.equal((await recovered).status, LanguageRequestStatus.Applied);
});

test("Caller cancellation is explicit before and during a request", async () => {
	using model = new TextModel("text");
	const workers: ControlledLanguageWorker[] = [];
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(
		model,
		() => {
			const worker = new ControlledLanguageWorker();
			workers.push(worker);
			return worker;
		},
	);
	const before = new AbortController();
	const beforeReason = new Error("not needed");
	before.abort(beforeReason);

	assert.deepEqual(await coordinator.runLatest(
		"tokens",
		{ label: "before" },
		() => assert.fail("Cancelled request must not apply"),
		{ signal: before.signal },
	), {
		status: LanguageRequestStatus.Cancelled,
		requestId: 1,
		modelVersion: 1,
		reason: LanguageRequestCancellationReason.Caller,
		cause: beforeReason,
	});
	assert.equal(workers.length, 0);

	const during = new AbortController();
	const duringReason = new Error("superseded by caller");
	const pending = coordinator.runLatest(
		"tokens",
		{ label: "during" },
		() => assert.fail("Cancelled request must not apply"),
		{ signal: during.signal },
	);
	during.abort(duringReason);
	assert.equal(workers[0]!.requests[0]!.signal.reason, duringReason);
	workers[0]!.requests[0]!.completion.resolve({ label: "during", text: "text" });
	assert.deepEqual(await pending, {
		status: LanguageRequestStatus.Cancelled,
		requestId: 2,
		modelVersion: 1,
		reason: LanguageRequestCancellationReason.Caller,
		cause: duringReason,
	});
});

test("Active worker failure restarts the worker and cancels peer lanes", async () => {
	using model = new TextModel("text");
	const workers: ControlledLanguageWorker[] = [];
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(
		model,
		() => {
			const worker = new ControlledLanguageWorker();
			workers.push(worker);
			return worker;
		},
	);

	const failed = coordinator.runLatest(
		"tokens",
		{ label: "failed" },
		() => assert.fail("Failed request must not apply"),
	);
	const peer = coordinator.runLatest(
		"diagnostics",
		{ label: "peer" },
		() => assert.fail("Restarted peer must not apply"),
	);
	const failure = new Error("worker crashed");
	workers[0]!.requests[0]!.completion.reject(failure);
	await assert.rejects(failed, failure);
	assert.equal(workers[0]!.disposed, true);
	assert.equal(workers[0]!.requests[1]!.signal.reason, LanguageRequestCancellationReason.WorkerRestarted);
	workers[0]!.requests[1]!.completion.resolve({ label: "peer", text: "text" });
	assert.deepEqual(await peer, {
		status: LanguageRequestStatus.Cancelled,
		requestId: 2,
		modelVersion: 1,
		reason: LanguageRequestCancellationReason.WorkerRestarted,
	});

	const recovered = coordinator.runLatest(
		"tokens",
		{ label: "recovered" },
		() => undefined,
	);
	assert.equal(workers.length, 2);
	workers[1]!.requests[0]!.completion.resolve({ label: "recovered", text: "text" });
	assert.equal((await recovered).status, LanguageRequestStatus.Applied);
});

test("Coordinator disposal and model disposal prevent late application", async () => {
	const model = new TextModel("text");
	const workers: ControlledLanguageWorker[] = [];
	const coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(
		model,
		() => {
			const worker = new ControlledLanguageWorker();
			workers.push(worker);
			return worker;
		},
	);
	const afterModel = coordinator.runLatest(
		"tokens",
		{ label: "model-disposed" },
		() => assert.fail("Disposed model result must not apply"),
	);
	model.dispose();
	workers[0]!.requests[0]!.completion.resolve({
		label: "model-disposed",
		text: "text",
	});
	assert.deepEqual(await afterModel, {
		status: LanguageRequestStatus.Cancelled,
		requestId: 1,
		modelVersion: 1,
		reason: LanguageRequestCancellationReason.ModelUnavailable,
	});

	const liveModel = new TextModel("live");
	const liveWorker = new ControlledLanguageWorker();
	const disposableCoordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(
		liveModel,
		() => liveWorker,
	);
	const afterCoordinator = disposableCoordinator.runLatest(
		"tokens",
		{ label: "coordinator-disposed" },
		() => assert.fail("Disposed coordinator result must not apply"),
	);
	disposableCoordinator.dispose();
	assert.equal(liveWorker.disposed, true);
	liveWorker.requests[0]!.completion.resolve({
		label: "coordinator-disposed",
		text: "live",
	});
	assert.deepEqual(await afterCoordinator, {
		status: LanguageRequestStatus.Cancelled,
		requestId: 1,
		modelVersion: 1,
		reason: LanguageRequestCancellationReason.CoordinatorDisposed,
	});
	await assert.rejects(
		disposableCoordinator.runLatest("tokens", { label: "late" }, () => undefined),
		ReferenceError,
	);
	assert.equal(liveModel.getText(), "live");
	liveModel.dispose();
	coordinator.dispose();
});

test("Application failures do not poison a healthy worker", async () => {
	using model = new TextModel("text");
	const worker = new ControlledLanguageWorker();
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(
		model,
		() => worker,
	);
	const applicationFailure = new Error("consumer failed");

	const first = coordinator.runLatest("tokens", { label: "first" }, () => {
		throw applicationFailure;
	});
	worker.requests[0]!.completion.resolve({ label: "first", text: "text" });
	await assert.rejects(first, applicationFailure);
	assert.equal(worker.disposed, false);

	const second = coordinator.runLatest("tokens", { label: "second" }, () => undefined);
	worker.requests[1]!.completion.resolve({ label: "second", text: "text" });
	assert.equal((await second).status, LanguageRequestStatus.Applied);
	assert.deepEqual(worker.settlements, [{
		requestId: 1,
		disposition: LanguageWorkerResultDisposition.Discarded,
	}, {
		requestId: 2,
		disposition: LanguageWorkerResultDisposition.Applied,
	}]);
});

test("Result confirmation occurs only after the renderer application gate", async () => {
	using model = new TextModel("text");
	const worker = new ControlledLanguageWorker();
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(model, () => worker);
	const first = coordinator.runLatest("tokens", { label: "first" }, () => undefined);
	worker.requests[0]!.completion.resolve({ label: "first", text: "text" });
	assert.equal((await first).status, LanguageRequestStatus.Applied);

	const cancelled = coordinator.runLatest("tokens", { label: "cancelled" }, () => assert.fail("Cancelled result must not apply"));
	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (4) + 1)),
		text: "!",
	}]);
	worker.requests[1]!.completion.resolve({ label: "cancelled", text: "text" });
	assert.equal((await cancelled).status, LanguageRequestStatus.Cancelled);

	assert.deepEqual(worker.settlements, [{
		requestId: 1,
		disposition: LanguageWorkerResultDisposition.Applied,
	}, {
		requestId: 2,
		disposition: LanguageWorkerResultDisposition.Discarded,
	}]);
});

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test('closing a model cancels pending work without waiting for its worker', async () => {
	using model = new TextModel('old');
	const worker = new ControlledLanguageWorker();
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(model, () => worker);
	const pending = coordinator.runLatest('tokens', { label: 'closing' }, () => assert.fail('Closed model must not receive results'));
	model.dispose();
	assert.equal(worker.requests[0]!.signal.aborted, true);
	assert.equal(worker.disposed, true);
	const outcome = await pending;
	assert.equal(outcome.status, LanguageRequestStatus.Cancelled);
	if (outcome.status === LanguageRequestStatus.Cancelled) {
		assert.equal(outcome.reason, LanguageRequestCancellationReason.ModelUnavailable);
	}
	assert.throws(() => coordinator.startWorker(), /model is disposed/);
	worker.requests[0]!.completion.resolve({ label: 'late', text: 'old' });
	await Promise.resolve();
	assert.deepEqual(worker.settlements, [{ requestId: 1, disposition: LanguageWorkerResultDisposition.Discarded }]);
});

test('a superseded request finishes even when its worker ignores cancellation', async () => {
	using model = new TextModel('text');
	const worker = new ControlledLanguageWorker();
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(model, () => worker);
	const first = coordinator.runLatest('tokens', { label: 'first' }, () => assert.fail('Superseded result must not apply'));
	const applied: string[] = [];
	const second = coordinator.runLatest('tokens', { label: 'second' }, result => applied.push(result.value.label));
	assert.equal((await first).status, LanguageRequestStatus.Cancelled);
	worker.requests[1]!.completion.resolve({ label: 'second', text: 'text' });
	assert.equal((await second).status, LanguageRequestStatus.Applied);
	worker.requests[0]!.completion.resolve({ label: 'first', text: 'text' });
	await Promise.resolve();
	assert.deepEqual(applied, ['second']);
	assert.deepEqual(worker.settlements, [
		{ requestId: 2, disposition: LanguageWorkerResultDisposition.Applied },
		{ requestId: 1, disposition: LanguageWorkerResultDisposition.Discarded },
	]);
});

test('a model closed during worker creation releases the newly created worker', async () => {
	using model = new TextModel('closing');
	const worker = new ControlledLanguageWorker();
	using coordinator = new LanguageRequestCoordinator<TestLane, TestPayload, TestResult>(model, () => {
		model.dispose();
		return worker;
	});
	const outcome = await coordinator.runLatest('tokens', { label: 'closing' }, () => assert.fail('Closed model must not receive results'));
	assert.deepEqual({ outcome, disposed: worker.disposed, requests: worker.requests.length }, {
		outcome: { status: LanguageRequestStatus.Cancelled, requestId: 1, modelVersion: 1, reason: LanguageRequestCancellationReason.ModelUnavailable },
		disposed: true,
		requests: 0,
	});
});
