import { isCancellationError } from '../../../../../../base/common/errors.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { ChatAttachmentModel, type IChatAttachmentChangeEvent } from '../../../browser/attachments/chatAttachmentModel.js';
import type { ChatContextAttachment } from '../../../../../services/chat/common/chatContextService.js';

function attachment(id: string): ChatContextAttachment {
	return { id, kind: 'file', name: id, resolve: async () => ({ name: id, content: id }) };
}

test('Attachment replacement publishes one committed change and preserves source identity', () => {
	using model = new ChatAttachmentModel();
	const first = attachment('first');
	const source = { ...attachment('source'), lifetime: 'source' as const };
	const changes: IChatAttachmentChangeEvent[] = [];
	using changed = model.onDidChange(event => {
		changes.push(event);
		assert.deepEqual(model.getAttachmentIDs(), new Set(model.attachments.map(entry => entry.id)));
	});
	model.addContext(first, source);
	const replacement = { ...first, name: 'Updated first' };
	model.updateContext(['source'], [replacement, attachment('next')]);
	assert.deepEqual(changes, [
		{ deleted: [], added: [first, source], updated: [] },
		{ deleted: ['source'], added: [model.attachments[1]], updated: [replacement] },
	]);
	model.addContext(replacement);
	assert.equal(changes.length, 2);
	model.clearAndSetContext(source);
	assert.equal(changes.length, 3);
	assert.equal(model.attachments[0], source);
	model.dispose();
	assert.deepEqual(model.attachments, []);
	assert.equal(changes.length, 3);
});

test('Image admission deduplicates one capture both within a batch and across batches', () => {
	using model = new ChatAttachmentModel();
	const original = { ...attachment('image'), kind: 'image', name: 'Original image' };
	model.addContext(original, { ...original, name: 'Duplicate name' });
	model.addContext({ ...original, name: 'Later image' });
	assert.deepEqual(model.attachments, [original]);
});

test('Attachment preparation waits for every batch and adds each batch atomically', async () => {
	using model = new ChatAttachmentModel();
	const first = new DeferredPromise<readonly ChatContextAttachment[]>();
	const second = new DeferredPromise<readonly ChatContextAttachment[]>();
	const acquiringFirst = model.acquireContext(() => first.p);
	const acquiringSecond = model.acquireContext(() => second.p);
	const waiting = model.resolvePendingContext();
	assert.equal(model.hasPendingContext, true);
	assert.equal(model.size, 0);
	await first.complete([attachment('first')]);
	await acquiringFirst;
	assert.equal(model.hasPendingContext, true);
	assert.deepEqual(model.attachments.map(entry => entry.id), ['first']);
	await second.complete([attachment('second')]);
	await Promise.all([acquiringSecond, waiting]);
	assert.equal(model.hasPendingContext, false);
	assert.deepEqual(model.attachments.map(entry => entry.id), ['first', 'second']);
});

test('Reference preparation commits through the message owner without adding a bar attachment', async () => {
	using model = new ChatAttachmentModel();
	const prepared = new DeferredPromise<readonly ChatContextAttachment[]>();
	const acquiring = model.acquireContext(() => prepared.p, undefined, contexts => contexts.map(context => ({ ...context, reference: { start: 0, end: context.name.length } })));
	assert.equal(model.hasPendingMessageContext, true);
	const waiting = model.resolvePendingContext();
	await prepared.complete([attachment('file.ts')]);
	const contexts = await waiting;
	assert.deepEqual((await acquiring)[0]?.reference, { start: 0, end: 7 });
	assert.deepEqual(contexts[0]?.reference, { start: 0, end: 7 });
	assert.equal(model.size, 0);
	assert.equal(model.hasPendingMessageContext, false);
});

test('Clearing an empty draft cancels waiters and rejects results that ignore cancellation', async () => {
	using model = new ChatAttachmentModel();
	const result = new DeferredPromise<readonly ChatContextAttachment[]>();
	const acquiring = model.acquireContext(() => result.p);
	const waiting = model.resolvePendingContext();
	const rejected = Promise.all([assert.rejects(acquiring, isCancellationError), assert.rejects(waiting, isCancellationError)]);
	model.clear();
	await rejected;
	await result.complete([attachment('stale')]);
	await Promise.resolve();
	assert.deepEqual([...model.attachments], []);
	assert.equal(model.hasPendingContext, false);
	await model.acquireContext(async () => [attachment('new-draft')]);
	assert.deepEqual(model.attachments.map(entry => entry.id), ['new-draft']);
});

test('Preparation failure rejects a waiting submission and retains existing context', async () => {
	using model = new ChatAttachmentModel();
	model.addContext(attachment('existing'));
	const result = new DeferredPromise<readonly ChatContextAttachment[]>();
	const acquiring = model.acquireContext(() => result.p);
	const waiting = model.resolvePendingContext();
	const rejected = Promise.all([assert.rejects(acquiring, /invalid file/u), assert.rejects(waiting, /invalid file/u)]);
	await result.error(new Error('invalid file'));
	await rejected;
	assert.deepEqual(model.attachments.map(entry => entry.id), ['existing']);
	assert.equal(model.hasPendingContext, false);
});

test('Disposing the composer cancels unfinished context and rejects later acquisition', async () => {
	const model = new ChatAttachmentModel();
	const result = new DeferredPromise<readonly ChatContextAttachment[]>();
	const acquiring = model.acquireContext(() => result.p);
	const rejected = assert.rejects(acquiring, isCancellationError);
	model.dispose();
	await rejected;
	await result.complete([attachment('stale')]);
	await assert.rejects(model.acquireContext(async () => [attachment('new')]), isCancellationError);
	assert.deepEqual([...model.attachments], []);
});


test('A captured request excludes batches acquired after submission starts', async () => {
	using model = new ChatAttachmentModel();
	const first = new DeferredPromise<readonly ChatContextAttachment[]>();
	const second = new DeferredPromise<readonly ChatContextAttachment[]>();
	const acquiringFirst = model.acquireContext(() => first.p);
	const captured = model.resolvePendingContext();
	const acquiringSecond = model.acquireContext(() => second.p);
	await first.complete([attachment('submitted')]);
	assert.deepEqual((await captured).map(entry => entry.id), ['submitted']);
	await second.complete([attachment('next-draft')]);
	await Promise.all([acquiringFirst, acquiringSecond]);
	assert.deepEqual(model.attachments.map(entry => entry.id), ['submitted', 'next-draft']);
});
