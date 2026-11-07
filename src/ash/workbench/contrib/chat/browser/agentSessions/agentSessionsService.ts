import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { IAgentSession, IAgentSessionsModel } from './agentSessionsModel.js';
import type { ReviewEnvironmentScope } from '../../../../../platform/approvalEnvironment/common/approvalEnvironmentService.js';
import type { IWorkspace } from '../../../../../platform/workspace/common/workspace.js';

/** The runtime supplies one catalog projection; Workbench owns its presentations. */
export interface IAgentSessionsService {
	readonly model: IAgentSessionsModel;
	getSession(resource: URI): IAgentSession | undefined;
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

/** Remote targets remain explicit so choosing a project cannot fall back to the local backend. */
export interface IAgentSessionReviewEnvironmentTarget {
	readonly label: string;
	readonly description?: string;
	readonly scope: ReviewEnvironmentScope | { readonly type: 'remote'; };
}

/** Borrowed Session operations; Workbench owns command presentation and confirmation. */
export interface IAgentSessionActionsService {
	readonly sessions: readonly IAgentSessionActionItem[];
	initialize(): Promise<void>;
	resolveTarget(argument: unknown, useActive?: boolean): IAgentSessionActionTarget;
	resolveCatalogArchiveTarget(catalogId: string): { readonly title: string; archive(): Promise<boolean>; };
	/** Resolve the requesting composer's identity, without materializing a draft or changing selection. */
	getReviewEnvironmentTargets(target: { readonly sessionId?: string; readonly threadId?: string; readonly untitledSessionId?: string; }, workspace: IWorkspace): readonly IAgentSessionReviewEnvironmentTarget[];
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
