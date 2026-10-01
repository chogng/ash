import assert from "node:assert/strict";
import { setup, teardown, test } from "mocha";
import { createServiceIdentifier, createDecorator, refineServiceDecorator, IInstantiationService, type ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { ServiceCollection } from "../../../../platform/instantiation/common/serviceCollection.js";
import { InstantiationService } from "../../../../platform/instantiation/common/instantiationService.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { getSingletonServiceDescriptors, InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from "../../../../base/common/lifecycle.js";
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, DisposableTracker, registerDisposableTracker } from '../../../../base/common/lifecycle.js';

let tracker: DisposableTracker;
let tracking: globalThis.Disposable;
setup(() => {
	tracker = new DisposableTracker();
	tracking = registerDisposableTracker(tracker);
});
teardown(() => {
	try {
		tracker.assertNoLeaks();
	} finally {
		tracking[Symbol.dispose]();
	}
});

test('refined service contracts share registration and constructor injection', () => {
	interface IBase { readonly name: string; }
	interface IExtended extends IBase { readonly enabled: boolean; }
	const IBase = createDecorator<IBase>('test.refined');
	const IExtended = refineServiceDecorator<IBase, IExtended>(IBase);
	class Consumer {
		constructor(@IBase readonly base: IBase, @IExtended readonly extended: IExtended) {}
	}
	using services = new InstantiationService();
	const instance: IExtended = { name: 'shared', enabled: true };
	services.registerInstance(IExtended, instance);
	const consumer = services.createInstance(Consumer);
	assert.deepEqual([consumer.base, consumer.extended], [instance, instance]);
	assert.throws(() => services.registerInstance(IBase, instance), /already registered/);
});

test('service identifiers with the same name share registrations', () => {
	const first = createDecorator<string>('test.canonical');
	const second = createDecorator<string>('test.canonical');
	using services = new InstantiationService(new ServiceCollection([first, 'shared']));
	assert.equal(first, second);
	assert.equal(services.get(second), 'shared');
});

test('a live service collection resolves descriptors added after scope creation', () => {
	const IValue = createDecorator<{ value: string }>('test.live');
	const IMessage = createDecorator<string>('test.live.message');
	class Value { constructor(@IMessage readonly value: string) {} }
	const collection = new ServiceCollection([IMessage, 'ready']);
	using services = new InstantiationService(collection);
	collection.set(IValue, new SyncDescriptor(Value));
	const first = services.get(IValue);
	assert.equal(first.value, 'ready');
	assert.equal(services.get(IValue), first);
});

test('a delayed service binds early event listeners and preserves method receivers', () => {
	const IService = createDecorator<Service>('test.delayed.events');
	let created = 0;
	class Service extends Disposable {
		private readonly changes = this._register(new Emitter<number>());
		readonly onDidChange = this.changes.event;
		private readonly value = ++created;
		fire(): void { this.changes.fire(this.value); }
	}
	using services = new InstantiationService(new ServiceCollection([IService, new SyncDescriptor(Service, [], true)]));
	const service = services.get(IService);
	const values: number[] = [];
	using removed = service.onDidChange(value => values.push(-value));
	removed.dispose();
	using listener = service.onDidChange(value => values.push(value));
	assert.equal(created, 0);
	const fire = service.fire;
	fire();
	assert.equal(service.fire, fire);
	assert.deepEqual(values, [1]);
	listener.dispose();
	fire();
	assert.deepEqual(values, [1]);
});

test('an unused delayed service is not constructed during scope disposal', () => {
	const IService = createDecorator<object>('test.delayed.unused');
	let created = 0;
	class Service { constructor() { created++; } }
	const services = new InstantiationService(new ServiceCollection([IService, new SyncDescriptor(Service, [], true)]));
	services.get(IService);
	services.dispose();
	assert.equal(created, 0);
});

test('missing transitive dependencies of delayed services fail before a consumer is constructed', () => {
	const IMissing = createDecorator<object>('test.delayed.missing');
	const IDependency = createDecorator<Dependency>('test.delayed.dependency');
	const IService = createDecorator<Service>('test.delayed.required');
	let created = 0;
	class Dependency { constructor(@IMissing readonly missing: object) {} }
	class Service { constructor(@IDependency readonly dependency: Dependency) {} }
	class Consumer { constructor(@IService service: Service) { created++; } }
	using services = new InstantiationService(new ServiceCollection(
		[IDependency, new SyncDescriptor(Dependency, [], true)],
		[IService, new SyncDescriptor(Service, [], true)],
	));
	assert.throws(() => services.createInstance(Consumer), /Unknown service: test.delayed.missing/);
	assert.equal(created, 0);
});

test('parent services resolve dependencies from their owner when requested by a child', () => {
	const IMessage = createDecorator<string>('test.scope.message');
	const IService = createDecorator<{ message: string }>('test.scope.owner');
	class Service { constructor(@IMessage readonly message: string) {} }
	using parent = new InstantiationService(new ServiceCollection([IMessage, 'parent'], [IService, new SyncDescriptor(Service)]));
	using child = parent.createChild(new ServiceCollection([IMessage, 'child']));
	assert.equal(child.get(IService).message, 'parent');
	assert.equal(child.get(IService), parent.get(IService));
});

test('parent disposal closes children and releases only services created by their scopes', () => {
	const IService = createDecorator<DisposableValue>('test.scope.disposal');
	const IBorrowed = createDecorator<DisposableValue>('test.scope.borrowed');
	using caller = new DisposableStore();
	using borrowed = new DisposableValue();
	const parent = caller.add(new InstantiationService(new ServiceCollection([IBorrowed, borrowed])));
	const child = parent.createChild(new ServiceCollection([IService, new SyncDescriptor(DisposableValue)]), caller);
	const owned = child.get(IService);
	parent.dispose();
	assert.deepEqual([child.isDisposed, owned.disposed, borrowed.disposed], [true, true, false]);
	assert.throws(() => child.createInstance(DisposableValue), /disposed/);
	caller.dispose();
	borrowed.dispose();
	tracker.assertNoLeaks();
});

