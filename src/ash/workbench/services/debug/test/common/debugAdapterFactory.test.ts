import assert from "node:assert/strict";
import { test } from "mocha";
import { createStaticDebugAdapterFactory, DebugAdapterFactoryRegistry } from "../../common/debugAdapterFactory.js";

test("DebugAdapterFactoryRegistry composes independent producers and removes only its owner", () => {
	using registry = new DebugAdapterFactoryRegistry();
	const declarative = registry.registerFactories([createStaticDebugAdapterFactory("node", "Node", "declarative.node", { program: "node-adapter", arguments: [] })]);
	using hosted = registry.registerFactories([createStaticDebugAdapterFactory("python", "Python", "hosted.python", { program: "python-adapter", arguments: ["--stdio"] })]);

	assert.deepEqual(registry.factories.map(factory => factory.type), ["node", "python"]);
	assert.deepEqual(registry.get("python")?.createDebugAdapter?.(), { program: "python-adapter", arguments: ["--stdio"] });
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

test('DebugAdapterFactoryRegistry retains unchanged factories when another type activates', () => {
	using registry = new DebugAdapterFactoryRegistry();
	const original = createStaticDebugAdapterFactory('original', 'Original', 'owner', { program: 'original', arguments: [] });
	const next = createStaticDebugAdapterFactory('next', 'Next', 'owner', { program: 'next', arguments: [] });
	using registration = registry.registerFactories([original]);
	const retained = registry.get('original');
	let changes = 0;
	using listener = registry.onDidChange(() => changes++);

	registration.replace([original, next]);
	assert.equal(registry.get('original'), retained);
	assert.deepEqual(registry.factories.map(factory => factory.type), ['next', 'original']);
	assert.equal(changes, 1);
	registration.replace([original, next]);
	assert.equal(changes, 1);
	registration.replace([next]);
	assert.equal(registry.get('original'), undefined);
});


test('DebugAdapterFactoryRegistry combines a default with a dynamic owner and reveals it after retirement', async () => {
	using registry = new DebugAdapterFactoryRegistry();
	using fallback = registry.registerFactories([createStaticDebugAdapterFactory('example', 'Example', 'declarative:example', { program: 'default', arguments: ['default-arg'] })]);
	using dynamic = registry.registerFactories([{ type: 'example', label: 'Factory', sourceId: 'runtime:example', createDebugAdapterDescriptor: async () => ({ program: 'dynamic', arguments: [] }) }]);
	const combined = registry.get('example');
	assert.equal(registry.factories.length, 1);
	assert.equal(combined?.label, 'Example');
	assert.deepEqual(combined?.createDebugAdapter?.(), { program: 'default', arguments: ['default-arg'] });
	assert.throws(() => registry.registerFactories([{ type: 'example', label: 'Duplicate', sourceId: 'other', createDebugAdapterDescriptor: async () => ({ program: 'other', arguments: [] }) }]), /already registered/);
	dynamic.dispose();
	assert.deepEqual(registry.get('example')?.createDebugAdapter?.(), { program: 'default', arguments: ['default-arg'] });
	assert.equal(registry.get('example')?.createDebugAdapterDescriptor, undefined);
});
