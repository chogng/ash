import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, DisposableStore, toDisposable } from "../../../base/common/lifecycle.js";
import { LanguageCompletionCatalogWirePublisher, LanguageCompletionCatalogWorkerClient } from "../../common/languages/completion/languageCompletionCatalogWire.js";
import { createLanguageCompletionInvokeContext, LanguageCompletionProviderRegistry, type LanguageCompletionProvider } from "../../common/languages/completion/languageCompletionProviders.js";
import { LanguageCompletionProviderModuleHost, LanguageCompletionProviderModuleRegistry, LanguageCompletionProviderModuleState } from "../../common/languages/completion/languageCompletionProviderModules.js";
import { LanguageCompletionProviderModuleWireClient, LanguageCompletionProviderModuleWireServer } from "../../common/languages/completion/languageCompletionProviderModuleWire.js";
import { LanguageCompletionResolveWireClient, LanguageCompletionResolveWireServer } from "../../common/languages/completion/languageCompletionResolveWire.js";
import { LANGUAGE_COMPLETION_LANE, LanguageCompletionProviderWorker, LanguageCompletionService } from "../../common/languages/completion/languageCompletionService.js";
import { languageCompletionWireCodec } from "../../common/languages/completion/languageCompletionWire.js";
import { LanguageCompletionItemKind } from "../../common/languages/completion/languageCompletions.js";
import { createLanguageWordCompletionProvider } from "../../common/languages/completion/languageWordCompletionProvider.js";
import { LanguageWorkerWireServer, type LanguageWorkerWireClientPort } from "../../common/languages/languageWorkerWire.js";
import { LanguageRequestStatus } from "../../common/languages/languageRequestCoordinator.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

test("Module wire publishes availability and controls Worker-local providers", async () => {
	using providers = new LanguageCompletionProviderRegistry();
	using modules = new LanguageCompletionProviderModuleRegistry();
	using moduleRegistration = modules.register({
		id: "language.word",
		load: () => [createLanguageWordCompletionProvider()],
	});
	using host = new LanguageCompletionProviderModuleHost(modules, providers);
	const [clientPort, serverPort] = createPortPair();
	using serverEndpoint = serverPort;
	using server = new LanguageCompletionProviderModuleWireServer(serverPort, modules, host);
	using client = new LanguageCompletionProviderModuleWireClient(clientPort, error => {
		throw error;
	});

	assert.deepEqual((await client.waitForModuleCatalog()).modules.map(module => module.id), ["language.word"]);
	assert.equal((await client.setProviderModuleActivation("language.word", LanguageCompletionProviderModuleState.Active)).changed, true);
	assert.deepEqual(providers.providerCatalog.providers.map(provider => provider.id), ["language.word"]);
	assert.equal((await client.setProviderModuleActivation("language.word", LanguageCompletionProviderModuleState.Inactive)).changed, true);
	assert.deepEqual(providers.providerCatalog.providers, []);
	await assert.rejects(
		client.setProviderModuleActivation("stanza.missing", LanguageCompletionProviderModuleState.Active),
		/unavailable/,
	);
});

test("Stale module catalogs invalidate the shared Worker client", async () => {
	const [clientPort, serverPort] = createPortPair();
	using serverEndpoint = serverPort;
	let failure: Error | undefined;
	using client = new LanguageCompletionProviderModuleWireClient(clientPort, error => {
		failure = error;
	});
	serverPort.send(moduleCatalogMessage(1));
	await client.waitForModuleCatalog();

	serverPort.send(moduleCatalogMessage(1));
	await new Promise<void>(resolve => setImmediate(resolve));

	assert.match(failure!.message, /revision must increase/);
	await assert.rejects(client.waitForModuleCatalog(), /revision must increase/);
	assert.equal(client.moduleCatalogReady, false);
});

