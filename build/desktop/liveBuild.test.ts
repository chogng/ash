import assert from 'node:assert/strict';
import childProcess, { ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';

import { LiveBuilder } from './liveBuild.ts';

function worker(t: TestContext) {
	const children: { child: ChildProcess; input: PassThrough; output: PassThrough; requests: { id: number; }[]; }[] = [];
	t.mock.method(childProcess, 'spawn', () => {
		const child = new ChildProcess();
		const input = new PassThrough();
		const output = new PassThrough();
		const requests: { id: number; }[] = [];
		Object.assign(child, { stdin: input, stdout: output });
		input.on('data', (chunk: Buffer) => requests.push(JSON.parse(chunk.toString())));
		input.on('finish', () => setImmediate(() => child.emit('close', 0, null)));
		children.push({ child, input, output, requests });
		setImmediate(() => output.write('{"protocol_version":1,"id":null,"result":{"event":"ready"}}\n'));
		return child;
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const builder = new LiveBuilder(process.cwd(), {});
	t.after(async () => builder.stop());
	return { builder, children };
}

async function requested(requests: { id: number; }[], count: number): Promise<void> {
	while (requests.length < count) await new Promise(resolve => setImmediate(resolve));
}

test('consecutive builds reuse a worker after a compiler error and EOF stops it', async t => {
	const { builder, children } = worker(t);
	const first = builder.build();
	const child = children[0]!;
	await requested(child.requests, 1);
	child.output.write('{"protocol_version":1,"id":1,"error":"E0308"}\n');
	await assert.rejects(first, /E0308/);
	const next = builder.build();
	await requested(child.requests, 2);
	// Responses may be split across pipe chunks.
	child.output.write('{"protocol_version":1,"id":2,');
	child.output.write('"result":{"kind":"function"}}\n');
	await next;
	assert.equal(children.length, 1);
	await builder.stop();
	assert.equal(child.input.writableEnded, true);
});

test('a crashed worker rejects the build and the next save starts a fresh session', async t => {
	const { builder, children } = worker(t);
	const first = builder.build();
	await requested(children[0]!.requests, 1);
	children[0]!.child.emit('close', 1, null);
	await assert.rejects(first, /session closed/);
	const retry = builder.build();
	await requested(children[1]!.requests, 1);
	children[1]!.output.write('{"protocol_version":1,"id":2,"result":{"kind":"module"}}\n');
	await retry;
	assert.equal(children.length, 2);
});

test('a stale reply retires the worker instead of acknowledging the new edit', async t => {
	const { builder, children } = worker(t);
	const first = builder.build();
	await requested(children[0]!.requests, 1);
	children[0]!.output.write('{"protocol_version":1,"id":9,"result":{"kind":"function"}}\n');
	await assert.rejects(first, /mismatched/);
	await builder.stop();
	assert.equal(children[0]!.input.writableEnded, true);
});
