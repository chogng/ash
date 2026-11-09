import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './worker.js';
import { conversationShareMaxBytes, conversationShareRetentionDays } from '../../src/ash/platform/chat/common/conversationShare.js';

const origin = 'https://share.example';

function fixture(allow = true) {
	const records = new Map<string, { text: string; uploaded: Date; }>();
	const environment = {
		SHARES: {
			async put(key: string, text: string) { records.set(key, { text, uploaded: new Date() }); },
			async get(key: string) {
				const record = records.get(key);
				return record ? { uploaded: record.uploaded, json: async () => JSON.parse(record.text) } : null;
			},
		},
		PUBLISH_LIMIT: { limit: async () => ({ success: allow }) },
	};
	const get = (path: string) => worker.fetch(new Request(origin + path), environment);
	const post = (body: string) => worker.fetch(new Request(origin + '/v1/shares', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
	}), environment);
	return { records, get, post };
}

test('a fresh browser can read the full stored snapshot and only public message data', async () => {
	const { records, post, get } = fixture();
	const response = await post(JSON.stringify({
		version: 1,
		title: '<Shared & readable>',
		sessionId: 'internal-session',
		messages: [
			{ role: 'user', text: 'First question', timestamp: 1_794_245_520_000 },
			{ role: 'assistant', text: '**Last answer**\n\n<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert(1))\n\n![image](https://tracker.example/img)', secret: 'internal-tool-output' },
		],
	}));
	assert.equal(response.status, 201);
	const path = response.headers.get('Location')!;
	assert.match(path, /^\/s\/[a-f0-9-]{36}$/u);
	const record = records.get('shares' + path.slice(2))!;
	assert.doesNotMatch(record.text, /internal-session|internal-tool-output/u);
	const reader = await get(path);
	assert.equal(reader.status, 200);
	assert.match(reader.headers.get('Content-Security-Policy')!, /default-src 'none'/u);
	assert.match(reader.headers.get('X-Robots-Tag')!, /noindex/u);
	const html = await reader.text();
	assert.match(html, /&lt;Shared &amp; readable&gt;[\s\S]*First question[\s\S]*<strong>Last answer<\/strong>/u);
	assert.match(html, /<time datetime="2026-11-09T17:32:00.000Z">/u);
	assert.doesNotMatch(html, /<img|href="javascript:|tracker\.example/u);
	record.uploaded = new Date(Date.now() - conversationShareRetentionDays * 86_400_000);
	assert.equal((await get(path)).status, 404);
});

test('invalid, oversized and rate limited requests do not create snapshots', async () => {
	const active = fixture();
	assert.equal((await active.post('{"version":1,"title":"x","messages":[{"role":"tool","text":"private"}]}')).status, 400);
	assert.equal((await active.post('x'.repeat(conversationShareMaxBytes + 1))).status, 413);
	assert.equal(active.records.size, 0);
	const limited = fixture(false);
	assert.equal((await limited.post('{"version":1,"title":"x","messages":[{"role":"user","text":"y"}]}')).status, 429);
	assert.equal(limited.records.size, 0);
});
