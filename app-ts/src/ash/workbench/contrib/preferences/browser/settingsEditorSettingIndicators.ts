import { h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';

export interface SettingsTreeIndicatorsState {
	readonly isModified: boolean;
	readonly isPending: boolean;
}

/** Projects persistent Settings state into a stable visible and accessible label. */
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
		const label = state.isPending ? 'Saving…' : state.isModified ? 'Modified' : '';
		this.labelDomNode.textContent = label;
		this.domNode.setAttribute('aria-label', getIndicatorsLabelAriaLabel(state));
		this.domNode.classList.toggle('is-modified', state.isModified);
		this.domNode.classList.toggle('is-pending', state.isPending);
		this.domNode.hidden = !label;
	}
}

export function getIndicatorsLabelAriaLabel(state: SettingsTreeIndicatorsState): string {
	return state.isPending ? 'Saving setting' : state.isModified ? 'Setting has been modified' : '';
}
