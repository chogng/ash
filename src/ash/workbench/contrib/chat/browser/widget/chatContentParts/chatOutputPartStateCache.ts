import { LRUCache } from '../../../../../../base/common/map.js';
import { createServiceIdentifier } from '../../../../../../platform/instantiation/common/instantiation.js';

export interface IChatOutputPartStateCache {
	getHeight(identity: string): number | undefined;
	setHeight(identity: string, height: number): void;
}

export const IChatOutputPartStateCache = createServiceIdentifier<IChatOutputPartStateCache>('chatOutputPartStateCache');

/** Keeps only presentation geometry across output remounts in this Workbench. */
export class ChatOutputPartStateCache implements IChatOutputPartStateCache {
	private readonly heights = new LRUCache<string, number>(100);

	getHeight(identity: string): number | undefined { return this.heights.get(identity); }
	setHeight(identity: string, height: number): void { this.heights.set(identity, height); }
}
