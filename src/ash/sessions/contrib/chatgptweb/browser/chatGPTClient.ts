import { localize } from '../../../../nls.js';
import { isRecord } from '../../../../base/common/types.js';
import { escapeMarkdownSyntaxTokens } from '../../../../base/common/htmlContent.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';
export interface ChatGPTConversation { readonly id: string; readonly title: string; }

export interface ChatGPTModel { readonly id: string; readonly title: string; }
export interface ChatGPTResource {
	readonly uri: string;
	readonly name: string;
	readonly kind: 'image' | 'audio' | 'video' | 'document' | 'html';
	readonly mimeType?: string;
	readonly frameOrigin?: string;
}
export interface ChatGPTReference { readonly id: string; readonly url: string; readonly title: string; readonly snippet: string; }
export interface ChatGPTMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly resources?: readonly ChatGPTResource[];
	readonly references?: readonly ChatGPTReference[];
}
export interface ChatGPTHistory {
	readonly id: string;
	readonly title: string;
	readonly parentId: string;
	readonly model?: string;
	readonly messages: readonly ChatGPTMessage[];
}
export interface ChatGPTStreamUpdate { readonly conversationId?: string; readonly message?: ChatGPTMessage; }

/** An explicit HTTP rejection is different from an interrupted, possibly accepted message. */
export class ChatGPTRequestError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

