import { h } from '../../../../base/browser/dom.js';
import type { IContextViewProvider } from '../../../../base/browser/ui/contextview/contextview.js';
import { Hover } from '../../../../base/browser/ui/hover/hover.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';

export interface SettingsTreeIndicatorsState {
	readonly isPending: boolean;
	readonly isConfigured: boolean;
	readonly hasPolicyValue?: boolean;
}

let indicatorId = 0;

/** Owns configured and maturity indicators and the row's accessible status. */
export class SettingsTreeIndicatorsLabel extends Disposable {
	public readonly domNode: HTMLSpanElement;
	private readonly markerDomNode: HTMLSpanElement;
	private readonly labelDomNode: HTMLSpanElement;
	private readonly configuredDescription: HTMLSpanElement;
	private readonly hover: Hover;
	private readonly maturityDomNode: HTMLSpanElement;
	private readonly policyDescription: HTMLSpanElement;

	constructor(container: HTMLElement, contextViewProvider: IContextViewProvider, hoverDelay: () => number, configuredText = configuredLabel()) {
		super();
		this.domNode = h(container.ownerDocument, 'span');
		this.domNode.className = 'ash-settings-indicators';
		this.domNode.setAttribute('aria-live', 'polite');
		this.labelDomNode = h(container.ownerDocument, 'span');
		this.labelDomNode.className = 'ash-settings-indicator-label';
		this.domNode.append(this.labelDomNode);
		container.append(this.domNode);
		this.maturityDomNode = h(container.ownerDocument, 'span');
		this.maturityDomNode.id = `ash-settings-maturity-${++indicatorId}`;
		this.maturityDomNode.className = 'ash-settings-maturity';
		this.maturityDomNode.hidden = true;
		container.append(this.maturityDomNode);
		this._register(toDisposable(() => this.maturityDomNode.remove()));
		this.policyDescription = h(container.ownerDocument, 'span');
		this.policyDescription.id = `ash-settings-policy-${++indicatorId}`;
		this.policyDescription.className = 'ash-settings-policy ash-configuration-setting-description';
		this.policyDescription.textContent = policyLabel();
		this.policyDescription.hidden = true;
		container.append(this.policyDescription);
		this._register(toDisposable(() => this.policyDescription.remove()));
		this._register(toDisposable(() => this.domNode.remove()));
		this.configuredDescription = h(container.ownerDocument, 'span');
		this.configuredDescription.id = `ash-settings-configured-${++indicatorId}`;
		this.configuredDescription.className = 'ash-settings-configured-description';
		this.configuredDescription.textContent = configuredText;
		container.append(this.configuredDescription);
		this._register(toDisposable(() => this.configuredDescription.remove()));
		this.markerDomNode = h(container.ownerDocument, 'span');
		this.markerDomNode.className = 'ash-settings-configured-marker';
		this.markerDomNode.setAttribute('aria-hidden', 'true');
		container.append(this.markerDomNode);
		this._register(toDisposable(() => this.markerDomNode.remove()));
		// Sessions supplies its modal ContextView; a window hover would be outside the dialog's top layer.
		this.hover = this._register(new Hover({ target: this.markerDomNode, content: configuredText, contextViewProvider, delayMs: hoverDelay, enabled: () => !this.markerDomNode.hidden }));
	}

	public get configuredDescriptionId(): string {
		return this.configuredDescription.id;
	}

	public get maturityDescriptionId(): string | undefined {
		return this.maturityDomNode.hidden ? undefined : this.maturityDomNode.id;
	}

	public get policyDescriptionId(): string | undefined {
		return this.policyDescription.hidden ? undefined : this.policyDescription.id;
	}

	public updateMetadata(tags: readonly string[] | undefined): void {
		const experimental = tags?.includes('experimental');
		const preview = tags?.includes('preview');
		this.maturityDomNode.hidden = !experimental && !preview;
		this.maturityDomNode.textContent = experimental
			? localize({ bundle: 'ash.settings', key: 'status.experimental' }, 'Experimental')
			: preview ? localize({ bundle: 'ash.settings', key: 'status.preview' }, 'Preview') : '';
		this.maturityDomNode.title = experimental
			? localize({ bundle: 'ash.settings', key: 'status.experimentalDescription' }, 'This feature is experimental and may change or be removed.')
			: preview ? localize({ bundle: 'ash.settings', key: 'status.previewDescription' }, 'This feature is in preview and may change.') : '';
	}

	public update(state: SettingsTreeIndicatorsState): void {
		const label = state.isPending
			? localize({ bundle: 'ash.settings', key: 'status.saving' }, 'Saving…')
			: state.hasPolicyValue ? policyLabel() : '';
		this.labelDomNode.textContent = label;
		this.domNode.setAttribute('aria-label', getIndicatorsLabelAriaLabel(state));
		this.domNode.classList.toggle('is-pending', state.isPending);
		this.domNode.hidden = !label;
		this.markerDomNode.hidden = !state.isConfigured;
		this.configuredDescription.hidden = !state.isConfigured;
		this.policyDescription.hidden = !state.hasPolicyValue;
		if (!state.isConfigured) this.hover.hide();
	}
}

export function getIndicatorsLabelAriaLabel(state: SettingsTreeIndicatorsState): string {
	const labels: string[] = [];
	if (state.isPending) labels.push(localize({ bundle: 'ash.settings', key: 'status.savingAria' }, 'Saving setting'));
	if (state.hasPolicyValue) labels.push(policyLabel());
	return labels.join(' ');
}

function policyLabel(): string {
	return localize({ bundle: 'ash.settings', key: 'status.policy' }, 'Managed by administrator policy. This value cannot be changed here.');
}

function configuredLabel(): string {
	return localize({ bundle: 'ash.settings', key: 'status.configured' }, 'Configured in local user settings.');
}
