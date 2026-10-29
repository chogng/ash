import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI, type UriComponents } from '../../../base/common/uri.js';
import { createUuid } from '../../../base/common/uuid.js';

export const EDITOR_AGENT_HOST_SESSIONS_STORAGE_KEY = 'chat.editorUsage.agentHostSessions';
export const AGENTS_WINDOW_TOTAL_SESSIONS_STORAGE_KEY = 'agentSessions.telemetry.totalSessions';
export const AGENTS_WINDOW_LAST_SESSION_CREATED_STORAGE_KEY = 'agentSessions.telemetry.lastSessionCreated';
export const AGENTS_WINDOW_INVITATION_IMPRESSION_STORAGE_KEY = 'chat.agentsWindowBanner.lastShown';

export interface IAgentHostEditorSession {
	readonly resource: UriComponents;
	readonly windowId: number;
	readonly inProgress: boolean;
	readonly needsInput: boolean;
}

export interface IAgentsWindowInvitationImpression {
	readonly timestamp: number;
	readonly editorSessionCount: number;
}

export interface IAgentsWindowInvitation {
	readonly id: string;
	readonly revision: number;
	readonly windowId: number;
	readonly resource: UriComponents;
	readonly shown: boolean;
}

export interface IAgentHostEditorState {
	readonly revision: number;
	readonly sessions: readonly IAgentHostEditorSession[];
	readonly editorSessionCount: number;
	readonly lastShown: IAgentsWindowInvitationImpression | undefined;
	readonly invitation: IAgentsWindowInvitation | undefined;
	readonly agentsWindowSessionCount: number;
	readonly lastAgentsWindowSessionCreated: number | undefined;
}

export type AgentHostEditorUpdate =
	| {
			readonly kind: 'request';
			readonly resource: UriComponents;
			readonly isNewSession: boolean;
			readonly requestSequence: number;
	  }
	| { readonly kind: 'sessions'; readonly sessions: readonly Omit<IAgentHostEditorSession, 'windowId'>[] }
	| { readonly kind: 'delete'; readonly resources: readonly UriComponents[] };

export function hasAgentsWindowInvitationSessionCooldownElapsed(state: IAgentHostEditorState): boolean {
	return !state.lastShown || state.editorSessionCount - state.lastShown.editorSessionCount >= 5;
}

/** Main owns window activity, not backend Sessions. Persistence uses the Desktop storage writer. */
export class AgentsWindowInvitationState extends Disposable {
	private readonly changed = this._register(new Emitter<IAgentHostEditorState>());
	readonly onDidChange = this.changed.event;
	private state: IAgentHostEditorState;
	// This fences late accepted replies; Thread records and their journal still belong to Core.
	private readonly requestSequences = new Map<string, number>();
	private readonly countedEditorResources = new Set<string>();
	private readonly countedAgentsResources = new Set<string>();

	constructor(
		private readonly now: () => number,
		history: Pick<
			IAgentHostEditorState,
			'editorSessionCount' | 'lastShown' | 'agentsWindowSessionCount' | 'lastAgentsWindowSessionCreated'
		>,
	) {
		super();
		this.state = { ...history, revision: 0, sessions: [], invitation: undefined };
	}

	getState(): IAgentHostEditorState {
		return this.state;
	}

