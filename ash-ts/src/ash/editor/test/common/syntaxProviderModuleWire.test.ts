import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, DisposableStore, toDisposable } from "../../../base/common/lifecycle.js";
import { SyntaxModuleWorkerClient } from "../../common/languages/syntax/syntaxModuleWorkerClient.js";
import { SyntaxProviderRegistry } from "../../common/languages/syntax/syntaxProviders.js";
import { SyntaxProviderModuleHost, SyntaxProviderModuleRegistry } from "../../common/languages/syntax/syntaxProviderModules.js";
import { SyntaxProviderModuleWireServer } from "../../common/languages/syntax/syntaxProviderModuleWire.js";
import { SYNTAX_TOKEN_LANE, SyntaxProviderWorker, SyntaxService } from "../../common/languages/syntax/syntaxService.js";
import { syntaxWireCodec } from "../../common/languages/syntax/syntaxWire.js";
import { testSyntaxProvider } from './testSyntaxProvider.js';
import { LanguageRequestStatus } from "../../common/languages/languageRequestCoordinator.js";
import { LanguageWorkerWireServer, type LanguageWorkerWireClientPort } from "../../common/languages/languageWorkerWire.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

test("Required Syntax modules activate before the first request and preserve confirmed result bases", async () => {
	using model = new TextModel("const value = 1;");
	using providers = new SyntaxProviderRegistry();
	using modules = new SyntaxProviderModuleRegistry();
	using moduleRegistration = modules.register({
		id: "test.payloads",
		load: async () => {
			await new Promise<void>(resolve => setImmediate(resolve));
			return [testSyntaxProvider()];
		},
	});
	using host = new SyntaxProviderModuleHost(modules, providers);
	const [clientPort, serverPort] = createPortPair();
	using workerServer = new LanguageWorkerWireServer(serverPort, syntaxWireCodec, new SyntaxProviderWorker(providers));
	using moduleServer = new SyntaxProviderModuleWireServer(serverPort, modules, host);
	using localProviders = new SyntaxProviderRegistry();
	using service = new SyntaxService(model, localProviders, {
		workerFactory: () => new SyntaxModuleWorkerClient(clientPort, {
			requiredProviderModules: ["test.payloads"],
		}),
	});

	assert.equal((await service.requestTokens("typescript")).status, LanguageRequestStatus.Applied);
	assert.deepEqual(service.tokens.result!.value.tokens.map(token => token.tokenType), ["const", "value", "=", "1;"]);
	const firstMessages = clientPort.sentMessages as WireMessage[];
	const activationIndex = firstMessages.findIndex(message => message.protocol === "ash.syntax.provider-modules" && message.kind === "setActivation");
	const requestIndex = firstMessages.findIndex(message => message.protocol === "ash.language-worker" && message.kind === "request");
	assert.equal(activationIndex >= 0, true);
	assert.equal(requestIndex > activationIndex, true);

	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (model.getText().length) + 1)),
		text: "\nreturn value;",
	}]);
	assert.equal((await service.requestTokens("typescript")).status, LanguageRequestStatus.Applied);
	const requests = (clientPort.sentMessages as WireMessage[]).filter(message => message.protocol === "ash.language-worker" && message.kind === "request");
	assert.equal(requests[0]!.lane, SYNTAX_TOKEN_LANE);
	assert.equal(requests[0]!.resultBaseRequestId, undefined);
	assert.equal(requests[1]!.resultBaseRequestId, 1);
});

test("Required Syntax module failure discards the Worker before the next request", async () => {
	using model = new TextModel("const value = 1;");
	using localProviders = new SyntaxProviderRegistry();
	using workerResources = new DisposableStore();
	let workerCount = 0;
	using service = new SyntaxService(model, localProviders, {
		workerFactory: () => {
			workerCount += 1;
			const providers = workerResources.add(new SyntaxProviderRegistry());
			const modules = workerResources.add(new SyntaxProviderModuleRegistry());
			workerResources.add(modules.register({
				id: "test.payloads",
				load: () => {
					if (workerCount === 1) throw new Error("syntax module failed");
					return [testSyntaxProvider()];
				},
			}));
			const host = workerResources.add(new SyntaxProviderModuleHost(modules, providers));
			const [clientPort, serverPort] = createPortPair();
			workerResources.add(new LanguageWorkerWireServer(serverPort, syntaxWireCodec, new SyntaxProviderWorker(providers)));
			workerResources.add(new SyntaxProviderModuleWireServer(serverPort, modules, host));
			return new SyntaxModuleWorkerClient(clientPort, {
				requiredProviderModules: ["test.payloads"],
			});
		},
	});

	await assert.rejects(service.requestTokens("typescript"), /syntax module failed/);
	const outcome = await service.requestTokens("typescript");

	assert.equal(outcome.status, LanguageRequestStatus.Applied);
	assert.equal(workerCount, 2);
	assert.equal(service.tokens.result!.value.tokens[0]!.tokenType, "const");
});

interface WireMessage {
	readonly protocol?: string;
	readonly kind?: string;
	readonly lane?: string;
	readonly resultBaseRequestId?: number;
}

function createPortPair(): readonly [MemorySyntaxModulePort, MemorySyntaxModulePort] {
	const first = new MemorySyntaxModulePort();
	const second = new MemorySyntaxModulePort();
	first.connect(second);
	second.connect(first);
	return [first, second];
}

class MemorySyntaxModulePort extends Disposable implements LanguageWorkerWireClientPort {
	private readonly messageEmitter = this._register(new Emitter<unknown>());
	private readonly failureEmitter = this._register(new Emitter<unknown>());
	private peer: MemorySyntaxModulePort | undefined;

	readonly sentMessages: unknown[] = [];
	readonly onMessage: Event<unknown> = this.messageEmitter.event;
	readonly onFailure: Event<unknown> = this.failureEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.peer = undefined;
		}));
	}

	connect(peer: MemorySyntaxModulePort): void {
		this.peer = peer;
	}

	send(message: unknown): void {
		if (this.isDisposed || !this.peer) {
			throw new ReferenceError("Memory syntax module port is unavailable");
		}
		const peer = this.peer;
		const cloned = structuredClone(message);
		this.sentMessages.push(cloned);
		queueMicrotask(() => {
			if (!peer.isDisposed) peer.messageEmitter.fire(cloned);
		});
	}
}
