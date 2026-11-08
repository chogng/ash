import type { Event } from '../../../base/common/event.js';
import { decodeBase64 } from '../../../base/common/buffer.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type MemoryScope = { readonly type: 'profile'; } | { readonly type: 'project'; readonly projectId: string; } | { readonly type: 'team'; readonly teamId: string; } | { readonly type: 'dir'; readonly dirId: string; };
export interface MemoryPolicy {
	readonly scope: MemoryScope;
	readonly revision: number;
	readonly reading: boolean;
	readonly saving: boolean;
}
export interface MemoryScopeEntry { readonly label: string; readonly policy: MemoryPolicy; }
export interface MemoryConversationSource {
	readonly sessionId: string;
	readonly threadId: string;
	readonly turnId: string;
}
export interface MemoryTurnSource extends MemoryConversationSource {
	readonly itemId: string;
}
export interface MemorySummary {
	readonly id: string;
	readonly scope: MemoryScope;
	readonly revision: number;
	readonly title: string;
	readonly source: 'user' | 'model';
	readonly origin?: MemoryConversationSource;
}
export interface Memory extends MemorySummary { readonly body: string; }
export interface MemoryPage { readonly memories: readonly MemorySummary[]; readonly cursor: string | undefined; }
export interface MemoryReference {
	readonly title: string;
	readonly body: string;
	readonly revision: number;
	readonly origin?: MemoryConversationSource;
}

export function parseCodeMemoryReference(reference: string): object | undefined {
	if (!reference.startsWith('memory:') || reference.length > 4096) { return undefined; }
	try {
		const bytes = decodeBase64(reference.slice('memory:'.length)).buffer;
		const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		return value && typeof value === 'object' && 'namespace' in value && value.namespace === 'code' ? value : undefined;
	} catch {
		return undefined;
	}
}

export interface IMemoriesService {
	readonly onDidChange: Event<void>;
	readModelMemoryEnabled(): Promise<boolean>;
	setModelMemoryEnabled(enabled: boolean): Promise<void>;
	scopes(threadId?: string): Promise<readonly MemoryScopeEntry[]>;
	list(scope: MemoryScope, query?: string, cursor?: string): Promise<MemoryPage>;
	read(memory: MemorySummary): Promise<Memory>;
	add(scope: MemoryScope, title: string, body: string, commandId: string, origin?: MemoryTurnSource): Promise<Memory>;
	update(memory: MemorySummary, title: string, body: string, commandId: string): Promise<Memory>;
	delete(memory: MemorySummary, commandId: string): Promise<void>;
	setPolicy(policy: MemoryPolicy, reading: boolean, saving: boolean): Promise<MemoryPolicy>;
	readReference(reference: string): Promise<MemoryReference>;
}
export const IMemoriesService = createServiceIdentifier<IMemoriesService>('memoriesService');
