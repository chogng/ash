import { localize } from '../../../../nls.js';
import { isRecord } from '../../../../base/common/types.js';
import { browserPageRequestHeader, browserPageAccountHeader, browserPageAccountScopeHeader } from '../../../../platform/browserView/common/browserPage.js';

export interface ChatGPTModel { readonly id: string; readonly title: string; }
export interface ChatGPTConversation { readonly id: string; readonly title: string; }
export interface ChatGPTMessage { readonly id: string; readonly role: 'user' | 'assistant'; readonly text: string; }
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

/** Credentials stay in the host. The page holds only an opaque connection binding. */
export class ChatGPTClient {
	private accountBinding: string | undefined;
	private generation = 0;
	constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) { }

	async connect(signal: AbortSignal): Promise<{ readonly id?: string; readonly name: string; }> {
		this.clear();
		const generation = this.generation;
		const response = await this.fetcher('/service/backend-api/me', { signal, cache: 'no-store', headers: { [browserPageRequestHeader]: 'chatgpt' } });
		const value: unknown = response.ok ? await response.json() : undefined;
		signal.throwIfAborted();
		if (generation !== this.generation) { throw new DOMException('Connection superseded', 'AbortError'); }
		const binding = response.headers.get(browserPageAccountHeader);
		const scope = response.headers.get(browserPageAccountScopeHeader);
		if (!isRecord(value) || typeof value.id !== 'string' || !binding || !scope) {
			if (!response.ok && response.status !== 401) { throw this.requestError(response.status); }
			throw this.signInRequired();
		}
		this.accountBinding = binding;
		return {
			id: `${scope}\0${value.id}`,
			name: typeof value.name === 'string' ? value.name : 'ChatGPT',
		};
	}

	clear(): void { this.generation++; this.accountBinding = undefined; }

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
			const message = readMessage(node.message);
			if (message) { messages.push(message); }
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
		// POST can be dispatched later by a still-running custom-protocol handler.
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

	private async json(path: string, signal: AbortSignal): Promise<unknown> {
		return (await this.request(path, signal)).json();
	}

	private async request(path: string, signal: AbortSignal, init: RequestInit = {}, headersOnly = false): Promise<Response> {
		signal.throwIfAborted();
		if (!this.accountBinding) { throw this.signInRequired(); }
		const generation = this.generation;
		const headers = new Headers(init.headers);
		headers.set(browserPageRequestHeader, 'chatgpt');
		headers.set(browserPageAccountHeader, this.accountBinding);
		const response = await this.fetcher(`/service${headersOnly ? '/.headers' : ''}/backend-api` + path, { ...init, headers, signal, cache: 'no-store' });
		signal.throwIfAborted();
		if (generation !== this.generation) { await response.body?.cancel(); throw new DOMException('Connection superseded', 'AbortError'); }
		if (response.ok) { return response; }
		if (response.status === 401 || response.status === 409) { this.clear(); }
		throw this.requestError(response.status);
	}

	private signInRequired(): Error {
		return new Error(localize('sessions.chatgpt.signInRequired', 'No usable local Codex login was found. Sign in through Codex, then select Connect.'));
	}

	private requestError(status: number): ChatGPTRequestError {
		if (status === 428) {
			return new ChatGPTRequestError(status, localize('sessions.chatgpt.sendVerificationUnavailable', 'ChatGPT send verification could not finish. Your message was not sent. Try again later.'));
		}
		if (status === 409) {
			return new ChatGPTRequestError(status, localize('sessions.chatgpt.accountChanged', 'The local login changed. Select Connect before continuing. Your message was not sent.'));
		}
		if (status === 403) {
			return new ChatGPTRequestError(status, localize('sessions.chatgpt.verificationRequired', 'ChatGPT rejected this request with a verification or access restriction (403). An existing login does not remove this restriction.'));
		}
		if (status === 429) { return new ChatGPTRequestError(status, localize('sessions.chatgpt.rateLimited', 'ChatGPT usage limit reached. Try again later.')); }
		return new ChatGPTRequestError(status, localize('sessions.chatgpt.requestFailed', 'ChatGPT request failed ({0}).', status));
	}

	private invalidResponse(): Error { return new Error(localize('sessions.chatgpt.invalidResponse', 'ChatGPT returned an unsupported response.')); }
}

function readMessage(value: unknown): ChatGPTMessage | undefined {
	if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.author) || !['user', 'assistant'].includes(value.author.role as string)
		|| !isRecord(value.content) || !Array.isArray(value.content.parts)) { return undefined; }
	if (isRecord(value.metadata) && value.metadata.is_visually_hidden_from_conversation === true) { return undefined; }
	const text = value.content.parts.filter((part): part is string => typeof part === 'string').join('\n') ||
		(value.content.parts.some(part => isRecord(part)) ? localize('sessions.chatgpt.unsupportedContent', 'This message contains content that cannot be displayed here. Open ChatGPT to view it.') : '');
	return { id: value.id, role: value.author.role as 'user' | 'assistant', text };
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
				const message = readMessage(snapshot.message);
				const conversationId = typeof snapshot.conversation_id === 'string' ? snapshot.conversation_id : undefined;
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