test('disposing a child leaves the parent usable and rejects stale accessors', () => {
	const IMessage = createDecorator<string>('test.child.disposal');
	using parent = new InstantiationService(new ServiceCollection([IMessage, 'ready']));
	const child = parent.createChild();
	child.dispose();
	assert.equal(parent.get(IMessage), 'ready');
	assert.throws(() => child.get(IMessage), /disposed/);
});

test('children release their services before late-created parent dependencies', () => {
	const events: string[] = [];
	const IParent = createDecorator<ParentService>('test.scope.disposal.parent');
	const IChild = createDecorator<ChildService>('test.scope.disposal.child');
	class ParentService extends Disposable {
		protected override disposeCore(): void {
			events.push('parent');
			super.disposeCore();
		}
	}
	class ChildService extends Disposable {
		constructor(@IParent private readonly parent: ParentService) { super(); }
		protected override disposeCore(): void {
			assert.equal(this.parent.isDisposed, false);
			events.push('child');
			super.disposeCore();
		}
	}
	using parent = new InstantiationService(new ServiceCollection([IParent, new SyncDescriptor(ParentService)]));
	using child = parent.createChild(new ServiceCollection([IChild, new SyncDescriptor(ChildService)]));
	child.get(IChild);
	parent.dispose();
	assert.deepEqual(events, ['child', 'parent']);
});

test('constructor services resolve from the creating scope after explicit arguments', () => {
	const IMessage = createDecorator<string>('test.constructor.message');
	class Consumer {
		constructor(
			readonly label: string,
			@IMessage readonly message: string,
			@IInstantiationService readonly services: IInstantiationService,
		) {}
	}
	using parent = new InstantiationService();
	parent.registerInstance(IMessage, 'parent');
	using child = parent.createChild();
	child.registerInstance(IMessage, 'child');
	const instance = child.createInstance(Consumer, 'label');
	assert.deepEqual([instance.label, instance.message, instance.services], ['label', 'child', child]);
	assert.equal(parent.createInstance(new SyncDescriptor(Consumer, ['label'])).message, 'parent');
});

test('constructor service metadata is inherited without changing the base class', () => {
	const IMessage = createDecorator<string>('test.constructor.inheritance');
	const IOther = createDecorator<string>('test.constructor.other');
	class Base { constructor(@IMessage readonly message: string) {} }
	class Inherited extends Base {}
	class Overridden extends Base { constructor(@IOther message: string) { super(message); } }
	using services = new InstantiationService();
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
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(Consumer, 'label'), /Unknown service: test.constructor.required/);
	services.registerInstance(IMessage, 'message');
	assert.throws(() => services.createInstance(Consumer), /Invalid constructor arguments/);
	assert.throws(() => services.createInstance(Consumer, 'label', 'override'), /Invalid constructor arguments/);
	assert.equal(created, 0);
});

test("instantiation resolves descriptor arguments in contract order", () => {
	const serviceId = createServiceIdentifier<string>("test.message");
	const container = new InstantiationService();
	container.registerInstance(serviceId, "service");
	class Contribution {
		readonly arguments: readonly string[];
		constructor(staticArgument: string, dynamicArgument: string, @serviceId service: string) {
			this.arguments = [staticArgument, dynamicArgument, service];
		}
	}
	const descriptor = new SyncDescriptor(Contribution, ["static"]);

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
	const container = new InstantiationService();
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
	const container = new InstantiationService();
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
	const container = new InstantiationService();
	container.registerInstance(serviceId, "first");

	assert.throws(
		() => container.registerInstance(serviceId, "second"),
		/already registered in this scope/u,
	);
	assert.equal(container.get(serviceId), "first");
	container.dispose();
});

test("eager singleton factories are created when a consumer depends on them", () => {
	const serviceId = createServiceIdentifier<string>("test.eager");
	const container = new InstantiationService();
	let created = 0;
	container.registerSingleton(serviceId, () => `value-${++created}`, {
		instantiation: InstantiationType.Eager,
	});

	assert.equal(created, 0);
	assert.equal(container.get(serviceId), "value-1");
	assert.equal(created, 1);
	container.dispose();
});

test("child containers inherit services and override only their scope", () => {
	const serviceId = createServiceIdentifier<string>("test.scope");
	const parent = new InstantiationService();
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
	const container = new InstantiationService();
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
	const container = new InstantiationService();
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
	using container = new InstantiationService(collection);
	assert.equal(container.get(serviceId), "ready");
});

test("global singleton descriptors remain explicit until a container adopts them", () => {
	const serviceId = createServiceIdentifier<{ readonly created: number }>("test.global-singleton");
	let created = 0;
	class RegisteredService { readonly created = ++created; }
	registerSingleton(serviceId, RegisteredService, InstantiationType.Delayed);
	assert.equal(getSingletonServiceDescriptors().some(([id]) => id === serviceId), true);
	using container = new InstantiationService();
	assert.equal(container.getOptional(serviceId), undefined);
	const descriptor = getSingletonServiceDescriptors().find(([id]) => id === serviceId)![1];
	container.registerCollection(new ServiceCollection([serviceId, descriptor]));
	const service = container.get(serviceId);
	assert.equal(created, 0);
	assert.equal(service.created, 1);
	assert.equal(container.get(serviceId).created, 1);
});

class DisposableValue extends Disposable {
	disposed = false;

	protected override disposeCore(): void {
		this.disposed = true;
		super.disposeCore();
	}
}