	update(windowId: number, update: AgentHostEditorUpdate): void;
	update(windowId: undefined, update: Extract<AgentHostEditorUpdate, { kind: 'request' }>): void;
	update(windowId: number | undefined, update: AgentHostEditorUpdate): void {
		if (this.isDisposed) return;
		const key = (resource: UriComponents): string => URI.revive(resource).toString();
		let sessions = [...this.state.sessions];
		let invitation = this.state.invitation;
		let editorSessionCount = this.state.editorSessionCount;
		let agentsWindowSessionCount = this.state.agentsWindowSessionCount;
		let lastAgentsWindowSessionCreated = this.state.lastAgentsWindowSessionCreated;
		if (update.kind === 'request') {
			const resourceKey = key(update.resource);
			if (update.requestSequence < (this.requestSequences.get(resourceKey) ?? 0)) return;
			this.requestSequences.set(resourceKey, update.requestSequence);
			const previous = sessions.find(session => key(session.resource) === resourceKey);
			sessions = sessions.filter(session => key(session.resource) !== resourceKey);
			if (invitation && key(invitation.resource) === resourceKey && invitation.windowId !== windowId)
				invitation = undefined;
			if (windowId !== undefined) {
				sessions.push({
					resource: update.resource,
					windowId,
					inProgress: previous?.windowId === windowId ? previous.inProgress : false,
					needsInput: false,
				});
				if (update.isNewSession && !this.countedEditorResources.has(resourceKey)) {
					this.countedEditorResources.add(resourceKey);
					editorSessionCount = Math.min(editorSessionCount + 1, Number.MAX_SAFE_INTEGER);
				}
			} else if (update.isNewSession && !this.countedAgentsResources.has(resourceKey)) {
				this.countedAgentsResources.add(resourceKey);
				agentsWindowSessionCount = Math.min(agentsWindowSessionCount + 1, Number.MAX_SAFE_INTEGER);
				lastAgentsWindowSessionCreated = this.now();
			}
		} else if (windowId !== undefined) {
			if (update.kind === 'sessions') {
				// A catalog refresh can update activity only after this window actually submitted a request.
				const activity = new Map(update.sessions.map(session => [key(session.resource), session]));
				sessions = sessions.flatMap(session => {
					if (session.windowId !== windowId) return [session];
					const current = activity.get(key(session.resource));
					return current ? [{ ...current, windowId }] : [];
				});
			} else {
				const removed = new Set(update.resources.map(key));
				sessions = sessions.filter(
					session => session.windowId !== windowId || !removed.has(key(session.resource)),
				);
			}
			if (
				invitation &&
				!sessions.some(
					session =>
						key(session.resource) === key(invitation!.resource) &&
						session.windowId === invitation!.windowId,
				)
			)
				invitation = undefined;
		}
		this.publish({
			...this.state,
			sessions,
			invitation,
			editorSessionCount,
			agentsWindowSessionCount,
			lastAgentsWindowSessionCreated,
		});
	}

	claim(windowId: number, resource: URI): IAgentsWindowInvitation | undefined {
		if (this.isDisposed) return undefined;
		const activity = getAgentHostEditorActivity(this.state, windowId, resource);
		const day = 24 * 60 * 60 * 1000;
		const activeAgentsUser =
			this.state.agentsWindowSessionCount >= 3 &&
			(this.state.lastAgentsWindowSessionCreated === undefined ||
				this.now() - this.state.lastAgentsWindowSessionCreated < 30 * day);
		if (
			!activity ||
			this.state.invitation ||
			activeAgentsUser ||
			!hasAgentsWindowInvitationSessionCooldownElapsed(this.state) ||
			(this.state.lastShown && this.now() - this.state.lastShown.timestamp < day)
		)
			return undefined;
		const invitation: IAgentsWindowInvitation = {
			id: createUuid(),
			revision: this.state.revision + 1,
			windowId,
			resource: resource.toJSON(),
			shown: false,
		};
		this.publish({ ...this.state, invitation });
		return invitation;
	}

	markShown(windowId: number, id: string): void {
		if (this.isDisposed) return;
		const invitation = this.state.invitation;
		if (!invitation || invitation.windowId !== windowId || invitation.id !== id || invitation.shown) return;
		this.publish({
			...this.state,
			invitation: { ...invitation, shown: true },
			lastShown: { timestamp: this.now(), editorSessionCount: this.state.editorSessionCount },
		});
	}

	release(windowId: number, id: string): void {
		if (this.isDisposed) return;
		if (this.state.invitation?.windowId === windowId && this.state.invitation.id === id)
			this.publish({ ...this.state, invitation: undefined });
	}

	resetWindow(windowId: number): void {
		if (this.isDisposed) return;
		this.publish({
			...this.state,
			sessions: this.state.sessions.filter(session => session.windowId !== windowId),
			invitation: this.state.invitation?.windowId === windowId ? undefined : this.state.invitation,
		});
	}

	private publish(state: IAgentHostEditorState): void {
		this.state = Object.freeze({
			...state,
			revision: this.state.revision + 1,
			sessions: Object.freeze(
				state.sessions.map(session =>
					Object.freeze({ ...session, resource: Object.freeze({ ...session.resource }) }),
				),
			),
			invitation:
				state.invitation &&
				Object.freeze({ ...state.invitation, resource: Object.freeze({ ...state.invitation.resource }) }),
			lastShown: state.lastShown && Object.freeze({ ...state.lastShown }),
		});
		this.changed.fire(this.state);
	}
}

export function getAgentHostEditorActivity(
	state: IAgentHostEditorState,
	windowId: number,
	resource: URI,
): { readonly sameWindow: number; readonly acrossWindows: boolean } | undefined {
	const working = state.sessions.filter(session => session.inProgress && !session.needsInput);
	if (
		!working.some(
			session => session.windowId === windowId && URI.revive(session.resource).toString() === resource.toString(),
		)
	)
		return undefined;
	return {
		sameWindow: working.filter(session => session.windowId === windowId).length,
		acrossWindows: working.some(session => session.windowId !== windowId),
	};
}
