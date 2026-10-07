import { h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

export interface SettingsTreeIndicatorsState {
	readonly isPending: boolean;
}

/** Announces an in-progress Settings write without adding a persistent row status. */
export class SettingsTreeIndicatorsLabel extends Disposable {
	public readonly domNode: HTMLSpanElement;
	private readonly labelDomNode: HTMLSpanElement;

	constructor(container: HTMLElement) {
		super();
		this.domNode = h(container.ownerDocument, 'span');
		this.domNode.className = 'ash-settings-indicators';
		this.domNode.setAttribute('aria-live', 'polite');
		this.labelDomNode = h(container.ownerDocument, 'span');
		this.labelDomNode.className = 'ash-settings-indicator-label';
		this.domNode.append(this.labelDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public update(state: SettingsTreeIndicatorsState): void {
		const label = state.isPending ? localize({ bundle: 'ash.settings', key: 'status.saving' }, 'Saving…') : '';
		this.labelDomNode.textContent = label;
		this.domNode.setAttribute('aria-label', getIndicatorsLabelAriaLabel(state));
		this.domNode.classList.toggle('is-pending', state.isPending);
		this.domNode.hidden = !label;
	}
}

export function getIndicatorsLabelAriaLabel(state: SettingsTreeIndicatorsState): string {
	return state.isPending ? localize({ bundle: 'ash.settings', key: 'status.savingAria' }, 'Saving setting') : '';
}
