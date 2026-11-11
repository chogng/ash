import type { ChatReplyRequest, ChatReplyAttachment as ChatGPTFile, ChatReplyResource as ChatGPTResource, ChatReplyReference as ChatGPTReference, ChatReplyMessage, ChatReplyUpdate as ChatGPTStreamUpdate } from '../../../common/chatReplyBackend.js';
export type { ChatReplyAttachment as ChatGPTFile, ChatReplyResource as ChatGPTResource, ChatReplyReference as ChatGPTReference, ChatReplyUpdate as ChatGPTStreamUpdate } from '../../../common/chatReplyBackend.js';
import { localize } from '../../../../nls.js';
import { isRecord } from '../../../../base/common/types.js';
import { escapeMarkdownSyntaxTokens } from '../../../../base/common/htmlContent.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';
import { SSEParser } from '../../../../base/common/sseParser.js';
import { chatGPTEntityDetailPath, chatGPTHistoryCooldownMs, chatGPTPrepareTokenHeader, readChatGPTGalleryImageUrl, readChatGPTRetryAfter } from '../common/chatGPTTransport.js';
import type { CatalogProjectMemoryMode } from '../../sessions/browser/views/sessionsCatalogList.js';

const projectFileId = /^file[-_][A-Za-z0-9_-]{1,240}$/u;
const uploadRetryDelays = [500, 1_500] as const;
const retryableUploadStatuses = new Set([408, 429, 500, 502, 503, 504]);
const retryableUploadNetworkError = /^net::ERR_(?:CONNECTION_(?:CLOSED|RESET|REFUSED|ABORTED|FAILED|TIMED_OUT)|NETWORK_CHANGED|INTERNET_DISCONNECTED|TIMED_OUT)$/u;
export interface ChatGPTBranchSource {
	readonly conversationId: string;
	readonly messageId: string;
	readonly projectId?: string;
}

export interface ChatGPTReplyRequest extends ChatReplyRequest {
	readonly branch?: ChatGPTBranchSource;
	readonly projectId?: string;
}
export interface ChatGPTConversation {
	readonly id: string;
	readonly title: string;
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly pinned?: boolean;
	readonly projectId?: string;
	readonly local?: boolean;
	readonly archived?: boolean;
	/** This row was discovered outside the window's recent-history pagination. */
	readonly projectOnly?: boolean;
}
export interface ChatGPTProject {
	readonly id: string;
	readonly title: string;
	readonly createdAt?: number;
	readonly updatedAt?: number;
}
export interface ChatGPTProjectDetails {
	readonly name: string;
	readonly description: string;
	readonly emoji: string | null;
	readonly theme: string | null;
	readonly memoryMode?: CatalogProjectMemoryMode;
	readonly canEditMemoryMode: boolean;
	readonly canWrite: boolean;
	readonly files?: readonly { readonly id: string; readonly name: string; readonly sizeBytes?: number; }[];
}
export type ChatGPTProjectCursor = { readonly kind: 'project'; readonly value: string; } | { readonly kind: 'recent'; readonly offset: number; };

function conversationTimestamp(value: unknown): number | undefined {
	const time = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(time) ? time : undefined;
}

function conversationTimestamps(item: Record<string, unknown>): Pick<ChatGPTConversation, 'createdAt' | 'updatedAt'> {
	const createdAt = conversationTimestamp(item.create_time);
	const updatedAt = conversationTimestamp(item.update_time);
	return {
		...(createdAt === undefined ? {} : { createdAt }),
		...(updatedAt === undefined ? {} : { updatedAt }),
	};
}

function projectTimestamps(gizmo: Record<string, unknown>): Pick<ChatGPTProject, 'createdAt' | 'updatedAt'> {
	const createdAt = typeof gizmo.created_at === 'string' ? Date.parse(gizmo.created_at) : NaN;
	const updatedAt = typeof gizmo.updated_at === 'string' ? Date.parse(gizmo.updated_at) : NaN;
	return {
		...(Number.isFinite(createdAt) ? { createdAt } : {}),
		...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
	};
}

function readProjectMemoryMode(scope: unknown): CatalogProjectMemoryMode | undefined {
	return scope === 'global' ? 'default' : scope === 'project_v2' ? 'projectOnly' : undefined;
}

function projectMemoryScope(mode: CatalogProjectMemoryMode | undefined): 'global' | 'project_v2' | undefined {
	return mode === undefined ? undefined : mode === 'default' ? 'global' : 'project_v2';
}

/** A product model family and its selectable presets from the web model picker. */
export interface ChatGPTModel {
	readonly id: string;
	readonly title: string;
	readonly modelIds: readonly string[];
	readonly presets: readonly {
		readonly id: string;
		readonly label: string;
		readonly model: string;
		readonly thinkingEffort?: string;
		/** Whether the web preset advertises the Pro lane. */
		readonly isPro: boolean;
	}[];
	readonly defaultPreset: string;
}
export interface ChatGPTVoiceUpdate {
	readonly conversationId?: string;
	readonly parentId?: string;
	readonly message?: ChatGPTMessage;
}
export type ChatGPTImageGroup = {
	readonly images: readonly { readonly uri: string; readonly label: string; readonly source?: string; }[];
} & ({ readonly marker: string; } | { readonly query: string; });
export type ChatGPTMessage = ChatReplyMessage & {
	readonly editableText?: string;
	readonly hasVersions?: boolean;
	readonly imageGroups?: readonly ChatGPTImageGroup[];
};
export interface ChatGPTMessageVersion {
	readonly head: string;
	readonly text: string;
	readonly selected: boolean;
}
export interface ChatGPTHistory {
	readonly id: string;
	readonly title: string;
	readonly parentId: string;
	readonly model?: string;
	readonly thinkingEffort?: string;
	readonly archived?: boolean;
	/** Undefined when the response does not report membership, null when unassigned. */
	readonly projectId?: string | null;
	readonly olderCursor?: string;
	readonly messages: readonly ChatGPTMessage[];
}

function historyProjectId(value: Record<string, unknown>): Pick<ChatGPTHistory, 'projectId'> {
	const id = value.gizmo_id;
	return id === null || typeof id === 'string' && /^g-p-[A-Za-z0-9_-]{1,240}$/u.test(id) ? { projectId: id } : {};
}
interface ChatGPTStreamFrame extends ChatGPTStreamUpdate { readonly resumeToken?: string; readonly handoff?: boolean; readonly finished?: boolean; }

/** An explicit HTTP rejection is different from an interrupted, possibly accepted message. */
export class ChatGPTRequestError extends Error {
	constructor(readonly status: number, message: string, readonly retryAt?: number) { super(message); }
}

export function isChatGPTRateLimit(error: unknown): error is ChatGPTRequestError {
	return error instanceof ChatGPTRequestError && error.status === 429;
}

type HistoryRead = 'recent' | 'projects' | 'pins' | 'project' | 'conversation';

