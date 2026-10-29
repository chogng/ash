import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { localize } from '../../../../../nls.js';
import {
	buildOpenSessionLinkUri,
	parseOpenSessionLinkUri,
} from '../../../../../platform/agentHost/common/openSessionLink.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import {
	getAgentHostEditorActivity,
	hasAgentsWindowInvitationSessionCooldownElapsed,
	type IAgentHostEditorState,
	type IAgentsWindowInvitation,
	type IAgentHostEditorSession,
} from '../../../../../platform/chat/common/agentsWindowInvitation.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	INotificationService,
	Severity,
	type INotificationHandle,
} from '../../../../../platform/notification/common/notification.js';
import { INativeHostService } from '../../../../common/services.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { IChatService } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IHostService } from '../../../../services/host/browser/host.js';

/** Desktop-only invitation; the native host arbitrates claims across both product windows. */
export class AgentsWindowInvitationContribution extends Disposable {
	static readonly ID = 'workbench.contrib.agentsWindowInvitation';
	private state: IAgentHostEditorState | undefined;
	private readonly activity = new Map<string, Omit<IAgentHostEditorSession, 'windowId'>>();
	private candidate: URI | undefined;
	private presentation:
		| {
				readonly invitation: IAgentsWindowInvitation;
				readonly notification: INotificationHandle;
				readonly lifetime: DisposableStore;
		  }
		| undefined;
	private queue: Promise<void> = Promise.resolve();
	private readonly pendingRefreshes = new Map<string, { dirty: boolean }>();
	private connectionEpoch = 0;
	private claiming = false;
	private readonly delay = this._register(
		new RunOnceScheduler(() => {
			void this.show().catch(error => console.error('Agents invitation failed', error));
		}, 30_000),
	);

