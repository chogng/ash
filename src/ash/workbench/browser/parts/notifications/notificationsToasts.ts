import { getNotificationsPosition, NotificationsPosition, type NotificationsModel, type NotificationItem } from '../../../common/notifications.js';
import "./media/notificationsToasts.css";
import { addDisposableListener, getActiveElement, isEditableElement } from "../../../../base/browser/dom.js";
import type { IActionRunner } from "../../../../base/common/actions.js";
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Emitter, Event } from '../../../../base/common/event.js';
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { INotificationService, NotificationPriority, NotificationsFilter, Severity } from "../../../../platform/notification/common/notification.js";
import { IHostService } from '../../../services/host/browser/host.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

import { NotificationsList } from "./notificationsList.js";
import { PendingNotificationToasts } from "./pendingNotificationToasts.js";

/** Transient presentation of notification history. Explicit removal clears the shared record. */
export class NotificationsToasts extends Disposable {
	private readonly element: HTMLDivElement;
	private readonly visible = new Set<number>();
	private readonly list: NotificationsList;
	private readonly pending: PendingNotificationToasts<number>;
	private readonly toastLifetimes = this._register(new DisposableMap<number, DisposableStore>());
	private hidden = false;
	private previousFocus: HTMLElement | undefined;
	private readonly visibilityChanges = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility = this.visibilityChanges.event;
	private wasVisible = false;
	get isVisible(): boolean { return !this.hidden && this.visible.size > 0; }

	constructor(private readonly container: HTMLElement, private readonly model: NotificationsModel, actionRunner: IActionRunner, @IInstantiationService instantiationService: IInstantiationService, @INotificationService private readonly notificationService: INotificationService, @IHostService private readonly hostService: IHostService, @IConfigurationService private readonly configurationService: IConfigurationService) {
		super();
		const document = container.ownerDocument;
		this.list = this._register(instantiationService.createInstance(NotificationsList, container, "toast", actionRunner));
		this.element = this.list.domNode;
		this.pending = this._register(new PendingNotificationToasts<number>(
			id => !this.hidden && model.getNotifications().some(current => current.id === id && !this.isFiltered(current) && !this.coversActiveInput(current)),
			callback => {
				const window = this.element.ownerDocument.defaultView!;
				const frame = window.requestAnimationFrame(callback);
				return toDisposable(() => window.cancelAnimationFrame(frame));
			},
		));
		this._register(model.onDidAdd(item => {
			if (this.hidden || item.priority === NotificationPriority.SILENT) return;
			this.pending.add(item.id, (id, resources) => {
				try {
					this.visible.add(id);
					if (this.visible.size > 3) this.visible.delete(this.visible.values().next().value!);
					this.render();
				} finally { resources.dispose(); }
			});
		}));
		this._register(model.onDidRemove(item => { this.pending.remove(item.id); this.visible.delete(item.id); this.render(); }));
		this._register(notificationService.onDidChangeFilter(() => {
			for (const item of model.getNotifications()) {
				if (this.isFiltered(item)) { this.pending.remove(item.id); this.visible.delete(item.id); }
			}
			this.render();
		}));
		this._register(addDisposableListener(this.element, "focusin", event => {
			const HTMLElement = document.defaultView?.HTMLElement;
			const target = event.relatedTarget;
			if (HTMLElement && target instanceof HTMLElement && target !== document.body && !this.element.contains(target)) {
				this.previousFocus = target;
			}
		}));
		this._register(addDisposableListener(this.element, "keydown", event => {
			if (event.key !== "Escape" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || this.hidden || this.isDisposed) return;
			const target = event.target;
			const HTMLElement = document.defaultView?.HTMLElement;
			if (!HTMLElement || !(target instanceof HTMLElement) || target !== document.activeElement || !this.element.isConnected || !this.element.contains(target) || !target.closest('.ash-notification')) return;
			event.preventDefault();
			event.stopPropagation();
			const previousFocus = this.previousFocus;
			// Passive dismissal clears this presentation, leaving the model and future arrivals intact.
			this.visible.clear();
			this.pending.clear();
			this.render();
			// DOM removal can transfer ownership of focus or dispose this window's presentation.
			if (!this.hidden && !this.isDisposed && this.element.isConnected && document.activeElement === document.body && previousFocus?.isConnected && !previousFocus.closest("[hidden], [inert], [aria-hidden='true']") && !previousFocus.matches(":disabled") && previousFocus.checkVisibility?.({ checkVisibilityCSS: true })) {
				previousFocus.focus();
			}
		}));
		this._register(this.list.onDidRequestRemove(id => {
			if (model.get(id)?.hasActiveProgress) return;
			const button = this.element.querySelector<HTMLButtonElement>(`[data-notification-close="${id}"]`);
			const buttons = [...this.element.querySelectorAll<HTMLButtonElement>("[data-notification-close]")];
			const focusedIndex = document.activeElement === button ? buttons.indexOf(button!) : -1;
			const rows = [...this.element.children] as HTMLElement[];
			const focusedRowIndex = rows.findIndex(row => row.contains(document.activeElement));
			model.remove(id);
			// Removal listeners can open the center, move focus, or dispose this owner.
			if (focusedIndex >= 0 && !this.hidden && !this.isDisposed && this.element.isConnected && document.activeElement === document.body) {
				const remaining = this.element.querySelectorAll<HTMLButtonElement>("[data-notification-close]");
				const nextFocus = remaining[Math.min(focusedIndex, remaining.length - 1)] ?? this.previousFocus;
				if (nextFocus?.isConnected) nextFocus.focus();
			} else if (focusedRowIndex >= 0 && !this.hidden && !this.isDisposed && this.element.isConnected && document.activeElement === document.body) {
				const nextFocus = this.element.children[Math.min(focusedRowIndex, this.element.children.length - 1)] as HTMLElement | undefined;
				(nextFocus ?? this.previousFocus)?.focus();
			}
		}));
		for (const item of model.getNotifications().filter(item => item.priority !== NotificationPriority.SILENT && !this.isFiltered(item) && !this.coversActiveInput(item)).slice(-3)) this.visible.add(item.id);
		this.render();
	}