/** ChatGPT web conversation client. Authentication is supplied by the host per request. */
export class ChatGPTClient {
	constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) { }

	async models(signal: AbortSignal): Promise<{ models: readonly ChatGPTModel[]; defaultModel: string; }> {
		const value = await this.json('/models?iim=false&include_icons=false&is_gizmo=false', signal);
		if (!isRecord(value) || !Array.isArray(value.models)) { throw this.invalidResponse(); }
		const models = value.models.flatMap(model => isRecord(model) && typeof model.slug === 'string' && typeof model.title === 'string'
			? [{ id: model.slug, title: model.title }] : []);
		if (!models.length) { throw this.invalidResponse(); }
		return { models, defaultModel: typeof value.default_model_slug === 'string' && models.some(model => model.id === value.default_model_slug) ? value.default_model_slug : models[0]!.id };
	}

	async conversations(offset: number, signal: AbortSignal): Promise<{ items: readonly ChatGPTConversation[]; hasMore: boolean; }> {
		const value = await this.json(`/conversations?offset=${offset}&limit=50&order=updated`, signal);
		if (!isRecord(value) || !Array.isArray(value.items)) { throw this.invalidResponse(); }
		const items = value.items.flatMap(item => isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string' ? [{ id: item.id, title: item.title }] : []);
		return { items, hasMore: typeof value.total === 'number' ? offset + value.items.length < value.total : value.items.length === 50 };
	}

	async history(id: string, signal: AbortSignal): Promise<ChatGPTHistory> {
		const value = await this.json(`/conversation/${encodeURIComponent(id)}`, signal);
		if (!isRecord(value) || !isRecord(value.mapping) || typeof value.current_node !== 'string') { throw this.invalidResponse(); }
		const messages: ChatGPTMessage[] = [];
		const visited = new Set<string>();
		let nodeId: string | undefined = value.current_node;
		while (nodeId && !visited.has(nodeId)) {
			visited.add(nodeId);
			const node: unknown = value.mapping[nodeId];
			if (!isRecord(node)) { break; }
			const message = readMessage(node.message, id);
			if (message && (message.text.trim() || message.resources?.length)) { messages.push(message); }
			nodeId = typeof node.parent === 'string' ? node.parent : undefined;
		}
		return {
			id, title: typeof value.title === 'string' ? value.title : 'ChatGPT', parentId: value.current_node,
			model: typeof value.default_model_slug === 'string' ? value.default_model_slug : undefined, messages: messages.reverse(),
		};
	}

	async *send(input: { text: string; model: string; parentId: string; conversationId?: string; messageId: string; }, signal: AbortSignal): AsyncGenerator<ChatGPTStreamUpdate> {
		const body = {
			action: 'next', model: input.model, parent_message_id: input.parentId,
			...(input.conversationId ? { conversation_id: input.conversationId } : {}),
			messages: [{ id: input.messageId, author: { role: 'user' }, content: { content_type: 'text', parts: [input.text] }, create_time: Date.now() / 1000 }],
			timezone_offset_min: new Date().getTimezoneOffset(), history_and_training_disabled: false,
			conversation_mode: { kind: 'primary_assistant' }, supports_buffering: true,
		};
		const preparation = await (await this.request('/f/conversation/prepare', signal, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
		})).json() as unknown;
		if (!isRecord(preparation) || typeof preparation.conduit_token !== 'string') { throw this.invalidResponse(); }
		// Verification has its own request. If the user cancels while it runs, no message
		// POST can be dispatched later by a still-running verification task.
		const verification: unknown = await (await this.request('/f/conversation', signal, { method: 'POST' }, true)).json();
		if (!isRecord(verification) || typeof verification['OpenAI-Sentinel-Chat-Requirements-Token'] !== 'string') { throw this.invalidResponse(); }
		const verificationHeaders: Record<string, string> = {};
		for (const name of ['OpenAI-Sentinel-Chat-Requirements-Token', 'OpenAI-Sentinel-Proof-Token', 'OpenAI-Sentinel-Turnstile-Token']) {
			if (typeof verification[name] === 'string') { verificationHeaders[name] = verification[name]; }
		}
		const response = await this.request('/f/conversation', signal, {
			method: 'POST', headers: { ...verificationHeaders, Accept: 'text/event-stream', 'Content-Type': 'application/json', 'x-conduit-token': preparation.conduit_token }, body: JSON.stringify(body),
		});
		if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) { throw this.invalidResponse(); }
		yield* decodeChatGPTStream(response.body, signal);
	}

	async stop(conversationId: string, messageId: string, signal: AbortSignal): Promise<void> {
		await this.request('/stop_conversation', signal, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: conversationId, message_id: messageId }),
		});
	}

	async readResource(resource: string, conversationId: string | undefined, messageId: string, signal: AbortSignal): Promise<Blob> {
		if (resource.startsWith('data:')) { return (await globalThis.fetch(resource, { signal })).blob(); }
		let url: string;
		if (/^(?:file-service|sediment):\/\//u.test(resource)) {
			const id = resource.slice(resource.indexOf('://') + 3);
			url = `https://chatgpt.com/backend-api/files/${encodeURIComponent(id)}/download`;
		} else if (resource.startsWith('sandbox:') && conversationId) {
			url = `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?` + new URLSearchParams({ message_id: messageId, sandbox_path: resource.slice('sandbox:'.length) });
		} else { url = new URL(resource, 'https://chatgpt.com').href; }
		for (let redirects = 0; redirects < 4; redirects++) {
			const response = await this.fetcher('/service/.resource?' + new URLSearchParams({ url }), { signal });
			if (!response.ok) throw this.requestError(response.status);
			if (response.headers.get('content-type')?.startsWith('application/json')) {
				const data: unknown = await response.clone().json();
				if (isRecord(data) && typeof data.download_url === 'string') { await response.body?.cancel(); url = data.download_url; continue; }
			}
			return response.blob();
		}
		throw this.invalidResponse();
	}

	private async json(path: string, signal: AbortSignal): Promise<unknown> {
		return (await this.request(path, signal)).json();
	}

	private async request(path: string, signal: AbortSignal, init: RequestInit = {}, headersOnly = false): Promise<Response> {
		signal.throwIfAborted();
		const response = await this.fetcher(`/service${headersOnly ? '/.headers' : ''}/backend-api` + path, { ...init, signal, cache: 'no-store' });
		if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
		if (response.ok) { return response; }
		throw this.requestError(response.status);
	}

	private requestError(status: number): ChatGPTRequestError {
		if (status === 428) {
			return new ChatGPTRequestError(status, localize('sessions.chatgpt.sendVerificationUnavailable', 'ChatGPT send verification could not finish. Your message was not sent. Try again later.'));
		}
		if (status === 403) {
			return new ChatGPTRequestError(status, localize('sessions.chatgpt.verificationRequired', 'ChatGPT rejected this request with a verification or access restriction (403). An existing login does not remove this restriction.'));
		}
		if (status === 429) { return new ChatGPTRequestError(status, localize('sessions.chatgpt.rateLimited', 'ChatGPT usage limit reached. Try again later.')); }
		return new ChatGPTRequestError(status, localize('sessions.chatgpt.requestFailed', 'ChatGPT request failed ({0}).', status));
	}

	private invalidResponse(): Error { return new Error(localize('sessions.chatgpt.invalidResponse', 'ChatGPT returned an unsupported response.')); }
}

