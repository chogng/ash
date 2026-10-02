import { addDisposableListener, getActiveElement, isHTMLElement, stopEvent } from '../../../base/browser/dom.js';
import '../../../base/browser/ui/dialog/dialog.css';
import '../../../base/browser/ui/menu/menu.css';
import { Dialog } from '../../../base/browser/ui/dialog/dialog.js';
import { Menu } from '../../../base/browser/ui/menu/menu.js';
import type { IAction } from '../../../base/common/actions.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../accessibility/browser/accessibleViewRegistry.js';
import { IContextViewService } from '../../contextview/browser/contextView.js';
import './actionWidget.css';

export const enum ActionListItemKind {
	Action = 'action',
}

export interface IActionListItem<T> {
	readonly kind: ActionListItemKind;
	readonly item: T;
	readonly label: string;
	readonly disabled?: boolean;
}

export interface IActionListDelegate<T> {
	onHide(didCancel?: boolean): void;
	onSelect(action: T): void | Promise<void>;
}

/** Owns typed action dispatch and its pending state; Menu owns row focus and navigation. */
export class ActionList<T> extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly menu: Menu;
	private readonly help = this._register(new MutableDisposable<DisposableStore>());
	private busy = false;

	constructor(
		user: string,
		items: readonly IActionListItem<T>[],
		private readonly delegate: IActionListDelegate<T>,
		container: HTMLElement,
		ariaHint: string | undefined,
	) {
		super();
		const actions: IAction[] = items.map((entry, index) => ({
			id: `${user}.${index}`,
			label: entry.label,
			tooltip: entry.label,
			enabled: !entry.disabled,
			run: () => this.select(entry),
		}));
		this.menu = this._register(new Menu(container, { actions, className: 'ash-action-widget' }));
		this.domNode = this.menu.element;
		this.domNode.tabIndex = -1;
		this.domNode.setAttribute('aria-label', localize('actionWidget.label', 'Actions'));
		if (ariaHint) {
			this.domNode.setAttribute('aria-description', ariaHint);
		}
		this._register(addDisposableListener(this.domNode, 'pointerdown', event => event.stopPropagation()));
		this._register(addDisposableListener(this.domNode, 'mousedown', event => event.stopPropagation()));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.isComposing) {
				return;
			}
			if (event.altKey && event.key === 'F1') {
				stopEvent(event);
				const lifetime = new DisposableStore();
				const provider = lifetime.add(createHelpProvider(getActiveElement(this.domNode.ownerDocument)));
				const dialog = lifetime.add(new Dialog(container, {
					title: localize('actionWidget.helpTitle', 'Action menu accessibility help'),
					content: provider.provideContent(),
				}));
				this.help.value = lifetime;
				void dialog.show().finally(() => {
					if (this.help.value === lifetime) {
						this.help.clear();
					}
				});
				return;
			}
		}, true));
	}

	private async select(entry: IActionListItem<T>): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = true;
		this.domNode.setAttribute('aria-busy', 'true');
		try {
			await this.delegate.onSelect(entry.item);
		} finally {
			if (!this.isDisposed) {
				this.busy = false;
				this.domNode.removeAttribute('aria-busy');
			}
		}
	}

	public focus(): void {
		this.menu.focusFirst();
		if (!this.domNode.contains(getActiveElement(this.domNode.ownerDocument))) {
			this.domNode.focus({ preventScroll: true });
		}
	}
}

function createHelpProvider(source: Element | null): AccessibleContentProvider {
	return new AccessibleContentProvider(
		AccessibleViewProviderId.ActionWidget,
		{ type: AccessibleViewType.Help },
		() => localize('actionWidget.help', 'Use Up and Down Arrow to move between available actions. Home and End move to the first and last action. Enter or Space runs the focused action. Escape closes the menu and returns focus to its source. Unavailable actions are skipped.'),
		() => {
			if (isHTMLElement(source) && source.isConnected) {
				source.focus({ preventScroll: true });
			}
		},
		AccessibilityVerbositySettingId.ActionWidget,
	);
}

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'action-widget',
	getProvider: accessor => {
		const active = getActiveElement(accessor.get(IContextViewService).container.ownerDocument);
		return active?.closest('.ash-action-widget') ? createHelpProvider(active) : undefined;
	},
});