/** ChatGPT web conversation client. Authentication is supplied by the host per request. */
export class ChatGPTClient {
	private readonly historyLimits = new Map<HistoryRead, ChatGPTRequestError>();
	constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private readonly native = false) { }

	clearHistoryLimits(): void { this.historyLimits.clear(); }

	async models(signal: AbortSignal): Promise<{ models: readonly ChatGPTModel[]; defaultModel: string; }> {
		const value = await this.json('/models?iim=false&include_icons=false&is_gizmo=false', signal);
		if (!isRecord(value) || !Array.isArray(value.models) || !Array.isArray(value.versions)) { throw this.invalidResponse(); }
		const defaultModelSlug = typeof value.default_model_slug === 'string' ? value.default_model_slug : undefined;
		const requestModels = new Map(value.models.flatMap(model => isRecord(model) && typeof model.slug === 'string' ? [[model.slug, model] as const] : []));
		const models: ChatGPTModel[] = [];
		// versions defines the product menu. models contains internal routing variants,
		// including Work models that must not become extra ChatGPT picker entries.
		for (const version of value.versions) {
			if (!isRecord(version) || typeof version.id !== 'string' || !version.id.trim() || version.enabled === false || version.disabled === true
				|| !Array.isArray(version.intelligence_presets) || models.some(model => model.id === version.id)) { continue; }
			const title = [version.display_text_for_intelligence, version.display_text, version.display_text_full].find(text => typeof text === 'string' && text.trim());
			if (typeof title !== 'string') { continue; }
			const versionNumber = /^(?:GPT-)?(\d+(?:\.\d+)*)(?=\s|$)/iu.exec(title.trim())?.[1];
			const presets: ChatGPTModel['presets'][number][] = [];
			for (const preset of version.intelligence_presets) {
				if (!isRecord(preset) || (preset.preset_type !== undefined && preset.preset_type !== 'available') || preset.disabled === true) { continue; }
				const id = typeof preset.id === 'number' && Number.isSafeInteger(preset.id) ? String(preset.id)
					: typeof preset.id === 'string' && preset.id.trim() ? preset.id : undefined;
				if (id === undefined || typeof preset.model_slug !== 'string' || presets.some(option => option.id === id)) { continue; }
				const requestModel = requestModels.get(preset.model_slug);
				if (!requestModel) { continue; }
				const presetTitle = [preset.selected_display_title, preset.title].find(text => typeof text === 'string' && text.trim());
				if (typeof presetTitle !== 'string') { continue; }
				// The picker already displays the family above or beside its preset label.
				const numberedTitle = /^(\d+(?:\.\d+)*)\s+(\S.*)$/u.exec(presetTitle.trim());
				const label = numberedTitle && numberedTitle[1] === versionNumber ? numberedTitle[2]! : presetTitle;
				let thinkingEffort: string | undefined;
				if (preset.thinking_effort != null) {
					if (typeof preset.thinking_effort !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(preset.thinking_effort)
						|| requestModel.configurable_thinking_effort !== true || !Array.isArray(requestModel.thinking_efforts)
						|| !requestModel.thinking_efforts.some(effort => isRecord(effort) && effort.thinking_effort === preset.thinking_effort)) { continue; }
					thinkingEffort = preset.thinking_effort;
				}
				presets.push({ id, label, model: preset.model_slug, thinkingEffort, isPro: preset.lane === 'pro' });
			}
			if (!presets.length) { continue; }
			const modelIds = [...new Set([
				...(Array.isArray(version.slugs) ? version.slugs.filter((slug): slug is string => typeof slug === 'string' && requestModels.has(slug)) : []),
				...presets.map(preset => preset.model),
			])];
			models.push({
				id: version.id, title, modelIds, presets,
				defaultPreset: presets.find(preset => preset.model === defaultModelSlug)?.id ?? presets[0]!.id,
			});
		}
		if (!models.length) { throw this.invalidResponse(); }
		return { models, defaultModel: models.find(model => defaultModelSlug !== undefined && model.modelIds.includes(defaultModelSlug))?.id ?? models[0]!.id };
	}

	async conversations(offset: number, signal: AbortSignal, visibility?: 'active' | 'archived'): Promise<{ items: readonly ChatGPTConversation[]; hasMore: boolean; nextOffset: number; }> {
		const limit = this.native ? 20 : 50;
		const query = this.native
			? `exclude_conversation_origin=tpp&expand=false&is_archived=false&is_starred=false&limit=${limit}&order=updated&offset=${offset}`
			: `offset=${offset}&limit=${limit}&order=updated&hide_snorlax=false`;
		const filters = new URLSearchParams(query);
		if (visibility) {
			filters.set('is_archived', String(visibility === 'archived'));
			filters.delete('is_starred');
		}
		const value = await this.json(`/conversations?${filters}`, signal, this.native ? undefined : 'recent');
		if (!isRecord(value) || !Array.isArray(value.items)) { throw this.invalidResponse(); }
		const items = value.items.flatMap(item => isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string'
			? [{
				id: item.id, title: item.title, ...conversationTimestamps(item), pinned: item.is_starred === true,
				projectId: typeof item.gizmo_id === 'string' ? item.gizmo_id : undefined,
				...(visibility && item.is_archived === true ? { archived: true } : {}),
			}] : []);
		return { items, nextOffset: offset + value.items.length, hasMore: value.items.length > 0 && (typeof value.total === 'number' ? offset + value.items.length < value.total : value.items.length === limit) };
	}

	async pinnedConversations(signal: AbortSignal): Promise<readonly ChatGPTConversation[]> {
		const value = await this.json('/pins?item_type=conversation', signal, this.native ? undefined : 'pins');
		if (!Array.isArray(value)) { throw this.invalidResponse(); }
		return value.flatMap(pin => {
			const item = isRecord(pin) ? pin.item : undefined;
			return isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string'
				? [{ id: item.id, title: item.title, ...conversationTimestamps(item), pinned: true, projectId: typeof item.gizmo_id === 'string' ? item.gizmo_id : undefined }] : [];
		});
	}

	async projects(signal: AbortSignal): Promise<readonly ChatGPTProject[]> {
		const projects = new Map<string, ChatGPTProject>();
		const cursors = new Set<string>();
		let cursor: string | undefined;
		do {
			const query = new URLSearchParams({ conversations_per_gizmo: '0', limit: '20', owned_only: 'false', ...(cursor ? { cursor } : {}) });
			const value = await this.json('/gizmos/snorlax/sidebar?' + query, signal, this.native ? undefined : 'projects');
			if (!isRecord(value) || !Array.isArray(value.items) || (value.cursor != null && typeof value.cursor !== 'string')) { throw this.invalidResponse(); }
			for (const item of value.items) {
				if (!isRecord(item) || !isRecord(item.gizmo)) { continue; }
				// ChatGPT can wrap the project metadata with its tools and files.
				const gizmo = isRecord(item.gizmo.gizmo) ? item.gizmo.gizmo : item.gizmo;
				if (!isRecord(gizmo.display) || typeof gizmo.id !== 'string'
					|| typeof gizmo.display.name !== 'string' || (gizmo.gizmo_snorlax_type === 'locked_chats' || gizmo.is_archived === true)) { continue; }
				projects.set(gizmo.id, { id: gizmo.id, title: gizmo.display.name, ...projectTimestamps(gizmo) });
			}
			cursor = value.cursor || undefined;
			if (cursor && cursors.has(cursor)) { throw this.invalidResponse(); }
			if (cursor) { cursors.add(cursor); }
		} while (cursor);
		return [...projects.values()];
	}

	async deleteProject(id: string, signal: AbortSignal): Promise<void> {
		await this.consume(`/gizmos/${encodeURIComponent(id)}`, signal, 'DELETE');
	}

	async createProject(name: string, description: string, signal: AbortSignal, memoryMode?: CatalogProjectMemoryMode): Promise<ChatGPTProject & { readonly memoryMode?: CatalogProjectMemoryMode; }> {
		const response = await this.request('/projects', signal, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, instructions: description, emoji: null, theme: null, memory_scope: projectMemoryScope(memoryMode) }),
		});
		const value: unknown = await response.json();
		signal.throwIfAborted();
		const resource = isRecord(value) && isRecord(value.resource) ? value.resource : value;
		const gizmo = isRecord(resource) && isRecord(resource.gizmo) ? resource.gizmo : undefined;
		if (typeof gizmo?.id !== 'string' || !/^g-p-[A-Za-z0-9_-]{1,240}$/u.test(gizmo.id)) throw this.invalidResponse();
		const savedMemoryMode = readProjectMemoryMode(gizmo.memory_scope);
		return { id: gizmo.id, title: name, ...projectTimestamps(gizmo), ...(savedMemoryMode && { memoryMode: savedMemoryMode }) };
	}

	async projectDetails(id: string, signal: AbortSignal, includeFiles = false): Promise<ChatGPTProjectDetails> {
		const value = await this.json(`/gizmos/${encodeURIComponent(id)}${includeFiles ? '?include_file_limits=true' : ''}`, signal);
		const gizmo = isRecord(value) && isRecord(value.gizmo) ? value.gizmo : undefined;
		const display = gizmo && isRecord(gizmo.display) ? gizmo.display : undefined;
		if (!gizmo || gizmo.id !== id || typeof display?.name !== 'string'
			|| (gizmo.instructions != null && typeof gizmo.instructions !== 'string')
			|| (display.emoji != null && typeof display.emoji !== 'string')
			|| (display.theme != null && typeof display.theme !== 'string')) throw this.invalidResponse();
		const files = new Map<string, NonNullable<ChatGPTProjectDetails['files']>[number]>();
		if (isRecord(value) && Array.isArray(value.files)) {
			for (const file of value.files) {
				if (isRecord(file) && typeof file.file_id === 'string' && projectFileId.test(file.file_id)
					&& typeof file.name === 'string' && file.name.trim() && file.name.length <= 1024) {
					const sizeBytes = typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : undefined;
					files.set(file.file_id, { id: file.file_id, name: file.name, ...(sizeBytes !== undefined && { sizeBytes }) });
				}
			}
		}
		return {
			name: display.name, description: gizmo.instructions ?? '', emoji: display.emoji ?? null, theme: display.theme ?? null,
			memoryMode: readProjectMemoryMode(gizmo.memory_scope),
			canEditMemoryMode: gizmo.share_recipient === 'private',
			canWrite: !isRecord(gizmo.current_user_permission) || gizmo.current_user_permission.can_write !== false,
			files: isRecord(value) && Array.isArray(value.files) ? [...files.values()] : undefined,
		};
	}

	async addProjectFile(projectId: string, file: File, signal: AbortSignal): Promise<string> {
		const mimeType = file.type || 'application/octet-stream';
		const project = { gizmo_id: projectId, mime_type: mimeType, use_case: 'gizmo' };
		const headers = { 'Content-Type': 'application/json', 'ChatGPT-Project-Id': projectId };
		const id = await this.uploadBytes(file, {
			file_name: file.name, file_size: file.size, ...project,
			reset_rate_limits: false, supports_direct_azure_multipart: false, timezone_offset_min: new Date().getTimezoneOffset(),
		}, headers, signal);
		const processing = await this.request('/files/process_upload_stream', signal, {
			method: 'POST', headers, body: JSON.stringify({
				...project, entry_surface: 'project_sources', file_id: id, file_name: file.name,
				index_for_retrieval: mimeType !== 'application/octet-stream' && !mimeType.startsWith('image/'),
			}),
		});
		let ready = false;
		let libraryId: string | undefined;
		let name = file.name;
		let type = mimeType;
		for (const line of (await processing.text()).split('\n')) {
			if (!line.trim()) continue;
			const frame: unknown = JSON.parse(line);
			if (!isRecord(frame) || typeof frame.event !== 'string') throw this.invalidResponse();
			if (frame.file_id !== id) continue;
			if (frame.event === 'file.indexing.error' && ready && isRecord(frame.extra) && frame.extra.raw_file_fallback_available === true) continue;
			if (/\.(?:error|cancelled|failed|unknown)$/u.test(frame.event)) throw this.invalidResponse();
			if (frame.event === 'file.processing.file_ready' || frame.event === 'file.processing.completed') ready = true;
			if (isRecord(frame.extra)) {
				if (typeof frame.extra.metadata_object_id === 'string') libraryId = frame.extra.metadata_object_id;
				if (typeof frame.extra.library_file_name === 'string') name = frame.extra.library_file_name;
				if (typeof frame.extra.mime_type === 'string') type = frame.extra.mime_type;
			}
		}
		if (!ready) throw this.invalidResponse();
		try {
			await this.consume(`/projects/${encodeURIComponent(projectId)}/files`, signal, 'POST', {
				files: [{ file_id: id, last_modified: file.lastModified, library_file_id: libraryId, location: 'fs', name, size: file.size, type }],
			});
		} catch (error) {
			// A failed response can arrive after ChatGPT has linked the uploaded file.
			const saved = await this.projectDetails(projectId, signal, true).catch(() => undefined);
			if (!saved?.files?.some(file => file.id === id)) throw error;
		}
		return id;
	}

	async removeProjectFile(projectId: string, id: string, signal: AbortSignal): Promise<void> {
		await this.consume(`/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(id)}`, signal, 'DELETE');
	}

	async readProjectFile(projectId: string, id: string, signal: AbortSignal): Promise<Blob> {
		const url = `https://chatgpt.com/backend-api/files/download/${encodeURIComponent(id)}?` + new URLSearchParams({ gizmo_id: projectId, inline: 'false' });
		return this.readResource(url, undefined, '', signal);
	}

	async updateProjectDetails(id: string, details: Pick<ChatGPTProjectDetails, 'name' | 'description' | 'emoji' | 'theme' | 'memoryMode'>, signal: AbortSignal): Promise<void> {
		const response = await this.request(`/projects/${encodeURIComponent(id)}`, signal, {
			method: 'PATCH', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: details.name, instructions: details.description, emoji: details.emoji, theme: details.theme, memory_scope: projectMemoryScope(details.memoryMode) }),
		});
		const text = await response.text();
		signal.throwIfAborted();
		if (text) {
			const value: unknown = JSON.parse(text);
			if (!isRecord(value) || value.error != null || value.success === false) throw this.invalidResponse();
		}
	}

	async projectConversations(projectId: string, cursor: ChatGPTProjectCursor | undefined, signal: AbortSignal): Promise<{ items: readonly ChatGPTConversation[]; cursor?: ChatGPTProjectCursor; }> {
		if (cursor?.kind !== 'recent') {
			try {
				const page = await this.readProjectConversations(projectId, cursor?.value, signal);
				return { items: page.items, cursor: page.cursor ? { kind: 'project', value: page.cursor } : undefined };
			} catch (error) {
				// This route can reject a sign-in that still has access to recent
				// history. Use only matching rows from that history.
				if (!(error instanceof ChatGPTRequestError) || (error.status !== 401 && error.status !== 403)) throw error;
			}
		}
		let offset = cursor?.kind === 'recent' ? cursor.offset : 0;
		for (let pages = 0; ; pages++) {
			const page = await this.conversations(offset, signal);
			const items = page.items.filter(item => item.projectId === projectId);
			// Check a few older history pages for quiet projects without turning one
			// expansion into an unbounded crawl of the account.
			if (items.length || !page.hasMore || pages === 2) {
				return { items, cursor: page.hasMore ? { kind: 'recent', offset: page.nextOffset } : undefined };
			}
			offset = page.nextOffset;
		}
	}

	/** Snapshot the project before mutations can change its pagination. */
	async listProjectConversationIds(projectId: string, signal: AbortSignal): Promise<readonly string[]> {
		const ids = new Set<string>();
		const cursors = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await this.readProjectConversations(projectId, cursor, signal);
			for (const item of page.items) ids.add(item.id);
			cursor = page.cursor;
			if (cursor) {
				if (cursors.has(cursor)) throw this.invalidResponse();
				cursors.add(cursor);
			}
		} while (cursor);
		return [...ids];
	}

	private async readProjectConversations(projectId: string, cursor: string | undefined, signal: AbortSignal): Promise<{ items: readonly ChatGPTConversation[]; cursor?: string; }> {
		const query = new URLSearchParams({ limit: '20', owned_only: 'false', ...(cursor ? { cursor } : {}) });
		const value = await this.json(`/gizmos/${encodeURIComponent(projectId)}/conversations?${query}`, signal, 'project');
		if (!isRecord(value) || !Array.isArray(value.items) || (value.cursor != null && typeof value.cursor !== 'string') || (cursor && value.cursor === cursor)) {
			throw this.invalidResponse();
		}
		const items = value.items.flatMap(item =>
			isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string' && item.is_archived !== true
				&& (item.gizmo_id == null || item.gizmo_id === projectId)
				? [{ id: item.id, title: item.title, ...conversationTimestamps(item), pinned: item.is_starred === true, projectId }] : []);
		return { items, cursor: value.cursor || undefined };
	}

	async rename(id: string, title: string, signal: AbortSignal): Promise<void> {
		await this.consume(`/conversation/id/${encodeURIComponent(id)}/rename`, signal, 'POST', { title });
	}

	async updateConversation(id: string, change: { is_starred: boolean; } | { is_archived: true; } | { gizmo_id: string | null; }, signal: AbortSignal): Promise<void> {
		await this.consume(`/conversation/${encodeURIComponent(id)}`, signal, 'PATCH', change);
	}

	async deleteConversation(id: string, signal: AbortSignal): Promise<void> {
		await this.consume(`/conversation/id/${encodeURIComponent(id)}`, signal, 'DELETE');
	}

	async share(id: string, signal: AbortSignal, messageId?: string): Promise<string> {
		const node = messageId ?? (await this.history(id, signal)).parentId;
		const response = await this.request('/share/v2/create', signal, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ conversation_id: id, current_node_id: node, is_anonymous: true }),
		});
		const value: unknown = await response.json();
		signal.throwIfAborted();
		if (!isRecord(value) || typeof value.share_url !== 'string') { throw this.invalidResponse(); }
		const url = URL.parse(value.share_url);
		if (url?.origin !== 'https://chatgpt.com' || !/^\/share\/(?:e\/)?[A-Za-z0-9_-]+$/u.test(url.pathname)
			|| url.username || url.password || url.hash) {
			throw this.invalidResponse();
		}
		return url.href;
	}

	async readResponseAudio(id: string, messageId: string, signal: AbortSignal): Promise<Blob> {
		const query = new URLSearchParams({ conversation_id: id, message_id: messageId, voice: 'juniper', format: 'mp3' });
		const response = await this.request('/synthesize?' + query, signal);
		if (!/^audio\/(?:mpeg|mp3)(?:;|$)/iu.test(response.headers.get('content-type') ?? '')) {
			await response.body?.cancel();
			throw this.invalidResponse();
		}
		const audio = await response.blob();
		signal.throwIfAborted();
		if (!audio.size) throw this.invalidResponse();
		return audio;
	}

	private async consume(path: string, signal: AbortSignal, method: string, body?: object): Promise<void> {
		const response = await this.request(path, signal, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
		if (response.status !== 204) {
			const text = await response.text();
			signal.throwIfAborted();
			if (text) {
				const value: unknown = JSON.parse(text);
				if (!isRecord(value) || value.success === false) { throw this.invalidResponse(); }
			}
		}
	}

	async history(id: string, signal: AbortSignal): Promise<ChatGPTHistory> {
		if (this.native) { return this.nativeHistory(id, signal); }
		const { value, mapping, head } = await this.conversationGraph(id, signal);
		return { id, ...this.readGraphHistory(value, mapping, head, id), ...historyProjectId(value) };
	}

	async readForkEvidence(id: string, signal: AbortSignal) {
		const { value, mapping, head } = await this.conversationGraph(id, signal);
		const readSource = (metadata: Record<string, unknown>) => {
			const parent = metadata.branching_from_conversation_id;
			const title = metadata.branching_from_conversation_title;
			return typeof parent === 'string' && parent !== id && /^[A-Za-z0-9_-]{1,240}$/u.test(parent)
				? { id: parent, title: typeof title === 'string' && title.trim() ? title : undefined }
				: undefined;
		};
		let source = readSource(value);
		let hasMarker = !!source;
		const messages = new Map<string, number>();
		for (const node of activeNodes(mapping, head)) {
			const message = node.message;
			if (!isRecord(message)) continue;
			if (!hasMarker && isRecord(message.metadata)) {
				source = readSource(message.metadata);
				const owner = message.metadata.branching_from_conversation_owner;
				hasMarker = !!source || typeof owner === 'string' && !!owner;
			}
			if (!isRecord(message.author) || message.author.role !== 'user' && message.author.role !== 'assistant' || typeof message.id !== 'string') continue;
			const time = conversationTimestamp(message.create_time);
			if (time !== undefined) messages.set(message.id, time);
		}
		return { source, hasMarker, createdAt: conversationTimestamp(value.create_time), messages };
	}

	async fork(id: string, messageId: string, signal: AbortSignal): Promise<Omit<ChatGPTHistory, 'id'> & { readonly projectId?: string; }> {
		const result: unknown = await (await this.request('/conversation/new_branch', signal, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: id, message_id: messageId }),
		})).json();
		signal.throwIfAborted();
		const value = isRecord(result) ? result.conversation : undefined;
		if (!isRecord(value) || !isRecord(value.mapping) || typeof value.current_node !== 'string'
			|| !/^[A-Za-z0-9_-]{1,240}$/u.test(value.current_node) || !Object.hasOwn(value.mapping, value.current_node)) {
			throw this.invalidResponse();
		}
		const history = this.readGraphHistory(value, value.mapping, value.current_node, id);
		if (!history.messages.length) {
			throw this.invalidResponse();
		}
		const projectId = typeof value.gizmo_id === 'string' && /^g-p-[A-Za-z0-9_-]{1,240}$/u.test(value.gizmo_id) ? value.gizmo_id : undefined;
		return { ...history, projectId };
	}

	private readGraphHistory(value: Record<string, unknown>, mapping: Record<string, unknown>, head: string, id: string): Omit<ChatGPTHistory, 'id'> {
		const messages: ChatGPTMessage[] = [];
		let thinkingEffort: string | undefined;
		for (const node of activeNodes(mapping, head)) {
			const message = readMessage(node.message, id);
			if (thinkingEffort === undefined && isRecord(node.message) && isRecord(node.message.author) && node.message.author.role === 'assistant'
				&& isRecord(node.message.metadata) && typeof node.message.metadata.thinking_effort === 'string') {
				thinkingEffort = node.message.metadata.thinking_effort;
			}
			if (message && (message.activity || message.text.trim() || message.resources?.length)) {
				const siblings = message.role === 'user' && nodeChildren(mapping, node.parent);
				const hasVersions = siblings && siblings.some(id => {
					const sibling = mapping[id];
					return isRecord(sibling) && isRecord(sibling.message) && sibling.message.id !== message.id
						&& isRecord(sibling.message.author) && sibling.message.author.role === 'user';
				});
				messages.push(hasVersions ? { ...message, hasVersions } : message);
			}
		}
		return {
			title: typeof value.title === 'string' ? value.title : 'ChatGPT', parentId: head,
			...(value.is_archived === true ? { archived: true } : {}),
			model: typeof value.default_model_slug === 'string' ? value.default_model_slug : undefined, thinkingEffort, messages: messages.reverse(),
		};
	}

	private async conversationGraph(id: string, signal: AbortSignal) {
		const value = await this.json(`/conversation/${encodeURIComponent(id)}`, signal, 'conversation');
		if (!isRecord(value) || !isRecord(value.mapping) || typeof value.current_node !== 'string') { throw this.invalidResponse(); }
		return { value, mapping: value.mapping, head: value.current_node };
	}

	async prepareMessageEdit(id: string, messageId: string, expectedHead: string, signal: AbortSignal): Promise<{ parentId: string; files: readonly ChatGPTFile[]; }> {
		const { node, parentId } = await this.messageVersionGraph(id, messageId, expectedHead, signal);
		const edit = readEditableMessage(node);
		if (edit) return { parentId, files: edit.files };
		throw new Error(localize('sessions.chatgpt.editUnavailable', 'This ChatGPT message is unavailable for editing.'));
	}

	private async messageVersionGraph(id: string, messageId: string, expectedHead: string, signal: AbortSignal) {
		const { mapping, head, value } = await this.conversationGraph(id, signal);
		if (head !== expectedHead || value.is_archived === true) {
			throw new Error(localize('sessions.chatgpt.editHistoryChanged', 'Reload the ChatGPT conversation before editing this message.'));
		}
		for (const node of activeNodes(mapping, head)) {
			if (isRecord(node.message) && node.message.id === messageId && typeof node.parent === 'string' && Object.hasOwn(mapping, node.parent)) {
				return { mapping, head, node: node.message, parentId: node.parent };
			}
		}
		throw new Error(localize('sessions.chatgpt.editUnavailable', 'This ChatGPT message is unavailable for editing.'));
	}

	async messageVersions(id: string, messageId: string, expectedHead: string, signal: AbortSignal): Promise<readonly ChatGPTMessageVersion[]> {
		const { mapping, head, parentId } = await this.messageVersionGraph(id, messageId, expectedHead, signal);
		return nodeChildren(mapping, parentId).flatMap(child => {
			const sibling = mapping[child];
			const message = isRecord(sibling) ? readMessage(sibling.message, id) : undefined;
			if (message?.role !== 'user' || !message.text.trim()) return [];
			const selected = message.id === messageId;
			const leaf = selected ? head : latestBranchLeaf(mapping, child);
			return leaf ? [{ head: leaf, text: message.editableText ?? message.text, selected }] : [];
		});
	}

	async selectMessageVersion(id: string, head: string, signal: AbortSignal): Promise<void> {
		await this.consume(`/conversation/${encodeURIComponent(id)}`, signal, 'PATCH', { current_node_id: head });
	}

	async confirmMessageEdit(id: string, replacementId: string, previousHead: string, signal: AbortSignal): Promise<ChatGPTHistory> {
		const deadline = Date.now() + 4_000;
		while (true) {
			const history = await this.history(id, signal);
			if (history.messages.some(message => message.id === replacementId && message.role === 'user')) return history;
			if (history.parentId !== previousHead || Date.now() >= deadline) {
				throw new Error(localize('sessions.chatgpt.editUnconfirmed', 'Reload the conversation to check whether ChatGPT accepted the edit.'));
			}
			await waitForChatGPTRequest(signal);
		}
	}

	private async nativeHistory(id: string, signal: AbortSignal): Promise<ChatGPTHistory> {
		const head = await this.json(`/conversations/${encodeURIComponent(id)}?num_turns=20&include_has_versions=true`, signal, 'conversation');
		if (!isRecord(head) || typeof head.current_node !== 'string') { throw this.invalidResponse(); }
		const { thinkingEffort, ...page } = this.readNativePage(head, id);
		return {
			id, title: typeof head.title === 'string' ? head.title : 'ChatGPT', parentId: head.current_node,
			...(head.is_archived === true ? { archived: true } : {}),
			...historyProjectId(head),
			model: typeof head.default_model_slug === 'string' ? head.default_model_slug : undefined,
			thinkingEffort, ...page,
		};
	}

	async olderHistory(id: string, before: string, signal: AbortSignal): Promise<Pick<ChatGPTHistory, 'messages' | 'olderCursor'>> {
		const value = await this.json(`/conversations/${encodeURIComponent(id)}/messages?num_turns=20&include_has_versions=true&before=${encodeURIComponent(before)}`, signal, 'conversation');
		const page = this.readNativePage(value, id);
		if (page.olderCursor === before) { throw this.invalidResponse(); }
		return page;
	}

	private readNativePage(value: unknown, id: string): Pick<ChatGPTHistory, 'messages' | 'olderCursor' | 'thinkingEffort'> {
		if (!isRecord(value) || !Array.isArray(value.messages) || !isRecord(value.page_info)) { throw this.invalidResponse(); }
		const before = value.page_info.start_cursor;
		const hasPrevious = value.page_info.has_previous_page;
		if (hasPrevious !== false && (hasPrevious !== true || typeof before !== 'string' || !before || before.length > 2048)) {
			throw this.invalidResponse();
		}
		const messages: ChatGPTMessage[] = [];
		let thinkingEffort: string | undefined;
		for (const item of value.messages) {
			if (isRecord(item) && isRecord(item.author) && item.author.role === 'assistant'
				&& isRecord(item.metadata) && typeof item.metadata.thinking_effort === 'string') {
				thinkingEffort = item.metadata.thinking_effort;
			}
			const message = readMessage(item, id);
			if (message && (message.activity || message.text.trim() || message.resources?.length)) messages.push(message);
		}
		return { messages, olderCursor: hasPrevious === true && typeof before === 'string' ? before : undefined, thinkingEffort };
	}

	async upload(file: File, signal: AbortSignal): Promise<ChatGPTFile> {
		let dimensions: { width: number; height: number; } | undefined;
		if (file.type.startsWith('image/')) {
			const image = await createImageBitmap(file);
			try { dimensions = { width: image.width, height: image.height }; }
			finally { image.close(); }
		}
		signal.throwIfAborted();
		const id = await this.uploadBytes(file, {
			file_name: file.name, file_size: file.size, use_case: dimensions ? 'multimodal' : 'ace_upload', ...dimensions,
		}, { 'Content-Type': 'application/json' }, signal);
		for (let attempt = 0; attempt < 20; attempt++) {
			const confirmed: unknown = await retryChatGPTUploadRequest(signal, async () => (await this.request(`/files/${encodeURIComponent(id)}/uploaded`, signal, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
			})).json());
			if (!isRecord(confirmed)) { throw this.invalidResponse(); }
			if (confirmed.status === 'success') {
				return { id, name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, ...dimensions };
			}
			if (confirmed.status !== 'pending' && confirmed.status !== 'processing') { throw this.invalidResponse(); }
			await waitForChatGPTRequest(signal);
		}
		throw new Error(localize('sessions.chatgpt.uploadNotReady', 'The file is still processing. Retry the attachment.'));
	}

	private async uploadBytes(file: File, metadata: object, headers: Record<string, string>, signal: AbortSignal): Promise<string> {
		const body = JSON.stringify(metadata);
		const value: unknown = await retryChatGPTUploadRequest(signal, async () => (await this.request('/files', signal, { method: 'POST', headers, body })).json());
		if (!isRecord(value) || typeof value.file_id !== 'string' || !projectFileId.test(value.file_id)
			|| typeof value.upload_url !== 'string' || value.upload_url.length > 8192) throw this.invalidResponse();
		const path = '/service/.upload?' + new URLSearchParams({ url: value.upload_url });
		// Reuse the reserved ID and signed URL when a byte transfer fails.
		await retryChatGPTUploadRequest(signal, async () => {
			const response = await this.fetcher(path, {
				method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' }, body: file, signal,
			});
			await response.body?.cancel().catch(() => undefined);
			if (!response.ok) {
				const retryAt = readChatGPTRetryAfter(response.headers.get('Retry-After'), Date.now());
				throw new ChatGPTRequestError(response.status, localize('sessions.chatgpt.uploadFailed', 'File upload failed ({0}).', response.status), retryAt);
			}
		});
		return value.file_id;
	}

	async voice(input: { conversationId?: string; parentId: string; language: string; sdp: string; }, signal: AbortSignal): Promise<string> {
		const form = new FormData();
		form.set('sdp', input.sdp);
		form.set('session', JSON.stringify({
			voice: 'cove', voice_mode: 'advanced', model_slug: 'auto', language_code: input.language,
			parent_message_id: input.parentId, voice_session_id: crypto.randomUUID(),
			...(input.conversationId ? { conversation_id: input.conversationId } : {}),
			conversation_mode: { kind: 'primary_assistant' }, history_and_training_disabled: false,
			timezone_offset_min: new Date().getTimezoneOffset(), user_locale: input.language,
			voice_training_allowed: false, video_training_allowed: false, enable_message_streaming: true,
		}));
		const response = await this.fetcher('/service/realtime/vp?dcid=0', { method: 'POST', body: form, signal });
		if (!response.ok) { throw new ChatGPTRequestError(response.status, localize('sessions.chatgpt.voiceRequestFailed', 'Could not start ChatGPT voice ({0}).', response.status)); }
		const answer = await response.text();
		if (answer.length > 128 * 1024 || !/^v=0\r?\n/u.test(answer)) { throw this.invalidResponse(); }
		return answer;
	}

	/** Voice persistence can finish after media disconnects. Never continue from an older branch. */
	async voiceHistory(id: string, messageId: string | undefined, signal: AbortSignal): Promise<ChatGPTHistory> {
		const deadline = Date.now() + 8_000;
		while (true) {
			try {
				const history = await this.history(id, signal);
				if (!messageId || history.messages.some(message => message.id === messageId)) { return history; }
			} catch (error) {
				if (!(error instanceof ChatGPTRequestError) || error.status !== 404 || !messageId) { throw error; }
			}
			if (Date.now() >= deadline) { throw new Error(localize('sessions.chatgpt.voiceHistoryPending', 'The voice conversation has not finished saving. Reload it before sending another message.')); }
			await waitForChatGPTRequest(signal);
		}
	}

	async *send(input: ChatGPTReplyRequest, signal: AbortSignal, beforeSubmit?: () => Promise<void>): AsyncGenerator<ChatGPTStreamUpdate> {
		const projectId = input.branch?.projectId ?? input.projectId;
		const images = input.files?.filter(file => file.width !== undefined && file.height !== undefined) ?? [];
		const content = images.length ? {
			content_type: 'multimodal_text', parts: [
				...images.map(file => ({ content_type: 'image_asset_pointer', asset_pointer: `${file.id.startsWith('file_') ? 'sediment' : 'file-service'}://${file.id}`, size_bytes: file.size, width: file.width, height: file.height })),
				...(input.text ? [input.text] : []),
			],
		} : { content_type: 'text', parts: [input.text] };
		const body = {
			action: 'next', model: input.model, parent_message_id: input.parentId,
			// ChatGPT Web uses its catalog's values, not the public API's reasoning.effort enum.
			...(input.thinkingEffort !== undefined ? { thinking_effort: input.thinkingEffort } : {}),
			...(input.conversationId ? { conversation_id: input.conversationId } : {}),
			...(input.branch ? {
				branching_from_conversation_id: input.branch.conversationId,
				branching_from_message_id: input.branch.messageId,
			} : {}),
			messages: [{
				id: input.messageId, author: { role: 'user' }, content, create_time: Date.now() / 1000,
				...(input.files?.length ? { metadata: { attachments: input.files.map(file => ({ id: file.id, name: file.name, mime_type: file.mimeType, size: file.size, ...(file.width ? { width: file.width, height: file.height } : {}) })) } } : {}),
			}],
			timezone_offset_min: new Date().getTimezoneOffset(), history_and_training_disabled: false,
			conversation_mode: projectId ? { kind: 'gizmo_interaction', gizmo_id: projectId } : { kind: 'primary_assistant' },
			supports_buffering: true,
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
		if (beforeSubmit) { await beforeSubmit(); }
		let response = await this.request('/f/conversation', signal, {
			method: 'POST', headers: { ...verificationHeaders, Accept: 'text/event-stream', 'Content-Type': 'application/json', 'x-conduit-token': preparation.conduit_token }, body: JSON.stringify(body),
		});
		let conversationId = input.conversationId;
		let resumeToken: string | undefined;
		for (let resumes = 0; ; resumes++) {
			if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) { throw this.invalidResponse(); }
			let handoff = false;
			for await (const frame of decodeChatGPTStream(response.body, signal)) {
				conversationId = frame.conversationId ?? conversationId;
				resumeToken = frame.resumeToken ?? resumeToken;
				handoff = frame.finished ? false : handoff || frame.handoff === true;
				if (frame.message || frame.conversationId) { yield { conversationId: frame.conversationId, message: frame.message }; }
			}
			if (!handoff) { return; }
			if (!conversationId || !resumeToken || resumes >= 3) { throw this.invalidResponse(); }
			// [DONE] closes this transport, not a Pro turn handed to background generation.
			// Resume the accepted turn; replayed message IDs merge in the service as usual.
			try {
				response = await this.request('/f/conversation/resume', signal, {
					method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', 'x-conduit-token': resumeToken },
					body: JSON.stringify({ conversation_id: conversationId, offset: 0 }),
				});
			} catch (error) {
				// The message was accepted before handoff. A resume rejection cannot undo it.
				if (error instanceof ChatGPTRequestError) { throw new Error(error.message, { cause: error }); }
				throw error;
			}
		}
	}

	async stop(conversationId: string, messageId: string, signal: AbortSignal): Promise<void> {
		await this.request('/stop_conversation', signal, {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: conversationId, message_id: messageId }),
		});
	}

	async *inspectEntity(source: ChatGPTBranchSource, entity: { readonly label: string; readonly category: string; readonly disambiguation: string; }, locale: string, signal: AbortSignal): AsyncGenerator<ChatGPTMessage> {
		const path = chatGPTEntityDetailPath.slice('/backend-api'.length);
		const verification: unknown = await (await this.request(path, signal, { method: 'POST' }, true)).json();
		if (!isRecord(verification) || typeof verification[chatGPTPrepareTokenHeader] !== 'string') { throw this.invalidResponse(); }
		const headers: Record<string, string> = { Accept: 'text/event-stream', 'Content-Type': 'application/json' };
		for (const name of [chatGPTPrepareTokenHeader, 'OpenAI-Sentinel-Proof-Token', 'OpenAI-Sentinel-Turnstile-Token']) {
			const token = verification[name];
			if (typeof token === 'string') { headers[name] = token; }
		}
		const response = await this.request(path, signal, {
			method: 'POST', headers,
			body: JSON.stringify({
				category: 'generic_entity', conversation_id: source.conversationId, message_id: source.messageId, locale,
				generic_entity_params: { category: entity.category, name: entity.label, extra_params: { disambiguation: entity.disambiguation }, multi_message_mode: true },
			}),
		});
		if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) { throw this.invalidResponse(); }
		for await (const frame of decodeChatGPTStream(response.body, signal, 'sidebar')) {
			if (frame.message?.role === 'assistant' && !frame.message.activity && (frame.message.text.trim() || frame.message.resources?.length)) { yield frame.message; }
		}
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

	private async json(path: string, signal: AbortSignal, history?: HistoryRead): Promise<unknown> {
		signal.throwIfAborted();
		const limited = history && this.historyLimits.get(history);
		if (limited && (limited.retryAt ?? 0) > Date.now()) { throw limited; }
		try {
			const value: unknown = await (await this.request(path, signal)).json();
			signal.throwIfAborted();
			return value;
		} catch (error) {
			if (!history || !isChatGPTRateLimit(error) || signal.aborted) { throw error; }
			// A shared cooldown can return only a few seconds remaining.
			// A local rejection must never extend that deadline.
			const now = Date.now();
			const retryAt = Math.max(error.retryAt ?? now + chatGPTHistoryCooldownMs, this.historyLimits.get(history)?.retryAt ?? 0);
			const message = history === 'conversation'
				? localize('sessions.chatgpt.conversationRateLimited', 'ChatGPT conversation sync is temporarily paused. Try again later.')
				: error.message;
			const rateLimit = new ChatGPTRequestError(429, message, retryAt);
			this.historyLimits.set(history, rateLimit);
			throw rateLimit;
		}
	}

	private async request(path: string, signal: AbortSignal, init: RequestInit = {}, headersOnly = false): Promise<Response> {
		signal.throwIfAborted();
		const response = await this.fetcher(`/service${headersOnly ? '/.headers' : ''}/backend-api` + path, { ...init, signal, cache: 'no-store' });
		if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
		if (response.ok) { return response; }
		await response.body?.cancel();
		throw this.requestError(response.status, response.headers.get('Retry-After'));
	}

	private requestError(status: number, retryAfter?: string | null): ChatGPTRequestError {
		if (status === 428) {
			return new ChatGPTRequestError(status, localize('sessions.chatgpt.sendVerificationUnavailable', 'ChatGPT send verification could not finish. Your message was not sent. Try again later.'));
		}
		if (status === 403) {
			return new ChatGPTRequestError(status, localize('sessions.chatgpt.verificationRequired', 'ChatGPT rejected this request with a verification or access restriction (403). An existing login does not remove this restriction.'));
		}
		if (status === 429) {
			const retryAt = readChatGPTRetryAfter(retryAfter, Date.now());
			return new ChatGPTRequestError(status, localize('sessions.chatgpt.rateLimited', 'ChatGPT is limiting requests. Try again later.'), retryAt);
		}
		return new ChatGPTRequestError(status, localize('sessions.chatgpt.requestFailed', 'ChatGPT request failed ({0}).', status), status === 503 ? readChatGPTRetryAfter(retryAfter, Date.now()) : undefined);
	}

	private invalidResponse(): Error { return new Error(localize('sessions.chatgpt.invalidResponse', 'ChatGPT returned an unsupported response.')); }
}

