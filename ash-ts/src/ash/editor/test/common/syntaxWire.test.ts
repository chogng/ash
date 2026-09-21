import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, DisposableStore, toDisposable } from "../../../base/common/lifecycle.js";
import { SyntaxProviderRegistry, type SyntaxRequest } from "../../common/languages/syntax/syntaxProviders.js";
import { SYNTAX_TOKEN_LANE, SyntaxProviderWorker, SyntaxService, type SyntaxLane, type SyntaxResult, type SyntaxWorker } from "../../common/languages/syntax/syntaxService.js";
import { syntaxWireCodec } from "../../common/languages/syntax/syntaxWire.js";
import { testSyntaxProvider } from './testSyntaxProvider.js';
import { LanguageRequestCoordinator, LanguageRequestStatus, LanguageWorkerResultDisposition, type LanguageWorkerRequest } from "../../common/languages/languageRequestCoordinator.js";
import { LanguageWorkerWireClient, LanguageWorkerWireServer, type LanguageWorkerWireClientPort } from "../../common/languages/languageWorkerWire.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

test("Token and diagnostic lanes share one structured-clone incremental document mirror", async () => {
	using model = new TextModel("const value = 1;");
	using localRegistry = new SyntaxProviderRegistry();
	using remoteRegistry = new SyntaxProviderRegistry();
	using registration = remoteRegistry.register(testSyntaxProvider());
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(
		serverPort,
		syntaxWireCodec,
		new SyntaxProviderWorker(remoteRegistry),
	);
	using service = new SyntaxService(model, localRegistry, {
		workerFactory: () => new LanguageWorkerWireClient(clientPort, syntaxWireCodec),
	});

	const outcomes = await service.requestAll("typescript");

	assert.equal(outcomes.tokens.status, LanguageRequestStatus.Applied);
	assert.equal(outcomes.diagnostics.status, LanguageRequestStatus.Applied);
	assert.deepEqual(service.tokens.result!.value.tokens.map(token => token.tokenType), ["const", "value", "=", "1;"]);
	assert.equal(service.tokens.result!.value.tokens[0]!.range instanceof Range, true);
	const initialMessages = clientPort.sentMessages as WireMessage[];
	assert.deepEqual(initialMessages.map(message => message.kind), ["request", "request"]);
	assert.equal(initialMessages[0]!.lane, "tokens");
	assert.equal(initialMessages[0]!.snapshot?.kind, "full");
	assert.equal(initialMessages[1]!.lane, "diagnostics");
	assert.equal(initialMessages[1]!.snapshot?.kind, "reference");

	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (model.getText().length) + 1)),
		text: "\nreturn value;",
	}]);
	assert.equal((await service.requestTokens("typescript")).status, LanguageRequestStatus.Applied);

	const messages = clientPort.sentMessages as WireMessage[];
	assert.deepEqual(messages.map(message => message.kind), ["request", "request", "sync", "request"]);
	assert.equal(messages[2]!.previousVersion, 1);
	assert.equal(messages[3]!.snapshot?.kind, "reference");
	assert.equal(messages[3]!.resultBaseRequestId, 1);
	assert.deepEqual(service.tokens.result!.value.tokens.filter(token => token.range.startLineNumber === 2).map(token => token.tokenType), ["return", "value;"]);
	const incrementalResponse = (serverPort.sentMessages as WireMessage[]).find(message => message.requestId === 3);
	assert.equal(incrementalResponse?.result?.kind, "delta");
	assert.equal(incrementalResponse?.result?.baseRequestId, 1);
	assert.equal(incrementalResponse?.result?.splices?.at(-1)?.lineDelta, 1);
	assert.equal(incrementalResponse?.result?.splices?.reduce((count, splice) => count + splice.items.length, 0), 2);
});

test("Syntax wire rejects malformed lane DTOs in the client realm", async () => {
	using model = new TextModel("value");
	const [clientPort, serverPort] = createPortPair();
	using serverEndpoint = serverPort;
	using client = new LanguageWorkerWireClient(clientPort, syntaxWireCodec);
	const pending = client.run({
		requestId: 1,
		lane: SYNTAX_TOKEN_LANE,
		snapshot: model.createVersionedSnapshot(),
		payload: { languageId: "typescript" },
	}, new AbortController().signal);
	await turn();
	serverPort.send({
		protocol: "ash.language-worker",
		version: 5,
		kind: "result",
		requestId: 1,
		result: {
			kind: "full",
			items: [{
				range: {
					start: { lineIndex: 0, columnIndex: 0 },
					end: { lineIndex: 0, columnIndex: 4 },
				},
				tokenType: "variable",
				modifiers: [],
			}, {
				range: {
					start: { lineIndex: 0, columnIndex: 3 },
					end: { lineIndex: 0, columnIndex: 5 },
				},
				tokenType: "variable",
				modifiers: [],
			}],
		},
	});

	await assert.rejects(pending, /sorted and non-overlapping/);
});

test("Syntax service replaces a failed wire Worker on the next request", async () => {
	using model = new TextModel("const value = 1;");
	using localRegistry = new SyntaxProviderRegistry();
	using remoteRegistry = new SyntaxProviderRegistry();
	using registration = remoteRegistry.register(testSyntaxProvider());
	using workerResources = new DisposableStore();
	let workerCount = 0;
	using service = new SyntaxService(model, localRegistry, {
		workerFactory: () => {
			workerCount += 1;
			const [clientPort, serverPort] = createPortPair();
			const worker: SyntaxWorker = workerCount === 1
				? new FailingSyntaxWorker()
				: new SyntaxProviderWorker(remoteRegistry);
			workerResources.add(new LanguageWorkerWireServer(serverPort, syntaxWireCodec, worker));
			return new LanguageWorkerWireClient(clientPort, syntaxWireCodec);
		},
	});

	await assert.rejects(service.requestTokens("typescript"), /syntax worker failed/);
	const outcome = await service.requestTokens("typescript");

	assert.equal(outcome.status, LanguageRequestStatus.Applied);
	assert.equal(workerCount, 2);
	assert.equal(service.tokens.result!.value.tokens[0]!.tokenType, "const");
});

