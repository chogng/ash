import assert from "node:assert/strict";
import { test } from "mocha";
import { CommandRegistry } from "../../common/commands.js";
import { ServiceContainer } from '../../../instantiation/common/instantiation.js';

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

test('command metadata validates supplied arguments while preserving handler values and registration input', () => {
	const registry = new CommandRegistry();
	using services = new ServiceContainer();
	const calls: unknown[][] = [];
	const handler = (accessor: unknown, ...args: unknown[]): unknown => {
		assert.equal(accessor, services);
		calls.push(args);
		return args[0];
	};
	const definition = {
		id: 'test.validated',
		handler,
		metadata: { description: 'test', args: [{ name: 'count', constraint: 'number' }] },
	};
	using registration = registry.registerMany([definition]);
	const command = registry.getCommand(definition.id)!;
	assert.throws(() => command(services, '3'), TypeError);
	assert.equal(command(services, 3, 'extra'), 3);
	assert.equal(command(services), undefined);
	assert.deepEqual(calls, [[3, 'extra'], []]);
	assert.equal(definition.handler, handler);
	definition.handler = () => 'changed';
	assert.equal(command(services, 4), 4);
});

test('replacing a command batch replaces its constraints and disposal removes the registered handler', () => {
	const registry = new CommandRegistry();
	using services = new ServiceContainer();
	const registration = registry.registerMany([{
		id: 'test.replaced',
		handler: (_accessor, value) => value,
		metadata: { description: 'test', args: [{ name: 'value', constraint: 'number' }] },
	}]);
	try {
		registration.replace([{
			id: 'test.replaced',
			handler: (_accessor, value) => value,
			metadata: { description: 'test', args: [{ name: 'value', constraint: 'string' }] },
		}]);
		const command = registry.getCommand('test.replaced')!;
		assert.throws(() => command(services, 3), TypeError);
		assert.equal(command(services, 'three'), 'three');
	} finally {
		registration.dispose();
	}
	assert.equal(registry.getCommand('test.replaced'), undefined);
});