/** Decode the current ChatGPT voice data channel; it wraps JSON events in data_message. */
export function readChatGPTVoiceUpdate(data: unknown): ChatGPTVoiceUpdate | undefined {
	if (typeof data !== 'string' || data.length > 128 * 1024) { return undefined; }
	let value: unknown;
	try {
		value = JSON.parse(data);
		if (isRecord(value) && value.type === 'data_message' && typeof value.data === 'string' && value.data.length <= 128 * 1024) { value = JSON.parse(value.data); }
	} catch { return undefined; }
	if (!isRecord(value) || !isRecord(value.payload)) { return undefined; }
	const payload = value.payload;
	const id = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_-]{1,240}$/u.test(value) ? value : undefined;
	const conversationId = id(payload.conversation_id);
	if (value.type === 'startup_telemetry' || value.type === 'conversation_update') { return { conversationId, parentId: id(payload.parent_message_id) }; }
	if (value.type !== 'full_chat_message' || !isRecord(payload.message) || !id(payload.message.id) || !isRecord(payload.message.author)
		|| !['user', 'assistant'].includes(payload.message.author.role as string)) { return undefined; }
	return { conversationId, message: readMessage(payload.message, conversationId) };
}

function nodeChildren(mapping: Record<string, unknown>, id: unknown): readonly string[] {
	const node = typeof id === 'string' && Object.hasOwn(mapping, id) ? mapping[id] : undefined;
	return isRecord(node) && Array.isArray(node.children)
		? node.children.filter((child): child is string => {
			const entry = typeof child === 'string' && Object.hasOwn(mapping, child) ? mapping[child] : undefined;
			return isRecord(entry) && entry.parent === id;
		})
		: [];
}

