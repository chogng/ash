import { LanguageCompletionTriggerKind } from '../../../common/languages.js';
import { LanguageCompletionProviderRegistry } from '../../../common/languageFeatureRegistry.js';
import { LanguageCompletionService } from '../../../contrib/suggest/browser/suggest.js';
import { WordBasedCompletionItemProvider, VersionedEditorWorkerClient } from '../../../browser/services/editorWorkerService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { LanguageWorkerWireClient, LanguageWorkerWireServer, type LanguageWorkerWireClientPort } from '../../../common/languages/languageWorkerWire.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { TextModel } from '../../../common/model/textModel.js';

import { EditorWorker } from '../../../common/services/editorWebWorker.js';
import { editorWorkerWireCodec } from '../../../common/services/editorWorkerWire.js';
import { EndOfLineSequence } from '../../../common/model.js';

test('worker wire preserves EOL-only edits after text minimization', async () => {
	using model = new TextModel('alpha');
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(serverPort, editorWorkerWireCodec, new EditorWorker());
	using client = new VersionedEditorWorkerClient(model, () => new LanguageWorkerWireClient(clientPort, editorWorkerWireCodec));
	const result = await client.computeMoreMinimalEdits([{ range: model.getFullModelRange(), text: 'alpha', eol: EndOfLineSequence.CRLF }]);
	assert.deepEqual(result, [{ range: new Range(1, 1, 1, 1), text: '', eol: EndOfLineSequence.CRLF }]);
});

test('Editor worker client synchronizes model versions across the structured-clone boundary', async () => {
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(serverPort, editorWorkerWireCodec, new EditorWorker());
	using model = new TextModel('const value = true;');
	using client = new VersionedEditorWorkerClient(model, () => new LanguageWorkerWireClient(clientPort, editorWorkerWireCodec));

	const first = await client.navigateValueSet(Range.fromPositions(new Position((0) + 1, (14) + 1)), true, /[A-Za-z]+/g);
	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (14) + 1), new Position((0) + 1, (18) + 1)), text: 'false' }]);
	const second = await client.navigateValueSet(Range.fromPositions(new Position((0) + 1, (14) + 1)), true, /[A-Za-z]+/g);

	assert.equal(first?.value, 'false');
	assert.equal(first?.range instanceof Range, true);
	assert.equal(second?.value, 'true');
	assert.deepEqual(clientPort.sentMessages.map(message => message.kind), ['request', 'sync', 'request']);
	assert.equal(clientPort.sentMessages[0]!.snapshot?.kind, 'full');
	assert.equal(clientPort.sentMessages[2]!.snapshot?.kind, 'reference');
});

function createPortPair(): readonly [MemoryWirePort, MemoryWirePort] {
	const first = new MemoryWirePort();
	const second = new MemoryWirePort();
	first.connect(second);
	second.connect(first);
	return [first, second];
}

interface WireMessage {
	readonly kind: string;
	readonly snapshot?: { readonly kind: string };
}

class MemoryWirePort extends Disposable implements LanguageWorkerWireClientPort {
	private readonly messageEmitter = this._register(new Emitter<unknown>());
	private readonly failureEmitter = this._register(new Emitter<unknown>());
	private peer: MemoryWirePort | undefined;
	readonly sentMessages: WireMessage[] = [];
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
		this.assertNotDisposed();
		if (!this.peer) throw new ReferenceError('Memory editor worker port is disconnected');
		const peer = this.peer;
		const clone = structuredClone(message) as WireMessage;
		this.sentMessages.push(clone);
		queueMicrotask(() => {
			if (!peer.isDisposed) peer.messageEmitter.fire(clone);
		});
	}
}

test('formatting can run again after an overlapping response fails across the worker wire', async () => {
	using model = new TextModel('alpha');
	using servers = new DisposableStore();
	let starts = 0;
	using client = new VersionedEditorWorkerClient(model, () => {
		starts++;
		const [clientPort, serverPort] = createPortPair();
		servers.add(new LanguageWorkerWireServer(serverPort, editorWorkerWireCodec, new EditorWorker()));
		return new LanguageWorkerWireClient(clientPort, editorWorkerWireCodec);
	});
	await assert.rejects(client.computeMoreMinimalEdits([
		{ range: new Range(1, 1, 1, 4), text: 'ALP' },
		{ range: new Range(1, 3, 1, 6), text: 'PHA' },
	]), /must not overlap/);
	const edits = await client.computeMoreMinimalEdits([{ range: model.getFullModelRange(), text: 'ALPHA' }]);
	assert.deepEqual(edits, [{ range: model.getFullModelRange(), text: 'ALPHA' }]);
	assert.equal(starts, 2);
});

test('word completion shares the general editor worker and retains dynamic providers', async () => {
	using model = new TextModel('alpha alphabet\nal', { languageId: 'typescript' });
	const [clientPort, serverPort] = createPortPair();
	using server = new LanguageWorkerWireServer(serverPort, editorWorkerWireCodec, new EditorWorker());
	using client = new VersionedEditorWorkerClient(model, () => new LanguageWorkerWireClient(clientPort, editorWorkerWireCodec));
	using registry = new LanguageCompletionProviderRegistry();
	using completions = new LanguageCompletionService(model, registry, { providers: [new WordBasedCompletionItemProvider(client)] });
	await completions.request('typescript', new Position(2, 3), { kind: LanguageCompletionTriggerKind.Invoke });
	assert.deepEqual(completions.results.result?.value.items.map(item => item.label), ['alpha', 'alphabet']);
	using provider = registry.register({ id: 'test.dynamic', languageIds: ['typescript'], provideCompletions: () => undefined });
	assert.deepEqual(completions.providerCatalog.providers.map(provider => provider.id), ['language.word', 'test.dynamic']);
	model.setValue('alpine\nal');
	await completions.request('typescript', new Position(2, 3), { kind: LanguageCompletionTriggerKind.Invoke });
	assert.deepEqual(completions.results.result?.value.items.map(item => item.label), ['alpine']);
	assert.ok(clientPort.sentMessages.some(message => message.kind === 'sync'));
});

test('editor worker transport rejects invalid edit coordinates and EOL before execution', () => {
	using model = new TextModel('text');
	const snapshot = model.createVersionedSnapshot();
	const range = { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 4 } };
	assert.throws(() => editorWorkerWireCodec.decodePayload('minimalEdits', { edits: [{ range, text: '', eol: 2 }] }, snapshot), /EOL/);
	assert.throws(() => editorWorkerWireCodec.decodePayload('minimalEdits', { edits: [{ range: { ...range, end: { lineIndex: 1, columnIndex: 0 } }, text: '' }] }, snapshot), /outside its snapshot/);
	assert.throws(() => editorWorkerWireCodec.decodeResult('minimalEdits', [{ range: { ...range, start: { lineIndex: -1, columnIndex: 0 } }, text: '' }], snapshot, undefined), /non-negative safe integer/);
	assert.equal(model.getValue(), 'text');
});
