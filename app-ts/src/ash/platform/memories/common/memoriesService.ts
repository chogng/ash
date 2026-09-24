import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export type MemoryScope = { readonly type: 'profile' } | { readonly type: 'project'; readonly projectId: string } | { readonly type: 'dir'; readonly dirId: string };
export interface MemoryPolicy {
	readonly scope: MemoryScope;
	readonly revision: number;
	readonly reading: boolean;
	readonly saving: boolean;
}
export interface MemoryScopeEntry { readonly label: string; readonly policy: MemoryPolicy }
export interface MemorySummary {
	readonly id: string;
	readonly scope: MemoryScope;
	readonly revision: number;
	readonly title: string;
	readonly source: 'user' | 'model';
}
export interface Memory extends MemorySummary { readonly body: string }
export interface MemoryPage { readonly memories: readonly MemorySummary[]; readonly cursor: string | undefined }
export interface MemoryReference { readonly title: string; readonly body: string; readonly revision: number }

export interface IMemoriesService {
	readonly onDidChange: Event<void>;
	scopes(threadId?: string): Promise<readonly MemoryScopeEntry[]>;
	list(scope: MemoryScope, query?: string, cursor?: string): Promise<MemoryPage>;
	read(memory: MemorySummary): Promise<Memory>;
	add(scope: MemoryScope, title: string, body: string, commandId: string): Promise<Memory>;
	update(memory: MemorySummary, title: string, body: string, commandId: string): Promise<Memory>;
	delete(memory: MemorySummary, commandId: string): Promise<void>;
	setPolicy(policy: MemoryPolicy, reading: boolean, saving: boolean): Promise<MemoryPolicy>;
	readReference(reference: string): Promise<MemoryReference>;
}
export const IMemoriesService = createServiceIdentifier<IMemoriesService>('memoriesService');
