import type { Event } from '../../../../../base/common/event.js';

export interface IAgentSessionListItem {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly kind: 'draft' | 'session';
	readonly active: boolean;
	open(): void;
}

/** The Chat view reads session navigation through this contract; the Sessions service owns its state. */
export interface IAgentSessionsModel {
	readonly onDidChange: Event<void>;
	readonly items: readonly IAgentSessionListItem[];
	readonly state: 'loading' | 'ready' | 'error';
	readonly error: string | undefined;
}
