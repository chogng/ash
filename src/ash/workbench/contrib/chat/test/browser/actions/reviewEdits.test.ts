import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import type { ICodeEditor } from '../../../../../../editor/browser/editorBrowser.js';
import { TextModel } from '../../../../../../editor/common/model/textModel.js';
import { EditSources, EditSuggestionId } from '../../../../../../editor/common/textModelEditSource.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatEditingService } from '../../../common/editing/chatEditingService.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { reviewEdits } from '../../../browser/actions/reviewEdits.js';
import type { ChatEditSource } from '../../../../../services/chat/common/chatService.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';

class Fixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly model = this._register(new TextModel('original', { resource: URI.file('/workspace/main.ts') }));
	readonly stopped = this._register(new Emitter<void>());
	readonly changed = this._register(new Emitter<never>());
	readonly token = this._register(new CancellationTokenSource());
	readonly outcomes: string[] = [];
	readonly sources: ChatEditSource[] = [];
	readonly applied = new DeferredPromise<void>();
	afterApply: (() => void) | undefined;
	readonly editor = { getModel: () => this.model, onDidDispose: this.stopped.event, onDidChangeModel: this.changed.event } as unknown as ICodeEditor;
	item = { feedbackSource: { sessionId: 'session', threadId: 'original-thread', turnId: 'original-turn', itemId: 'reply' }, transient: false } as IChatListItem;
	constructor() {
		super();
		this.services.registerInstance(IChatWidgetService, { lastFocusedWidget: { getFocus: () => this.item } } as unknown as IChatWidgetService);
		this.services.registerInstance(IChatEditingService, {
			applyEdits: async (edit, _signal, source) => {
				this.sources.push(source);
				const reason = EditSources.chatApplyEdits({ codeBlockSuggestionId: source.codeBlockSuggestionId, sessionId: source.sessionId, requestId: source.turnId, languageId: this.model.getLanguageId(), modelId: undefined, mode: undefined, extensionId: undefined });
				for (const entry of edit.entries) if (entry.kind === 'textDocument') this.model.applyEdits([...entry.edits], reason);
				this.afterApply?.();
				await this.applied.complete(undefined);
				return { isApplied: true };
			},
			finishTurn: async (_source, outcome) => { this.outcomes.push(outcome); },
		} as IChatEditingService);
	}
}

suite('Streamed code edit review', () => {
	test('pins the original reply while batches update the same working copy', async () => {
		using f = new Fixture();
		const id = EditSuggestionId.newId();
		const stream = async function* () {
			yield [{ range: f.model.getFullModelRange(), text: 'first' }];
			f.item = { ...f.item, feedbackSource: { ...f.item.feedbackSource!, turnId: 'other-turn' } };
			yield [{ range: f.model.getFullModelRange(), text: 'second' }];
		};
		assert.equal(await f.services.invokeFunction(reviewEdits, f.editor, stream(), f.token.token, id), true);
		assert.equal(f.model.getValue(), 'second');
		assert.ok(f.sources.every(source => source.turnId === 'original-turn' && source.codeBlockSuggestionId === id));
		assert.deepEqual(f.outcomes, ['completed']);
	});
	test('an unrelated user edit stops later batches and keeps the first batch reviewable', async () => {
		using f = new Fixture();
		const stream = async function* () {
			yield [{ range: f.model.getFullModelRange(), text: 'mapped' }];
			f.model.applyEdits([{ range: f.model.getFullModelRange(), text: 'user text' }]);
			yield [{ range: f.model.getFullModelRange(), text: 'must not apply' }];
		};
		await assert.rejects(f.services.invokeFunction(reviewEdits, f.editor, stream(), f.token.token, undefined), /file changed/);
		assert.equal(f.model.getValue(), 'user text'); assert.equal(f.sources.length, 1);
		assert.deepEqual(f.outcomes, ['failed']);
	});
	for (const retire of ['cancel', 'editor disposed'] as const) {
		test(`${retire} releases a stalled stream and completes attribution as interrupted`, async () => {
			using f = new Fixture();
			const waiting = new DeferredPromise<void>();
			const stream = async function* () {
				yield [{ range: f.model.getFullModelRange(), text: 'partial' }];
				await waiting.p;
			};
			const review = f.services.invokeFunction(reviewEdits, f.editor, stream(), f.token.token, undefined);
			await f.applied.p;
			if (retire === 'cancel') f.token.cancel(); else f.stopped.fire();
			await assert.rejects(review, isCancellationError);
			assert.equal(f.model.getValue(), 'partial'); assert.deepEqual(f.outcomes, ['interrupted']);
			await waiting.complete(undefined);
		});
	}
	test('user edits made while the review service persists a batch are not accepted as the next baseline', async () => {
		using f = new Fixture();
		f.afterApply = () => { f.model.applyEdits([{ range: f.model.getFullModelRange(), text: 'user while saving' }]); };
		const stream = async function* () {
			yield [{ range: f.model.getFullModelRange(), text: 'mapped' }];
			yield [{ range: f.model.getFullModelRange(), text: 'must not apply' }];
		};
		await assert.rejects(f.services.invokeFunction(reviewEdits, f.editor, stream(), f.token.token, undefined), /file changed/);
		assert.equal(f.model.getValue(), 'user while saving');
		assert.equal(f.sources.length, 1); assert.deepEqual(f.outcomes, ['failed']);
	});
});
