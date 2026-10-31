import type { IAction } from '../../../../../base/common/actions.js';
import type { Event } from '../../../../../base/common/event.js';

export interface IAgentSessionListItem {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly kind: 'draft' | 'session';
	readonly active: boolean;
	readonly pinned?: boolean;
	readonly group?: { readonly sectionId: string; readonly name: string; };
	getActions(): readonly IAction[];
	open(options?: { readonly preserveFocus?: boolean; }): void;
}

/** The Chat view reads session navigation through this contract; the Sessions service owns its state. */
export interface IAgentSessionsModel {
	readonly onDidChange: Event<void>;
	readonly items: readonly IAgentSessionListItem[];
	readonly state: 'loading' | 'ready' | 'error';
	readonly error: string | undefined;
}

/** A section is a presentation projection of the model's session records. */
export interface IAgentSessionSection {
	readonly kind: 'section';
	readonly id: string;
	readonly label: string;
	readonly items: readonly IAgentSessionListItem[];
}

export type AgentSessionListItem = IAgentSessionListItem | IAgentSessionSection;

export function isAgentSessionSection(item: AgentSessionListItem): item is IAgentSessionSection {
	return item.kind === 'section';
}
