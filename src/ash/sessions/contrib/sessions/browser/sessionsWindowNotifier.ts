import { RunOnceScheduler } from '../../../../base/common/async.js';
import { cancelOnDispose } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ChatConfiguration, ChatNotificationMode } from '../../../../workbench/contrib/chat/common/constants.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import type { IChat, ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

type NotificationKind = 'needsInput' | 'completed' | 'failed';
type Occurrence = { readonly kind: NotificationKind; readonly id: string; };

function getOccurrence(session: ISession, chat: IChat, useSessionStatus: boolean): Occurrence | undefined {
	const management = chat.management ?? (useSessionStatus ? session.management : undefined);
	if (!management) return;
	let kind: NotificationKind;
	switch (management.status) {
		case 'needsInput': kind = 'needsInput'; break;
		case 'failed': kind = 'failed'; break;
		case 'readyForReview':
		case 'completed':
			if (chat.executionStatus === 'queued' || chat.executionStatus === 'running') return;
			kind = 'completed';
			break;
		default: return;
	}
	return { kind, id: JSON.stringify([kind, management.statusChangedAtUnixMs]) };
}

export class SessionsWindowNotifier extends Disposable {
	static readonly ID = 'workbench.contrib.sessionsWindowNotifier';
	private previous = new Map<string, string | undefined>();
	private readonly pending = this._register(new DisposableMap<string, DisposableStore>());

	constructor(
		@ISessionsManagementService private readonly catalog: ISessionsManagementService,
		@IHostService private readonly host: IHostService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this.update();
		this._register(catalog.onDidChange(() => this.update()));
	}

	private update(): void {
		if (this.catalog.state === 'error') {
			this.previous.clear();
			this.pending.clearAndDisposeAll();
			return;
		}
		if (this.catalog.state === 'loading') return;
		const previous = this.previous;
		const current = new Map<string, string | undefined>();
		this.previous = current;
		for (const session of this.catalog.sessions) {
			// Automation runs already have their own notification producer and result destination.
			if (session.status !== 'active' || session.source === 'automation') continue;
			const chats = session.chats.filter(chat => chat.status === 'active' && chat.origin.type !== 'agentSpawn');
			for (const chat of chats) {
				const key = JSON.stringify([session.sessionId, chat.threadId]);
				const occurrence = getOccurrence(session, chat, chats.length === 1);
				current.set(key, occurrence?.id);
				if (previous.get(key) === occurrence?.id) continue;
				this.pending.deleteAndDispose(key);
				if (occurrence && previous.has(key) && this.getMode(occurrence.kind) !== ChatNotificationMode.Off) {
					this.schedule(key, session, chat, occurrence);
				}
			}
		}
		for (const key of previous.keys()) {
			if (!current.has(key)) this.pending.deleteAndDispose(key);
		}
	}

	private getMode(kind: NotificationKind): ChatNotificationMode {
		const setting = kind === 'needsInput' ? ChatConfiguration.NotifyWindowOnConfirmation : ChatConfiguration.NotifyWindowOnResponseReceived;
		return this.configuration.getValue<ChatNotificationMode>(setting) ?? ChatNotificationMode.WindowNotFocused;
	}

	private schedule(key: string, session: ISession, chat: IChat, occurrence: Occurrence): void {
		const lifetime = new DisposableStore();
		const token = cancelOnDispose(lifetime);
		const send = async (): Promise<void> => {
			try {
				const mode = this.getMode(occurrence.kind);
				if (mode === ChatNotificationMode.Off) return;
				const title = localize({ bundle: 'ash.sessions', key: 'sessions.notification.title' }, 'Session: {0}', chat.title?.trim() || session.title);
				const body = occurrence.kind === 'needsInput'
					? localize({ bundle: 'ash.sessions', key: 'sessions.notification.needsInput' }, 'Your input is needed.')
					: occurrence.kind === 'failed'
						? localize({ bundle: 'ash.sessions', key: 'sessions.notification.failed' }, 'Session failed.')
						: localize({ bundle: 'ash.sessions', key: 'sessions.notification.completed' }, 'Session completed.');
				const result = await this.host.showToast({
					id: generateUuid(),
					dedupeKey: JSON.stringify([key, occurrence.id]),
					title: title.replace(/\s+/g, ' ').slice(0, 256),
					body,
					onlyWhenUnfocused: mode === ChatNotificationMode.WindowNotFocused,
				}, token);
				if (result.clicked && !token.isCancellationRequested) {
					await this.navigation.openConversation(session.sessionId, chat.threadId);
				}
			} catch (error) {
				if (!token.isCancellationRequested) this.log.warn('[SessionsWindowNotifier] Toast failed', error);
			} finally {
				if (this.pending.get(key) === lifetime) this.pending.deleteAndDispose(key);
			}
		};
		// A queued follow-up can restart the conversation shortly after the previous response.
		const scheduler = lifetime.add(new RunOnceScheduler(() => { void send(); }, occurrence.kind === 'completed' ? 1500 : 0));
		this.pending.set(key, lifetime);
		scheduler.schedule();
	}
}
