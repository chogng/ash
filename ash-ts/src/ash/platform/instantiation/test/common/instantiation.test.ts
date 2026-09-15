import assert from "node:assert/strict";
import { test } from "mocha";
import {
	createServiceIdentifier,
	createDecorator,
	IInstantiationService,
	ServiceCollection,
	ServiceContainer,
	ServiceConstructionDescriptor,
	type ServicesAccessor,
} from "../../../../platform/instantiation/common/instantiation.js";
import { getSingletonServiceDescriptors, InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from "../../../../base/common/lifecycle.js";

test('constructor services resolve from the creating scope after explicit arguments', () => {
	const IMessage = createDecorator<string>('test.constructor.message');
	class Consumer {
		constructor(
			readonly label: string,
			@IMessage readonly message: string,
			@IInstantiationService readonly services: IInstantiationService,
		) {}
	}
	using parent = new ServiceContainer();
	parent.registerInstance(IMessage, 'parent');
	using child = parent.createChild();
	child.registerInstance(IMessage, 'child');
	const instance = child.createInstance(Consumer, 'label');
	assert.deepEqual([instance.label, instance.message, instance.services], ['label', 'child', child]);
	assert.equal(parent.createInstance(new ServiceConstructionDescriptor(Consumer, { staticArguments: ['label'] })).message, 'parent');
});

test('constructor service metadata is inherited without changing the base class', () => {
	const IMessage = createDecorator<string>('test.constructor.inheritance');
	const IOther = createDecorator<string>('test.constructor.other');
	class Base { constructor(@IMessage readonly message: string) {} }
	class Inherited extends Base {}
	class Overridden extends Base { constructor(@IOther message: string) { super(message); } }
	using services = new ServiceContainer();
	services.registerInstance(IMessage, 'base');
	services.registerInstance(IOther, 'override');
	assert.deepEqual([
		services.createInstance(Base).message,
		services.createInstance(Inherited).message,
		services.createInstance(Overridden).message,
		services.createInstance(Base).message,
	], ['base', 'base', 'override', 'base']);
});

test('missing services and invalid constructor arguments fail before construction', () => {
	const IMessage = createDecorator<string>('test.constructor.required');
	let created = 0;
	class Consumer {
		constructor(label: string, @IMessage message: string) { created++; }
	}
	using services = new ServiceContainer();
	assert.throws(() => services.createInstance(Consumer, 'label'), /Unknown service: test.constructor.required/);
	services.registerInstance(IMessage, 'message');
	assert.throws(() => services.createInstance(Consumer), /Invalid constructor arguments/);
	assert.throws(() => services.createInstance(Consumer, 'label', 'override'), /Invalid constructor arguments/);
	assert.throws(() => services.createInstance(new ServiceConstructionDescriptor(Consumer, { serviceDependencies: [IMessage] }), 'label'), /only in the constructor/);
	assert.equal(created, 0);
});

test("instantiation resolves descriptor arguments in contract order", () => {
	const serviceId = createServiceIdentifier<string>("test.message");
	const container = new ServiceContainer();
	container.registerInstance(serviceId, "service");
	const descriptor = new ServiceConstructionDescriptor(TestContribution, {
		staticArguments: ["static"],
		serviceDependencies: [serviceId],
	});

	const contribution = container.createInstance(
		descriptor,
		"dynamic",
	);

	assert.deepEqual(contribution.arguments, [
		"static",
		"dynamic",
		"service",
	]);
	container.dispose();
});

test("invocation accessors cannot escape their call", () => {
	const serviceId = createServiceIdentifier<string>("test.value");
	const container = new ServiceContainer();
	container.registerInstance(serviceId, "ready");
	let escapedAccessor: ServicesAccessor | undefined;

	const result = container.invokeFunction((accessor, suffix) => {
		escapedAccessor = accessor;
		return `${accessor.get(serviceId)}:${suffix}`;
	}, "done");

	assert.equal(result, "ready:done");
	assert.throws(
		() => escapedAccessor?.get(serviceId),
		/only valid during invocation/,
	);
	container.dispose();
});

test("singleton factories are delayed and resolved once", () => {
	const serviceId = createServiceIdentifier<{ id: number }>("test.singleton");
	const container = new ServiceContainer();
	let created = 0;
	container.registerSingleton(serviceId, () => ({ id: ++created }));

	assert.equal(created, 0);
	const first = container.get(serviceId);
	const second = container.get(serviceId);
	assert.equal(created, 1);
	assert.strictEqual(first, second);
	container.dispose();
});

test("service registration is explicit and rejects a duplicate in one scope", () => {
	const serviceId = createServiceIdentifier<string>("test.duplicate");
	const container = new ServiceContainer();
	container.registerInstance(serviceId, "first");

	assert.throws(
		() => container.registerInstance(serviceId, "second"),
		/already registered in this scope/u,
	);
	assert.equal(container.get(serviceId), "first");
	container.dispose();
});

test("eager singleton factories are created during registration", () => {
	const serviceId = createServiceIdentifier<string>("test.eager");
	const container = new ServiceContainer();
	let created = 0;
	container.registerSingleton(serviceId, () => `value-${++created}`, {
		instantiation: InstantiationType.Eager,
	});

	assert.equal(created, 1);
	assert.equal(container.get(serviceId), "value-1");
	container.dispose();
});

test("child containers inherit services and override only their scope", () => {
	const serviceId = createServiceIdentifier<string>("test.scope");
	const parent = new ServiceContainer();
	parent.registerInstance(serviceId, "parent");
	const child = parent.createChild();
	child.registerInstance(serviceId, "child");

	assert.equal(parent.get(serviceId), "parent");
	assert.equal(child.get(serviceId), "child");
	child.dispose();
	parent.dispose();
});

test("cyclic singleton dependencies report the dependency chain", () => {
	const first = createServiceIdentifier<string>("test.first");
	const second = createServiceIdentifier<string>("test.second");
	const container = new ServiceContainer();
	container.registerSingleton(first, accessor => `${accessor.get(second)}`);
	container.registerSingleton(second, accessor => `${accessor.get(first)}`);

	assert.throws(
		() => container.get(first),
		/Cyclic service dependency: test\.first -> test\.second -> test\.first/u,
	);
	container.dispose();
});

test("container owns disposable singleton instances", () => {
	const serviceId = createServiceIdentifier<DisposableValue>("test.disposable");
	const container = new ServiceContainer();
	let value: DisposableValue | undefined;
	container.registerSingleton(serviceId, () => {
		value = new DisposableValue();
		return value;
	});

	container.get(serviceId);
	container.dispose();
	assert.equal(value?.disposed, true);
});

test("ServiceCollection transfers explicit instances into a container", () => {
	const serviceId = createServiceIdentifier<string>("test.collection");
	const collection = new ServiceCollection([serviceId, "ready"]);
	assert.equal(collection.has(serviceId), true);
	assert.equal(collection.get(serviceId), "ready");
	using container = new ServiceContainer();
	container.registerCollection(collection);
	assert.equal(container.get(serviceId), "ready");
});

test("global singleton descriptors remain explicit until a container adopts them", () => {
	const serviceId = createServiceIdentifier<{ readonly created: number }>("test.global-singleton");
	let created = 0;
	class RegisteredService { readonly created = ++created; }
	registerSingleton(serviceId, RegisteredService, InstantiationType.Delayed);
	assert.equal(getSingletonServiceDescriptors().some(([id]) => id === serviceId), true);
	using container = new ServiceContainer();
	assert.equal(container.getOptional(serviceId), undefined);
	container.registerSingleton(serviceId, () => new RegisteredService());
	assert.equal(created, 0);
	assert.equal(container.get(serviceId).created, 1);
	assert.equal(container.get(serviceId).created, 1);
});

class TestContribution {
	readonly arguments: readonly string[];

	constructor(
		staticArgument: string,
		dynamicArgument: string,
		service: string,
	) {
		this.arguments = [staticArgument, dynamicArgument, service];
	}
}

class DisposableValue extends Disposable {
	disposed = false;

	protected override disposeCore(): void {
		this.disposed = true;
		super.disposeCore();
	}
}
