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
import type { Direction } from '../../base/browser/ui/grid/grid.js';
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
import type { Part } from '../../workbench/browser/part.js';
import type { SessionsPartId } from '../common/layoutConstants.js';
import type { CodeCardId, CodeCardTarget, ICodeCardLayout } from './codeCardLayout.js';
import { EditorPart } from './parts/editorPart.js';
import './media/codeCards.css';

const names = () => ({
	panel: localize('sessions.cards.terminal', 'Terminal'),
	auxiliarybar: localize('sessions.cards.files', 'Files'),
	info: localize('sessions.cards.information', 'Session information'),
	sessions: localize('sessions.cards.conversation', 'Conversation'),
	editor: localize('sessions.cards.editor', 'Editor'),
});

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
		private readonly parts: ReadonlyMap<SessionsPartId, Part>,
		@IAuxiliaryWindowService private readonly windows: IAuxiliaryWindowService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
	) {
		super();
		for (const id of ['panel', 'auxiliarybar', 'info', 'editor'] as const) {
			const element = this.element(id);
			const header =
				id === 'info'
					? layout.information.header
					: parts.get(id)!.domNode.querySelector<HTMLElement>(':scope > .ash-workbench-part-title')!;
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
		return id === 'info' ? this.layout.information.card : this.parts.get(id)!.domNode;
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
		const editor = this.parts.get('editor');
		if (editor instanceof EditorPart) { editor.setCardPresentation(this.layout.active); }
		for (const [id, controls] of this.controls) {
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
		const labels = names();
		const directions: readonly [Direction, string][] = [
			['left', localize('sessions.cards.left', 'Move to the left of {0}', '{0}')],
			['right', localize('sessions.cards.right', 'Move to the right of {0}', '{0}')],
			['up', localize('sessions.cards.above', 'Move above {0}', '{0}')],
			['down', localize('sessions.cards.below', 'Move below {0}', '{0}')],
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
						action(direction, label.replace('{0}', labels[target]), () => {
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
		return (['panel', 'auxiliarybar', 'info', 'sessions', 'editor'] as const).filter(
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
							['left', x],
							['right', 1 - x],
							['up', y],
							['down', 1 - y],
						];
						edges.sort((a, b) => a[1] - b[1]);
						const direction = edges[0]![0];
						drop = { target: candidate, direction };
						const horizontal = direction === 'left' || direction === 'right';
						Object.assign(preview.style, {
							left: rect.left + (direction === 'right' ? rect.width / 2 : 0) + 'px',
							top: rect.top + (direction === 'down' ? rect.height / 2 : 0) + 'px',
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
						status(localize('sessions.cards.moved', '{0} moved', names()[id]));
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
				title: names()[id],
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
			popup.window.document.title = names()[id];
			popup.container.setAttribute('aria-label', names()[id]);
			popup.container.classList.add('ash-sessions-window', 'ash-code-card-window', 'ash-sessions-code-tools');
			const titlebar = h(popup.window.document, 'header', { className: 'ash-code-card-window-titlebar' });
			const title = h(popup.window.document, 'span');
			title.textContent = names()[id];
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
				if (id !== 'info') this.parts.get(id)!.layout(new Dimension(width, height));
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
