import { decodeAppServerRequestParams } from '../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import type { Memory as MemoryDto, MemorySummary as MemorySummaryDto, MemoryPolicy as MemoryPolicyDto } from '../../../../../.build/protocol/typescript/index.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import { localize } from '../../../nls.js';
import { parseCodeMemoryReference } from '../common/memoriesService.js';
import type { IMemoriesService, Memory, MemoryConversationSource, MemoryPage, MemoryPolicy, MemoryReference, MemoryScope, MemoryScopeEntry, MemorySummary, MemoryTurnSource } from '../common/memoriesService.js';

export class AppServerMemoriesService extends Disposable implements IMemoriesService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly ownChanges = new Set<number>();
	private readonly observedChanges = new Set<number>();

	constructor(private readonly client: AppServerProtocolClient) {
		super();
		this._register(client.onNotification(event => {
			if (event.method !== 'memory/changed') { return; }
			const revision = event.params.catalogRevision;
			if (this.ownChanges.delete(revision)) { return; }
			this.rememberRevision(this.observedChanges, revision);
			this.changed.fire();
		}));
		this._register(client.onStateChange(() => { this.ownChanges.clear(); this.observedChanges.clear(); this.changed.fire(); }));
	}

	public async readModelMemoryEnabled(): Promise<boolean> {
		const config = await this.client.request(APP_SERVER_METHODS['config/read'], {});
		return config.features.some(feature => feature.feature === 'memories' && feature.enabled);
	}

	public async setModelMemoryEnabled(enabled: boolean): Promise<void> {
		const config = await this.client.request(APP_SERVER_METHODS['config/read'], {});
		const overrides = Object.fromEntries(config.features
			.filter(feature => feature.source === 'user')
			.map(feature => [feature.feature, feature.enabled]));
		await this.client.request(APP_SERVER_METHODS['config/update'], {
			commandId: generateUuid(),
			expectedRevision: config.revision,
			features: { ...overrides, memories: enabled },
		});
	}

	private markMutation(revision: number): void {
		if (!this.observedChanges.delete(revision)) { this.rememberRevision(this.ownChanges, revision); }
	}
	private rememberRevision(revisions: Set<number>, revision: number): void {
		revisions.add(revision);
		if (revisions.size > 64) { revisions.delete(revisions.values().next().value!); }
	}

	public async scopes(threadId?: string): Promise<readonly MemoryScopeEntry[]> {
		const result = await this.client.request(APP_SERVER_METHODS['memory/scopes'], { threadId }).catch(explain);
		return result.scopes.map(entry => ({ label: entry.label, policy: policy(entry.policy) }));
	}

	public async list(scope: MemoryScope, query?: string, cursor?: string): Promise<MemoryPage> {
		if (query?.trim()) {
			const result = await this.client.request(APP_SERVER_METHODS['memory/search'], { scope, query, cursor, limit: 20 }).catch(explain);
			return { memories: result.matches.map(entry => ({ id: entry.memoryId, scope: entry.scope, revision: entry.revision, title: entry.title, source: entry.source === 'user' ? 'user' as const : 'model' as const })), cursor: result.nextCursor ?? undefined };
		}
		const result = await this.client.request(APP_SERVER_METHODS['memory/list'], { scope, cursor, limit: 20 }).catch(explain);
		return { memories: result.memories.map(summary), cursor: result.nextCursor ?? undefined };
	}

	public async read(memory: MemorySummary): Promise<Memory> {
		return record(await this.client.request(APP_SERVER_METHODS['memory/read'], { memoryId: memory.id, scope: memory.scope }).catch(explain));
	}
	public async add(scope: MemoryScope, title: string, body: string, commandId: string, origin?: MemoryTurnSource): Promise<Memory> {
		const result = await this.client.request(APP_SERVER_METHODS['memory/add'], {
			commandId, memoryId: commandId, scope, title, body, origin,
		}).catch(explain);
		this.markMutation(result.catalogRevision);
		return record(result.memory);
	}
	public async update(memory: MemorySummary, title: string, body: string, commandId: string): Promise<Memory> {
		const result = await this.client.request(APP_SERVER_METHODS['memory/update'], { commandId, memoryId: memory.id, scope: memory.scope, expectedRevision: memory.revision, title, body }).catch(explain);
		this.markMutation(result.catalogRevision);
		return record(result.memory);
	}
	public async delete(memory: MemorySummary, commandId: string): Promise<void> {
		const result = await this.client.request(APP_SERVER_METHODS['memory/delete'], { commandId, memoryId: memory.id, scope: memory.scope, expectedRevision: memory.revision }).catch(explain);
		this.markMutation(result.catalogRevision);
	}
	public async setPolicy(current: MemoryPolicy, reading: boolean, saving: boolean): Promise<MemoryPolicy> {
		const result = await this.client.request(APP_SERVER_METHODS['memory/policy/update'], {
			commandId: generateUuid(), scope: current.scope, expectedRevision: current.revision,
			automaticRead: reading ? 'firstInvocation' : 'disabled', modelWrite: saving ? 'enabled' : 'disabled',
		}).catch(explain);
		this.markMutation(result.catalogRevision);
		return policy(result.policy);
	}
	public async readReference(reference: string): Promise<MemoryReference> {
		const citation = parseCodeMemoryReference(reference);
		if (!citation) { throw new Error(localize('memories.codeReferenceRequired', 'Enter a complete Code memory reference.')); }
		const params = decodeAppServerRequestParams('memory/citation/read', { citation });
		const result = await this.client.request(APP_SERVER_METHODS['memory/citation/read'], params).catch(explain);
		return {
			title: result.title, body: result.body, revision: result.citation.revision,
			origin: sourceConversation(result.source),
		};
	}
}

function policy(value: MemoryPolicyDto): MemoryPolicy {
	return { scope: value.scope, revision: value.revision, reading: value.automaticRead === 'firstInvocation', saving: value.modelWrite === 'enabled' };
}
function summary(value: MemorySummaryDto): MemorySummary {
	return {
		id: value.memoryId, scope: value.scope, revision: value.revision, title: value.title,
		source: typeof value.source === 'object' && 'model' in value.source ? 'model' : 'user',
		origin: sourceConversation(value.source),
	};
}
function sourceConversation(source: MemorySummaryDto['source']): MemoryConversationSource | undefined {
	if (source === 'user') { return undefined; }
	return 'model' in source ? source.model : source.userFromTurn;
}
function record(value: MemoryDto): Memory { return { ...summary(value), body: value.body }; }
function explain(error: unknown): never {
	if (error instanceof AppServerRemoteError) {
		switch (error.errorName) {
			case 'MemoryConflict': throw new Error('This memory changed in another window. Refresh and select it again; your draft has been kept.');
			case 'MemoryCursorStale': throw new Error('The memory list changed. Refresh to load the current list.');
			case 'MemoryNotFound': throw new Error('This memory was deleted. Refresh the list.');
			case 'MemoryUnavailable': throw new Error('Memories are unavailable on this backend.');
			case 'InvalidParams': throw new Error('Check the memory title, content and reference.');
		}
	}
	throw error;
}