test("Required modules activate before the first completion request crosses the wire", async () => {
	using model = new TextModel("console\nconst connection = con");
	using providers = new LanguageCompletionProviderRegistry();
	using modules = new LanguageCompletionProviderModuleRegistry();
	using moduleRegistration = modules.register({
		id: "language.word",
		load: async () => {
			await new Promise<void>(resolve => setImmediate(resolve));
			return [createLanguageWordCompletionProvider()];
		},
	});
	using host = new LanguageCompletionProviderModuleHost(modules, providers);
	const [clientPort, serverPort] = createPortPair();
	using workerServer = new LanguageWorkerWireServer(serverPort, languageCompletionWireCodec, new LanguageCompletionProviderWorker(providers));
	using catalogPublisher = new LanguageCompletionCatalogWirePublisher(serverPort, providers);
	using moduleServer = new LanguageCompletionProviderModuleWireServer(serverPort, modules, host);
	using client = new LanguageCompletionCatalogWorkerClient(clientPort, {
		requiredProviderModules: ["language.word"],
	});
	const snapshot = model.createVersionedSnapshot();
	const request = Object.freeze({
		requestId: 1,
		lane: LANGUAGE_COMPLETION_LANE,
		snapshot,
		payload: Object.freeze({
			languageId: "typescript",
			position: new Position((1) + 1, ("const connection = con".length) + 1),
			context: createLanguageCompletionInvokeContext(),
		}),
	});

	const result = await client.run(request, new AbortController().signal);

	assert.deepEqual(result.items.map(item => item.label), ["connection", "console", "const"]);
	assert.deepEqual(client.providerCatalog.providers.map(provider => provider.id), ["language.word"]);
	const messages = clientPort.sentMessages as Array<{ readonly protocol?: string; readonly kind?: string }>;
	const activationIndex = messages.findIndex(message => message.protocol === "ash.language.completion-provider-modules" && message.kind === "setActivation");
	const requestIndex = messages.findIndex(message => message.protocol === "ash.language-worker" && message.kind === "request");
	assert.equal(activationIndex >= 0, true);
	assert.equal(requestIndex > activationIndex, true);
});

test("Required-module failure discards the prewarmed Worker before the next trigger", async () => {
	using model = new TextModel("object.");
	using localProviders = new LanguageCompletionProviderRegistry();
	using workerResources = new DisposableStore();
	let workerCount = 0;
	using service = new LanguageCompletionService(model, localProviders, {
		workerFactory: () => {
			workerCount += 1;
			const providers = workerResources.add(new LanguageCompletionProviderRegistry());
			const modules = workerResources.add(new LanguageCompletionProviderModuleRegistry());
			workerResources.add(modules.register({
				id: "stanza.dot",
				load: () => {
					if (workerCount === 1) throw new Error("required module failed");
					return [triggerProvider()];
				},
			}));
			const host = workerResources.add(new LanguageCompletionProviderModuleHost(modules, providers));
			const [clientPort, serverPort] = createPortPair();
			workerResources.add(new LanguageWorkerWireServer(serverPort, languageCompletionWireCodec, new LanguageCompletionProviderWorker(providers)));
			workerResources.add(new LanguageCompletionCatalogWirePublisher(serverPort, providers));
			workerResources.add(new LanguageCompletionProviderModuleWireServer(serverPort, modules, host));
			return new LanguageCompletionCatalogWorkerClient(clientPort, {
				requiredProviderModules: ["stanza.dot"],
			});
		},
	});
	const position = new Position((0) + 1, (model.getText().length) + 1);

	await assert.rejects(
		service.requestTriggerCharacter("typescript", position, "."),
		/required module failed/,
	);
	const outcome = await service.requestTriggerCharacter("typescript", position, ".");

	assert.equal(outcome?.status, LanguageRequestStatus.Applied);
	assert.equal(workerCount, 2);
	assert.deepEqual(service.results.result!.value.items.map(item => item.providerId), ["stanza.dot"]);
});

