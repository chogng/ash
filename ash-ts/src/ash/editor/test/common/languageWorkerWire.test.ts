import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, DisposableStore, toDisposable } from "../../../base/common/lifecycle.js";
import { createLanguageCompletionInvokeContext, LanguageCompletionProviderRegistry, type LanguageCompletionRequest } from "../../common/languages/completion/languageCompletionProviders.js";
import { LANGUAGE_COMPLETION_LANE, LanguageCompletionProviderWorker, LanguageCompletionService, type LanguageCompletionWorker } from "../../common/languages/completion/languageCompletionService.js";
import { languageCompletionWireCodec } from "../../common/languages/completion/languageCompletionWire.js";
import { LanguageCompletionItemKind } from "../../common/languages/completion/languageCompletions.js";
import { createLanguageWordCompletionProvider } from "../../common/languages/completion/languageWordCompletionProvider.js";
import { LanguageWorkerRemoteError, LanguageWorkerWireClient, LanguageWorkerWireServer, type LanguageWorkerWireClientPort } from "../../common/languages/languageWorkerWire.js";
import { LanguageRequestStatus, type LanguageWorkerRequest } from "../../common/languages/languageRequestCoordinator.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";
import { type TextModelChange } from '../../common/core/textChange.js';

test("Completion service crosses a structured-clone worker boundary", async () => {
	const text = "console\nconst connection = con";
	using model = new TextModel(text);
	using localRegistry = new LanguageCompletionProviderRegistry();
	using remoteRegistry = new LanguageCompletionProviderRegistry();
	using remoteRegistration = remoteRegistry.register(createLanguageWordCompletionProvider());
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(
		serverPort,
		languageCompletionWireCodec,
		new LanguageCompletionProviderWorker(remoteRegistry),
	);
	using service = new LanguageCompletionService(model, localRegistry, {
		workerFactory: () => new LanguageWorkerWireClient(clientPort, languageCompletionWireCodec),
	});
	const line = "const connection = con";
	const position = new Position((1) + 1, (line.length) + 1);

	const outcome = await service.request("typescript", position, createLanguageCompletionInvokeContext());

	assert.equal(outcome.status, LanguageRequestStatus.Applied);
	const result = service.results.result!.value;
	assert.deepEqual(result.items.map(item => item.label), ["connection", "console", "const"]);
	assert.equal(result.items.every(item => item.providerId === "language.word"), true);
	assert.equal(result.position instanceof Position, true);
	assert.equal(result.items[0]!.range instanceof Range, true);
	assert.deepEqual(result.items[0]!.range, Range.fromPositions(
		new Position((1) + 1, (line.length - 3) + 1),
		position,
	));
});

test("Completion wire synchronizes model changes and then references the mirror", async () => {
	using model = new TextModel("alpha al");
	using localRegistry = new LanguageCompletionProviderRegistry();
	using remoteRegistry = new LanguageCompletionProviderRegistry();
	using remoteRegistration = remoteRegistry.register(createLanguageWordCompletionProvider());
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(
		serverPort,
		languageCompletionWireCodec,
		new LanguageCompletionProviderWorker(remoteRegistry),
	);
	using service = new LanguageCompletionService(model, localRegistry, {
		workerFactory: () => new LanguageWorkerWireClient(clientPort, languageCompletionWireCodec),
	});
	const firstPosition = new Position((0) + 1, (model.getText().length) + 1);
	assert.equal((await service.request("plaintext", firstPosition, createLanguageCompletionInvokeContext())).status, LanguageRequestStatus.Applied);

	model.applyEdits([{
		range: Range.fromPositions(firstPosition),
		text: "p",
	}]);
	const secondPosition = new Position((0) + 1, (model.getText().length) + 1);
	assert.equal((await service.request("plaintext", secondPosition, createLanguageCompletionInvokeContext())).status, LanguageRequestStatus.Applied);

	assert.deepEqual(service.results.result!.value.items.map(item => item.label), ["alpha"]);
	const messages = clientPort.sentMessages as WireMessage[];
	assert.deepEqual(messages.map(message => message.kind), ["request", "sync", "request"]);
	assert.equal(messages[0]!.snapshot?.kind, "full");
	assert.equal(messages[0]!.snapshot?.text, "alpha al");
	assert.equal(messages[1]!.previousVersion, 1);
	assert.deepEqual(messages[1]!.changes, [{ rangeOffset: 8, rangeLength: 0, text: "p" }]);
	assert.equal(messages[2]!.snapshot?.kind, "reference");
	assert.equal("text" in messages[2]!.snapshot!, false);
});

