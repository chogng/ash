import { isCancellationError } from '../../../../base/common/errors.js';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { chatInputStackSlotClass, ChatInputStackSlot, setChatInputStackSlot } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStack.js';
import { chatSubagentStatusLabel } from '../../../../workbench/contrib/chat/common/model/chatSubagentActivity.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { directSessionSubagents } from '../../../common/sessionSubagentActivity.js';

/** Projects the current thread's directly delegated agents from the owning Session tree. */
export class SessionBackgroundActivitiesControl extends Disposable {
	readonly element: HTMLDetailsElement;
	private readonly rows = this._register(new DisposableMap<string, Button>());
	private owner: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly model: ChatWidgetModel,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const document = container.ownerDocument;
		this.element = h(document, 'details', { className: `ash-sessions-background-activities ${chatInputStackSlotClass}` });
		const summary = h(document, 'summary');
		summary.textContent = localize('sessions.background.activities', 'Background activities');
		this.element.append(summary);
		container.append(this.element);
		this._register(toDisposable(() => {
			setChatInputStackSlot(this.element, ChatInputStackSlot.Empty);
			this.element.remove();
		}));
		this._register(model.onDidChange(() => this.update()));
		this.update();
	}

	private update(): void {
		const { sessionId, threadId } = this.model;
		const owner = sessionId && threadId ? JSON.stringify([sessionId, threadId]) : undefined;
		if (this.owner !== owner) {
			this.rows.clearAndDisposeAll();
			this.element.open = false;
			this.owner = owner;
		}
		const agents = threadId ? directSessionSubagents(this.model.agentTree, threadId) : [];
		this.element.hidden = agents.length === 0;
		setChatInputStackSlot(this.element, agents.length ? ChatInputStackSlot.Standalone : ChatInputStackSlot.Empty);
		const live = new Set(agents.map(agent => agent.threadId));
		for (const id of this.rows.keys()) {
			if (!live.has(id)) this.rows.deleteAndDispose(id);
		}
		for (const agent of agents) {
			const label = localize('sessions.background.activityLabel', '{0} · {1}', agent.title, chatSubagentStatusLabel(agent));
			let button = this.rows.get(agent.threadId);
			if (!button) {
				button = this.rows.set(agent.threadId, new Button(this.element, {
					...defaultButtonStyles, label, presentation: 'secondary', size: 'small',
					onClick: () => {
						if (!sessionId || this.owner !== owner) return;
						const open = this.navigation.openSideConversation
							? this.navigation.openSideConversation(sessionId, agent.threadId)
							: this.navigation.openConversation(sessionId, agent.threadId);
						void open.catch(error => {
							if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(error);
						});
					},
				}));
			}
			if (button.label !== label) button.label = label;
		}
	}
}
