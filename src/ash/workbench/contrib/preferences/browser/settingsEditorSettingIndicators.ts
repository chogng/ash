import { h } from '../../../../base/browser/dom.js';
import type { IContextViewProvider } from '../../../../base/browser/ui/contextview/contextview.js';
import { Hover } from '../../../../base/browser/ui/hover/hover.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

export interface SettingsTreeIndicatorsState {
	readonly isPending: boolean;
	readonly isConfigured: boolean;
}

let indicatorId = 0;

/** Owns the configured marker, its hover, and the row's accessible status. */
export class SettingsTreeIndicatorsLabel extends Disposable {
	public readonly domNode: HTMLSpanElement;
	private readonly markerDomNode: HTMLSpanElement;
	private readonly labelDomNode: HTMLSpanElement;
	private readonly configuredDescription: HTMLSpanElement;
	private readonly hover: Hover;

	constructor(container: HTMLElement, contextViewProvider: IContextViewProvider, hoverDelay: () => number) {
		super();
		this.domNode = h(container.ownerDocument, 'span');
		this.domNode.className = 'ash-settings-indicators';
		this.domNode.setAttribute('aria-live', 'polite');
		this.labelDomNode = h(container.ownerDocument, 'span');
		this.labelDomNode.className = 'ash-settings-indicator-label';
		this.domNode.append(this.labelDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.configuredDescription = h(container.ownerDocument, 'span');
		this.configuredDescription.id = `ash-settings-configured-${++indicatorId}`;
		this.configuredDescription.className = 'ash-settings-configured-description';
		this.configuredDescription.textContent = configuredLabel();
		container.append(this.configuredDescription);
		this._register(toDisposable(() => this.configuredDescription.remove()));
		this.markerDomNode = h(container.ownerDocument, 'span');
		this.markerDomNode.className = 'ash-settings-configured-marker';
		this.markerDomNode.setAttribute('aria-hidden', 'true');
		container.append(this.markerDomNode);
		this._register(toDisposable(() => this.markerDomNode.remove()));
		// Sessions supplies its modal ContextView; a window hover would be outside the dialog's top layer.
		this.hover = this._register(new Hover({ target: this.markerDomNode, content: configuredLabel(), contextViewProvider, delayMs: hoverDelay, enabled: () => !this.markerDomNode.hidden }));
	}

	public get configuredDescriptionId(): string {
		return this.configuredDescription.id;
	}

	public update(state: SettingsTreeIndicatorsState): void {
		const label = state.isPending ? localize({ bundle: 'ash.settings', key: 'status.saving' }, 'Saving…') : '';
		this.labelDomNode.textContent = label;
		this.domNode.setAttribute('aria-label', getIndicatorsLabelAriaLabel(state));
		this.domNode.classList.toggle('is-pending', state.isPending);
		this.domNode.hidden = !label;
		this.markerDomNode.hidden = !state.isConfigured;
		this.configuredDescription.hidden = !state.isConfigured;
		if (!state.isConfigured) this.hover.hide();
	}
}

export function getIndicatorsLabelAriaLabel(state: SettingsTreeIndicatorsState): string {
	return state.isPending ? localize({ bundle: 'ash.settings', key: 'status.savingAria' }, 'Saving setting') : '';
}

function configuredLabel(): string {
	return localize({ bundle: 'ash.settings', key: 'status.configured' }, 'Configured in local user settings.');
}