function latestBranchLeaf(mapping: Record<string, unknown>, id: string): string | undefined {
	const visited = new Set<string>();
	while (!visited.has(id)) {
		visited.add(id);
		const next = nodeChildren(mapping, id).at(-1);
		if (!next) return id;
		id = next;
	}
	return undefined;
}

function* activeNodes(mapping: Record<string, unknown>, head: string): Iterable<Record<string, unknown>> {
	const visited = new Set<string>();
	let id: string | undefined = head;
	while (id && !visited.has(id) && Object.hasOwn(mapping, id)) {
		visited.add(id);
		const node: unknown = mapping[id];
		if (!isRecord(node)) return;
		yield node;
		id = typeof node.parent === 'string' ? node.parent : undefined;
	}
}

function readEditableMessage(message: Record<string, unknown>): { text: string; files: readonly ChatGPTFile[]; } | undefined {
	if (!isRecord(message.author) || message.author.role !== 'user' || !isRecord(message.content)
		|| message.status !== undefined && message.status !== 'finished_successfully'
		|| ![undefined, 'text', 'multimodal_text'].includes(message.content.content_type as string | undefined)
		|| !Array.isArray(message.content.parts)) return undefined;
	const metadata = isRecord(message.metadata) ? message.metadata : undefined;
	if (metadata?.is_visually_hidden_from_conversation === true || metadata?.targeted_reply != null
		|| metadata?.targeted_reply_label != null || Array.isArray(metadata?.system_hints) && metadata.system_hints.length) return undefined;
	const attachments = metadata?.attachments ?? [];
	if (!Array.isArray(attachments)) return undefined;
	const files = new Map<string, ChatGPTFile>();
	for (const attachment of attachments) {
		if (!isRecord(attachment) || attachment.is_big_paste === true || attachment.cloud_doc_url != null || attachment.library_file_id != null) return undefined;
		const { id, name, mime_type: mimeType, size } = attachment;
		if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,240}$/u.test(id) || files.has(id)
			|| typeof name !== 'string' || typeof mimeType !== 'string'
			|| typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return undefined;
		files.set(id, { id, name, mimeType, size });
	}
	const parts: string[] = [];
	for (const part of message.content.parts) {
		if (typeof part === 'string') {
			parts.push(part);
			continue;
		}
		if (!isRecord(part) || part.content_type !== 'image_asset_pointer' || typeof part.asset_pointer !== 'string') return undefined;
		const fileId = /^(?:file-service|sediment):\/\/([A-Za-z0-9_-]{1,240})$/u.exec(part.asset_pointer)?.[1];
		const file = fileId ? files.get(fileId) : undefined;
		const { width, height } = part;
		if (!file || typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0
			|| typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0) return undefined;
		files.set(file.id, { ...file, width, height });
	}
	const text = parts.join('\n');
	return text.trim() ? { text, files: [...files.values()] } : undefined;
}