test("A skipped model version makes the next wire request send a full snapshot", async () => {
	using model = new TextModel("alpha al");
	using registry = new LanguageCompletionProviderRegistry();
	using registration = registry.register(createLanguageWordCompletionProvider());
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(
		serverPort,
		languageCompletionWireCodec,
		new LanguageCompletionProviderWorker(registry),
	);
	using client = new LanguageWorkerWireClient(clientPort, languageCompletionWireCodec);
	await client.run(request(model, 1), new AbortController().signal);
	let skipped: TextModelChange | undefined;
	using listener = model.onDidChangeContent(change => { skipped = change; });
	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (8) + 1)), text: "p" }]);
	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (9) + 1)), text: "h" }]);

	client.synchronizeModel(skipped!);
	await client.run(request(model, 2), new AbortController().signal);

	const messages = clientPort.sentMessages as WireMessage[];
	assert.deepEqual(messages.map(message => message.kind), ["request", "request"]);
	assert.equal(messages[1]!.snapshot?.kind, "full");
	assert.equal(messages[1]!.snapshot?.text, "alpha alph");
});

test("Wire cancellation aborts remote work and ignores late messages", async () => {
	const [clientPort, serverPort] = createPortPair();
	let startRequest!: () => void;
	const started = new Promise<void>(resolve => {
		startRequest = resolve;
	});
	let observeAbort!: () => void;
	const aborted = new Promise<void>(resolve => {
		observeAbort = resolve;
	});
	const worker = new TestCompletionWorker(async (_request, signal) => {
		startRequest();
		await new Promise<void>((_resolve, reject) => {
			signal.addEventListener("abort", () => {
				observeAbort();
				reject(new Error("remote cancelled"));
			}, { once: true });
		});
		throw new Error("unreachable");
	});
	using server = new LanguageWorkerWireServer(serverPort, languageCompletionWireCodec, worker);
	using client = new LanguageWorkerWireClient(clientPort, languageCompletionWireCodec);
	using model = new TextModel("value");
	const controller = new AbortController();
	const promise = client.run(request(model, 1), controller.signal);
	await started;

	controller.abort("superseded");

	await assert.rejects(promise, error => error instanceof Error && error.name === "AbortError");
	await aborted;
});

test("Remote failures and invalid DTO results reject in the client realm", async () => {
	await assertRemoteFailure(
		new TestCompletionWorker(async () => {
			throw new TypeError("provider host exploded");
		}),
		error => error instanceof LanguageWorkerRemoteError &&
			error.remoteName === "TypeError" &&
			error.message === "provider host exploded",
	);
	await assertRemoteFailure(
		new TestCompletionWorker(async request => ({
			position: request.payload.position,
			items: [{
				providerId: "broken",
				id: "outside",
				label: "outside",
				kind: LanguageCompletionItemKind.Text,
				range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (99) + 1)),
				insertText: "outside",
			}],
			isIncomplete: false,
		})),
		error => error instanceof RangeError &&
			error.message.includes("outside its snapshot"),
	);
});

test("Completion service replaces a failed wire worker on the next request", async () => {
	using model = new TextModel("console con");
	using localRegistry = new LanguageCompletionProviderRegistry();
	using remoteRegistry = new LanguageCompletionProviderRegistry();
	using remoteRegistration = remoteRegistry.register(createLanguageWordCompletionProvider());
	using servers = new DisposableStore();
	let workerCount = 0;
	using service = new LanguageCompletionService(model, localRegistry, {
		workerFactory: () => {
			workerCount += 1;
			const [clientPort, serverPort] = createPortPair();
			const worker = workerCount === 1
				? new TestCompletionWorker(async () => {
					throw new Error("first worker failed");
				})
				: new LanguageCompletionProviderWorker(remoteRegistry);
			servers.add(new LanguageWorkerWireServer(serverPort, languageCompletionWireCodec, worker));
			return new LanguageWorkerWireClient(clientPort, languageCompletionWireCodec);
		},
	});
	const position = new Position((0) + 1, (model.getText().length) + 1);

	await assert.rejects(service.request("typescript", position, createLanguageCompletionInvokeContext()), /first worker failed/);
	const outcome = await service.request("typescript", position, createLanguageCompletionInvokeContext());

	assert.equal(outcome.status, LanguageRequestStatus.Applied);
	assert.equal(workerCount, 2);
	assert.deepEqual(service.results.result!.value.items.map(item => item.label), ["console"]);
});

test("Wire rejects inconsistent snapshots and unsupported protocol responses", async () => {
	const [requestPort, serverPort] = createPortPair();
	using requester = requestPort;
	const worker = new TestCompletionWorker(async () => {
		throw new Error("Malformed requests must not reach the worker");
	});
	using server = new LanguageWorkerWireServer(serverPort, languageCompletionWireCodec, worker);
	const response = nextMessage(requester);
	requester.send({
		protocol: "ash.language-worker",
		version: 5,
		kind: "request",
		requestId: 1,
		lane: LANGUAGE_COMPLETION_LANE,
		snapshot: { kind: "full", version: 1, length: 99, lineCount: 1, text: "x" },
		payload: {},
	});

	assert.match((await response as WireFailure).error.message, /length does not match/);

	const [clientPort, peerPort] = createPortPair();
	using peer = peerPort;
	using client = new LanguageWorkerWireClient(clientPort, languageCompletionWireCodec);
	using model = new TextModel("value");
	const pending = client.run(request(model, 1), new AbortController().signal);
	peerPort.send({
		protocol: "ash.language-worker",
		version: 6,
		kind: "result",
		requestId: 1,
		result: {},
	});

	await assert.rejects(pending, /Unsupported language worker protocol version/);
});

