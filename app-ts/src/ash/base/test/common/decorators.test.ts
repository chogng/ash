import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../common/cancellation.js';
import { cancelPreviousCalls, debounce, memoize, throttle } from '../../common/decorators.js';
import { Disposable } from '../../common/lifecycle.js';

suite('Decorators', () => {
	test('memoize caches methods and getters independently per instance', () => {
		class Example {
			public calls = 0;
			constructor(private readonly result: number | null) {}

			@memoize
			public value(): number | null {
				this.calls += 1;
				return this.result;
			}

			@memoize
			public get label(): string {
				this.calls += 1;
				return String(this.result);
			}
		}

		const first = new Example(null);
		const second = new Example(2);
		assert.deepEqual([first.value(), first.value(), first.label, first.label, first.calls], [null, null, 'null', 'null', 2]);
		assert.deepEqual([second.value(), second.label, second.calls], [2, '2', 2]);
		assert.deepEqual(Object.keys(first).sort(), ['calls', 'result']);
		assert.equal(Object.getOwnPropertyDescriptor(first, '$memoize$value')?.writable, false);
	});

	test('debounce sends the reduced value once after the quiet period', async () => {
		let complete!: (value: number) => void;
		const result = new Promise<number>(resolve => complete = resolve);
		class Example {
			@debounce(0, (total: number, value: number) => total + value, () => 0)
			public report(value: number): void {
				complete(value);
			}
		}
		const example = new Example();
		example.report(1);
		example.report(2);
		assert.equal(await result, 3);
	});

	test('debounce forwards the final call arguments without a reducer', async () => {
		let complete!: (value: string) => void;
		const result = new Promise<string>(resolve => complete = resolve);
		class Example {
			@debounce(0)
			public report(value: string): void {
				complete(value);
			}
		}
		const example = new Example();
		example.report('first');
		example.report('last');
		assert.equal(await result, 'last');
	});

	test('throttle runs immediately and reduces calls within the interval', async () => {
		const seen: number[] = [];
		let complete!: (value: number[]) => void;
		const result = new Promise<number[]>(resolve => complete = resolve);
		class Example {
			@throttle(10, (total: number, value: number) => total + value, () => 0)
			public report(value: number): void {
				seen.push(value);
				if (seen.length === 2) complete([...seen]);
			}
		}
		const example = new Example();
		example.report(1);
		example.report(2);
		example.report(3);
		assert.deepEqual(await result, [1, 5]);
	});

	test('throttle passes the initial value when no reducer is supplied', () => {
		const seen: number[] = [];
		let initializations = 0;
		class Example {
			@throttle(0, undefined, () => ++initializations)
			public report(value: number): void {
				seen.push(value);
			}
		}
		const example = new Example();
		example.report(100);
		example.report(200);
		assert.deepEqual({ seen, initializations }, { seen: [1, 2], initializations: 2 });
	});

	test('cancelPreviousCalls supersedes only the same instance and method', () => {
		class Example extends Disposable {
			public readonly tokens: CancellationToken[] = [];
			public readonly otherTokens: CancellationToken[] = [];

			@cancelPreviousCalls
			public run(value: number, token?: CancellationToken): number {
				assert.ok(token);
				this.tokens.push(token);
				return value;
			}

			@cancelPreviousCalls
			public other(token?: CancellationToken): void {
				assert.ok(token);
				this.otherTokens.push(token);
			}
		}

		using parent = new CancellationTokenSource();
		const first = new Example();
		const second = new Example();
		assert.equal(first.run(1), 1);
		assert.equal(second.run(2), 2);
		first.other();
		assert.equal(first.tokens[0]?.isCancellationRequested, false);
		first.run(3, parent.token);
		assert.equal(first.tokens[0]?.isCancellationRequested, true);
		assert.equal(first.otherTokens[0]?.isCancellationRequested, false);
		assert.equal(second.tokens[0]?.isCancellationRequested, false);
		parent.cancel();
		assert.equal(first.tokens[1]?.isCancellationRequested, true);
		second.dispose();
		assert.equal(second.tokens[0]?.isCancellationRequested, false);
		first.dispose();
		assert.equal(first.otherTokens[0]?.isCancellationRequested, false);
	});
});