/** History can describe one upload in both the content and attachment metadata. */
export function mergeChatGPTResources(resources: readonly ChatGPTResource[]): ChatGPTResource[] {
	const merged = new Map<string, ChatGPTResource>();
	for (const resource of resources) {
		const key = resource.uri.replace(/^sediment:\/\//u, 'file-service://');
		const previous = merged.get(key);
		if (!previous) {
			merged.set(key, resource);
		} else if (previous.kind === 'image' || resource.kind === 'image') {
			// Keep the content pointer's identity and prefer the attachment's file metadata.
			const generic = resource.name === localize('sessions.chatgpt.media', 'Media') || resource.name === localize('sessions.chatgpt.file', 'File');
			merged.set(key, { ...previous, kind: 'image', name: generic ? previous.name : resource.name, mimeType: resource.mimeType ?? previous.mimeType });
		}
	}
	return [...merged.values()];
}

function readSearchImage(result: Record<string, unknown>): ChatGPTImageGroup['images'][number] | undefined {
	const image = readChatGPTGalleryImageUrl(result.content_url) ?? readChatGPTGalleryImageUrl(result.thumbnail_url);
	if (!image) return undefined;
	let source: URL | undefined;
	if (typeof result.url === 'string' && result.url.length <= 2048 && result.show_url !== false) {
		try {
			const url = new URL(result.url);
			if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) source = url;
		} catch { /* The image can still be previewed. */ }
	}
	const title = typeof result.title === 'string' ? result.title.trim().slice(0, 256) : '';
	return { uri: image.href, label: title || source?.hostname || localize('sessions.chatgpt.image', 'Image'), source: source?.href };
}

