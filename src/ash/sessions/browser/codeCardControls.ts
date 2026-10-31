import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
	IAccessibleViewService,
} from '../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../platform/accessibility/browser/accessibleViewRegistry.js';
import { addDisposableListener, Dimension, h } from '../../base/browser/dom.js';
import { Button } from '../../base/browser/ui/button/button.js';
import { status } from '../../base/browser/ui/aria/aria.js';
import { Direction } from '../../base/browser/ui/grid/grid.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { Lxicon } from '../../base/common/lxicons.js';
import type { Icon } from '../../base/common/icon.js';
import { localize } from '../../nls.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../platform/theme/browser/defaultStyles.js';
import {
	IAuxiliaryWindowService,
	type IAuxiliaryWindow,
} from '../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import type { CodeCardId, CodeCardTarget, ICodeCardLayout, ICodeCardPresentation } from './codeCardLayout.js';
import { CommandsRegistry } from '../../platform/commands/common/commands.js';
import { MenusRegistry } from '../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr, RawContextKey } from '../../platform/contextkey/common/contextkey.js';
import './media/codeCards.css';

/** Card chrome moves retained DOM; no terminal, explorer or chat model is copied into a popup. */
export class CodeCardControls extends Disposable {
	private readonly popouts = new Map<CodeCardId, IAuxiliaryWindow>();
	private readonly opening = new Set<CodeCardId>();
	private readonly drag = this._register(new MutableDisposable<DisposableStore>());
	private readonly expandedButtons = new Map<CodeCardId, Button>();
	private readonly controls = new Map<CodeCardId, HTMLElement>();
	private readonly popupLifetimes = this._register(new DisposableStore());
	private disposed = false;

