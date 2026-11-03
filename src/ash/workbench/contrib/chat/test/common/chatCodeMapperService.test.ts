import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import type { TextEdit } from '../../../../../editor/common/languages.js';
import { IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import type { ThreadRead, ThreadUpdateEnvelope, ThreadTranscriptUpdateEnvelope } from '../../../../../platform/agentHost/common/agent.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IChatService, type StartTurnOptions } from '../../../../services/chat/common/chatService.js';
import { IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ITextModelResourceService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { CodeMapperService } from '../../common/editing/chatCodeMapperService.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';

class Fixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly model = this._register(new TextModel('old\nfile', { resource: URI.file('/workspace/main.ts') }));
	readonly updates = this._register(new Emitter<ThreadUpdateEnvelope>());
	readonly transcripts = this._register(new Emitter<ThreadTranscriptUpdateEnvelope>());
	readonly sentiment = this._register(new Emitter<void>());
	readonly started = new DeferredPromise<StartTurnOptions>();
	readonly batches: TextEdit[][] = [];
	readonly cancellation = this._register(new CancellationTokenSource());
	batchReady = new DeferredPromise<void>();
	text = '';
	status: 'running' | 'completed' | 'failed' = 'running';
	generation = 1;
	unsubscribed = 0;
	interrupted = 0;
	created = 0;
	hidden = false;
	constructor() {
		super();
		const fixture = this;
		this.services.registerInstance(IAppServerApi, { get connectionGeneration() { return fixture.generation; }, getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => { }) } as unknown as IAppServerApi);
		this.services.registerInstance(IChatSessionNavigationService, {} as IChatSessionNavigationService);
		this.services.registerInstance(IChatEntitlementService, { onDidChangeSentiment: this.sentiment.event, get sentiment() { return { hidden: fixture.hidden }; } } as IChatEntitlementService);
		this.services.registerInstance(ITextModelResourceService, { acquire: async () => ({ ...toDisposable(() => { }), model: this.model }) } as unknown as ITextModelResourceService);
		this.services.registerInstance(IAgentThreadService, { createSideChat: async () => { this.created++; return { sessionId: 'session', threadId: 'mapping' }; } } as unknown as IAgentThreadService);
		this.services.registerInstance(IChatService, {
			onDidUpdateThread: this.updates.event, onDidUpdateThreadTranscript: this.transcripts.event,
			readThread: async (_session: string, thread: string) => thread === 'source' ? { thread: { turns: [{ turnId: 'origin', status: 'completed', model: { provider: 'fixture', model: 'source-model' } }] } } as unknown as ThreadRead : this.snapshot(),
			subscribeThread: async () => ({ thread: { sequence: 1, turns: [] } }),
			startTurn: async (options: StartTurnOptions) => { await this.started.complete(options); },
			unsubscribeThread: async () => { this.unsubscribed++; },
			interruptTurn: async () => { this.interrupted++; },
		} as unknown as IChatService);
	}
	snapshot(): ThreadRead {
		return { thread: { sequence: 2, turns: [{ turnId: 'mapped', status: this.status }] }, transcript: { entries: this.text ? [{ type: 'item', turnId: 'mapped', item: { type: 'agentMessage', text: this.text } }] : [] } } as unknown as ThreadRead;
	}
	push(text: string, status: Fixture['status'] = 'running'): void {
		this.text = text;
		this.status = status;
		this.updates.fire({ sessionId: 'session', threadId: 'mapping' } as ThreadUpdateEnvelope);
	}
	map() {
		const mapper = this._register(this.services.createInstance(CodeMapperService));
		return mapper.mapCode({ codeBlocks: [{ code: 'updated', resource: this.model.uri }], chatRequestId: 'origin', chatSessionResource: LocalChatSessionUri.forSession('session', 'source') }, {
			textEdit: (_resource, edits) => { this.batches.push(edits); void this.batchReady.complete(undefined); },
		}, this.cancellation.token);
	}
}

suite('Chat code mapper through the Core execution owner', () => {
	test('the UTF-8 size boundary rejects an oversized file before creating a task and explains it in Chinese', async () => {
		using f = new Fixture();
		setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/chat.json', 'utf8')));
		try {
			f.model.setValue('界'.repeat(400_000));
			const result = await f.map();
			assert.match(result?.errorMessage ?? '', /不超过 1 MiB/);
			assert.equal(f.created, 0);
			assert.equal(f.batches.length, 0);
		} finally { resetNlsResolver(); }
	});
	test('uses the source model, streams relative batches and releases the child subscription', async () => {
		using f = new Fixture();
		const mapping = f.map();
		const submission = await f.started.p;
		assert.deepEqual(submission.model, { provider: 'fixture', model: 'source-model' });
		assert.equal(submission.commandInterpretation, 'literal');
		assert.equal(submission.contexts?.[0]?.content, 'old\nfile');
		f.push('new'); await f.batchReady.p;
		f.batchReady = new DeferredPromise<void>();
		f.push('new\nfile', 'completed'); await mapping;
		assert.deepEqual(f.batches.map(batch => [batch[0]!.range.endLineNumber, batch[0]!.range.endColumn, batch[0]!.text]), [[2, 5, 'new'], [1, 4, 'new\nfile']]);
		assert.equal(f.model.getValue(), 'old\nfile');
		assert.equal(f.unsubscribed, 1); assert.equal(f.interrupted, 0);
	});
	test('failure after a batch does not fabricate a successful completion', async () => {
		using f = new Fixture(); const mapping = f.map(); await f.started.p;
		f.push('partial'); await f.batchReady.p;
		f.push('partial', 'failed'); await assert.rejects(mapping, /did not complete/);
		assert.equal(f.batches.length, 1); assert.equal(f.unsubscribed, 1);
	});
	test('cancellation interrupts the captured execution and releases its subscription', async () => {
		using f = new Fixture(); const mapping = f.map(); await f.started.p;
		f.push('partial'); await f.batchReady.p; f.cancellation.cancel();
		await assert.rejects(mapping, isCancellationError);
		assert.equal(f.interrupted, 1); assert.equal(f.unsubscribed, 1);
	});
	test('cancellation immediately after acceptance still interrupts the new Core turn', async () => {
		using f = new Fixture();
		const mapping = f.map();
		await f.started.p;
		f.cancellation.cancel();
		await assert.rejects(mapping, isCancellationError);
		assert.equal(f.interrupted, 1);
		assert.equal(f.batches.length, 0);
		assert.equal(f.unsubscribed, 1);
	});
	test('the canonical AI visibility preference cancels mapping and retains its execution owner', async () => {
		using f = new Fixture();
		const mapping = f.map();
		await f.started.p;
		f.hidden = true;
		f.sentiment.fire();
		await assert.rejects(mapping, isCancellationError);
		assert.equal(f.interrupted, 1);
		assert.equal(f.batches.length, 0);
		assert.equal(f.unsubscribed, 1);
	});
	test('replacement connections cannot deliver edits or receive an interrupt for the retired execution', async () => {
		using f = new Fixture(); const mapping = f.map(); await f.started.p;
		f.generation++; f.push('wrong connection', 'completed');
		await assert.rejects(mapping, isCancellationError);
		assert.equal(f.batches.length, 0); assert.equal(f.interrupted, 0); assert.equal(f.unsubscribed, 1);
	});
});
