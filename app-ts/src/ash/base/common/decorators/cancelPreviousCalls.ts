import { CancellationToken, CancellationTokenSource } from '../cancellation.js';
import { Disposable, toDisposable } from '../lifecycle.js';

type WithOptionalCancellationToken<TFunction extends (...args: any[]) => unknown> =
	TFunction extends (...args: infer TArgs) => infer TResult
		? (...args: [...TArgs, cancellationToken?: CancellationToken]) => TResult
		: never;

/**
 * Supply an optional final CancellationToken to a method on a Disposable instance.
 * Omit the token or pass one explicitly; a supplied token becomes the parent of the new call's token.
 * Repeating the same method on the same instance cancels its preceding token without affecting other methods or instances.
 * Owner disposal releases the current source without canceling its token; the method must observe cancellation cooperatively.
 */
export function cancelPreviousCalls<TObject extends Disposable, TArgs extends unknown[], TResult>(
	_proto: TObject,
	methodName: string,
	descriptor: TypedPropertyDescriptor<WithOptionalCancellationToken<(...args: TArgs) => TResult>>,
): TypedPropertyDescriptor<WithOptionalCancellationToken<(...args: TArgs) => TResult>> {
	const method = descriptor.value;
	if (!method) throw new TypeError(`Method '${methodName}' is not defined`);

	const active = new WeakMap<TObject, CancellationTokenSource>();
	descriptor.value = function (this: TObject, ...args: Parameters<typeof method>): TResult {
		const previous = active.get(this);
		previous?.dispose(true);

		const lastArgument = args.at(-1);
		const parent = CancellationToken.isCancellationToken(lastArgument) ? lastArgument : undefined;
		const source = new CancellationTokenSource(parent);
		active.set(this, source);
		if (CancellationToken.isCancellationToken(lastArgument)) {
			args[args.length - 1] = source.token;
		} else {
			args.push(source.token);
		}
		if (!previous) {
			this._register(toDisposable(() => {
				active.get(this)?.dispose();
				active.delete(this);
			}));
		}
		return method.apply(this, args);
	};
	return descriptor;
}