	constructor(
		private readonly layout: ICodeCardLayout,
		private readonly cards: ReadonlyMap<CodeCardTarget, ICodeCardPresentation>,
		@IAuxiliaryWindowService private readonly windows: IAuxiliaryWindowService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) {
		super();
		for (const [id, card] of cards) {
			if (id === 'sessions') { continue; }
			const element = card.domNode;
			const header = card.header!;
			element.dataset.codeCard = id;
			if (card.layoutMenuId) {
				this.registerLayoutMenu(id, card);
				this._register(addDisposableListener<PointerEvent>(header, 'pointerdown', event => this.startDrag(id, event)));
				continue;
			}
			header.classList.add('ash-code-card-draggable');
			const controls = h(header.ownerDocument, 'div', { className: 'ash-code-card-controls' });
			header.append(controls);
			this.controls.set(id, controls);
			this._register(
				toDisposable(() => {
					controls.remove();
					header.classList.remove('ash-code-card-draggable');
				}),
			);
			this.button(controls, Lxicon.linkExternal, localize('sessions.cards.popout', 'Open in new window'), () => {
				void this.popout(id).catch(error => this.notifications.error(String(error)));
			}).domNode.dataset.cardAction = 'popout';
			const expand = this.button(
				controls,
				Lxicon.screenFull,
				localize('sessions.cards.expand', 'Expand card'),
				() => {
					if (this.popouts.has(id)) this.popouts.get(id)!.window.close();
					else layout.expandCard(id);
				},
			);
			expand.domNode.dataset.cardAction = 'expand';
			this.expandedButtons.set(id, expand);
			this.button(controls, Lxicon.close, localize('sessions.cards.close', 'Close card'), () => {
				this.popouts.get(id)?.window.close();
				layout.closeCard(id);
			}).domNode.dataset.cardAction = 'close';
			this._register(
				addDisposableListener<PointerEvent>(header, 'pointerdown', event => this.startDrag(id, event)),
			);
		}

		this._register(
			AccessibleViewRegistry.register({
				name: 'sessions-code-cards',
				type: AccessibleViewType.Help,
				priority: 100,
				getProvider: () => {
					const controls = [...this.controls.values()];
					for (const card of this.cards.values()) {
						if (!card.layoutMenuId) { continue; }
						const focused = card.domNode.ownerDocument.activeElement;
						const header = focused?.closest<HTMLElement>('.ash-editor-group-header');
						if (header && card.domNode.contains(header)) { controls.push(header); }
					}
					const control = controls.find(element =>
						element.contains(element.ownerDocument.activeElement),
					);
					if (!control) return undefined;
					const focused = control.ownerDocument.activeElement as HTMLElement;
					return new AccessibleContentProvider(
						AccessibleViewProviderId.SessionsChat,
						{ type: AccessibleViewType.Help },
						() =>
							localize(
								'sessions.cards.help',
								'Use Tab and arrow keys to reach editor actions and Open in new window, Expand and Close. Drag the header to move a card; Escape cancels dragging. Separators resize neighboring cards. Expanding preserves the original layout. Closing a separate window returns the same content to its previous slot. Closing a card keeps its content and terminal sessions for the next time it is shown.',
							),
						() => focused.isConnected && focused.focus(),
						AccessibilityVerbositySettingId.Chat,
					);
				},
			}),
		);
		this._register(layout.onDidChangeCards(() => this.render()));
		this.render();
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	private element(id: CodeCardTarget): HTMLElement {
		return this.cards.get(id)!.domNode;
	}
	/** The editor group's header renders these commands; card chrome only supplies layout operations. */
	private registerLayoutMenu(id: CodeCardId, card: ICodeCardPresentation): void {
		const visible = new RawContextKey<boolean>('sessions.filesCardLayoutActive', false).bindTo(this.contextKeys);
		const expanded = new RawContextKey<boolean>('sessions.filesCardExpanded', false).bindTo(this.contextKeys);
		const update = (): void => {
			visible.set(this.layout.active);
			expanded.set(this.layout.expandedCard === id || this.popouts.has(id));
		};
		this._register(this.layout.onDidChangeCards(update));
		this._register(toDisposable(() => { visible.reset(); expanded.reset(); }));
		update();
		const actions = [
			{
				name: 'popout',
				title: localize('sessions.cards.popout', 'Open in new window'),
				icon: Lxicon.linkExternal,
				run: () => this.popout(id).catch(error => this.notifications.error(String(error))),
			},
			{
				name: 'expand',
				title: localize('sessions.cards.expand', 'Expand card'),
				icon: Lxicon.screenFull,
				run: () => {
					if (this.popouts.has(id)) { this.popouts.get(id)!.window.close(); }
					else { this.layout.expandCard(id); }
				},
			},
			{
				name: 'close',
				title: localize('sessions.cards.close', 'Close card'),
				icon: Lxicon.close,
				run: () => {
					this.popouts.get(id)?.window.close();
					this.layout.closeCard(id);
				},
			},
		];
		for (const [order, action] of actions.entries()) {
			const commandId = `sessions.cards.${id}.${action.name}`;
			this._register(CommandsRegistry.register(commandId, action.run));
			this._register(MenusRegistry.appendMenuItem(card.layoutMenuId!, {
				command: {
					id: commandId, title: action.title, icon: action.icon,
					toggled: action.name === 'expand' ? {
						condition: ContextKeyExpr.equals('sessions.filesCardExpanded', true),
						icon: Lxicon.screenNormal,
						title: localize('sessions.cards.restore', 'Restore card size'),
					} : undefined,
				},
				when: ContextKeyExpr.equals('sessions.filesCardLayoutActive', true), group: 'navigation', order,
			}));
		}
	}
	private button(parent: HTMLElement, icon: Icon, label: string, onClick: () => void): Button {
		return this._register(
			new Button(parent, {
				...defaultButtonStyles,
				icon,
				label,
				iconOnly: true,
				presentation: 'quiet',
				size: 'small',
				onClick,
			}),
		);
	}
	private render(): void {
		for (const [id, card] of this.cards) {
			if (id !== 'sessions' && card.layoutMenuId && this.popouts.has(id) && (!this.layout.active || !this.layout.isCardVisible(id))) {
				this.popouts.get(id)!.window.close();
			}
		}
		for (const [id, controls] of this.controls) {
			if (controls.parentElement?.lastElementChild !== controls) { controls.parentElement?.append(controls); }
			controls.hidden = !this.layout.active;
			this.element(id).classList.toggle('ash-code-card-managed', this.layout.active);
			const popup = this.popouts.has(id);
			const expanded = this.layout.expandedCard === id;
			const button = this.expandedButtons.get(id)!;
			button.icon = expanded || popup ? Lxicon.screenNormal : Lxicon.screenFull;
			button.label = popup
				? localize('sessions.cards.return', 'Return to main window')
				: expanded
					? localize('sessions.cards.restore', 'Restore card size')
					: localize('sessions.cards.expand', 'Expand card');
			button.domNode.setAttribute('aria-pressed', String(expanded));
			if ((!this.layout.active || !this.layout.isCardVisible(id)) && popup) this.popouts.get(id)!.window.close();
		}
	}

	private targets(id: CodeCardId): CodeCardTarget[] {
		return [...this.cards.keys()].filter(
			target =>
				target !== id &&
				!this.popouts.has(target as CodeCardId) &&
				this.element(target).getClientRects().length > 0,
		);
	}

	private startDrag(id: CodeCardId, event: PointerEvent): void {
		if (event.button !== 0 || !this.layout.active || this.popouts.has(id)) return;
		const target = event.target as HTMLElement;
		if (this.cards.get(id)?.layoutMenuId && !target.closest('.ash-editor-group-header, .ash-editor-tabs-and-actions')) return;
		if (target.closest('button, input, a, [role="tab"], [role="separator"]')) return;
		const document = target.ownerDocument;
		const resources = new DisposableStore();
		this.drag.value = resources;
		const preview = h(document, 'div', { className: 'ash-code-card-drop-preview' });
		preview.hidden = true;
		document.body.append(preview);
		resources.add(
			toDisposable(() => {
				preview.remove();
				document.body.classList.remove('ash-code-card-dragging');
			}),
		);
		let dragged = false;
		let drop: { target: CodeCardTarget; direction: Direction; } | undefined;
		resources.add(
			addDisposableListener<PointerEvent>(
				document,
				'pointermove',
				next => {
					if (!dragged && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 5) return;
					dragged = true;
					next.preventDefault();
					document.body.classList.add('ash-code-card-dragging');
					drop = undefined;
					preview.hidden = true;
					for (const candidate of this.targets(id)) {
						const rect = this.element(candidate).getBoundingClientRect();
						if (
							next.clientX < rect.left ||
							next.clientX > rect.right ||
							next.clientY < rect.top ||
							next.clientY > rect.bottom
						)
							continue;
						const x = (next.clientX - rect.left) / rect.width,
							y = (next.clientY - rect.top) / rect.height;
						const edges: [Direction, number][] = [
							[Direction.Left, x],
							[Direction.Right, 1 - x],
							[Direction.Up, y],
							[Direction.Down, 1 - y],
						];
						edges.sort((a, b) => a[1] - b[1]);
						const direction = edges[0]![0];
						drop = { target: candidate, direction };
						const horizontal = direction === Direction.Left || direction === Direction.Right;
						Object.assign(preview.style, {
							left: rect.left + (direction === Direction.Right ? rect.width / 2 : 0) + 'px',
							top: rect.top + (direction === Direction.Down ? rect.height / 2 : 0) + 'px',
							width: (horizontal ? rect.width / 2 : rect.width) + 'px',
							height: (horizontal ? rect.height : rect.height / 2) + 'px',
						});
						preview.hidden = false;
						break;
					}
				},
				true,
			),
		);
		resources.add(
			addDisposableListener(
				document,
				'pointerup',
				() => {
					const destination = drop;
					this.drag.clear();
					if (destination) {
						this.layout.moveCard(id, destination.target, destination.direction);
						status(localize('sessions.cards.moved', '{0} moved', this.cards.get(id)!.title));
					}
				},
				true,
			),
		);
		resources.add(
			addDisposableListener<KeyboardEvent>(
				document,
				'keydown',
				key => {
					if (key.key === 'Escape') {
						key.preventDefault();
						key.stopPropagation();
						this.drag.clear();
					}
				},
				true,
			),
		);
		resources.add(addDisposableListener(document, 'pointercancel', () => this.drag.clear()));
		resources.add(addDisposableListener(document.defaultView!, 'blur', () => this.drag.clear()));
	}

	private async popout(id: CodeCardId): Promise<void> {
		const existing = this.popouts.get(id);
		if (existing) {
			existing.window.focus();
			return;
		}
		if (this.opening.has(id)) return;
		this.opening.add(id);
		try {
			const element = this.element(id);
			const frame = element.parentElement!;
			const bounds = element.getBoundingClientRect();
			const popup = await this.windows.open({
				title: this.cards.get(id)!.title,
				width: Math.max(560, bounds.width),
				height: Math.max(460, bounds.height),
			});
			if (this.disposed || !this.layout.active || !this.layout.isCardVisible(id)) {
				popup.dispose();
				return;
			}
			const lifetime = new DisposableStore();
			this.popupLifetimes.add(lifetime);
			this.popouts.set(id, popup);
			this.layout.detachCard(id, true);
			popup.window.document.title = this.cards.get(id)!.title;
			popup.container.setAttribute('aria-label', this.cards.get(id)!.title);
			popup.container.classList.add('ash-sessions-window', 'ash-code-card-window', 'ash-sessions-code-tools');
			const titlebar = h(popup.window.document, 'header', { className: 'ash-code-card-window-titlebar' });
			const title = h(popup.window.document, 'span');
			title.textContent = this.cards.get(id)!.title;
			titlebar.append(title);
			lifetime.add(
				new Button(titlebar, {
					...defaultButtonStyles,
					presentation: 'quiet',
					iconOnly: true,
					icon: Lxicon.screenNormal,
					label: localize('sessions.cards.return', 'Return to main window'),
					onClick: () => popup.window.close(),
				}),
			);
			popup.container.append(titlebar, element);
			lifetime.add(
				addDisposableListener<KeyboardEvent>(
					popup.window,
					'keydown',
					event => {
						if (event.altKey && event.key === 'F1' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
							event.preventDefault();
							event.stopPropagation();
							this.accessibleViews.show(
								AccessibleViewType.Help,
								popup.window.document.activeElement as HTMLElement,
							);
						}
					},
					true,
				),
			);
			const size = () => {
				const width = popup.container.clientWidth,
					height = Math.max(0, popup.container.clientHeight - titlebar.offsetHeight);
				element.style.width = width + 'px';
				element.style.height = height + 'px';
				this.cards.get(id)!.layout(new Dimension(width, height));
			};
			// Return the original node before the auxiliary document and its styles are destroyed.
			lifetime.add(
				toDisposable(() => {
					this.popouts.delete(id);
					frame.append(element);
					element.style.removeProperty('width');
					element.style.removeProperty('height');
					this.layout.detachCard(id, false);
					popup.dispose();
					if (!this.disposed) {
						const button = this.expandedButtons.get(id)?.domNode ?? element.querySelector<HTMLElement>(`[data-action-id="sessions.cards.${id}.expand"]`);
						button?.focus();
					}
				}),
			);
			lifetime.add(popup.onDidLayout(size));
			lifetime.add(
				popup.onDidClose(() => {
					this.popupLifetimes.delete(lifetime);
					lifetime.dispose();
				}),
			);
			await popup.whenStylesHaveLoaded;
			if (lifetime.isDisposed) return;
			popup.layout();
			size();
			this.render();
			popup.window.focus();
			this.expandedButtons.get(id)?.domNode.focus();
		} finally {
			this.opening.delete(id);
		}
	}
}
