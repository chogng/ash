import { CancellationToken, CancellationTokenSource } from './cancellation.js';
import { canceled } from './errors.js';
import { DisposableStore, toDisposable } from './lifecycle.js';

export interface ReadableStreamEvents<T> {
	on(event: 'data', callback: (data: T) => void): void;
	on(event: 'error', callback: (error: Error) => void): void;
	on(event: 'end', callback: () => void): void;
}

export interface ReadableStream<T> extends ReadableStreamEvents<T> {
	pause(): void;
	resume(): void;
	destroy(): void;
	removeListener(event: string, callback: Function): void;
}

export interface WriteableStream<T> extends ReadableStream<T> {
	write(data: T): void | Promise<void>;
	error(error: Error): void;
	end(result?: T): void;
}

export interface IReducer<T, R = T> { (data: T[]): R; }
export interface IDataTransformer<T, R> { (data: T): R; }
export interface IErrorTransformer { (error: Error): Error; }
export interface ITransformer<T, R> { data: IDataTransformer<T, R>; error?: IErrorTransformer; }
export interface IStreamListener<T> {
	onData(data: T): void;
	onError(error: Error): void;
	onEnd(): void;
}

export interface WriteableStreamOptions { highWaterMark?: number; }

/** A paused stream owns its queued chunks until a consumer starts or destroys it. */
export function newWriteableStream<T>(reducer: IReducer<T> | null, options?: WriteableStreamOptions): WriteableStream<T> {
	const listeners = new Map<string, Set<Function>>();
	const buffered: T[] = [];
	const errors: Error[] = [];
	const blocked = new Set<() => void>();
	let paused = true;
	let ending = false;
	let destroyed = false;
	let flushing = false;
	const emit = (event: string, value?: unknown): void => {
		for (const listener of [...(listeners.get(event) ?? [])]) {
			if (!destroyed && listeners.get(event)?.has(listener)) { listener(value); }
		}
	};
	const releaseWriters = (): void => {
		for (const release of blocked) { release(); }
		blocked.clear();
	};
	const flush = (): void => {
		if (flushing || paused || destroyed) { return; }
		flushing = true;
		try {
			while (!paused && !destroyed && buffered.length && listeners.get('data')?.size) {
				const chunks = buffered.splice(0, reducer ? buffered.length : 1);
				emit('data', reducer ? reducer(chunks) : chunks[0]);
			}
			if (buffered.length === 0) { releaseWriters(); }
			while (!paused && !destroyed && errors.length && listeners.get('error')?.size) {
				emit('error', errors.shift());
			}
			if (!paused && !destroyed && ending && buffered.length === 0 && errors.length === 0 && listeners.get('end')?.size) {
				emit('end');
				stream.destroy();
			}
		} finally { flushing = false; }
	};
	const stream: WriteableStream<T> = {
		on(event: string, callback: Function): void {
			if (destroyed) { return; }
			let callbacks = listeners.get(event);
			if (!callbacks) { callbacks = new Set(); listeners.set(event, callbacks); }
			callbacks.add(callback);
			if (event === 'data') { paused = false; }
			flush();
		},
		removeListener(event: string, callback: Function): void { listeners.get(event)?.delete(callback); },
		pause(): void { paused = true; },
		resume(): void { paused = false; flush(); },
		destroy(): void {
			destroyed = true;
			buffered.length = errors.length = 0;
			listeners.clear();
			releaseWriters();
		},
		write(data: T): void | Promise<void> {
			if (destroyed || ending) { return; }
			buffered.push(data);
			flush();
			if (options?.highWaterMark !== undefined && buffered.length > options.highWaterMark) {
				return new Promise<void>(resolve => blocked.add(resolve));
			}
		},
		error(error: Error): void {
			if (destroyed) { return; }
			errors.push(error);
			flush();
		},
		end(result?: T): void {
			if (destroyed || ending) { return; }
			if (result !== undefined) { buffered.push(result); }
			ending = true;
			flush();
		},
	};
	return stream;
}

/** Registers terminal listeners before data can switch the stream into flowing mode. */
export function listenStream<T>(stream: ReadableStreamEvents<T>, listener: IStreamListener<T>, token: CancellationToken = CancellationToken.None): void {
	const lifetime = new DisposableStore();
	const stop = (): void => lifetime.dispose();
	const onError = (error: Error): void => { stop(); listener.onError(error); };
	const onEnd = (): void => { stop(); listener.onEnd(); };
	const onData = (data: T): void => listener.onData(data);
	const removable = stream as Partial<ReadableStream<T>>;
	lifetime.add(toDisposable(() => {
		removable.removeListener?.('error', onError);
		removable.removeListener?.('end', onEnd);
		removable.removeListener?.('data', onData);
	}));
	if (token.isCancellationRequested) { onError(canceled()); return; }
	lifetime.add(token.onCancellationRequested(() => onError(canceled())));
	stream.on('error', onError);
	stream.on('end', onEnd);
	stream.on('data', onData);
}

export function consumeStream<T, R = T>(stream: ReadableStreamEvents<T>, reducer: IReducer<T, R>): Promise<R>;
export function consumeStream(stream: ReadableStreamEvents<unknown>): Promise<undefined>;
export function consumeStream<T, R>(stream: ReadableStreamEvents<T>, reducer?: IReducer<T, R>): Promise<R | undefined> {
	return new Promise((resolve, reject) => {
		const chunks: T[] = [];
		listenStream(stream, {
			onData: chunk => { if (reducer) { chunks.push(chunk); } },
			onError: error => { chunks.length = 0; reject(error); (stream as Partial<ReadableStream<T>>).destroy?.(); },
			onEnd: () => {
				try { resolve(reducer?.(chunks)); } catch (error) { reject(error); }
			},
		});
	});
}

/** Keeps transformation buffering bounded and propagates consumer destruction to the source. */
export function transform<T, R>(source: ReadableStreamEvents<T>, transformer: ITransformer<T, R>, reducer: IReducer<R>): ReadableStream<R> {
	const target = newWriteableStream(reducer, { highWaterMark: 1 });
	const cancellation = new CancellationTokenSource();
	const originalDestroy = target.destroy;
	const readable = source as Partial<ReadableStream<T>>;
	target.destroy = (): void => {
		cancellation.dispose(true);
		readable.destroy?.();
		originalDestroy();
	};
	listenStream(source, {
		onData: data => {
			let pending: void | Promise<void>;
			try { pending = target.write(transformer.data(data)); }
			catch (error) { target.error(error instanceof Error ? error : new Error(String(error))); target.end(); return; }
			if (pending) {
				readable.pause?.();
				void pending.then(() => readable.resume?.());
			}
		},
		onError: error => { target.error(transformer.error?.(error) ?? error); target.end(); },
		onEnd: () => { cancellation.dispose(); target.end(); },
	}, cancellation.token);
	return target;
}
