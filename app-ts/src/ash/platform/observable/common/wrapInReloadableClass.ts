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
 * The `1` denotes one leading argument supplied by the caller; remaining
 * constructor arguments are resolved services.
 */
export function wrapInReloadableClass1<TArgument, TServices extends unknown[], TResult extends IDisposable>(
	getClass: () => DisposableConstructor1<TArgument, TServices, TResult>,
): new (argument: TArgument, ...services: any[]) => IDisposable {
	if (!isHotReloadEnabled()) {
		return getClass();
	}
	return wrapInHotClass1(derived(reader => readHotReloadableExport(getClass(), reader)));
}
