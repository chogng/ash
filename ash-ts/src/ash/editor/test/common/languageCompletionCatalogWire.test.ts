import { strict as assert } from "node:assert";
import { test } from "mocha";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, DisposableStore, toDisposable } from "../../../base/common/lifecycle.js";
import { LanguageCompletionCatalogWirePublisher, LanguageCompletionCatalogWorkerClient } from "../../common/languages/completion/languageCompletionCatalogWire.js";
import { createLanguageCompletionInvokeContext, LanguageCompletionProviderRegistry, type LanguageCompletionProvider, type LanguageCompletionProviderCatalog } from "../../common/languages/completion/languageCompletionProviders.js";
import { LanguageCompletionProviderWorker, LanguageCompletionService, type LanguageCompletionWorker } from "../../common/languages/completion/languageCompletionService.js";
import { languageCompletionWireCodec } from "../../common/languages/completion/languageCompletionWire.js";
import { LanguageCompletionItemKind } from "../../common/languages/completion/languageCompletions.js";
import { LanguageRequestStatus } from "../../common/languages/languageRequestCoordinator.js";
import { LanguageWorkerWireServer, type LanguageWorkerWireClientPort } from "../../common/languages/languageWorkerWire.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";

test("Remote provider catalog drives trigger routing without renderer providers", async () => {
	using model = new TextModel("object.");
	using localRegistry = new LanguageCompletionProviderRegistry();
	using remoteRegistry = new LanguageCompletionProviderRegistry();
	using dotRegistration = remoteRegistry.register(triggerProvider("remote.dot", "."));
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(serverPort, languageCompletionWireCodec, new LanguageCompletionProviderWorker(remoteRegistry));
	using publisher = new LanguageCompletionCatalogWirePublisher(serverPort, remoteRegistry);
	using service = new LanguageCompletionService(model, localRegistry, {
		workerFactory: () => new LanguageCompletionCatalogWorkerClient(clientPort),
	});
	const position = new Position((0) + 1, (model.getText().length) + 1);

	const outcome = await service.requestTriggerCharacter("typescript", position, ".");

	assert.equal(outcome?.status, LanguageRequestStatus.Applied);
	assert.equal(localRegistry.providerCatalog.providers.length, 0);
	assert.equal(service.supportsTriggerCharacter("typescript", "."), true);
	assert.deepEqual(service.providerCatalog.providers.map(provider => provider.id), ["remote.dot"]);
	assert.deepEqual(service.results.result!.value.items.map(item => item.providerId), ["remote.dot"]);

	const catalogChanged = nextCatalog(service.onDidChangeProviderCatalog);
	using colonRegistration = remoteRegistry.register(triggerProvider("remote.colon", ":"));
	assert.deepEqual((await catalogChanged).providers.map(provider => provider.id), ["remote.dot", "remote.colon"]);
	assert.equal(service.supportsTriggerCharacter("typescript", ":"), true);
});

test("Catalog client waits for the first snapshot and rejects stale revisions", async () => {
	const [clientPort, serverPort] = createPortPair();
	using serverEndpoint = serverPort;
	using client = new LanguageCompletionCatalogWorkerClient(clientPort);
	const ready = client.waitForProviderCatalog();
	serverPort.send({
		protocol: "ash.language.completion-provider-catalog",
		version: 1,
		kind: "catalog",
		catalog: { revision: 1, providers: [] },
	});
	assert.equal((await ready).revision, 1);

	serverPort.send({
		protocol: "ash.language.completion-provider-catalog",
		version: 1,
		kind: "catalog",
		catalog: { revision: 1, providers: [] },
	});
	await new Promise<void>(resolve => setImmediate(resolve));

	await assert.rejects(client.waitForProviderCatalog(), /revision must increase/);
});

test("A failed catalog worker clears metadata and the next trigger rebuilds both", async () => {
	using model = new TextModel("object.");
	using localRegistry = new LanguageCompletionProviderRegistry();
	using remoteRegistry = new LanguageCompletionProviderRegistry();
	using registration = remoteRegistry.register(triggerProvider("remote.dot", "."));
	using workerResources = new DisposableStore();
	let workerCount = 0;
	using service = new LanguageCompletionService(model, localRegistry, {
		workerFactory: () => {
			workerCount += 1;
			const [clientPort, serverPort] = createPortPair();
			const worker: LanguageCompletionWorker = workerCount === 1
				? new FailingCompletionWorker()
				: new LanguageCompletionProviderWorker(remoteRegistry);
			workerResources.add(new LanguageWorkerWireServer(serverPort, languageCompletionWireCodec, worker));
			workerResources.add(new LanguageCompletionCatalogWirePublisher(serverPort, remoteRegistry));
			return new LanguageCompletionCatalogWorkerClient(clientPort);
		},
	});
	const position = new Position((0) + 1, (model.getText().length) + 1);

	await assert.rejects(
		service.request("typescript", position, createLanguageCompletionInvokeContext()),
		/catalog worker failed/,
	);
	assert.equal(service.providerCatalog.providers.length, 0);

	const outcome = await service.requestTriggerCharacter("typescript", position, ".");

	assert.equal(outcome?.status, LanguageRequestStatus.Applied);
	assert.equal(workerCount, 2);
	assert.deepEqual(service.providerCatalog.providers.map(provider => provider.id), ["remote.dot"]);
});

function triggerProvider(id: string, triggerCharacter: string): LanguageCompletionProvider {
	return {
		id,
		languageIds: ["typescript"],
		triggerCharacters: [triggerCharacter],
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

function nextCatalog(event: Event<LanguageCompletionProviderCatalog>): Promise<LanguageCompletionProviderCatalog> {
	return new Promise(resolve => {
		const registration = event(catalog => {
			registration.dispose();
			resolve(catalog);
		});
	});
}

function createPortPair(): readonly [MemoryCatalogPort, MemoryCatalogPort] {
	const first = new MemoryCatalogPort();
	const second = new MemoryCatalogPort();
	first.connect(second);
	second.connect(first);
	return [first, second];
}

class MemoryCatalogPort extends Disposable implements LanguageWorkerWireClientPort {
	private readonly messageEmitter = this._register(new Emitter<unknown>());
	private readonly failureEmitter = this._register(new Emitter<unknown>());
	private peer: MemoryCatalogPort | undefined;

	readonly onMessage: Event<unknown> = this.messageEmitter.event;
	readonly onFailure: Event<unknown> = this.failureEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.peer = undefined;
		}));
	}

	connect(peer: MemoryCatalogPort): void {
		this.peer = peer;
	}

	send(message: unknown): void {
		if (this.isDisposed || !this.peer) {
			throw new ReferenceError("Memory catalog port is unavailable");
		}
		const peer = this.peer;
		const cloned = structuredClone(message);
		queueMicrotask(() => {
			if (!peer.isDisposed) peer.messageEmitter.fire(cloned);
		});
	}
}

class FailingCompletionWorker extends Disposable implements LanguageCompletionWorker {
	async run(): Promise<never> {
		throw new Error("catalog worker failed");
	}
}