function readImageGroup(reference: Record<string, unknown>, text: string): ChatGPTImageGroup | undefined {
	const marker = reference.matched_text;
	if (typeof marker !== 'string' || !marker || marker.length > 8192 || !text.includes(marker) || !Array.isArray(reference.images)) return undefined;
	const images = new Map<string, ChatGPTImageGroup['images'][number]>();
	for (const entry of reference.images.slice(0, 12)) {
		if (!isRecord(entry) || !isRecord(entry.image_result)) continue;
		const image = readSearchImage(entry.image_result);
		if (image && !images.has(image.uri)) images.set(image.uri, image);
	}
	return images.size ? { marker, images: [...images.values()] } : undefined;
}

/** Saved AsyncImage components keep their result separately from the Markdown. */
function readAsyncImages(metadata: Record<string, unknown>): ChatGPTImageGroup[] {
	const model = metadata.model_dil_v2;
	if (!isRecord(model) || !isRecord(model.appData) || !isRecord(model.appData.opGenui)) return [];
	const results = model.appData.opGenui.componentResults;
	if (!isRecord(results)) return [];
	const images: ChatGPTImageGroup[] = [];
	for (const result of Object.values(results).slice(0, 64)) {
		if (!isRecord(result) || result.componentName !== 'AsyncImage' || !isRecord(result.state) || !Array.isArray(result.state.images)) continue;
		const first = result.state.images[0];
		if (!isRecord(first) || typeof first.image_search_query !== 'string' || !first.image_search_query || first.image_search_query.length > 1024) continue;
		const image = readSearchImage(first);
		if (image) images.push({ query: first.image_search_query, images: [image] });
	}
	return images;
}

