import assert from "node:assert/strict";
import { test } from "mocha";
import { ActionRunner, type IRunEvent } from "../../common/actions.js";

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
