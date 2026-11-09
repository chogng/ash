import './sessionLeadingIcon.css';
import { h } from '../../../base/browser/dom.js';
import { ActionBar } from '../../../base/browser/ui/actionbar/actionbar.js';
import { LabelActionViewItem } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import type { Icon } from '../../../base/common/icon.js';
import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IconPicker } from '../../../workbench/services/userDataProfile/browser/iconPicker.js';
import { SessionStatusIcon, type ISessionStatusIcon } from '../sessionStatusIcon.js';

/** Shared leading control. Hosts place it in their own row and supply the current icon and status. */
export class SessionLeadingIcon extends Disposable {
	readonly element: HTMLElement;
	private readonly statusIcon: SessionStatusIcon;
	private readonly picker = this._register(new MutableDisposable<IconPicker>());
	private readonly button: HTMLButtonElement | undefined;
	private readonly bar: ActionBar | undefined;

	constructor(document: Document, title: string, onPick: ((icon: Icon | undefined) => void) | undefined,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		const graphic = h(document, 'span', { className: 'ash-session-leading-graphic', attributes: { 'aria-hidden': 'true' } });
		this.statusIcon = this._register(this.instantiation.createInstance(SessionStatusIcon, graphic));
		this.element = h(document, 'div', { className: 'ash-session-leading-icon' });
		if (onPick) {
			const label = localize('sessionRow.changeIcon', 'Change icon for {0}', title);
			const bar = this.bar = this._register(new ActionBar(this.element, {
				ariaLabel: label,
				actions: [{
					id: 'sessions.changeRowIcon',
					label,
					tooltip: label,
					enabled: true,
					run: () => this.pickIcon(onPick),
				}],
				actionViewItemProvider: action => new class extends LabelActionViewItem {
					override render(container: HTMLElement): void {
						super.render(container);
						const button = container.querySelector('button')!;
						button.setAttribute('aria-haspopup', 'dialog');
						button.prepend(graphic);
					}
				}(action, { label: '', ariaLabel: label }),
			}));
			this.button = bar.domNode.querySelector('button')!;
		} else {
			this.element.append(graphic);
		}
	}

	setTitle(title: string): void {
		if (!this.button) { return; }
		const label = localize('sessionRow.changeIcon', 'Change icon for {0}', title);
		if (this.button.getAttribute('aria-label') === label) { return; }
		this.bar?.setAriaLabel(label);
		this.button.setAttribute('aria-label', label);
		this.button.title = label;
	}

	setRestingIcon(icon: Icon | undefined): void { this.statusIcon.setRestingIcon(icon); }

	setStatus(status: ISessionStatusIcon | undefined): void { this.statusIcon.setStatus(status); }

	closePicker(): void { this.picker.clear(); }

	private async pickIcon(onPick: (icon: Icon | undefined) => void): Promise<void> {
		const anchor = this.button;
		if (!anchor || this.picker.value) { return; }
		const picker = this.instantiation.createInstance(IconPicker);
		this.picker.value = picker;
		try {
			const icon = await picker.pickIcons(undefined, anchor);
			if (icon !== undefined && this.picker.value === picker && anchor.isConnected) {
				onPick(icon ?? undefined);
			}
		} finally {
			if (this.picker.value === picker) { this.picker.clear(); }
		}
	}
}