function readMessage(value: unknown, conversationId: string | undefined): ChatGPTMessage | undefined {
	if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.author) || !['user', 'assistant', 'tool'].includes(value.author.role as string)
		|| !isRecord(value.content)) { return undefined; }
	if (isRecord(value.metadata) && value.metadata.is_visually_hidden_from_conversation === true) { return undefined; }
	// The web sends this turn-status node separately from the answer. Treating
	// it as opaque media creates a content-free message with a web-view link.
	if (value.content.content_type === 'reasoning_recap') { return undefined; }
	const recipient = typeof value.recipient === 'string' && value.recipient !== 'all' ? value.recipient : undefined;
	const result = value.author.role === 'tool';
	const progress = value.author.role === 'assistant'
		&& (value.content.content_type === 'thoughts' || ['analysis', 'commentary'].includes(value.channel as string));
	if (result || (value.author.role === 'assistant' && recipient) || progress) {
		const text = typeof value.content.text === 'string' ? value.content.text : Array.isArray(value.content.parts)
			? value.content.parts.map(part => typeof part === 'string' ? part : isRecord(part) && typeof part.text === 'string' ? part.text : JSON.stringify(part)).join('\n') : '';
		return {
			id: value.id, role: 'assistant', text,
			activity: {
				kind: result ? 'result' : recipient ? 'call' : 'progress',
				tool: result ? typeof value.author.name === 'string' ? value.author.name : undefined : recipient,
				failed: ['failed', 'error'].includes(value.status as string) || (isRecord(value.metadata) && value.metadata.is_error === true),
			},
		};
	}
	const url = conversationId ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` : 'https://chatgpt.com/';
	const fallback = `[${localize('sessions.chatgpt.viewContent', 'View this content in ChatGPT')}](${url})`;
	const resources: ChatGPTResource[] = [];
	const resourcePart = (part: Record<string, unknown>): ChatGPTResource | undefined => {
		const uri = ['asset_pointer', 'audio_asset_pointer', 'video_asset_pointer', 'url'].map(key => part[key]).find(value => typeof value === 'string') ?? (typeof part.file_id === 'string' ? `file-service://${part.file_id}` : undefined);
		if (typeof uri !== 'string' || uri.length > 8192) return undefined;
		const name = ['name', 'file_name', 'title', 'alt'].map(key => part[key]).find(value => typeof value === 'string');
		const mimeType = typeof part.mime_type === 'string' ? part.mime_type : typeof part.mimeType === 'string' ? part.mimeType : typeof name === 'string' ? getMediaOrTextMime(name) : undefined;
		const type = typeof part.content_type === 'string' ? part.content_type : mimeType ?? '';
		const kind = /image/u.test(type) || mimeType?.startsWith('image/') ? 'image' : /audio/u.test(type) ? 'audio' : /video/u.test(type) ? 'video' : mimeType === 'text/html' ? 'html' : 'document';
		return { uri, kind, name: typeof name === 'string' ? name : kind === 'document' ? localize('sessions.chatgpt.file', 'File') : localize('sessions.chatgpt.media', 'Media'), mimeType };
	};
	const literal = (text: string): string => escapeMarkdownSyntaxTokens(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	const user = value.author.role === 'user';
	const addResource = (resource: ChatGPTResource): string | undefined => {
		resources.push(resource);
		return user && resource.kind === 'image' ? undefined : literal(resource.name);
	};
	const partText = (part: unknown): string | undefined => {
		if (typeof part === 'string') { return part; }
		if (!isRecord(part)) { return part == null ? '' : fallback; }
		// Keep mixed text/media parts in source order. Selecting only string parts
		// used to silently discard an image whenever that same message had a caption.
		if (['text', 'audio_transcription', 'text_audio'].includes(part.content_type as string) && typeof part.text === 'string') { return part.text; }
		const resource = resourcePart(part);
		if (resource) return addResource(resource);
		for (const key of ['audio', 'video', 'image']) {
			if (isRecord(part[key])) { const nested = resourcePart({ content_type: key, ...part[key] }); if (nested) return addResource(nested); }
		}
		const description = ['text', 'title', 'alt', 'name'].flatMap(key => typeof part[key] === 'string' ? [literal(part[key])] : []).join('\n');
		return [description, fallback].filter(Boolean).join('\n\n');
	};
	let text: string;
	if (Array.isArray(value.content.parts)) { text = value.content.parts.map(partText).filter(part => part !== undefined).join('\n'); }
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
	const imageGroups: ChatGPTImageGroup[] = [];
	const addReference = (entry: unknown, cited?: true): string | undefined => {
		if (!isRecord(entry) || typeof entry.url !== 'string') return;
		let url: URL; try { url = new URL(entry.url); } catch { return; }
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
		const ids = [entry.ref_id, ...(Array.isArray(entry.refs) ? entry.refs : [])].flatMap(ref =>
			typeof ref === 'string' ? [ref] : isRecord(ref) && typeof ref.turn_index === 'number' && typeof ref.ref_type === 'string' && typeof ref.ref_index === 'number'
				? [`turn${ref.turn_index}${ref.ref_type}${ref.ref_index}`] : []);
		for (const id of ids.length ? ids : [url.href]) {
			const index = references.findIndex(item => item.id === id);
			if (index < 0) references.push({ id, url: url.href, title: typeof entry.title === 'string' ? entry.title : url.hostname, snippet: typeof entry.snippet === 'string' ? entry.snippet : '', ...(cited && { cited }) });
			else if (cited && references[index].url === url.href) references[index] = { ...references[index], cited };
		}
		return url.href;
	};
	if (isRecord(value.metadata)) {
		imageGroups.push(...readAsyncImages(value.metadata));
		for (const group of Array.isArray(value.metadata.search_result_groups) ? value.metadata.search_result_groups : []) {
			if (isRecord(group) && Array.isArray(group.entries)) group.entries.forEach(entry => addReference(entry));
		}
		for (const reference of Array.isArray(value.metadata.content_references) ? value.metadata.content_references : []) {
			if (!isRecord(reference)) continue;
			if (reference.type === 'image_group') {
				const group = readImageGroup(reference, text);
				if (group) imageGroups.push(group);
				continue;
			}
			addReference(reference, true);
			addReference(reference.item, true);
			for (const key of ['sources', 'items']) if (Array.isArray(reference[key])) reference[key].forEach(entry => addReference(entry, true));
			// Sidebar replies can bind a whole citation marker to URLs without supplying per-result IDs.
			const marker = reference.matched_text;
			if (reference.type === 'grouped_webpages' && typeof marker === 'string' && /^\uE200cite\uE202[^\uE200\uE201\r\n]+\uE201$/u.test(marker)
				&& text.includes(marker) && Array.isArray(reference.safe_urls) && !reference.url && !reference.item
				&& ![reference.sources, reference.items].some(items => Array.isArray(items) && items.length)) {
				const urls = reference.safe_urls.slice(0, 20).flatMap(url => {
					const href = typeof url === 'string' && url.length <= 8192 ? addReference({ url }, true) : undefined;
					return href ? [href] : [];
				});
				if (urls.length) text = text.replaceAll(marker, `\uE200cite\uE202${urls.join('\uE202')}\uE201`);
			}
		}
	}
	const timestamp = conversationTimestamp(value.create_time);
	const edit = readEditableMessage(value);
	return {
		id: value.id, role: value.author.role as 'user' | 'assistant', text,
		...(edit && { editableText: edit.text }),
		...(isRecord(value.metadata) && value.metadata.has_versions === true && { hasVersions: true }),
		...(timestamp !== undefined && Number.isFinite(new Date(timestamp).getTime()) ? { timestamp } : {}),
		...(resources.length ? { resources: mergeChatGPTResources(resources) } : {}),
		...(references.length ? { references } : {}), ...(imageGroups.length ? { imageGroups } : {}),
	};
}

