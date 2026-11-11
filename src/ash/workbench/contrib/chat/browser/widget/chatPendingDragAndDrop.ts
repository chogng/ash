import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IChatService, type QueueMessageTarget } from '../../../../services/chat/common/chatService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

type MoveDirection = 'up' | 'down';

/** Moves a pending request by one place through the durable, revision-checked queue. */
export class ChatPendingDragController extends Disposable {
	private readonly handles = new WeakMap<HTMLElement, () => QueueMessageTarget | undefined>();
	private dragging: { readonly row: HTMLElement; readonly target: QueueMessageTarget; } | undefined;
	private highlighted: HTMLElement | undefined;
	private moving = false;

	constructor(
		private readonly transcript: HTMLElement,
		private readonly queue: () => readonly QueueMessageTarget[],
		private readonly isVisible: () => boolean,
		@IChatService private readonly chat: IChatService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) {
		super();
		this._register(addDisposableListener(transcript, 'dragover', event => {
			const drop = this.getDrop(event);
			if (drop) {
				event.preventDefault();
				if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
			}
			this.highlight(drop?.row);
		}));
		this._register(addDisposableListener(transcript, 'dragleave', event => {
			const related = event.relatedTarget as Node | null;
			if (!related?.nodeType || !transcript.contains(related)) this.highlight(undefined);
		}));
		this._register(addDisposableListener(transcript, 'drop', event => {
			const drop = this.getDrop(event);
			const source = this.dragging?.target;
			this.cancelDrag();
			if (!drop || !source) return;
			event.preventDefault();
			void this.move(source, drop.direction);
		}));
		this._register(toDisposable(() => this.cancelDrag()));
	}

	attachDragHandle(row: HTMLElement, container: HTMLElement, currentTarget: () => QueueMessageTarget | undefined, lifetime: DisposableStore): void {
		this.handles.set(row, currentTarget);
		const label = localize('chat.queue.reorder', 'Reorder queued message');
		const button = lifetime.add(new Button(container, {
			...defaultButtonStyles,
			label,
			title: label,
			icon: Lxicon.sort,
			iconOnly: true,
			presentation: 'quiet',
			size: 'small',
		}));
		button.domNode.classList.add('ash-chat-pending-drag-handle');
		button.domNode.dataset.chatQueueReorder = 'true';
		button.domNode.draggable = true;
		const enabledKeys = new Set([ChatContextKeys.enabled.key]);
		const updateVisibility = () => { button.hidden = this.contextKeys.getValue(ChatContextKeys.enabled.key) !== true; };
		lifetime.add(this.contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(enabledKeys)) updateVisibility();
		}));
		updateVisibility();
		lifetime.add(button.onDidClick(() => {
			const target = currentTarget();
			if (!target || !this.isVisible() || this.moving) return;
			this.contextMenus.showContextMenu({
				getAnchor: () => button.domNode,
				getActions: () => (['up', 'down'] as const).map(direction => {
					const label = direction === 'up'
						? localize('chat.queue.moveEarlier', 'Move earlier')
						: localize('chat.queue.moveLater', 'Move later');
					return { id: `chat.queue.move.${direction}`, label, tooltip: label, enabled: !!this.neighbor(target, direction), run: () => this.move(target, direction) };
				}),
			});
		}));
		lifetime.add(addDisposableListener(button.domNode, 'dragstart', event => {
			const target = currentTarget();
			if (!event.dataTransfer || !target || button.hidden || this.moving || !this.isVisible() || this.queue().length < 2) {
				event.preventDefault();
				return;
			}
			this.dragging = { row, target };
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('application/x-ash-chat-pending', 'move');
		}));
		lifetime.add(addDisposableListener(button.domNode, 'dragend', () => this.cancelDrag()));
		lifetime.add(toDisposable(() => {
			this.handles.delete(row);
			if (this.dragging?.row === row) this.cancelDrag();
			else if (this.highlighted === row) this.highlight(undefined);
		}));
	}

	cancelDrag(): void {
		this.dragging = undefined;
		this.highlight(undefined);
	}

	private getDrop(event: DragEvent): { readonly row: HTMLElement; readonly direction: MoveDirection; } | undefined {
		if (!this.dragging || this.moving || !this.isVisible()) return undefined;
		const row = (event.target as Element | null)?.closest?.<HTMLElement>('.ash-chat-item');
		if (!row || row.parentElement !== this.transcript) return undefined;
		const destination = this.handles.get(row)?.();
		if (!destination) return undefined;
		const { target } = this.dragging;
		for (const direction of ['up', 'down'] as const) {
			const neighbor = this.neighbor(target, direction);
			if (neighbor && this.sameRequest(neighbor, destination)) return { row, direction };
		}
		return undefined;
	}

	private highlight(row: HTMLElement | undefined): void {
		if (row === this.highlighted) return;
		this.highlighted?.classList.remove('ash-chat-pending-drop-target');
		this.highlighted = row;
		row?.classList.add('ash-chat-pending-drop-target');
	}

	private neighbor(target: QueueMessageTarget, direction: MoveDirection): QueueMessageTarget | undefined {
		const queue = this.queue();
		const index = queue.findIndex(candidate => this.sameRequest(candidate, target) && candidate.expectedRevision === target.expectedRevision);
		if (index < 0) return undefined;
		const next = queue[index + (direction === 'up' ? -1 : 1)];
		return next?.sessionId === target.sessionId && next.threadId === target.threadId ? next : undefined;
	}

	private sameRequest(left: QueueMessageTarget, right: QueueMessageTarget): boolean {
		return left.sessionId === right.sessionId && left.threadId === right.threadId && left.commandId === right.commandId;
	}

	private async move(target: QueueMessageTarget, direction: MoveDirection): Promise<void> {
		if (this.moving || !this.isVisible() || !this.neighbor(target, direction)) return;
		this.moving = true;
		try {
			await this.chat.movePendingRequest(target, direction);
			if (!this.isDisposed && this.isVisible()) status(localize('chat.queue.moved', 'Queued message moved.'));
		} catch (error) {
			if (!this.isDisposed && this.isVisible()) this.notifications.error(String(error));
		} finally {
			this.moving = false;
		}
	}
}
