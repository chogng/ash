import { isHotReloadEnabled } from '../../../base/common/hotReload.js';
import { readHotReloadableExport } from '../../../base/common/hotReloadHelpers.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { derived } from '../../../base/common/observable.js';
import { wrapInHotClass1 } from './wrapInHotClass.js';

type DisposableConstructor1<TArgument, TServices extends unknown[], TResult extends IDisposable> = new (
	argument: TArgument,
	...services: TServices
) => TResult;

/**
 * Recreates a disposable class when its defining module reloads.
 * The `1` denotes one leading argument supplied by the caller; constructor
 * service parameters are resolved by the instantiation service.
 */
export function wrapInReloadableClass1<TArgument, TServices extends unknown[], TResult extends IDisposable>(
	getClass: () => DisposableConstructor1<TArgument, TServices, TResult>,
): new (argument: TArgument) => TResult {
	if (!isHotReloadEnabled()) {
		// The service parameters of the returned constructor are container-resolved and not caller-supplied.
		return getClass() as unknown as new (argument: TArgument) => TResult;
	}
	return wrapInHotClass1(derived(reader => readHotReloadableExport(getClass(), reader)));
}