/** SSE framing is independent of HTTP chunks; delta paths are restricted to ordinary JSON properties. */
export async function* decodeChatGPTStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal, mode: 'conversation' | 'sidebar' = 'conversation'): AsyncGenerator<ChatGPTStreamFrame> {
	const reader = stream.getReader();
	const cancel = (): void => { void reader.cancel().catch(() => { }); };
	signal.addEventListener('abort', cancel, { once: true });
	const events: string[] = [];
	const parser = new SSEParser(event => events.push(event.data));
	// Bound unfinished frames in UTF-8 bytes, including comments and unknown fields.
	let frameBytes = 0;
	let lineHasBytes = false;
	let afterCarriageReturn = false;
	const validateFrameSize = (bytes: Uint8Array): void => {
		for (const byte of bytes) {
			if (afterCarriageReturn && byte === 10) {
				afterCarriageReturn = false;
				// The LF belongs to the preceding CR delimiter, even across chunks.
				if (frameBytes === 0) continue;
				frameBytes++;
			} else {
				afterCarriageReturn = false;
				frameBytes++;
				if (byte === 10 || byte === 13) {
					if (!lineHasBytes) frameBytes = 0;
					lineHasBytes = false;
					afterCarriageReturn = byte === 13;
				} else { lineHasBytes = true; }
			}
			if (frameBytes > 4 * 1024 * 1024) { throw new Error(localize('sessions.chatgpt.invalidResponse', 'ChatGPT returned an unsupported response.')); }
		}
	};
	let snapshot: Record<string, unknown> = {};
	let previousPath = '';
	const sidebar = mode === 'sidebar' ? new SidebarConversationDeltas() : undefined;
	let done = false;
	try {
		while (!done) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			const bytes = chunk.value ?? new Uint8Array();
			// Dispatch bounded batches so a large HTTP chunk cannot queue unbounded events.
			for (let offset = 0; offset < bytes.length && !done; offset += 64 * 1024) {
				const part = bytes.subarray(offset, offset + 64 * 1024);
				validateFrameSize(part);
				parser.feed(part);
				for (const data of events) {
					if (!data) { continue; }
					if (data === '[DONE]') { done = true; break; }
					const value: unknown = JSON.parse(data);
					if (!isRecord(value)) { continue; }
					if (value.error) { throw new Error(localize('sessions.chatgpt.streamFailed', 'ChatGPT could not finish this reply. The message may already have been sent. Reload the conversation before trying again.')); }
					if (sidebar) {
						const message = sidebar.apply(value);
						if (message) { yield { message }; }
						continue;
					}
					if (value.type === 'resume_conversation_token') {
						if (typeof value.token !== 'string' || !value.token || value.token.length > 16384 || /[\r\n\0]/u.test(value.token)) { throw new Error(localize('sessions.chatgpt.invalidResponse', 'ChatGPT returned an unsupported response.')); }
						yield { resumeToken: value.token };
						continue;
					}
					if (value.type === 'stream_handoff') {
						if (typeof value.conversation_id !== 'string' || !/^[A-Za-z0-9_-]{1,240}$/u.test(value.conversation_id)
							|| !Array.isArray(value.options) || !value.options.some(option => isRecord(option) && option.type === 'resume_sse_endpoint')) { throw new Error(localize('sessions.chatgpt.invalidResponse', 'ChatGPT returned an unsupported response.')); }
						yield { conversationId: value.conversation_id, handoff: true };
						continue;
					}
					if (value.type === 'message_stream_complete') {
						yield { finished: true };
						continue;
					}
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
				events.length = 0;
			}
			if (chunk.done) {
				if (!done) { throw new Error(localize('sessions.chatgpt.streamFailed', 'ChatGPT could not finish this reply. The message may already have been sent. Reload the conversation before trying again.')); }
				break;
			}
		}
	} finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => { }); reader.releaseLock(); }
}

/** Sidebar delta frames multiplex message envelopes and inherit omitted path and operation fields. */
class SidebarConversationDeltas {
	private readonly channels = new Map<number, Record<string, unknown>>();
	private channel = 0;
	private path = '';
	private operation: unknown;

	apply(frame: Record<string, unknown>): ChatGPTMessage | undefined {
		if (typeof frame.type === 'string') { return undefined; }
		if (frame.c !== undefined) {
			if (typeof frame.c !== 'number' || !Number.isInteger(frame.c) || frame.c < 0 || frame.c >= 64) { return undefined; }
			this.channel = frame.c;
		}
		const value = frame.v;
		const path = this.path = typeof frame.p === 'string' ? frame.p : this.path;
		const operation = this.operation = typeof frame.o === 'string' ? frame.o : this.operation;
		let envelope = this.channels.get(this.channel);
		if ((frame.c !== undefined || path === '') && isRecord(value) && typeof value.type === 'string') {
			envelope = value;
			this.channels.set(this.channel, envelope);
		} else if (envelope && operation === 'patch' && Array.isArray(value)) {
			for (const patch of value) {
				if (isRecord(patch) && typeof patch.p === 'string') { applyDelta(envelope, patch.p, patch.o, patch.v); }
			}
		} else if (envelope) {
			applyDelta(envelope, path, operation, value);
		}
		return envelope?.type === 'message' ? readMessage(envelope.data, typeof envelope.conversation_id === 'string' ? envelope.conversation_id : undefined) : undefined;
	}
}

async function retryChatGPTUploadRequest<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
	for (const delay of uploadRetryDelays) {
		signal.throwIfAborted();
		try {
			return await request();
		} catch (error) {
			const retryable = error instanceof ChatGPTRequestError ? retryableUploadStatuses.has(error.status)
				: error instanceof Error && retryableUploadNetworkError.test(error.message);
			if (!retryable) { throw error; }
			const retryAfter = error instanceof ChatGPTRequestError ? (error.retryAt ?? 0) - Date.now() : 0;
			// Long server cooldowns require a later manual retry.
			if (retryAfter >= 60_000) { throw error; }
			await waitForChatGPTRequest(signal, Math.max(delay, retryAfter));
		}
	}
	signal.throwIfAborted();
	return request();
}

function waitForChatGPTRequest(signal: AbortSignal, delay = 500): Promise<void> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
		const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
		signal.addEventListener('abort', abort, { once: true });
	});
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
