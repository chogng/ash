import assert from "node:assert/strict";
import { test } from "mocha";
import { ActionRunner, type IAction, type IRunEvent } from "../../common/actions.js";
import { CancellationError } from "../../common/errors.js";

test("ActionRunner forwards context and reports action failures", async () => {
	using runner = new ActionRunner();
	const context = { resource: "test.txt" };
	const failure = new Error("failed");
	const events: IRunEvent[] = [];
	runner.onWillRun((event) => events.push(event));
	runner.onDidRun((event) => events.push(event));

	await runner.run({
		id: "test.action",
		label: "Test",
		tooltip: "Test",
		enabled: true,
		run(receivedContext) {
			assert.equal(receivedContext, context);
			throw failure;
		},
	}, context);

	assert.equal(events.length, 2);
	assert.equal(events[0]?.context, context);
	assert.equal(events[1]?.error, failure);
});

test("ActionRunner delegates execution to its protected hook inside the existing event boundary", async () => {
	const context = { resource: "hook.txt" };
	const calls: unknown[] = [];
	class CustomRunner extends ActionRunner {
		protected override async runAction(action: IAction, receivedContext?: unknown): Promise<void> {
			calls.push([action, receivedContext]);
		}
	}
	using runner = new CustomRunner();
	const action: IAction = { id: "custom", label: "Custom", tooltip: "", enabled: true, run() { throw new Error("The hook owns execution"); } };
	runner.onWillRun(event => calls.push(["will", event]));
	runner.onDidRun(event => calls.push(["did", event]));
	await runner.run(action, context);
	assert.deepEqual(calls, [
		["will", { action, context }], [action, context], ["did", { action, context, error: undefined }],
	]);
});

test("ActionRunner waits for asynchronous completion and preserves the action receiver", async () => {
	using runner = new ActionRunner();
	let complete!: () => void;
	const completion = new Promise<void>(resolve => { complete = resolve; });
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const order: string[] = [];
	const context = { value: 7 };
	let count = 0;
	const action: IAction = {
		id: "async", label: "Async", tooltip: "", enabled: true,
		async run(receivedContext) {
			assert.equal(this, action);
			assert.equal(receivedContext, context);
			count++;
			order.push("run");
			entered();
			await completion;
			order.push("complete");
		},
	};
	runner.onWillRun(() => order.push("will"));
	runner.onDidRun(event => { assert.equal(event.error, undefined); order.push("did"); });
	const pending = runner.run(action, context);
	await started;
	assert.deepEqual(order, ["will", "run"]);
	complete();
	await pending;
	assert.deepEqual({ order, count }, { order: ["will", "run", "complete", "did"], count: 1 });
});

for (const failure of [new Error("sync failure"), "primitive failure", undefined, new CancellationError()]) {
	for (const asynchronous of [false, true]) {
		test(`ActionRunner fulfills and preserves ${String(failure)} from ${asynchronous ? "rejected" : "throwing"} actions`, async () => {
			using runner = new ActionRunner();
			const events: IRunEvent[] = [];
			runner.onDidRun(event => events.push(event));
			const action: IAction = {
				id: "failure", label: "Failure", tooltip: "", enabled: true,
				run() { if (asynchronous) return Promise.reject(failure); throw failure; },
			};
			await runner.run(action);
			assert.deepEqual(events, [{ action, context: undefined, error: failure }]);
		});
	}
}

test("ActionRunner retains existing disabled-action and disposed-run behavior", async () => {
	const runner = new ActionRunner();
	let calls = 0;
	let events = 0;
	runner.onDidRun(() => events++);
	const action: IAction = { id: "disabled", label: "Disabled", tooltip: "", enabled: false, run() { calls++; return 42; } };
	try {
		await runner.run(action);
		runner.dispose();
		await runner.run(action);
		assert.deepEqual({ calls, events }, { calls: 2, events: 1 });
	} finally { runner.dispose(); }
});
