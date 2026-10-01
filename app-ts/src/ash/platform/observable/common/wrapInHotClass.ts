import { isHotReloadEnabled } from '../../../base/common/hotReload.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { autorunWithStore, type IObservable } from '../../../base/common/observable.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';

const instances = new WeakMap<object, IDisposable>();

/** Contribution registries retain the disposable wrapper; commands access its current implementation. */
export function hotClassGetOriginalInstance<T>(value: T): T {
	return (value !== null && typeof value === 'object' ? instances.get(value) ?? value : value) as T;
}

export function wrapInHotClass1<TArgument, TServices extends unknown[], TResult extends IDisposable>(
	clazz: IObservable<new (argument: TArgument, ...services: TServices) => TResult>,
): new (argument: TArgument) => TResult {
	if (!isHotReloadEnabled()) {
		// The service parameters of the returned constructor are container-resolved and not caller-supplied.
		return clazz.get() as unknown as new (argument: TArgument) => TResult;
	}
	class HotClassWrapper extends Disposable {
		constructor(argument: TArgument, @IInstantiationService instantiationService: IInstantiationService) {
			super();
			this._register(autorunWithStore((reader, store) => {
				// The reaction disposes the previous instance before constructing its replacement.
				const instance = store.add(instantiationService.createInstance(clazz.read(reader), argument));
				instances.set(this, instance);
			}));
			this._register(toDisposable(() => instances.delete(this)));
		}
	}
	return HotClassWrapper as unknown as new (argument: TArgument) => TResult;
}