function readMessage(value: unknown, conversationId: string | undefined): ChatGPTMessage | undefined {
	if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.author) || !['user', 'assistant'].includes(value.author.role as string)
		|| !isRecord(value.content)) { return undefined; }
	if (isRecord(value.metadata) && value.metadata.is_visually_hidden_from_conversation === true) { return undefined; }
	// The web sends this turn-status node separately from the answer. Treating
	// it as opaque media creates a content-free message with a web-view link.
	if (value.content.content_type === 'reasoning_recap') { return undefined; }
	const url = conversationId ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` : 'https://chatgpt.com/';
	const fallback = `[${localize('sessions.chatgpt.viewContent', 'View this content in ChatGPT')}](${url})`;
	const resources: ChatGPTResource[] = [];
	const resourcePart = (part: Record<string, unknown>): ChatGPTResource | undefined => {
		const uri = ['asset_pointer', 'audio_asset_pointer', 'video_asset_pointer', 'url'].map(key => part[key]).find(value => typeof value === 'string') ?? (typeof part.file_id === 'string' ? `file-service://${part.file_id}` : undefined);
		if (typeof uri !== 'string' || uri.length > 8192) return undefined;
		const name = ['name', 'file_name', 'title', 'alt'].map(key => part[key]).find(value => typeof value === 'string');
		const mimeType = typeof part.mime_type === 'string' ? part.mime_type : typeof part.mimeType === 'string' ? part.mimeType : typeof name === 'string' ? getMediaOrTextMime(name) : undefined;
		const type = typeof part.content_type === 'string' ? part.content_type : mimeType ?? '';
		const kind = /image/u.test(type) ? 'image' : /audio/u.test(type) ? 'audio' : /video/u.test(type) ? 'video' : mimeType === 'text/html' ? 'html' : 'document';
		return { uri, kind, name: typeof name === 'string' ? name : kind === 'document' ? localize('sessions.chatgpt.file', 'File') : localize('sessions.chatgpt.media', 'Media'), mimeType };
	};
	const literal = (text: string): string => escapeMarkdownSyntaxTokens(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	const partText = (part: unknown): string => {
		if (typeof part === 'string') { return part; }
		if (!isRecord(part)) { return part == null ? '' : fallback; }
		// Keep mixed text/media parts in source order. Selecting only string parts
		// used to silently discard an image whenever that same message had a caption.
		if (part.content_type === 'text' && typeof part.text === 'string') { return part.text; }
		const resource = resourcePart(part);
		if (resource) { resources.push(resource); return literal(resource.name); }
		for (const key of ['audio', 'video', 'image']) {
			if (isRecord(part[key])) { const nested = resourcePart({ content_type: key, ...part[key] }); if (nested) { resources.push(nested); return literal(nested.name); } }
		}
		const description = ['text', 'title', 'alt', 'name'].flatMap(key => typeof part[key] === 'string' ? [literal(part[key])] : []).join('\n');
		return [description, fallback].filter(Boolean).join('\n\n');
	};
	let text: string;
	if (Array.isArray(value.content.parts)) { text = value.content.parts.map(partText).join('\n'); }
	else if (typeof value.content.text === 'string') {
		const body = value.content.text;
		// Code content uses a different web payload shape. Quote it instead of
		// interpreting embedded HTML/components as the surrounding message.
		let fenceLength = 3;
		for (const match of body.matchAll(/`+/gu)) { fenceLength = Math.max(fenceLength, match[0].length + 1); }
		const fence = '`'.repeat(fenceLength);
		text = value.content.content_type === 'code' ? `${fence}\n${body}\n${fence}` : body;
		if (value.content.content_type && !['text', 'code'].includes(value.content.content_type as string)) { text += `\n\n${fallback}`; }
	} else { text = value.content.content_type === 'text' || !value.content.content_type ? '' : fallback; }
	if (isRecord(value.metadata) && Array.isArray(value.metadata.attachments)) {
		for (const attachment of value.metadata.attachments) {
			if (!isRecord(attachment)) { continue; }
			const name = typeof attachment.name === 'string' ? attachment.name : typeof attachment.file_name === 'string' ? attachment.file_name : '';
			const resource = resourcePart({ ...attachment, file_id: attachment.file_id ?? attachment.id });
			if (resource) { resources.push(resource); }
			else { text += `\n\n${name ? localize('sessions.chatgpt.attachment', 'Attachment: {0}', literal(name)) + '\n\n' : ''}${fallback}`; }
		}
	}
	const references: ChatGPTReference[] = [];
	const addReference = (entry: unknown): void => {
		if (!isRecord(entry) || typeof entry.url !== 'string') return;
		let url: URL; try { url = new URL(entry.url); } catch { return; }
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
		const ids = [entry.ref_id, ...(Array.isArray(entry.refs) ? entry.refs : [])].flatMap(ref =>
			typeof ref === 'string' ? [ref] : isRecord(ref) && typeof ref.turn_index === 'number' && typeof ref.ref_type === 'string' && typeof ref.ref_index === 'number'
				? [`turn${ref.turn_index}${ref.ref_type}${ref.ref_index}`] : []);
		for (const id of ids.length ? ids : [url.href]) {
			if (!references.some(item => item.id === id)) references.push({ id, url: url.href, title: typeof entry.title === 'string' ? entry.title : url.hostname, snippet: typeof entry.snippet === 'string' ? entry.snippet : '' });
		}
	};
	if (isRecord(value.metadata)) {
		for (const group of Array.isArray(value.metadata.search_result_groups) ? value.metadata.search_result_groups : []) {
			if (isRecord(group) && Array.isArray(group.entries)) group.entries.forEach(addReference);
		}
		for (const reference of Array.isArray(value.metadata.content_references) ? value.metadata.content_references : []) {
			if (!isRecord(reference)) continue;
			addReference(reference);
			addReference(reference.item);
			for (const key of ['sources', 'items']) if (Array.isArray(reference[key])) reference[key].forEach(addReference);
		}
	}
	return { id: value.id, role: value.author.role as 'user' | 'assistant', text, ...(resources.length ? { resources } : {}), ...(references.length ? { references } : {}) };
}

/** SSE framing is independent of HTTP chunks; delta paths are restricted to ordinary JSON properties. */
export async function* decodeChatGPTStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<ChatGPTStreamUpdate> {
	const reader = stream.getReader();
	const cancel = (): void => { void reader.cancel().catch(() => { }); };
	signal.addEventListener('abort', cancel, { once: true });
	const decoder = new TextDecoder();
	let buffer = '';
	let snapshot: Record<string, unknown> = {};
	let previousPath = '';
	let done = false;
	try {
		while (!done) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			buffer += decoder.decode(chunk.value, { stream: !chunk.done });
			if (buffer.length > 4 * 1024 * 1024) { throw new Error(localize('sessions.chatgpt.invalidResponse', 'ChatGPT returned an unsupported response.')); }
			let match: RegExpExecArray | null;
			while ((match = /\r?\n\r?\n/u.exec(buffer))) {
				const event = buffer.slice(0, match.index);
				buffer = buffer.slice(match.index + match[0].length);
				const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
				if (!data) { continue; }
				if (data === '[DONE]') { done = true; break; }
				const value: unknown = JSON.parse(data);
				if (!isRecord(value)) { continue; }
				if (value.error) { throw new Error(localize('sessions.chatgpt.streamFailed', 'ChatGPT could not finish this reply. The message may already have been sent. Reload the conversation before trying again.')); }
				if (typeof value.o === 'string') {
					const patches = value.o === 'patch' && Array.isArray(value.v) ? value.v : [value];
					for (const patch of patches) {
						if (!isRecord(patch)) { continue; }
						const path = typeof patch.p === 'string' ? patch.p : previousPath;
						previousPath = path;
						if (path === '' && (patch.o === 'add' || patch.o === 'replace') && isRecord(patch.v)) { snapshot = patch.v; }
						else { applyDelta(snapshot, path, patch.o, patch.v); }
					}
				} else { snapshot = value; }
				const conversationId = typeof snapshot.conversation_id === 'string' ? snapshot.conversation_id : undefined;
				const message = readMessage(snapshot.message, conversationId);
				if (message || conversationId) { yield { conversationId, message }; }
			}
			if (chunk.done) {
				if (!done) { throw new Error(localize('sessions.chatgpt.streamFailed', 'ChatGPT could not finish this reply. The message may already have been sent. Reload the conversation before trying again.')); }
				break;
			}
		}
	} finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => { }); reader.releaseLock(); }
}

function applyDelta(root: Record<string, unknown>, path: string, operation: unknown, value: unknown): void {
	const keys = path.split('/').slice(1).map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
	if (!keys.length || keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) { return; }
	let target: Record<string, unknown> | unknown[] = root;
	for (const key of keys.slice(0, -1)) {
		if (!Object.hasOwn(target, key)) { return; }
		const next: unknown = Reflect.get(target, key);
		if (!isRecord(next) && !Array.isArray(next)) { return; }
		target = next;
	}
	const key = keys.at(-1)!;
	// JSON cannot contain sparse arrays or a forged length. Do not let a delta create
	// either: readMessage joins parts, so a huge sparse length would stall the renderer.
	if (Array.isArray(target) && (!/^(?:0|[1-9]\d*)$/u.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) > target.length)) { return; }
	const previous: unknown = Reflect.get(target, key);
	if (operation === 'append' && typeof previous === 'string' && typeof value === 'string') { Reflect.set(target, key, previous + value); }
	else if (operation === 'append' && Array.isArray(previous) && Array.isArray(value)) { previous.push(...value); }
	else if (operation === 'add' || operation === 'replace') { Reflect.set(target, key, value); }
	else if (operation === 'remove') { Reflect.deleteProperty(target, key); }
}
