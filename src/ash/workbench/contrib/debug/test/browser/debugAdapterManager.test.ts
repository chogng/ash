import assert from "node:assert/strict";
import { test } from "mocha";
import { createStaticDebugAdapterFactory, IAdapterManager } from "../../common/debug.js";
import { AdapterManager } from "../../browser/debugAdapterManager.js";
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';

test('AdapterManager registration shares factories within a window and isolates other windows', () => {
	const descriptors = getSingletonServiceDescriptors().filter(([id]) => id === IAdapterManager);
	assert.equal(descriptors.length, 1, 'one production singleton registration');
	using firstWindow = new InstantiationService(new ServiceCollection(...descriptors));
	using secondWindow = new InstantiationService(new ServiceCollection(...descriptors));
	const first = firstWindow.get(IAdapterManager);
	const second = secondWindow.get(IAdapterManager);
	assert.equal(firstWindow.get(IAdapterManager), first);
	assert.notEqual(first, second);
	using registration = first.registerFactories([createStaticDebugAdapterFactory('isolated', 'Isolated', 'extension.test', { program: 'adapter', arguments: [] })]);
	assert.equal(firstWindow.get(IAdapterManager).get('isolated')?.sourceId, 'extension.test');
	assert.equal(second.get('isolated'), undefined);
});

test("AdapterManager composes independent producers and removes only its owner", () => {
	using registry = new AdapterManager();
	const declarative = registry.registerFactories([createStaticDebugAdapterFactory("node", "Node", "declarative.node", { program: "node-adapter", arguments: [] })]);
	using hosted = registry.registerFactories([createStaticDebugAdapterFactory("python", "Python", "hosted.python", { program: "python-adapter", arguments: ["--stdio"] })]);

	assert.deepEqual(registry.factories.map(factory => factory.type), ["node", "python"]);
	assert.deepEqual(registry.get("python")?.createDebugAdapter?.(), { program: "python-adapter", arguments: ["--stdio"] });
	declarative.dispose();
	assert.deepEqual(registry.factories.map(factory => factory.type), ["python"]);
});

test("AdapterManager rejects conflicting replacement atomically", () => {
	using registry = new AdapterManager();
	using first = registry.registerFactories([createStaticDebugAdapterFactory("node", "Node", "first", { program: "first", arguments: [] })]);
	using second = registry.registerFactories([createStaticDebugAdapterFactory("python", "Python", "second", { program: "second", arguments: [] })]);

	assert.throws(() => second.replace([createStaticDebugAdapterFactory("node", "Other Node", "second", { program: "other", arguments: [] })]), /already registered/);
	assert.equal(registry.get("node")?.sourceId, "first");
	assert.equal(registry.get("python")?.sourceId, "second");
});

test('AdapterManager retains unchanged factories when another type activates', () => {
	using registry = new AdapterManager();
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


test('AdapterManager combines a default with a dynamic owner and reveals it after retirement', async () => {
	using registry = new AdapterManager();
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
