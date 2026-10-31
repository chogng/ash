import { addDisposableListener, Dimension, h, type IDimension } from '../../base/browser/dom.js';
import { Button } from '../../base/browser/ui/button/button.js';
import { Event } from '../../base/common/event.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { Lxicon } from '../../base/common/lxicons.js';
import { localize } from '../../nls.js';
import { IAccessibleViewService, AccessibleViewType } from '../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../platform/theme/browser/defaultStyles.js';
import { IAuxiliaryWindowService, type IAuxiliaryWindow } from '../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';

interface AuxiliaryViewOptions {
	readonly content: HTMLElement;
	readonly title: string;
	readonly layoutContent: (dimension: IDimension) => void;
	readonly canAttach: () => boolean;
	readonly onAttach: () => void;
	readonly onReturn: () => void;
	readonly focus: () => void;
}

/** Hosts one retained view in an auxiliary document; its owner keeps the Grid slot. */
export class AuxiliaryView extends Disposable {
	private popup: IAuxiliaryWindow | undefined;
	private parent: HTMLElement | undefined;

	constructor(
		private readonly view: AuxiliaryViewOptions,
		@IAuxiliaryWindowService private readonly windows: IAuxiliaryWindowService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
	}

	async open(): Promise<void> {
		try {
			const bounds = this.view.content.getBoundingClientRect();
			const popup = await this.windows.open({
				title: this.view.title,
				width: Math.max(560, bounds.width),
				height: Math.max(460, bounds.height),
			});
			if (this.isDisposed || !this.view.canAttach()) {
				popup.dispose();
				this.dispose();
				return;
			}
			this.popup = popup;
			this._register(toDisposable(() => popup.dispose()));
			this.parent = this.view.content.parentElement!;
			this._register(Event.once(popup.onDidClose)(() => this.dispose()));
			this.view.onAttach();
			popup.window.document.title = this.view.title;
			popup.container.setAttribute('aria-label', this.view.title);
			popup.container.classList.add('ash-sessions-window', 'ash-code-card-window', 'ash-sessions-code-tools');
			const titlebar = h(popup.window.document, 'header', { className: 'ash-code-card-window-titlebar' });
			const title = h(popup.window.document, 'span');
			title.textContent = this.view.title;
			titlebar.append(title);
			this._register(new Button(titlebar, {
				...defaultButtonStyles,
				presentation: 'quiet',
				iconOnly: true,
				icon: Lxicon.screenNormal,
				label: localize('sessions.cards.return', 'Return to main window'),
				onClick: () => this.close(),
			}));
			popup.container.append(titlebar, this.view.content);
			this._register(addDisposableListener<KeyboardEvent>(popup.window, 'keydown', event => {
				if (event.altKey && event.key === 'F1' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
					event.preventDefault();
					event.stopPropagation();
					this.accessibleViews.show(AccessibleViewType.Help, popup.window.document.activeElement as HTMLElement);
				}
			}, true));
			const size = (): void => {
				const width = popup.container.clientWidth;
				const height = Math.max(0, popup.container.clientHeight - titlebar.offsetHeight);
				this.view.content.style.width = width + 'px';
				this.view.content.style.height = height + 'px';
				this.view.layoutContent(new Dimension(width, height));
			};
			this._register(popup.onDidLayout(size));
			await popup.whenStylesHaveLoaded;
			if (this.isDisposed) { return; }
			popup.layout();
			size();
			this.focus();
			this.view.focus();
		} catch (error) {
			this.dispose();
			this.notifications.error(String(error));
		}
	}

	focus(): void {
		this.popup?.window.focus();
	}

	close(): void {
		if (this.popup) { this.popup.window.close(); }
		else { this.dispose(); }
	}

	protected override disposeCore(): void {
		// Return the node while both documents and the layout owner are still alive.
		if (this.parent) {
			this.parent.append(this.view.content);
			this.view.content.style.removeProperty('width');
			this.view.content.style.removeProperty('height');
		}
		this.view.onReturn();
		super.disposeCore();
		this.view.focus();
	}
}
