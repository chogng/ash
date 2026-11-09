import { Marked } from '../../src/ash/base/common/marked/marked.js';
import {
	conversationShareId, conversationShareMaxBytes, conversationShareRetentionDays, parseConversationShare, type ConversationShare,
} from '../../src/ash/platform/chat/common/conversationShare.js';

interface Environment {
	SHARES: {
		put(key: string, content: string): Promise<unknown>;
		get(key: string): Promise<{ uploaded: Date; json(): Promise<unknown>; } | null>;
	};
	PUBLISH_LIMIT: { limit(options: { key: string; }): Promise<{ success: boolean; }>; };
}

const publishPath = '/v1/shares';
const retentionMs = conversationShareRetentionDays * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const responseHeaders = {
	'Cache-Control': 'no-store',
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
	'X-Robots-Tag': 'noindex, nofollow',
};
const apiHeaders = { ...responseHeaders, 'Access-Control-Allow-Origin': '*' };

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const markdown = new Marked({
	renderer: {
		html: ({ text }) => escapeHtml(text),
		image: ({ text }) => escapeHtml(text),
		link({ href, text, tokens, autolink }) {
			const label = autolink ? escapeHtml(text) : this.parser.parseInline(tokens);
			let url: URL;
			try { url = new URL(href); } catch { return label; }
			if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return label;
			return `<a href="${escapeHtml(url.href)}" rel="noreferrer noopener">${label}</a>`;
		},
	},
});

async function readSnapshot(request: Request): Promise<ConversationShare | Response> {
	const reader = request.body?.getReader();
	if (!reader) return apiError(400, 'A transcript is required');
	const decoder = new TextDecoder('utf-8', { fatal: true });
	let length = 0;
	let body = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > conversationShareMaxBytes) {
				await reader.cancel();
				return apiError(413, 'Transcript too large');
			}
			body += decoder.decode(value, { stream: true });
		}
		const snapshot = parseConversationShare(JSON.parse(body + decoder.decode()));
		return snapshot ?? apiError(400, 'Invalid transcript');
	} catch {
		await reader.cancel().catch(() => { });
		return apiError(400, 'Invalid transcript');
	} finally {
		reader.releaseLock();
	}
}

function apiError(status: number, message: string): Response {
	return new Response(message, { status, headers: apiHeaders });
}

function renderSnapshot(snapshot: ConversationShare, chinese: boolean): Response {
	const language = chinese ? 'zh-CN' : 'en';
	const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
	const title = escapeHtml(snapshot.title);
	function* page(): Generator<string> {
		yield `<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Ash</title>
<style>
:root{color-scheme:light dark;font:16px/1.55 system-ui,sans-serif}
main{max-width:50rem;margin:auto;padding:2rem 1rem;overflow-wrap:anywhere}
h1{font-size:1.65rem;line-height:1.25;margin:0 0 .5rem}
article{border-top:1px solid GrayText;margin-top:1.5rem;padding-top:1rem}
article header{display:flex;gap:1rem;align-items:baseline}
time,small{color:GrayText}
pre{overflow:auto;padding:1rem;background:color-mix(in srgb,CanvasText 8%,Canvas)}
blockquote{border-inline-start:3px solid GrayText;padding-inline-start:1rem;margin-inline:0}
table{display:block;overflow:auto;border-collapse:collapse}
td,th{border:1px solid GrayText;padding:.35rem .6rem}
</style>
<main><h1>${title}</h1><small>${chinese ? 'Ash 分享的对话快照' : 'Conversation shared from Ash'}</small>`;
		for (const message of snapshot.messages) {
			const speaker = message.role === 'user' ? (chinese ? '用户' : 'User') : 'Ash';
			const time = message.timestamp === undefined ? '' : `<time datetime="${new Date(message.timestamp).toISOString()}">${date.format(message.timestamp)} UTC</time>`;
			let content: string;
			try { content = markdown.parse(message.text, { async: false, breaks: true }); }
			catch { content = `<pre>${escapeHtml(message.text)}</pre>`; }
			yield `<article><header><strong>${speaker}</strong>${time}</header>${content}</article>`;
		}
		yield '</main></html>';
	}
	const chunks = page();
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks.next();
			if (chunk.done) controller.close();
			else controller.enqueue(encoder.encode(chunk.value));
		},
	}), {
		headers: {
			...responseHeaders,
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
		},
	});
}

export default {
	async fetch(request: Request, environment: Environment): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === publishPath) {
			if (request.method === 'OPTIONS') return new Response(null, {
				status: 204,
				headers: { ...apiHeaders, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' },
			});
			if (request.method !== 'POST') return apiError(405, 'Method not allowed');
			if (request.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') return apiError(415, 'Expected JSON');
			const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
			if (!(await environment.PUBLISH_LIMIT.limit({ key: ip })).success) return apiError(429, 'Too many shares');
			const snapshot = await readSnapshot(request);
			if (snapshot instanceof Response) return snapshot;
			const id = crypto.randomUUID();
			await environment.SHARES.put(`shares/${id}`, JSON.stringify(snapshot));
			return new Response(null, {
				status: 201,
				headers: { ...apiHeaders, Location: `/s/${id}`, 'Access-Control-Expose-Headers': 'Location' },
			});
		}
		const id = pathname.slice('/s/'.length);
		if (request.method === 'GET' && pathname.startsWith('/s/') && conversationShareId.test(id)) {
			const record = await environment.SHARES.get(`shares/${id}`);
			if (record && Date.now() - record.uploaded.getTime() < retentionMs) {
				const snapshot = parseConversationShare(await record.json());
				if (snapshot) return renderSnapshot(snapshot, /^zh(?:-|\b)/iu.test(request.headers.get('accept-language') ?? ''));
			}
		}
		return new Response('This conversation share is unavailable.', { status: 404, headers: responseHeaders });
	},
};