	setHidden(hidden: boolean): void {
		if (hidden && !this.hidden) { this.visible.clear(); this.pending.clear(); }
		this.hidden = hidden;
		this.render();
	}

	setPosition(position: NotificationsPosition, top: number): void {
		this.container.classList.add('ash-notifications-placement');
		this.container.dataset.notificationPosition = position;
		this.container.style.setProperty('--ash-notifications-top', `${top + 8}px`);
	}

	private render(): void {
		if (this.isDisposed) return;
		const items = this.hidden ? [] : this.model.getNotifications().filter(item => this.visible.has(item.id)).reverse();
		this.list.updateNotificationsList(0, this.element.children.length, items);
		for (const [id] of this.toastLifetimes) {
			if (!this.visible.has(id) || this.hidden) this.toastLifetimes.deleteAndDispose(id);
		}
		for (const item of items) {
			if (this.visible.has(item.id) && this.model.get(item.id) && !this.toastLifetimes.has(item.id)) this.trackTimeout(item.id);
		}
		if (this.wasVisible !== this.isVisible) {
			this.wasVisible = this.isVisible;
			this.visibilityChanges.fire(this.wasVisible);
		}
	}

	private isFiltered(item: NotificationItem): boolean {
		return item.priority !== NotificationPriority.URGENT && item.severity !== Severity.Error && (this.notificationService.getFilter() === NotificationsFilter.ERROR
			|| (!!item.sourceId && this.notificationService.getFilter({ id: item.sourceId, label: item.source! }) === NotificationsFilter.ERROR));
	}

	private coversActiveInput(item: NotificationItem): boolean {
		if (item.priority !== NotificationPriority.OPTIONAL) return false;
		const active = getActiveElement(this.element.ownerDocument);
		if (!active || !isEditableElement(active)) return false;
		const root = this.container.parentElement?.getBoundingClientRect();
		if (!root?.width || !root.height) return false;
		const input = active.getBoundingClientRect();
		const right = input.left - root.left > root.width / 2;
		const bottom = input.top - root.top > root.height / 2;
		switch (getNotificationsPosition(this.configurationService)) {
			case NotificationsPosition.BOTTOM_LEFT: return !right && bottom;
			case NotificationsPosition.TOP_RIGHT: return right && !bottom;
			default: return right && bottom;
		}
	}

	private trackTimeout(id: number): void {
		const node = this.element.querySelector<HTMLElement>(`[data-notification-id="${id}"]`);
		if (!node) return;
		const lifetime = this.toastLifetimes.set(id, new DisposableStore());
		const pending = lifetime.add(new MutableDisposable());
		let hovered = false;
		lifetime.add(addDisposableListener(node, 'mouseenter', () => { hovered = true; }));
		lifetime.add(addDisposableListener(node, 'mouseleave', () => { hovered = false; }));
		const schedule = (): void => {
			if (lifetime.isDisposed) return;
			const item = this.model.get(id);
			if (!item) return;
			const delay = item.severity === Severity.Error ? 15000 : item.severity === Severity.Warning ? 12000 : 10000;
			const timer = setTimeout(() => {
				const current = this.model.get(id);
				if (!current || lifetime.isDisposed) return;
				if (!this.hostService.hasFocus) {
					// Give the returning user a full reading interval, with one owned focus wait.
					const onFocus: Event<void> = listener => this.hostService.onDidChangeFocus(focused => { if (focused) listener(); });
					pending.value = Event.once(onFocus)(schedule);
				} else if (current.sticky || current.hasActiveProgress || (current.severity === Severity.Error && !!current.actions?.primary?.length) || hovered || node.contains(node.ownerDocument.activeElement) || node.querySelector('[aria-haspopup="menu"][aria-expanded="true"]')) {
					schedule();
				} else {
					this.visible.delete(id);
					this.render();
				}
			}, delay);
			pending.value = toDisposable(() => clearTimeout(timer));
		};
		schedule();
	}
}
