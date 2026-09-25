type DecoratedMethod = (...args: unknown[]) => unknown;

function methodFrom(descriptor: PropertyDescriptor): { readonly key: 'value' | 'get'; readonly method: DecoratedMethod } {
	if (typeof descriptor.value === 'function') return { key: 'value', method: descriptor.value };
	if (typeof descriptor.get === 'function') return { key: 'get', method: descriptor.get };
	throw new TypeError('Decorator requires a method or getter');
}

/**
 * Cache the first result of a zero-argument method or getter on each instance.
 * Null and undefined are cached too; the hidden instance property cannot be overwritten or invalidated.
 * A method with parameters is accepted but warns because later arguments will be ignored.
 */
export function memoize(_target: object, key: string, descriptor: PropertyDescriptor): void {
	const { key: descriptorKey, method } = methodFrom(descriptor);
	if (descriptorKey === 'value' && method.length !== 0) {
		console.warn('Memoize should only be used in functions with zero parameters');
	}
	const cacheKey = `$memoize$${key}`;
	descriptor[descriptorKey] = function (this: Record<string, unknown>, ...args: unknown[]): unknown {
		if (!Object.prototype.hasOwnProperty.call(this, cacheKey)) {
			Object.defineProperty(this, cacheKey, {
				value: method.apply(this, args),
				configurable: false,
				enumerable: false,
				writable: false,
			});
		}
		return this[cacheKey];
	};
}

/** Combines calls during a debounce or throttle interval with the prior accumulated value. */
export interface IDebounceReducer<T> {
	(previousValue: T, ...args: any[]): T;
}

/**
 * Invoke after calls stop for `delay` milliseconds, discarding the decorated method's return value.
 * A reducer accumulates calls from the optional initial value; otherwise the last call's arguments are forwarded.
 * The timer is not tied to the receiver's disposal.
 */
export function debounce<T>(delay: number, reducer?: IDebounceReducer<T>, initialValueProvider?: () => T): MethodDecorator {
	return (_target, propertyKey, descriptor) => {
		if (typeof propertyKey === 'symbol') throw new TypeError('Decorator does not support symbol keys');
		const property = descriptor as PropertyDescriptor;
		const { key, method } = methodFrom(property);
		const states = new WeakMap<object, { timer: ReturnType<typeof setTimeout>; value: T | undefined }>();
		property[key] = function (this: object, ...args: unknown[]): void {
			const previous = states.get(this);
			if (previous) clearTimeout(previous.timer);
			const accumulated = previous ? previous.value : initialValueProvider?.();
			const value = reducer
				? reducer(accumulated as T, ...args)
				: undefined;
			const timer = setTimeout(() => {
				states.delete(this);
				method.apply(this, reducer ? [value] : args);
			}, delay);
			states.set(this, { timer, value });
		};
	};
}

/**
 * Invoke immediately, then at most once per `delay` milliseconds, with one accumulated argument.
 * A reducer combines calls from the optional initial value; without a reducer, input arguments are ignored.
 * The decorated method's return value is discarded and pending timers are not tied to disposal.
 */
export function throttle<T>(delay: number, reducer?: IDebounceReducer<T>, initialValueProvider?: () => T): MethodDecorator {
	return (_target, propertyKey, descriptor) => {
		if (typeof propertyKey === 'symbol') throw new TypeError('Decorator does not support symbol keys');
		const property = descriptor as PropertyDescriptor;
		const { key, method } = methodFrom(property);
		interface State {
			lastRun: number;
			pending: boolean;
			hasValue: boolean;
			value: T | undefined;
		}
		const states = new WeakMap<object, State>();
		property[key] = function (this: object, ...args: unknown[]): void {
			let state = states.get(this);
			if (!state) {
				state = { lastRun: -Infinity, pending: false, hasValue: false, value: undefined };
				states.set(this, state);
			}
			if (!state.hasValue) {
				state.value = initialValueProvider?.();
				state.hasValue = true;
			}
			if (reducer) state.value = reducer(state.value as T, ...args);
			if (state.pending) return;

			const run = (): void => {
				state.lastRun = Date.now();
				state.pending = false;
				const value = state.value;
				state.value = undefined;
				state.hasValue = false;
				method.call(this, value);
			};
			const remaining = state.lastRun + delay - Date.now();
			if (remaining <= 0) {
				run();
			} else {
				state.pending = true;
				setTimeout(run, remaining);
			}
		};
	};
}

export { cancelPreviousCalls } from './decorators/cancelPreviousCalls.js';
