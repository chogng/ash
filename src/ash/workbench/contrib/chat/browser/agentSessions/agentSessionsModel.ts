import type { Event } from '../../../../../base/common/event.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';

/** A borrowed Session or Thread projection. Its host owns selection, drafts and mutations. */
export interface IAgentSession {
	readonly id: string;
	readonly resource: URI;
	readonly label: string;
	readonly description: string;
	readonly providerLabel?: string;
	readonly kind: 'draft' | 'session';
	readonly target: { readonly untitledSessionId: string; } | { readonly sessionId: string; readonly threadId?: string; };
	readonly active: boolean;
	readonly inProgress?: boolean;
	readonly group?: { readonly sectionId: string; readonly name: string; };
	readonly updatedAt?: number;
	readonly children?: readonly IAgentSession[];
	readonly parentSession?: { readonly resource: URI; readonly label: string; };
	isArchived(): boolean;
	isPinned(): boolean;
	/** Borrows this conversation in an editor without selecting or recreating it. */
	getEditorInput?(): IResourceEditorInput;
	open(options?: { readonly preserveFocus?: boolean; }): void | Promise<void>;
}

/** One window catalog consumed by both the Session list and history picker. */
export interface IAgentSessionsModel {
	/** Refreshes through the catalog owner without changing the selected conversation. */
	refresh?(): Promise<void>;
	readonly onDidChangeSessions: Event<void>;
	readonly sessions: readonly IAgentSession[];
	getSession(resource: URI): IAgentSession | undefined;
	readonly state: 'loading' | 'ready' | 'error';
	readonly error: string | undefined;
}

/** A section is a presentation projection of the model's session records. */
export interface IAgentSessionSection {
	readonly kind: 'section';
	readonly id: string;
	readonly label: string;
	readonly items: readonly IAgentSession[];
}

export function isAgentSessionSection(item: IAgentSession | IAgentSessionSection): item is IAgentSessionSection {
	return item.kind === 'section';
}
