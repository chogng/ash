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
import { Separator, SubmenuAction, type IAction } from '../../base/common/actions.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { Lxicon } from '../../base/common/lxicons.js';
import type { Icon } from '../../base/common/icon.js';
import { localize } from '../../nls.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../platform/theme/browser/defaultStyles.js';
import {
	IAuxiliaryWindowService,
	type IAuxiliaryWindow,
} from '../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import type { CodeCardId, CodeCardTarget, ICodeCardLayout, ICodeCardPresentation } from './codeCardLayout.js';
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
		@IContextMenuService private readonly menus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
	) {
		super();
		for (const [id, card] of cards) {
			if (id === 'sessions') { continue; }
			const element = card.domNode;
			const header = card.header!;
			element.dataset.codeCard = id;
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
			const arrange = this.button(
				controls,
				Lxicon.ellipsis,
				localize('sessions.cards.arrange', 'Arrange card'),
				() => this.arrange(id, arrange.domNode),
			);
			arrange.domNode.dataset.cardAction = 'arrange';
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
					const control = [...this.controls.values()].find(element =>
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
								'Use Tab to reach Arrange card, Open in new window, Expand and Close. Arrange offers keyboard movement to each edge of another card and width or height adjustments. You can also drag the header; Escape cancels dragging. Separators resize neighboring cards. Expanding preserves the original layout. Closing a separate window returns the same content to its previous slot. Closing a card keeps its content and terminal sessions for the next time it is shown.',
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

	private arrange(id: CodeCardId, anchor: HTMLElement): void {
		if (this.popouts.has(id)) {
			this.popouts.get(id)!.window.close();
			return;
		}
		const labels = Object.fromEntries([...this.cards].map(([id, card]) => [id, card.title]));
		const directions: readonly [Direction, string][] = [
			[Direction.Left, localize('sessions.cards.left', 'Move to the left of {0}', '{0}')],
			[Direction.Right, localize('sessions.cards.right', 'Move to the right of {0}', '{0}')],
			[Direction.Up, localize('sessions.cards.above', 'Move above {0}', '{0}')],
			[Direction.Down, localize('sessions.cards.below', 'Move below {0}', '{0}')],
		];
		const action = (key: string, label: string, run: () => void): IAction => ({
			id: key,
			label,
			tooltip: '',
			enabled: true,
			run,
		});
		const actions: IAction[] = this.targets(id).map(
			target =>
				new SubmenuAction(
					target,
					labels[target],
					directions.map(([direction, label]) =>
						action(Direction[direction].toLowerCase(), label.replace('{0}', labels[target]), () => {
							this.layout.moveCard(id, target, direction);
							anchor.focus();
							status(localize('sessions.cards.moved', '{0} moved', labels[id]));
						}),
					),
				),
		);
		actions.push(new Separator());
		for (const [key, label, width, height] of [
			['wider', localize('sessions.cards.wider', 'Increase width'), 48, 0],
			['narrower', localize('sessions.cards.narrower', 'Decrease width'), -48, 0],
			['taller', localize('sessions.cards.taller', 'Increase height'), 0, 48],
			['shorter', localize('sessions.cards.shorter', 'Decrease height'), 0, -48],
		] as const)
			actions.push(
				action(key, label, () => {
					this.layout.resizeCard(id, width, height);
					anchor.focus();
				}),
			);
		this.menus.showContextMenu({ getAnchor: () => anchor, getActions: () => actions, autoSelectFirstItem: true });
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
					if (!this.disposed) this.expandedButtons.get(id)?.domNode.focus();
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