test("Invalid incremental synchronization drops the mirror and poisons its client", async () => {
	using model = new TextModel("alpha al");
	using registry = new LanguageCompletionProviderRegistry();
	using registration = registry.register(createLanguageWordCompletionProvider());
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(
		serverPort,
		languageCompletionWireCodec,
		new LanguageCompletionProviderWorker(registry),
	);
	using client = new LanguageWorkerWireClient(clientPort, languageCompletionWireCodec);
	await client.run(request(model, 1), new AbortController().signal);

	clientPort.send({
		protocol: "ash.language-worker",
		version: 5,
		kind: "sync",
		previousVersion: 1,
		modelVersion: 2,
		eol: '\n',
		changes: [{ rangeOffset: 99, rangeLength: 0, text: "!" }],
	});
	await new Promise<void>(resolve => setImmediate(resolve));

	assert.throws(
		() => client.run(request(model, 2), new AbortController().signal),
		/inside the mirror/,
	);
});

test("Wire ports fail pending requests and validate service factory options", async () => {
	const [clientPort, peerPort] = createPortPair();
	using unusedPeer = peerPort;
	using client = new LanguageWorkerWireClient(clientPort, languageCompletionWireCodec);
	using model = new TextModel("value");
	const pending = client.run(request(model, 1), new AbortController().signal);

	clientPort.fail(new Error("worker process crashed"));

	await assert.rejects(pending, /worker process crashed/);
	assert.throws(() => client.run(request(model, 2), new AbortController().signal), /worker process crashed/);
	using registry = new LanguageCompletionProviderRegistry();
	assert.throws(() => new LanguageCompletionService(model, registry, {
		workerFactory: () => client,
		onProviderError: () => undefined,
	}), /owns its provider error policy/);
});

async function assertRemoteFailure(worker: LanguageCompletionWorker, predicate: (error: unknown) => boolean): Promise<void> {
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(serverPort, languageCompletionWireCodec, worker);
	using client = new LanguageWorkerWireClient(clientPort, languageCompletionWireCodec);
	using model = new TextModel("value");
	await assert.rejects(client.run(request(model, 1), new AbortController().signal), predicate);
}

function request(model: TextModel, requestId: number): LanguageWorkerRequest<typeof LANGUAGE_COMPLETION_LANE, LanguageCompletionRequest> {
	return Object.freeze({
		requestId,
		lane: LANGUAGE_COMPLETION_LANE,
		snapshot: model.createVersionedSnapshot(),
		payload: Object.freeze({
			languageId: "typescript",
			position: new Position((0) + 1, (model.getText().length) + 1),
			context: createLanguageCompletionInvokeContext(),
		}),
	});
}

function createPortPair(): readonly [MemoryWirePort, MemoryWirePort] {
	const first = new MemoryWirePort();
	const second = new MemoryWirePort();
	first.connect(second);
	second.connect(first);
	return [first, second];
}

interface WireFailure {
	readonly error: {
		readonly message: string;
	};
}

interface WireMessage {
	readonly kind: string;
	readonly previousVersion?: number;
	readonly changes?: unknown;
	readonly snapshot?: {
		readonly kind: string;
		readonly text?: string;
	};
}

function nextMessage(port: MemoryWirePort): Promise<unknown> {
	return new Promise(resolve => {
		const listener = port.onMessage(message => {
			listener.dispose();
			resolve(message);
		});
	});
}

class MemoryWirePort extends Disposable implements LanguageWorkerWireClientPort {
	private readonly messageEmitter = this._register(new Emitter<unknown>());
	private readonly failureEmitter = this._register(new Emitter<unknown>());
	private peer: MemoryWirePort | undefined;

	readonly sentMessages: unknown[] = [];
	readonly onMessage: Event<unknown> = this.messageEmitter.event;
	readonly onFailure: Event<unknown> = this.failureEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.peer = undefined;
		}));
	}

	connect(peer: MemoryWirePort): void {
		this.peer = peer;
	}

	send(message: unknown): void {
		if (this.isDisposed || !this.peer) {
			throw new ReferenceError("Memory wire port is unavailable");
		}
		const peer = this.peer;
		const cloned = structuredClone(message);
		this.sentMessages.push(cloned);
		queueMicrotask(() => {
			if (!peer.isDisposed) peer.messageEmitter.fire(cloned);
		});
	}

	fail(error: unknown): void {
		this.failureEmitter.fire(error);
	}
}

class TestCompletionWorker extends Disposable implements LanguageCompletionWorker {
	constructor(private readonly runRequest: (request: LanguageWorkerRequest<typeof LANGUAGE_COMPLETION_LANE, LanguageCompletionRequest>, signal: AbortSignal) => ReturnType<LanguageCompletionWorker["run"]>) {
		super();
	}

	run(request: LanguageWorkerRequest<typeof LANGUAGE_COMPLETION_LANE, LanguageCompletionRequest>, signal: AbortSignal): ReturnType<LanguageCompletionWorker["run"]> {
		return this.runRequest(request, signal);
	}
}
