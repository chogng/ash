import { Event, EventMultiplexer } from '../../../../base/common/event.js';
import { DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { ITerminalCapabilityImplMap, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import type { ITerminalInstance } from './terminal.js';

/** One observable source per live instance/capability; no command or instance state is copied. */
export function createInstanceCapabilityEventMultiplexer<T extends TerminalCapability, K>(
	currentInstances: readonly ITerminalInstance[],
	onAddInstance: Event<ITerminalInstance>,
	onRemoveInstance: Event<ITerminalInstance>,
	capabilityId: T,
	getEvent: (capability: ITerminalCapabilityImplMap[T]) => Event<K>,
): IDisposable & { readonly event: Event<{ readonly instance: ITerminalInstance; readonly data: K; }>; } {
	const lifetime = new DisposableStore();
	const multiplexer = lifetime.add(new EventMultiplexer<{ instance: ITerminalInstance; data: K; }>());
	const instances = lifetime.add(new DisposableMap<ITerminalInstance, DisposableStore>());
	const add = (instance: ITerminalInstance): void => {
		if (instances.has(instance) || !instance.capabilities) return;
		const subscriptions = new DisposableStore();
		instances.set(instance, subscriptions);
		let lease: IDisposable | undefined;
		const update = (): void => {
			lease?.dispose();
			lease = undefined;
			const capability = instance.capabilities!.get(capabilityId);
			if (capability) lease = multiplexer.add(Event.map(getEvent(capability), data => ({ instance, data })));
		};
		subscriptions.add(toDisposable(() => lease?.dispose()));
		subscriptions.add(instance.capabilities.createOnDidAddCapabilityOfTypeEvent(capabilityId)(update));
		subscriptions.add(instance.capabilities.createOnDidRemoveCapabilityOfTypeEvent(capabilityId)(update));
		update();
	};
	for (const instance of currentInstances) add(instance);
	lifetime.add(onAddInstance(add));
	lifetime.add(onRemoveInstance(instance => instances.deleteAndDispose(instance)));
	return Object.assign(lifetime, { event: multiplexer.event });
}
