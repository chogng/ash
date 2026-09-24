import assert from "node:assert/strict";
import { test } from "mocha";
import type { IDisposable } from "../../../base/common/lifecycle.js";
import { start, type StanzaWorkerPort } from "../../editor.worker.start.js";

test("Stanza worker bootstrap owns one structured-clone port lifecycle", () => {
	const port = new FakeWorkerPort();
	let received: unknown;
	let resources: { dispose(): void } | undefined;

	start(context => {
		resources = context.resources;
		context.port.onMessage(message => {
			received = message;
			context.port.send({ kind: "ack", message });
		});
	}, () => port);

	assert.throws(() => start(() => undefined, () => new FakeWorkerPort()), /already started/);
	port.receive({ kind: "request" });
	assert.deepEqual(received, { kind: "request" });
	assert.deepEqual(port.sent, [{ kind: "ack", message: { kind: "request" } }]);

	resources?.dispose();
	assert.equal(port.disposed, true);
	assert.doesNotThrow(() => start(context => context.resources.dispose(), () => new FakeWorkerPort()));
});

class FakeWorkerPort implements StanzaWorkerPort {
	private readonly listeners = new Set<(message: unknown) => void>();
	readonly sent: unknown[] = [];
	disposed = false;
	readonly onMessage = (listener: (message: unknown) => void): IDisposable => {
		if (this.disposed) throw new ReferenceError("Fake worker port is disposed");
		this.listeners.add(listener);
		const dispose = (): void => {
			this.listeners.delete(listener);
		};
		return { dispose, [Symbol.dispose]: dispose };
	};

	send(message: unknown): void {
		if (this.disposed) throw new ReferenceError("Fake worker port is disposed");
		this.sent.push(message);
	}

	receive(message: unknown): void {
		if (this.disposed) throw new ReferenceError("Fake worker port is disposed");
		for (const listener of this.listeners) listener(message);
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}
