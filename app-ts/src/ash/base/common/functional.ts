/** Returns a function that evaluates the supplied function at most once. */
export function createSingleCallFunction<TArguments extends unknown[], TResult>(this: unknown, function_: (...arguments_: TArguments) => TResult, afterCall?: () => void): (...arguments_: TArguments) => TResult {
	const receiver = this;
	let called = false;
	let result: TResult;
	return function(...arguments_: TArguments): TResult {
		if (called) return result;
		called = true;
		try { result = function_.apply(receiver, arguments_); }
		finally { afterCall?.(); }
		return result;
	};
}
