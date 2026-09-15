import assert from "node:assert/strict";
import { test } from "mocha";
import {
	CommandRegistry,
} from "../../../../../platform/commands/common/commands.js";
import {
	ServiceContainer,
} from "../../../../../platform/instantiation/common/instantiation.js";
import {
	CommandService,
} from "../../../../../workbench/services/commands/common/commandService.js";

test("command service emits execution events around the handler call", async () => {
	const registry = new CommandRegistry();
	const order: string[] = [];
	using commandRegistration = registry.register(
		"test.command.events",
		async () => {
			order.push("handler");
			return "result";
		},
	);
	using service = new CommandService(new ServiceContainer(), registry);
	using willListener = service.onWillExecuteCommand((event) => {
		order.push(`will:${event.commandId}:${String(event.args[0])}`);
	});
	using didListener = service.onDidExecuteCommand((event) => {
		order.push(`did:${event.commandId}:${String(event.args[0])}`);
	});

	const result = await service.executeCommand<string>(
		"test.command.events",
		"argument",
	);

	assert.equal(result, "result");
	assert.deepEqual(order, [
		"will:test.command.events:argument",
		"handler",
		"did:test.command.events:argument",
	]);
});

test("command service does not emit did when a handler throws", async () => {
	const registry = new CommandRegistry();
	using commandRegistration = registry.register(
		"test.command.failure",
		() => {
			throw new Error("failed");
		},
	);
	using service = new CommandService(new ServiceContainer(), registry);
	let willCount = 0;
	let didCount = 0;
	using willListener = service.onWillExecuteCommand(() => {
		willCount += 1;
	});
	using didListener = service.onDidExecuteCommand(() => {
		didCount += 1;
	});

	await assert.rejects(
		service.executeCommand("test.command.failure"),
		/failed/,
	);
	assert.equal(willCount, 1);
	assert.equal(didCount, 0);
});