	constructor(
		@IChatService private readonly chat: IChatService,
		@INativeHostService private readonly host: INativeHostApi,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@IHostService private readonly windowHost: IHostService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
		@IAppServerApi appServer: IAppServerApi,
	) {
		super();
		const stateListener = host.onDidChangeAgentHostEditorState(state => this.acceptState(state));
		this._register(toDisposable(() => stateListener.dispose()));
		this._register(
			chat.onDidSubmitRequest(event => {
				const resource = buildOpenSessionLinkUri(event.sessionId, event.threadId, 'local');
				this.enqueue(async () => {
					await this.host.updateAgentHostEditorState({
						kind: 'request',
						resource: resource.toJSON(),
						isNewSession: event.isNewSession,
						requestSequence: event.requestSequence,
					});
					if (this.isDisposed) return;
					if (this.candidate?.toString() !== resource.toString()) {
						this.delay.cancel();
						this.closePresentation();
					}
					this.candidate = resource;
					// These are only window-owned activity coordinates, never a second Session catalog.
					this.activity.set(resource.toString(), {
						resource: resource.toJSON(),
						inProgress: false,
						needsInput: false,
					});
					if (this.activity.size > 128) this.activity.delete(this.activity.keys().next().value!);
					await this.refresh(resource);
				});
			}),
		);
		this._register(
			chat.onDidUpdateThread(event => {
				// Streaming deltas cannot change activity. Coalesce durable invalidations while a read is in flight.
				if (event.update.type !== 'committed') return;
				const resource = buildOpenSessionLinkUri(event.sessionId, event.threadId, 'local');
				if (this.activity.has(resource.toString())) this.scheduleRefresh(resource);
			}),
		);
		this._register(
			chat.onDidChangeSession(event => {
				for (const key of this.activity.keys()) {
					const resource = URI.parse(key);
					if (parseOpenSessionLinkUri(resource).sessionId === event.sessionId) this.scheduleRefresh(resource);
				}
			}),
		);
		const connectionListener = appServer.onConnectionState(state => {
			this.connectionEpoch++;
			this.pendingRefreshes.clear();
			if (state === 'ready') {
				this.enqueue(async () => {
					for (const key of [...this.activity.keys()]) await this.refresh(URI.parse(key));
				});
			} else {
				this.delay.cancel();
				this.closePresentation();
				for (const [key, session] of this.activity)
					this.activity.set(key, { ...session, inProgress: false, needsInput: false });
				this.enqueue(() => this.publishActivity());
			}
		});
		this._register(toDisposable(() => connectionListener.dispose()));
		this._register(
			windowHost.onDidChangeFocus(focused => {
				if (!focused) {
					this.delay.cancel();
					this.closePresentation();
				} else this.schedule();
			}),
		);
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (!event.affectsConfiguration(ChatAIDisabledSettingId)) return;
				if (!this.enabled) {
					this.delay.cancel();
					this.closePresentation();
				} else this.schedule();
			}),
		);

		this._register(
			toDisposable(() => {
				this.closePresentation();
				void this.host.updateAgentHostEditorState({ kind: 'sessions', sessions: [] }).catch(() => {});
			}),
		);
		void host
			.getAgentHostEditorState()
			.then(state => this.acceptState(state))
			.catch(error => console.error('Could not read editor window activity', error));
	}

	private get enabled(): boolean {
		return !this.configuration.getValue<boolean>(ChatAIDisabledSettingId) && this.windowHost.hasFocus;
	}

	private enqueue(operation: () => Promise<void>): void {
		const epoch = this.connectionEpoch;
		this.queue = this.queue
			.then(async () => {
				if (!this.isDisposed && epoch === this.connectionEpoch) await operation();
			})
			.catch(error => console.error('Could not update editor window activity', error));
	}

	private async refresh(resource: URI): Promise<void> {
		const epoch = this.connectionEpoch;
		const link = parseOpenSessionLinkUri(resource);
		let thread;
		try {
			({ thread } = await this.chat.readThread(link.sessionId, link.threadId));
		} catch {
			// Unavailable history cannot justify an invitation. The conversation owner handles recovery.
			if (!this.isDisposed && epoch === this.connectionEpoch) {
				this.activity.delete(resource.toString());
				await this.host.updateAgentHostEditorState({ kind: 'delete', resources: [resource.toJSON()] });
				await this.publishActivity();
			}
			return;
		}
		if (this.isDisposed || epoch !== this.connectionEpoch || !this.activity.has(resource.toString())) return;
		if (thread.sessionId !== link.sessionId || thread.threadId !== link.threadId || thread.status === 'archived') {
			this.activity.delete(resource.toString());
			await this.host.updateAgentHostEditorState({ kind: 'delete', resources: [resource.toJSON()] });
		} else {
			const turn = thread.turns.at(-1);
			const needsInput =
				turn?.status === 'waitingForApproval' ||
				turn?.status === 'waitingForUserInput' ||
				turn?.status === 'waitingForCapability';
			const inProgress = !!turn && ['created', 'running', 'cancelling'].includes(turn.status);
			this.activity.set(resource.toString(), { resource: resource.toJSON(), inProgress, needsInput });
		}
		await this.publishActivity();
	}

	private scheduleRefresh(resource: URI): void {
		const key = resource.toString();
		const pending = this.pendingRefreshes.get(key);
		if (pending) {
			pending.dirty = true;
			return;
		}
		const work = { dirty: true };
		const epoch = this.connectionEpoch;
		this.pendingRefreshes.set(key, work);
		this.enqueue(async () => {
			try {
				do {
					work.dirty = false;
					await this.refresh(resource);
				} while (work.dirty && !this.isDisposed && epoch === this.connectionEpoch);
			} finally {
				if (this.pendingRefreshes.get(key) === work) this.pendingRefreshes.delete(key);
			}
		});
	}

	private async publishActivity(): Promise<void> {
		await this.host.updateAgentHostEditorState({ kind: 'sessions', sessions: [...this.activity.values()] });
		if (!this.isDisposed) this.acceptState(await this.host.getAgentHostEditorState());
	}

	private acceptState(state: IAgentHostEditorState): void {
		if (this.isDisposed || (this.state && state.revision < this.state.revision)) return;
		this.state = state;
		if (this.presentation && state.invitation?.id !== this.presentation.invitation.id) this.closePresentation();
		this.schedule();
	}

	private isCurrent(resource: URI): boolean {
		const active = this.navigation.getActiveConversation();
		const link = parseOpenSessionLinkUri(resource);
		return this.enabled && active?.sessionId === link.sessionId && active.threadId === link.threadId;
	}

	private schedule(): void {
		const candidate = this.candidate;
		const session =
			candidate &&
			this.state?.sessions.find(session => URI.revive(session.resource).toString() === candidate.toString());
		const activity =
			candidate && session && this.state && getAgentHostEditorActivity(this.state, session.windowId, candidate);
		if (
			!candidate ||
			!activity ||
			!this.isCurrent(candidate) ||
			this.presentation ||
			this.claiming ||
			this.state?.invitation ||
			(this.state && !hasAgentsWindowInvitationSessionCooldownElapsed(this.state))
		) {
			this.delay.cancel();
			return;
		}
		if (!this.delay.isScheduled())
			this.delay.schedule(activity.acrossWindows || activity.sameWindow >= 2 ? 15_000 : 30_000);
	}

	private async show(): Promise<void> {
		const candidate = this.candidate;
		if (!candidate || this.claiming || !this.isCurrent(candidate) || this.isDisposed) return;
		this.claiming = true;
		let invitation: IAgentsWindowInvitation | undefined;
		try {
			invitation = await this.host.claimAgentsWindowInvitation(candidate.toJSON());
			if (!invitation) return;
			if (
				this.isDisposed ||
				!this.isCurrent(candidate) ||
				this.candidate?.toString() !== candidate.toString() ||
				(this.state &&
					this.state.revision >= invitation.revision &&
					this.state.invitation?.id !== invitation.id)
			) {
				await this.host.releaseAgentsWindowInvitation(invitation.id);
				return;
			}
			const claimed = invitation;
			const notification = this.notifications.notify({
				severity: Severity.Info,
				message: localize(
					'agentsWindowInvitation.message',
					'Continue in the Agents Window to keep track of your agent conversations across projects.',
				),
				actions: {
					primary: [
						{
							tooltip: '',
							enabled: true,
							id: 'agentsWindowInvitation.open',
							label: localize('agentsWindowInvitation.open', 'Continue in Agents Window'),
							run: () => this.open(claimed),
						},
					],
				},
			});
			const lifetime = new DisposableStore();
			this.presentation = { invitation: claimed, notification, lifetime };
			const recordShown = (visible: boolean): void => {
				if (visible && !this.isDisposed && this.isCurrent(candidate)) {
					void this.host
						.markAgentsWindowInvitationShown(claimed.id)
						.catch(error => console.error('Could not record Agents invitation', error));
				}
			};
			lifetime.add(notification.onDidChangeVisibility(recordShown));
			lifetime.add(notification.onDidClose(() => this.closePresentation()));
			recordShown(notification.visible === true);
		} catch (error) {
			if (invitation) await this.host.releaseAgentsWindowInvitation(invitation.id);
			throw error;
		} finally {
			this.claiming = false;
		}
	}

	private async open(invitation: IAgentsWindowInvitation): Promise<void> {
		const resource = URI.revive(invitation.resource);
		if (this.isDisposed || !this.isCurrent(resource)) {
			this.closePresentation();
			return;
		}
		const captured = await this.navigation.captureActiveDraft();
		const state = await this.host.getAgentHostEditorState();
		if (this.isDisposed || !this.isCurrent(resource) || state.invitation?.id !== invitation.id) {
			this.closePresentation();
			return;
		}
		const { sessionId, threadId } = parseOpenSessionLinkUri(resource);
		await this.host.openAgentsWindow({ conversation: { sessionId, threadId }, draft: captured?.draft });
		captured?.clear();
		this.closePresentation();
	}

	private closePresentation(): void {
		const current = this.presentation;
		this.presentation = undefined;
		if (!current) return;
		current.lifetime.dispose();
		current.notification.close();
		void this.host.releaseAgentsWindowInvitation(current.invitation.id).catch(() => {});
	}
}
