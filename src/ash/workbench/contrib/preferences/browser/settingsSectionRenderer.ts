import './media/settingsSection.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { Switch } from '../../../../base/browser/ui/toggle/toggle.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewType, type AccessibleViewProviderId, type AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import type { ISetting } from '../../../services/preferences/common/preferences.js';
import type { SettingsContent, SettingsContentItem, SettingsSectionField, SettingsSectionModel, SettingsTreeNode } from './settingsTreeModels.js';

/** Renders service-backed sections from data while preserving controls and focus across updates. */
export class SettingsSectionRenderer extends Disposable implements SettingsContent {
	public get categoryId(): string { return this.model.categoryId; }
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly domNode: HTMLElement;
	private readonly titleDomNode: HTMLElement;
	private readonly descriptionDomNode: HTMLElement;
	private readonly controls = new Map<string, Button | InputBox | SelectBox | Switch | HTMLElement>();
	private readonly actionsDomNode: HTMLElement;
	private readonly fields = new Map<string, SettingsSectionField>();
	private isVisible = false;

	constructor(container: HTMLElement, private readonly model: SettingsSectionModel, providerId: AccessibleViewProviderId, verbosity: AccessibilityVerbositySettingId,
		@IContextViewService private readonly contextView: IContextViewService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div'); this.domNode.className = 'ash-settings-section';
		this.titleDomNode = h(document, 'h5'); this.descriptionDomNode = h(document, 'p'); this.domNode.append(this.titleDomNode, this.descriptionDomNode);
		this.actionsDomNode = h(document, 'div'); this.actionsDomNode.className = 'ash-settings-section-actions';
		this._register(model.onDidChange(() => { this.render(); this.changed.fire(); }));
		const key = `settingsSection-${generateUuid()}`;
		const scope = this._register(contextKeys.createScoped(this.domNode)); scope.createKey(key, true);
		const updateHint = (): void => {
			const hint = accessibleView.getOpenAriaHint(verbosity);
			if (hint) { this.domNode.setAttribute('aria-description', hint); } else { this.domNode.removeAttribute('aria-description'); }
		};
		this._register(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(verbosity)) { updateHint(); } }));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 110, name: `${key}-${type}`, when: ContextKeyExpr.has(key),
				getProvider: () => {
					const focused = document.activeElement;
					if (!this.isVisible || !isHTMLElement(focused) || !this.domNode.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(providerId, { type },
						() => type === AccessibleViewType.Help ? model.help : this.accessibleContent(),
						() => { if (focused.isConnected) { focused.focus(); } }, verbosity);
				},
			}));
		}
		updateHint();
		this._register(toDisposable(() => { this.model.setVisible(false); this.domNode.remove(); }));
	}

	public getNodes(): readonly SettingsTreeNode<ISetting | SettingsContentItem>[] {
		this.render();
		return [{ element: { kind: 'group', id: `${this.categoryId}.services`, title: this.model.title, description: '' }, children: [{ element: { kind: 'item', id: `${this.categoryId}.section`, title: this.model.title, description: this.model.description, keywords: [this.categoryId, ...this.model.fields.flatMap(field => field.kind === 'status' ? [] : [field.label])], value: { domNode: this.domNode } } }] }];
	}

	public setVisible(visible: boolean): void { this.isVisible = visible; this.model.setVisible(visible); }

	private accessibleContent(): string {
		const content = this.model.fields.map(field => {
			switch (field.kind) {
				case 'status': return field.text;
				case 'action': return field.label;
				case 'text': return `${field.label}: ${field.value}`;
				case 'select': return `${field.label}: ${field.options.find(option => option.value === field.value)?.label ?? ''}`;
				case 'boolean': return `${field.label}: ${field.value
					? localize({ bundle: 'ash.settings', key: 'section.on' }, 'On')
					: localize({ bundle: 'ash.settings', key: 'section.off' }, 'Off')}`;
			}
		});
		return [this.model.title, this.model.description, ...content].join('\n');
	}

	private render(): void {
		this.titleDomNode.textContent = this.model.title; this.descriptionDomNode.textContent = this.model.description;
		for (const field of this.model.fields) {
			this.fields.set(field.id, field);
			let control = this.controls.get(field.id);
			if (!control) {
				if (field.kind === 'status') {
					control = h(this.domNode.ownerDocument, 'p'); control.setAttribute('role', 'status'); control.setAttribute('aria-live', 'polite'); this.domNode.append(control);
				} else if (field.kind === 'text') {
					const label = h(this.domNode.ownerDocument, 'label');
					label.textContent = field.label;
					this.domNode.append(label);
					const input = this._register(new InputBox(this.domNode, { ariaLabel: field.label, placeholder: field.placeholder, presentation: 'field' }));
					input.inputElement.id = `settingsField-${generateUuid()}`;
					label.htmlFor = input.inputElement.id;
					// InputBox also emits when the renderer restores a saved value. Only a
					// value different from the model is a user edit, otherwise a read dirties the draft.
					this._register(input.onDidChange(value => { const current = this.fields.get(field.id); if (current?.kind === 'text' && current.value !== value) { current.setValue(value); } })); control = input;
				} else if (field.kind === 'boolean') {
					const toggle = this._register(new Switch(this.domNode, { label: field.label, ariaLabel: field.label }));
					this._register(toggle.onDidChange(value => { const current = this.fields.get(field.id); if (current?.kind === 'boolean') { current.setValue(value); } }));
					control = toggle;
				} else if (field.kind === 'select') {
					const select = this._register(new SelectBox(this.domNode, { options: field.options, ariaLabel: field.label, contextViewProvider: this.contextView }));
					this._register(select.onDidSelect(({ value }) => { const current = this.fields.get(field.id); if (current?.kind === 'select') { current.setValue(value); } })); control = select;
				} else {
					if (!this.actionsDomNode.isConnected) { this.domNode.append(this.actionsDomNode); }
					const button = this._register(new Button(this.actionsDomNode, { label: field.label, presentation: 'secondary' }));
					this._register(button.onDidClick(() => { const current = this.fields.get(field.id); if (current?.kind === 'action' && current.enabled) { void current.run(); } })); control = button;
				}
				this.controls.set(field.id, control);
			}
			if (field.kind === 'status' && isHTMLElement(control)) { if (control.textContent !== field.text) { control.textContent = field.text; } }
			else if (field.kind === 'text' && control instanceof InputBox) { control.value = field.value; control.enabled = field.enabled; }
			else if (field.kind === 'boolean' && control instanceof Switch) { control.checked = field.value; control.enabled = field.enabled; }
			else if (field.kind === 'select' && control instanceof SelectBox) { if (JSON.stringify(control.options) !== JSON.stringify(field.options)) { control.setOptions(field.options); } control.value = field.value; control.enabled = field.enabled; }
			else if (field.kind === 'action' && control instanceof Button) { control.label = field.label; control.enabled = field.enabled; }
		}
	}
}
