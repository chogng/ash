import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IAction } from '../../../../../base/common/actions.js';
import type { Event } from '../../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';

/** A host operation; the picker owns how its prompt is suspended and resumed. */
export interface IAgentSessionPickerAction extends IAction {
	readonly keepPickerOpen?: boolean;
	/** An operation may return the identity to focus after a draft is materialized. */
	run(): void | string | Promise<void | string>;
}

/** Presentation and borrowed operations, without exposing the host's Session implementation. */
export interface IAgentSessionPickerItem extends IQuickPickItem {
	readonly id: string;
	open(): void | Promise<void>;
	getActions(): readonly IAgentSessionPickerAction[];
	getButtonAction(id: string): IAgentSessionPickerAction | undefined;
}

export interface IAgentSessionsPickerModel {
	readonly onDidChange: Event<void>;
	readonly items: readonly (IAgentSessionPickerItem | IQuickPickSeparator)[];
}

/** The host projects its catalog on demand; Workbench owns picker presentation. */
export interface IAgentSessionsService {
	readonly model: IAgentSessionsPickerModel;
}

export const IAgentSessionsService = createServiceIdentifier<IAgentSessionsService>('agentSessions');

export interface IAgentSessionActionItem {
	readonly sessionId: string;
	readonly title: string;
	readonly status: 'active' | 'archived';
	readonly description: string | undefined;
	readonly rootThreadId: string | undefined;
	readonly threadIds: readonly string[];
}

export interface IAgentSessionActionTarget {
	readonly title: string;
	resolve(): Promise<IAgentSessionActionItem>;
}

/** Borrowed Session operations; Workbench owns command presentation and confirmation. */
export interface IAgentSessionActionsService {
	readonly sessions: readonly IAgentSessionActionItem[];
	initialize(): Promise<void>;
	resolveTarget(argument: unknown, useActive?: boolean): IAgentSessionActionTarget;
	discardDraft(argument: unknown): boolean;
	togglePin(argument: unknown): Promise<string>;
	archiveSession(id: string): Promise<void>;
	restoreSession(id: string): Promise<void>;
	renameSession(id: string, title: string): Promise<void>;
	deleteSession(id: string): Promise<void>;
	captureSelection(): IDisposable & { isCurrent(): boolean; };
}

export const IAgentSessionActionsService = createServiceIdentifier<IAgentSessionActionsService>('agentSessionActions');

/** Command boundary shared by actions and host target resolution. */
export function getAgentSessionId(argument: unknown): string | undefined {
	if (argument === undefined || typeof argument === 'string') return argument;
	if (argument && typeof argument === 'object') {
		const keys = Object.keys(argument);
		if (!keys.length) return undefined;
		const sessionId = Reflect.get(argument, 'sessionId');
		const threadId = Reflect.get(argument, 'threadId');
		if (keys.every(key => key === 'sessionId' || key === 'threadId') && typeof sessionId === 'string' && (threadId === undefined || typeof threadId === 'string')) return sessionId;
	}
	throw new TypeError(localize('chatSession.target.invalid', 'Choose a valid session.'));
}
