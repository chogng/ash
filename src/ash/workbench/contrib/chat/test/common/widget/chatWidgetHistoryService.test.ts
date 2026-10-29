import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ChatHistoryNavigator } from '../../../common/widget/chatWidgetHistoryService.js';
import type { IMessageHistoryService, MessageHistoryEntry, MessageHistoryPage, MessageHistoryQuery } from '../../../../../../platform/messageHistory/common/messageHistory.js';

function entry(id: string, text = `Input ${id}`): MessageHistoryEntry {
	return { id, text, kind: 'agent', submittedAtMs: 1 };
}

function service(read: IMessageHistoryService['read']): IMessageHistoryService {
	return { read, append: async submission => ({ ...submission, id: 'new', submittedAtMs: 1 }), clear: async () => { } };
}

test('Chat history pages older inputs and restores the exact draft after reaching the newest entry', async () => {
	const reads: MessageHistoryQuery[] = [];
	using navigator = new ChatHistoryNavigator<{ text: string; selection: { anchor: number; active: number; }; attachments: readonly object[]; }>(service(async query => {
		reads.push(query);
		return query.before ? { entries: [entry('2'), entry('1')] } : { entries: [entry('4'), entry('3')], nextBefore: '3' };
	}));
	const draft = { text: 'original draft', selection: { anchor: 8, active: 3 }, attachments: [{}] };
	assert.equal((await navigator.previous(draft))?.kind, 'history');
	assert.deepEqual(await navigator.previous(draft), { kind: 'history', entry: entry('3') });
	assert.deepEqual(await navigator.previous(draft), { kind: 'history', entry: entry('2') });
	assert.equal(reads[1]?.before, '3');
	await navigator.next();
	await navigator.next();
	const restored = await navigator.next();
	assert.equal(restored?.kind, 'draft');
	assert.strictEqual(restored?.kind === 'draft' ? restored.draft : undefined, draft);
	assert.equal(navigator.active, false);
});

test('Chat history retires a delayed read after the draft changes', async () => {
	let finish!: (page: MessageHistoryPage) => void;
	let started!: () => void;
	const reading = new Promise<void>(resolve => { started = resolve; });
	using navigator = new ChatHistoryNavigator<string>(service(() => {
		started();
		return new Promise(resolve => { finish = resolve; });
	}));
	const pending = navigator.previous('original');
	await reading;
	navigator.invalidatePending();
	finish({ entries: [entry('1')] });
	assert.equal(await pending, undefined);
	assert.equal(navigator.restore(), 'original');
});

test('Chat history releases pending navigation when its input is disposed', async () => {
	let finish!: (page: MessageHistoryPage) => void;
	let started!: () => void;
	const reading = new Promise<void>(resolve => { started = resolve; });
	const navigator = new ChatHistoryNavigator<string>(service(() => {
		started();
		return new Promise(resolve => { finish = resolve; });
	}));
	const pending = navigator.previous('original');
	await reading;
	const queued = navigator.previous('original');
	navigator.dispose();
	finish({ entries: [entry('1')] });
	assert.equal(await pending, undefined);
	assert.equal(await queued, undefined);
	assert.equal(navigator.active, false);
});

test('Chat history search selection does not append or send and keeps the original draft during further recall', async () => {
	const appended: string[] = [];
	const api = service(async query => ({ entries: [entry('1')], nextBefore: query.text ? '1' : undefined }));
	api.append = async submission => { appended.push(submission.text); return { ...submission, id: 'new', submittedAtMs: 1 }; };
	using navigator = new ChatHistoryNavigator<string>(api);
	await navigator.previous('original');
	const search = await navigator.search('needle');
	navigator.select(search.entries[0]!, 'preview');
	assert.deepEqual(appended, []);
	assert.deepEqual(await navigator.next(), { kind: 'draft', draft: 'original' });
	await navigator.record('/config', 'command');
	assert.deepEqual(appended, ['/config']);
});
