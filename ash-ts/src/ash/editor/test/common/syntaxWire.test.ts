import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, DisposableStore, toDisposable } from "../../../base/common/lifecycle.js";
import { SyntaxProviderRegistry } from '../../common/languageFeatureRegistry.js';
import { type SyntaxRequest, SYNTAX_DIAGNOSTIC_LANE, SYNTAX_TOKEN_LANE, type SyntaxLane, type SyntaxResult, type SyntaxWorker } from '../../common/languages.js';
import { SyntaxProviderWorker } from '../../common/services/editorWebWorker.js';
import { testSyntaxProvider } from './testSyntaxProvider.js';
import { LanguageRequestCoordinator, LanguageRequestStatus, LanguageWorkerResultDisposition, type LanguageWorkerRequest } from '../../common/model/languageRequestCoordinator.js';
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";
import { syntaxWireCodec } from '../../common/services/semanticTokensDto.js';
import { WorkerTextModelSyncClient, WorkerTextModelSyncServer } from '../../common/services/textModelSync/textModelSync.impl.js';
import { type WebWorkerClientPort } from '../../../base/common/worker/webWorker.js';

test("Token and diagnostic lanes share one structured-clone incremental document mirror", async () => {
	using model = new TextModel("const value = 1;");

	using remoteRegistry = new SyntaxProviderRegistry();
	using registration = remoteRegistry.register(testSyntaxProvider());
	const [clientPort, serverPort] = createPortPair();
	using server = new WorkerTextModelSyncServer(
		serverPort,
		syntaxWireCodec,
		new SyntaxProviderWorker(remoteRegistry),
	);
	using coordinator = new LanguageRequestCoordinator(model, () => new WorkerTextModelSyncClient(clientPort, syntaxWireCodec));
	let tokens: Extract<SyntaxResult, { lane: typeof SYNTAX_TOKEN_LANE }> | undefined;
	const requestTokens = () => coordinator.runLatest(SYNTAX_TOKEN_LANE, { languageId: "typescript" }, result => {
		if (result.value.lane !== SYNTAX_TOKEN_LANE) throw new Error("Wrong lane");
		tokens = result.value;
	});

	const [tokenOutcome, diagnosticOutcome] = await Promise.all([requestTokens(), coordinator.runLatest(SYNTAX_DIAGNOSTIC_LANE, { languageId: "typescript" }, () => undefined)]);

	assert.equal(tokenOutcome.status, LanguageRequestStatus.Applied);
	assert.equal(diagnosticOutcome.status, LanguageRequestStatus.Applied);
	assert.deepEqual(tokens!.value.tokens.map(token => token.tokenType), ["const", "value", "=", "1;"]);
	assert.equal(tokens!.value.tokens[0]!.range instanceof Range, true);
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
	assert.equal((await requestTokens()).status, LanguageRequestStatus.Applied);

	const messages = clientPort.sentMessages as WireMessage[];
	assert.deepEqual(messages.map(message => message.kind), ["request", "request", "sync", "request"]);
	assert.equal(messages[2]!.previousVersion, 1);
	assert.equal(messages[3]!.snapshot?.kind, "reference");
	assert.equal(messages[3]!.resultBaseRequestId, 1);
	assert.deepEqual(tokens!.value.tokens.filter(token => token.range.startLineNumber === 2).map(token => token.tokenType), ["return", "value;"]);
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
	using client = new WorkerTextModelSyncClient(clientPort, syntaxWireCodec);
	const pending = client.run({
		requestId: 1,
		lane: SYNTAX_TOKEN_LANE,
		snapshot: model.createVersionedSnapshot(),
		payload: { languageId: "typescript" },
	}, new AbortController().signal);
	await turn();
	serverPort.send({
		protocol: "ash.text-model",
		version: 1,
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

	using remoteRegistry = new SyntaxProviderRegistry();
	using registration = remoteRegistry.register(testSyntaxProvider());
	using workerResources = new DisposableStore();
	let workerCount = 0;
	using coordinator = new LanguageRequestCoordinator(model, () => {
			workerCount += 1;
			const [clientPort, serverPort] = createPortPair();
			const worker: SyntaxWorker = workerCount === 1
				? new FailingSyntaxWorker()
				: new SyntaxProviderWorker(remoteRegistry);
			workerResources.add(new WorkerTextModelSyncServer(serverPort, syntaxWireCodec, worker));
			return new WorkerTextModelSyncClient(clientPort, syntaxWireCodec);
	});
	let tokens: Extract<SyntaxResult, { lane: typeof SYNTAX_TOKEN_LANE }> | undefined;
	const requestTokens = () => coordinator.runLatest(SYNTAX_TOKEN_LANE, { languageId: "typescript" }, result => {
		if (result.value.lane !== SYNTAX_TOKEN_LANE) throw new Error("Wrong lane");
		tokens = result.value;
	});

	await assert.rejects(requestTokens(), /syntax worker failed/);
	const outcome = await requestTokens();

	assert.equal(outcome.status, LanguageRequestStatus.Applied);
	assert.equal(workerCount, 2);
	assert.equal(tokens!.value.tokens[0]!.tokenType, "const");
});

test("Syntax wire falls back to full when the client missed the server result base", async () => {
	using model = new TextModel("const value = 1;");
	using registry = new SyntaxProviderRegistry();
	using registration = registry.register(testSyntaxProvider());
	const [clientPort, serverPort] = createPortPair();
	using server = new WorkerTextModelSyncServer(serverPort, syntaxWireCodec, new SyntaxProviderWorker(registry));
	using client = new WorkerTextModelSyncClient(clientPort, syntaxWireCodec);
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
		protocol: "ash.text-model",
		version: 1,
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
	using server = new WorkerTextModelSyncServer(serverPort, syntaxWireCodec, new SyntaxProviderWorker(registry));
	const client = new WorkerTextModelSyncClient(clientPort, syntaxWireCodec);
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

class MemorySyntaxPort extends Disposable implements WebWorkerClientPort {
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
