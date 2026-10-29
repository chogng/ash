import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import type { IActionRunner } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { NotificationItem } from '../../../common/notifications.js';
import { NotificationTemplateRenderer } from './notificationsViewer.js';

/** Owns retained notification rows and their controls, never the shared history. */
export class NotificationsList extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly renderers = this._register(new DisposableMap<number, NotificationTemplateRenderer>());
	private readonly removeEmitter = this._register(new Emitter<number>());
	public readonly onDidRequestRemove = this.removeEmitter.event;
	private readonly items: NotificationItem[] = [];
	private readonly itemsById = new Map<number, NotificationItem>();
	private readonly visible = new Set<number>();

	constructor(
		container: HTMLElement,
		private readonly presentation: 'toast' | 'center',
		private readonly actionRunner: IActionRunner,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = presentation === 'toast' ? 'ash-notification-host' : 'ash-notifications-list';
		this.domNode.setAttribute('role', presentation === 'toast' ? 'region' : 'list');
		if (presentation === 'toast') {
			this.domNode.setAttribute('aria-label', localize('notifications.toasts', 'Notifications'));
		}
		container.append(this.domNode);
		this._register(
			addDisposableListener(this.domNode, 'keydown', event => {
				if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return;
				const target = event.target as HTMLElement;
				const row = target.closest<HTMLElement>('[data-notification-id]');
				if (!row || row.parentElement !== this.domNode) return;
				if ((!event.ctrlKey && !event.metaKey && event.key === 'Delete') || (isMacintosh && event.metaKey && !event.ctrlKey && event.key === 'Backspace')) {
					event.preventDefault();
					event.stopPropagation();
					this.removeEmitter.fire(Number(row.dataset.notificationId));
					return;
				}
				if (target !== row) return;
				if ((isMacintosh ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && event.key === 'Enter') {
					const primary = row.querySelector<HTMLButtonElement>('.ash-notification-action');
					if (primary && !primary.disabled) {
						event.preventDefault();
						primary.click();
					}
					return;
				}
				if (event.ctrlKey || event.metaKey) return;
				const item = this.itemsById.get(Number(row.dataset.notificationId));
				if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					if (event.key === 'ArrowRight') item?.expand();
					else if (event.key === 'ArrowLeft') item?.collapse();
					else item?.toggle();
					return;
				}
				const rows = [...this.domNode.children] as HTMLElement[];
				const index = rows.indexOf(row);
				const next =
					event.key === 'ArrowDown'
						? Math.min(index + 1, rows.length - 1)
						: event.key === 'ArrowUp'
							? Math.max(index - 1, 0)
							: event.key === 'Home'
								? 0
								: event.key === 'End'
									? rows.length - 1
									: undefined;
				if (next !== undefined) {
					event.preventDefault();
					rows[next]?.focus();
				}
			}),
		);
		this._register(
			toDisposable(() => {
				for (const id of this.visible) this.itemsById.get(id)?.updateVisibility(false);
				this.visible.clear();
				this.itemsById.clear();
				this.domNode.remove();
			}),
		);
	}

	public focusFirst(): void {
		this.domNode.querySelector<HTMLElement>('[data-notification-id]')?.focus();
	}

	public updateNotificationsList(start: number, deleteCount: number, items: readonly NotificationItem[] = []): void {
		this.items.splice(start, deleteCount, ...items);
		for (const [id] of this.renderers) {
			if (!this.items.some(item => item.id === id)) {
				this.renderers.deleteAndDispose(id);
				if (this.visible.delete(id)) this.itemsById.get(id)?.updateVisibility(false);
				this.itemsById.delete(id);
			}
		}
		for (const [index, item] of this.items.entries()) {
			let renderer = this.renderers.get(item.id);
			if (!renderer) {
				renderer = this.renderers.set(
					item.id,
					this.instantiationService.createInstance(NotificationTemplateRenderer, this.domNode, item, this.presentation, this.actionRunner, (id: number) => this.removeEmitter.fire(id)),
				);
			}
			const position = this.domNode.children[index];
			if (position !== renderer.domNode) {
				this.domNode.insertBefore(renderer.domNode, position ?? null);
			}
			this.itemsById.set(item.id, item);
			const visible = renderer.domNode.isConnected && renderer.domNode.checkVisibility?.({ checkVisibilityCSS: true }) === true;
			if (visible !== this.visible.has(item.id)) {
				if (visible) this.visible.add(item.id);
				else this.visible.delete(item.id);
				item.updateVisibility(visible);
			}
		}
	}
}
