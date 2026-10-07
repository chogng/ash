import assert from "node:assert/strict";
import { test } from "mocha";
import { createStaticDebugAdapterFactory, DebugAdapterFactoryRegistry } from "../../common/debugAdapterFactory.js";

test("DebugAdapterFactoryRegistry composes independent producers and removes only its owner", () => {
	using registry = new DebugAdapterFactoryRegistry();
	const declarative = registry.registerFactories([createStaticDebugAdapterFactory("node", "Node", "declarative.node", { program: "node-adapter", arguments: [] })]);
	using hosted = registry.registerFactories([createStaticDebugAdapterFactory("python", "Python", "hosted.python", { program: "python-adapter", arguments: ["--stdio"] })]);

	assert.deepEqual(registry.factories.map(factory => factory.type), ["node", "python"]);
	assert.deepEqual(registry.get("python")?.createDebugAdapter(), { program: "python-adapter", arguments: ["--stdio"] });
	declarative.dispose();
	assert.deepEqual(registry.factories.map(factory => factory.type), ["python"]);
});

test("DebugAdapterFactoryRegistry rejects conflicting replacement atomically", () => {
	using registry = new DebugAdapterFactoryRegistry();
	using first = registry.registerFactories([createStaticDebugAdapterFactory("node", "Node", "first", { program: "first", arguments: [] })]);
	using second = registry.registerFactories([createStaticDebugAdapterFactory("python", "Python", "second", { program: "second", arguments: [] })]);

	assert.throws(() => second.replace([createStaticDebugAdapterFactory("node", "Other Node", "second", { program: "other", arguments: [] })]), /already registered/);
	assert.equal(registry.get("node")?.sourceId, "first");
	assert.equal(registry.get("python")?.sourceId, "second");
});