test("Syntax wire falls back to full when the client missed the server result base", async () => {
	using model = new TextModel("const value = 1;");
	using registry = new SyntaxProviderRegistry();
	using registration = registry.register(testSyntaxProvider());
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(serverPort, syntaxWireCodec, new SyntaxProviderWorker(registry));
	using client = new LanguageWorkerWireClient(clientPort, syntaxWireCodec);
	const signal = new AbortController().signal;
	const request = (requestId: number): LanguageWorkerRequest<SyntaxLane, SyntaxRequest> => ({
		requestId,
		lane: SYNTAX_TOKEN_LANE,
		snapshot: model.createVersionedSnapshot(),
		payload: { languageId: "typescript" },
	});
	await client.run(request(1), signal);
	client.settleResult(1, LanguageWorkerResultDisposition.Applied);
	const snapshot = model.createVersionedSnapshot();
	clientPort.send({
		protocol: "ash.language-worker",
		version: 5,
		kind: "request",
		requestId: 2,
		lane: SYNTAX_TOKEN_LANE,
		resultBaseRequestId: 1,
		snapshot: {
			kind: "reference",
			version: snapshot.version,
			length: snapshot.length,
			lineCount: snapshot.lineCount,
		},
		payload: { languageId: "typescript" },
	});
	await turn();
	await turn();

	const result = await client.run(request(3), signal);

	assert.equal(result.lane, SYNTAX_TOKEN_LANE);
	const thirdRequest = (clientPort.sentMessages as WireMessage[]).find(message => message.requestId === 3);
	assert.equal(thirdRequest?.resultBaseRequestId, 1);
	const thirdResponse = (serverPort.sentMessages as WireMessage[]).find(message => message.requestId === 3);
	assert.equal(thirdResponse?.result?.kind, "full");
});

test("Syntax wire does not confirm a result rejected by renderer application", async () => {
	using model = new TextModel("const value = 1;");
	using registry = new SyntaxProviderRegistry();
	using registration = registry.register(testSyntaxProvider());
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(serverPort, syntaxWireCodec, new SyntaxProviderWorker(registry));
	const client = new LanguageWorkerWireClient(clientPort, syntaxWireCodec);
	using coordinator = new LanguageRequestCoordinator<SyntaxLane, SyntaxRequest, SyntaxResult>(model, () => client);
	const applicationFailure = new Error("renderer rejected result");

	await assert.rejects(coordinator.runLatest(SYNTAX_TOKEN_LANE, { languageId: "typescript" }, () => {
		throw applicationFailure;
	}), applicationFailure);
	assert.equal((await coordinator.runLatest(SYNTAX_TOKEN_LANE, { languageId: "typescript" }, () => undefined)).status, LanguageRequestStatus.Applied);

	const requests = (clientPort.sentMessages as WireMessage[]).filter(message => message.kind === "request");
	assert.equal(requests[0]!.resultBaseRequestId, undefined);
	assert.equal(requests[1]!.resultBaseRequestId, undefined);
	const secondResponse = (serverPort.sentMessages as WireMessage[]).find(message => message.requestId === 2);
	assert.equal(secondResponse?.result?.kind, "full");
});

interface WireMessage {
	readonly kind?: string;
	readonly lane?: string;
	readonly previousVersion?: number;
	readonly requestId?: number;
	readonly resultBaseRequestId?: number;
	readonly snapshot?: {
		readonly kind?: string;
	};
	readonly result?: {
		readonly kind?: string;
		readonly baseRequestId?: number;
		readonly splices?: readonly {
			readonly lineDelta?: number;
			readonly items: readonly unknown[];
		}[];
	};
}

function createPortPair(): readonly [MemorySyntaxPort, MemorySyntaxPort] {
	const first = new MemorySyntaxPort();
	const second = new MemorySyntaxPort();
	first.connect(second);
	second.connect(first);
	return [first, second];
}

class MemorySyntaxPort extends Disposable implements LanguageWorkerWireClientPort {
	private readonly messageEmitter = this._register(new Emitter<unknown>());
	private readonly failureEmitter = this._register(new Emitter<unknown>());
	private peer: MemorySyntaxPort | undefined;

	readonly sentMessages: unknown[] = [];
	readonly onMessage: Event<unknown> = this.messageEmitter.event;
	readonly onFailure: Event<unknown> = this.failureEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.peer = undefined;
		}));
	}

	connect(peer: MemorySyntaxPort): void {
		this.peer = peer;
	}

	send(message: unknown): void {
		if (this.isDisposed || !this.peer) {
			throw new ReferenceError("Memory syntax port is unavailable");
		}
		const peer = this.peer;
		const cloned = structuredClone(message);
		this.sentMessages.push(cloned);
		queueMicrotask(() => {
			if (!peer.isDisposed) peer.messageEmitter.fire(cloned);
		});
	}
}

class FailingSyntaxWorker extends Disposable implements SyntaxWorker {
	async run(_request: LanguageWorkerRequest<SyntaxLane, SyntaxRequest>): Promise<SyntaxResult> {
		throw new Error("syntax worker failed");
	}
}

function turn(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}
