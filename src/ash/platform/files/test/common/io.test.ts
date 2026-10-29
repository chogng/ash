import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { consumeStream, newWriteableStream } from '../../../../base/common/stream.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { readFileIntoStream } from '../../common/io.js';
import { DiskFileSystemProvider } from '../../node/diskFileSystemProvider.js';

suite('File stream IO', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('emits independent ranged chunks and closes the descriptor on completion', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-file-stream-'));
		using provider = new DiskFileSystemProvider([URI.file(directory)]);
		try {
			const resource = URI.file(join(directory, 'bytes.bin'));
			await writeFile(resource.fsPath, new Uint8Array([0, 1, 2, 3, 4, 5]));
			const stream = newWriteableStream<Uint8Array>(null);
			const producer = readFileIntoStream(provider, resource, stream, buffer => buffer.buffer, { bufferSize: 2, position: 1, length: 4 }, CancellationToken.None);
			const chunks = await consumeStream(stream, values => values.map(value => [...value]));
			await producer;
			assert.deepEqual(chunks, [[1, 2], [3, 4]]);
			// Windows cannot remove an open file lacking delete sharing; also exercise the public closed handle guard.
			await assert.rejects(provider.read(1, 0, new Uint8Array(1), 0, 1), /closed/);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('cancellation while backpressured rejects the read and closes its descriptor', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-file-cancel-'));
		using cancellation = new CancellationTokenSource();
		using provider = new DiskFileSystemProvider([URI.file(directory)]);
		try {
			const resource = URI.file(join(directory, 'bytes.bin'));
			await writeFile(resource.fsPath, new Uint8Array([0, 1, 2, 3]));
			const stream = newWriteableStream<Uint8Array>(null, { highWaterMark: 0 });
			const blocked = new DeferredPromise<void>();
			const write = stream.write;
			stream.write = data => {
				const result = write(data);
				if (result instanceof Promise) { void blocked.complete(); }
				return result;
			};
			const producer = readFileIntoStream(provider, resource, stream, buffer => buffer.buffer, { bufferSize: 1 }, cancellation.token);
			await blocked.p;
			cancellation.cancel();
			await producer;
			await assert.rejects(consumeStream(stream), CancellationError);
			await assert.rejects(provider.read(1, 0, new Uint8Array(1), 0, 1), /closed/);
			stream.destroy();
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
});
