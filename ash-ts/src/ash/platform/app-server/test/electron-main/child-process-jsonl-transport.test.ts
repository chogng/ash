import { strict as assert } from "node:assert";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { test } from "mocha";
import { PassThrough, Writable } from "node:stream";
import {
	ChildProcessJsonlTransport,
	type ChildProcessJsonlTransportOptions,
} from "../../../../platform/app-server/electron-main/child-process-jsonl-transport.js";
class FakeChildProcess extends EventEmitter {
	stdin: Writable = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.exitCode !== null || this.signalCode !== null) return false;
		this.signalCode = signal;
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}
}

function transport(
	child: FakeChildProcess,
	options?: ChildProcessJsonlTransportOptions,
): ChildProcessJsonlTransport {
	return new ChildProcessJsonlTransport(
		child as unknown as ChildProcessWithoutNullStreams,
		options,
	);
}

test("frames split UTF-8 code points incrementally on LF boundaries", async () => {
	const child = new FakeChildProcess();
	const jsonl = transport(child);
	const frames: string[] = [];
	jsonl.onFrame((frame) => frames.push(frame));
	const bytes = Buffer.from('{"message":"你好"}\n{"ok":true}\n', "utf8");

	child.stdout.write(bytes.subarray(0, 14));
	child.stdout.write(bytes.subarray(14, 17));
	child.stdout.write(bytes.subarray(17));

	assert.deepEqual(frames, ['{"message":"你好"}', '{"ok":true}']);
	await jsonl.close();
});

test("rejects an oversized unterminated frame before buffering more input", async () => {
	const child = new FakeChildProcess();
	const jsonl = transport(child, { maxFrameBytes: 4 });
	const closed = once(child, "exit");
	const failure = new Promise<Error>((resolve) => jsonl.onClose(resolve));

	child.stdout.write("12345");

	assert.match((await failure).message, /exceeds 4 bytes/);
	await closed;
});

test("rejects CRLF, empty frames, and invalid UTF-8", async () => {
	for (const [bytes, expected] of [
		[Buffer.from("{}\r\n"), /must use LF/],
		[Buffer.from("\n"), /empty JSONL frame/],
		[Buffer.from([0xff, 0x0a]), /invalid UTF-8/],
	] as const) {
		const child = new FakeChildProcess();
		const jsonl = transport(child);
		const failure = new Promise<Error>((resolve) => jsonl.onClose(resolve));
		child.stdout.write(bytes);
		assert.match((await failure).message, expected);
	}
});

test("waits for the stdin write callback and backpressure drain", async () => {
	const child = new FakeChildProcess();
	let written = "";
	child.stdin = new Writable({
		highWaterMark: 1,
		write(chunk: Buffer, _encoding, callback) {
			written += chunk.toString("utf8");
			setImmediate(callback);
		},
	});
	const jsonl = transport(child);

	await jsonl.send('{"id":1}');

	assert.equal(written, '{"id":1}\n');
	await jsonl.close();
});

test("bounds and redacts stderr diagnostics", async () => {
	const child = new FakeChildProcess();
	const jsonl = transport(child, { maxStderrBytes: 128 });
	child.stderr.write("discard-me-".repeat(20));
	child.stderr.write(" Authorization: Bearer super-secret-token\n");

	const diagnostics = jsonl.diagnostics();
	assert.ok(Buffer.byteLength(diagnostics, "utf8") < 160);
	assert.doesNotMatch(diagnostics, /super-secret-token/);
	assert.match(diagnostics, /\[REDACTED\]/);
	await jsonl.close();
});

test("close is asynchronous and idempotent", async () => {
	const child = new FakeChildProcess();
	const jsonl = transport(child);

	const first = jsonl.close();
	const second = jsonl.close();

	assert.equal(first, second);
	await first;
	assert.equal(child.signalCode, "SIGTERM");
});
