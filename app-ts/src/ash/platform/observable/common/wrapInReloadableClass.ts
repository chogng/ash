import { isHotReloadEnabled } from '../../../base/common/hotReload.js';
import { readHotReloadableExport } from '../../../base/common/hotReloadHelpers.js';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { autorunWithStore } from '../../../base/common/observable.js';
import { IInstantiationService, type ServiceIdentifier, ServiceConstructionDescriptor } from '../../instantiation/common/instantiation.js';

type DisposableConstructor1<TArgument, TServices extends unknown[], TResult extends IDisposable> = new (
	argument: TArgument,
	...services: TServices
) => TResult;

type ServiceDependencies<TServices extends unknown[]> = {
	readonly [TIndex in keyof TServices]: ServiceIdentifier<TServices[TIndex]>;
};

/**
 * Recreates a disposable class when its defining module reloads.
 * The `1` denotes one leading argument supplied by the caller; remaining
 * constructor arguments are resolved services.
 */
export function wrapInReloadableClass1<TArgument, TServices extends unknown[], TResult extends IDisposable>(
	getClass: () => DisposableConstructor1<TArgument, TServices, TResult>,
	...serviceDependenciesArgument: TServices extends [] ? [] : [serviceDependencies: ServiceDependencies<TServices>]
): ServiceConstructionDescriptor<IDisposable> {
	const serviceDependencies = serviceDependenciesArgument[0] ?? [];
	if (!isHotReloadEnabled()) {
		return new ServiceConstructionDescriptor(getClass(), { serviceDependencies });
	}

	class ReloadableWrapper extends Disposable {
		constructor(argument: TArgument, instantiationService: IInstantiationService) {
			super();
			this._register(autorunWithStore((reader, store) => {
				const Constructor = readHotReloadableExport(getClass(), reader);
				store.add(instantiationService.createInstance(
					new ServiceConstructionDescriptor(Constructor, { serviceDependencies }),
					argument,
				));
			}));
		}
	}

	return new ServiceConstructionDescriptor(ReloadableWrapper, {
		serviceDependencies: [IInstantiationService],
	});
}