test("Deferred completion details and cancellation cross the shared Worker port", async () => {
	using model = new TextModel("con");
	using localProviders = new LanguageCompletionProviderRegistry();
	using remoteProviders = new LanguageCompletionProviderRegistry();
	let blockResolution = false;
	let remoteCancelled = false;
	using registration = remoteProviders.register({
		id: "stanza.resolve",
		languageIds: ["typescript"],
		provideCompletions: () => ({
			items: [{
				id: "console",
				label: "console",
				kind: LanguageCompletionItemKind.Variable,
				range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1)),
				insertText: "console",
				resolveData: { symbol: "console" },
			}],
			isIncomplete: false,
		}),
		resolveCompletionItem: (request, signal) => {
			if (!blockResolution) {
				return { documentation: `Remote docs for ${(request.item.resolveData as { symbol: string }).symbol}` };
			}
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					remoteCancelled = true;
					reject(new Error("remote resolve cancelled"));
				}, { once: true });
			});
		},
	});
	const [clientPort, serverPort] = createPortPair();
	const providerWorker = new LanguageCompletionProviderWorker(remoteProviders);
	using workerServer = new LanguageWorkerWireServer(serverPort, languageCompletionWireCodec, providerWorker);
	using catalogPublisher = new LanguageCompletionCatalogWirePublisher(serverPort, remoteProviders);
	using resolveServer = new LanguageCompletionResolveWireServer(serverPort, providerWorker);
	using service = new LanguageCompletionService(model, localProviders, {
		workerFactory: () => new LanguageCompletionCatalogWorkerClient(clientPort),
	});
	await service.request("typescript", new Position((0) + 1, (3) + 1), createLanguageCompletionInvokeContext());
	const result = service.results.result!;
	const target = {
		completionRequestId: result.requestId,
		modelVersion: result.modelVersion,
		providerId: "stanza.resolve",
		itemId: "console",
	};

	assert.deepEqual(
		await service.resolveCompletionItem(target, new AbortController().signal),
		{ documentation: "Remote docs for console" },
	);
	assert.equal(clientPort.sentMessages.some(message => (
		(message as { readonly protocol?: string }).protocol === "ash.language.completion-resolve"
	)), true);

	blockResolution = true;
	const controller = new AbortController();
	const pending = service.resolveCompletionItem(target, controller.signal);
	await new Promise<void>(resolve => setImmediate(resolve));
	controller.abort("cancel resolve");
	await assert.rejects(pending, /cancel resolve/);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(remoteCancelled, true);
});

test("Malformed resolve responses reject pending work and invalidate the shared client", async () => {
	const [clientPort, serverPort] = createPortPair();
	using serverEndpoint = serverPort;
	let invalidation: Error | undefined;
	using client = new LanguageCompletionResolveWireClient(clientPort, error => {
		invalidation = error;
	});
	const target = {
		completionRequestId: 7,
		modelVersion: 1,
		providerId: "stanza.resolve",
		itemId: "console",
	};
	const pending = client.resolveCompletionItem(target, new AbortController().signal);
	await new Promise<void>(resolve => setImmediate(resolve));
	serverPort.send({
		protocol: "ash.language.completion-resolve",
		version: 1,
		kind: "result",
		requestId: 1,
		target: { ...target, itemId: "different" },
		details: {},
	});

	await assert.rejects(pending, /does not match/);
	assert.match(invalidation!.message, /does not match/);
	await assert.rejects(
		async () => client.resolveCompletionItem(target, new AbortController().signal),
		/does not match/,
	);
});

function moduleCatalogMessage(revision: number): unknown {
	return {
		protocol: "ash.language.completion-provider-modules",
		version: 1,
		kind: "catalog",
		catalog: { revision, modules: [] },
	};
}

function triggerProvider(): LanguageCompletionProvider {
	return {
		id: "stanza.dot",
		languageIds: ["typescript"],
		triggerCharacters: ["."],
		provideCompletions: request => ({
			items: [{
				id: "member",
				label: "member",
				kind: LanguageCompletionItemKind.Property,
				range: Range.fromPositions(request.position),
				insertText: "member",
			}],
			isIncomplete: false,
		}),
	};
}

function createPortPair(): readonly [MemoryModulePort, MemoryModulePort] {
	const first = new MemoryModulePort();
	const second = new MemoryModulePort();
	first.connect(second);
	second.connect(first);
	return [first, second];
}

class MemoryModulePort extends Disposable implements LanguageWorkerWireClientPort {
	private readonly messageEmitter = this._register(new Emitter<unknown>());
	private readonly failureEmitter = this._register(new Emitter<unknown>());
	private peer: MemoryModulePort | undefined;

	readonly sentMessages: unknown[] = [];
	readonly onMessage: Event<unknown> = this.messageEmitter.event;
	readonly onFailure: Event<unknown> = this.failureEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.peer = undefined;
		}));
	}

	connect(peer: MemoryModulePort): void {
		this.peer = peer;
	}

	send(message: unknown): void {
		if (this.isDisposed || !this.peer) {
			throw new ReferenceError("Memory module port is unavailable");
		}
		const peer = this.peer;
		const cloned = structuredClone(message);
		this.sentMessages.push(cloned);
		queueMicrotask(() => {
			if (!peer.isDisposed) peer.messageEmitter.fire(cloned);
		});
	}
}
