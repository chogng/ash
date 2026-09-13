import assert from "node:assert/strict";
import { test } from "mocha";
import { CommandRegistry } from "../../common/commands.js";

test("CommandRegistry atomically replaces one caller-owned command batch", () => {
	const registry = new CommandRegistry();
	using registration = registry.registerMany([
		{ id: "demo.first", handler: () => "first" },
		{ id: "demo.second", handler: () => "second" },
	]);

	assert.deepEqual(registry.getCommandIds(), ["demo.first", "demo.second"]);
	registration.replace([{ id: "demo.third", handler: () => "third" }]);
	assert.equal(registry.hasCommand("demo.first"), false);
	assert.equal(typeof registry.getCommand("demo.third"), "function");
});

test("CommandRegistry rejects a conflicting replacement without dropping the previous batch", () => {
	const registry = new CommandRegistry();
	using builtIn = registry.register("demo.builtIn", () => undefined);
	using registration = registry.registerMany([{ id: "demo.extension", handler: () => undefined }]);

	assert.throws(() => registration.replace([{ id: "demo.builtIn", handler: () => undefined }]), /already registered/);
	assert.equal(registry.hasCommand("demo.extension"), true);
	assert.equal(registry.hasCommand("demo.builtIn"), true);
});

test("disposing a command batch removes only commands owned by that batch", () => {
	const registry = new CommandRegistry();
	const registration = registry.registerMany([{ id: "demo.extension", handler: () => undefined }]);
	using builtIn = registry.register("demo.builtIn", () => undefined);

	registration.dispose();

	assert.deepEqual(registry.getCommandIds(), ["demo.builtIn"]);
	assert.throws(() => registration.replace([]), /disposed/);
});
