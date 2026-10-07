import { VSBuffer } from '../../../base/common/buffer.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import type { IDataTransformer, IErrorTransformer, WriteableStream } from '../../../base/common/stream.js';
import type { URI } from '../../../base/common/uri.js';
import {
	createFileSystemProviderError,
	FileSystemProviderErrorCode,
	type IFileReadStreamOptions,
	type IFileSystemProviderWithOpenReadWriteCloseCapability,
} from './files.js';

export interface ICreateReadStreamOptions extends IFileReadStreamOptions {
	readonly bufferSize: number;
	readonly errorTransformer?: IErrorTransformer;
}

/** Reads independent chunks while retaining a single descriptor until completion or cancellation. */
export async function readFileIntoStream<T>(provider: IFileSystemProviderWithOpenReadWriteCloseCapability, resource: URI, target: WriteableStream<T>, transformer: IDataTransformer<VSBuffer, T>, options: ICreateReadStreamOptions, token: CancellationToken): Promise<void> {
	let descriptor: number | undefined;
	let failure: Error | undefined;
	const checkCancellation = (): void => { if (token.isCancellationRequested) { throw canceled(); } };
	try {
		checkCancellation();
		for (const value of [options.bufferSize, options.position ?? 0, options.length, options.limits?.size]) {
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) { throw new RangeError('Invalid file read range or size'); }
		}
		if (options.bufferSize === 0) { throw new RangeError('File read buffer must not be empty'); }
		descriptor = await provider.open(resource, { create: false });
		let position = options.position ?? 0;
		let remaining = options.length ?? Infinity;
		let total = 0;
		while (remaining > 0) {
			checkCancellation();
			const chunk = VSBuffer.alloc(Math.min(options.bufferSize, remaining));
			const count = await provider.read(descriptor, position, chunk.buffer, 0, chunk.byteLength);
			checkCancellation();
			if (count === 0) { break; }
			if (!Number.isInteger(count) || count < 0 || count > chunk.byteLength) { throw new Error('Invalid file read count'); }
			total += count;
			if (options.limits?.size !== undefined && total > options.limits.size) {
				throw createFileSystemProviderError('File exceeds the read size limit', FileSystemProviderErrorCode.FileTooLarge);
			}
			position += count;
			remaining -= count;
			await raceCancellationError(Promise.resolve(target.write(transformer(count === chunk.byteLength ? chunk : chunk.slice(0, count)))), token);
		}
	} catch (error) {
		failure = error instanceof Error ? error : new Error(String(error));
	} finally {
		if (descriptor !== undefined) {
			try { await provider.close(descriptor); } catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
		}
		if (failure) { target.error(options.errorTransformer?.(failure) ?? failure); }
		target.end();
	}
}
