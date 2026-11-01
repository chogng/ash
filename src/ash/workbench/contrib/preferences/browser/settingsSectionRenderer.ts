import { SettingsPageRenderer } from './settingsRenderers.js';
import {
	defaultButtonStyles,
	defaultInputBoxStyles,
	defaultSelectBoxStyles,
	defaultToggleStyles,
} from '../../../../platform/theme/browser/defaultStyles.js';
import './media/settingsSection.css';
import './media/settingsCard.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { Switch } from '../../../../base/browser/ui/toggle/toggle.js';
import { Emitter } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewType, type AccessibleViewProviderId, type AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../services/preferences/common/preferences.js';
import type { SettingsSectionReference, SettingsTreeNode } from './settingsTreeModels.js';

/** Renders service-backed sections from data while preserving controls and focus across updates. */
export class SettingsSectionRenderer extends SettingsPageRenderer<SettingsSectionReference> {
	public get categoryId(): string { return this.model.categoryId; }
	public override get settingIds(): readonly string[] | undefined { return this.model.settingIds; }
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly domNode: HTMLElement;
	private readonly titleDomNode: HTMLElement | undefined;
	private readonly descriptionDomNode: HTMLElement | undefined;
	private readonly fieldsDomNode: HTMLElement;
	private readonly controls = new Map<string, Button | InputBox | SelectBox | Switch | HTMLElement>();
	private readonly actionsDomNode: HTMLElement;
	private readonly fields = new Map<string, SettingsSectionField>();
	private isVisible = false;
	private pendingFocus: HTMLElement | undefined;

	constructor(container: HTMLElement, private readonly model: SettingsSectionModel, providerId: AccessibleViewProviderId, verbosity: AccessibilityVerbositySettingId,
		@IContextViewService private readonly contextView: IContextViewService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div'); this.domNode.className = 'ash-settings-section';
		if (model.itemId) { this.domNode.dataset.settingsItemId = model.itemId; }
		if (model.groupId === null) {
			this.domNode.classList.add('ash-settings-card-section');
			this.titleDomNode = h(document, 'h4');
			this.titleDomNode.className = 'ash-settings-card-title';
			this.titleDomNode.id = `settingsSectionTitle-${generateUuid()}`;
			this.domNode.setAttribute('role', 'group');
			this.domNode.setAttribute('aria-labelledby', this.titleDomNode.id);
			this.fieldsDomNode = h(document, 'div');
			this.fieldsDomNode.className = 'ash-settings-card';
			this.domNode.append(this.titleDomNode, this.fieldsDomNode);
		} else {
			if (!model.hideInnerTitle) {
				this.titleDomNode = h(document, 'h5');
				this.domNode.append(this.titleDomNode);
			}
			this.descriptionDomNode = h(document, 'p');
			this.domNode.append(this.descriptionDomNode);
			this.fieldsDomNode = this.domNode;
		}
		this.actionsDomNode = h(document, 'div'); this.actionsDomNode.className = 'ash-settings-section-actions';
		this._register(model.onDidChange(() => {
			const focused = document.activeElement;
			if (isHTMLElement(focused) && this.domNode.contains(focused)) { this.pendingFocus = focused; }
			this.render();
			this.changed.fire();
			// Saving disables controls; rebuilding the settings tree can detach them.
			// Return focus once usable, without taking it from another control.
			if (document.activeElement === document.body && this.pendingFocus?.isConnected && !this.pendingFocus.matches(':disabled')) {
				this.pendingFocus.focus();
			}
			if (document.activeElement !== document.body && (document.activeElement !== this.pendingFocus || !this.pendingFocus?.matches(':disabled'))) {
				this.pendingFocus = undefined;
			}
		}));
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

	protected override buildNodes(): readonly SettingsTreeNode<SettingsSectionReference>[] {
		this.render();
		const item: SettingsTreeNode<SettingsSectionReference> = { element: { kind: 'item', id: this.model.itemId ?? `${this.categoryId}.section`, title: this.model.title, description: this.model.description, keywords: [this.categoryId, ...this.model.keywords ?? [], ...this.model.fields.flatMap(field => field.kind === 'status' ? [] : [field.label])], value: this.retainElement(this.model.itemId ?? `${this.categoryId}.section`, this.domNode) } };
		if (this.model.groupId === null) { return [item]; }
		return [{ element: { kind: 'group', id: this.model.groupId ?? `${this.categoryId}.services`, title: this.model.groupTitle ?? this.model.title, description: '' }, children: [item] }];
	}

	public setVisible(visible: boolean): void {
		this.isVisible = visible;
		this.model.setVisible(visible);
		if (!visible) {
			this.pendingFocus = undefined;
			for (const control of this.controls.values()) { if (control instanceof SelectBox) { control.hide(); } }
		}
	}

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
		if (this.titleDomNode) { this.titleDomNode.textContent = this.model.title; }
		if (this.descriptionDomNode) { this.descriptionDomNode.textContent = this.model.description; }
		for (const field of this.model.fields) {
			this.fields.set(field.id, field);
			let control = this.controls.get(field.id);
			if (!control) {
				let container = this.fieldsDomNode;
				let copy = container;
				if (this.model.groupId === null && field.kind !== 'status' && field.kind !== 'action') {
					container = h(this.domNode.ownerDocument, 'div');
					container.className = 'ash-settings-field-row';
					copy = h(this.domNode.ownerDocument, 'div');
					copy.className = 'ash-settings-field-copy';
					container.append(copy);
					this.fieldsDomNode.append(container);
					if (field.description) {
						const description = h(this.domNode.ownerDocument, 'p');
						description.className = 'ash-settings-field-description';
						description.textContent = field.description;
						description.id = `settingsFieldDescription-${generateUuid()}`;
						copy.append(description);
						container.setAttribute('role', 'group');
						container.setAttribute('aria-describedby', description.id);
					}
				}
				if (field.kind === 'status') {
					control = h(this.domNode.ownerDocument, 'p');
					control.className = 'ash-settings-section-status';
					control.setAttribute('role', 'status');
					control.setAttribute('aria-live', 'polite');
					this.fieldsDomNode.append(control);
				} else if (field.kind === 'text') {
					const label = h(this.domNode.ownerDocument, 'label');
					label.textContent = field.label;
					if (copy === container) {
						copy.append(label);
					} else {
						copy.prepend(label);
					}
					const input = this._register(new InputBox(container, {
						inputBoxStyles: defaultInputBoxStyles,
						ariaLabel: field.label,
						placeholder: field.placeholder,
						presentation: 'field',
					}));
					input.inputElement.id = `settingsField-${generateUuid()}`;
					label.htmlFor = input.inputElement.id;
					// InputBox also emits when the renderer restores a saved value. Only a
					// value different from the model is a user edit, otherwise a read dirties the draft.
					this._register(input.onDidChange(value => { const current = this.fields.get(field.id); if (current?.kind === 'text' && current.value !== value) { current.setValue(value); } })); control = input;
				} else if (field.kind === 'boolean') {
					const standalone = this.model.groupId === null;
					const toggle = this._register(new Switch(container, {
						...defaultToggleStyles,
						label: standalone ? undefined : field.label,
						ariaLabel: field.label,
					}));
					if (standalone) {
						const label = h(this.domNode.ownerDocument, 'label');
						label.textContent = field.label;
						toggle.input.id = `settingsField-${generateUuid()}`;
						label.htmlFor = toggle.input.id;
						copy.prepend(label);
					}
					this._register(toggle.onDidChange(value => { const current = this.fields.get(field.id); if (current?.kind === 'boolean') { current.setValue(value); } }));
					control = toggle;
				} else if (field.kind === 'select') {
					const label = h(this.domNode.ownerDocument, 'p');
					label.textContent = field.label;
					if (copy === container) {
						copy.append(label);
					} else {
						copy.prepend(label);
					}
					const select = this._register(new SelectBox(container, {
						options: field.options, ariaLabel: field.label, contextViewProvider: this.contextView
					}, defaultSelectBoxStyles));
					this._register(select.onDidSelect(({ value }) => { const current = this.fields.get(field.id); if (current?.kind === 'select') { current.setValue(value); } })); control = select;
				} else {
					if (!this.actionsDomNode.isConnected) { this.fieldsDomNode.append(this.actionsDomNode); }
					const button = this._register(new Button(this.actionsDomNode, {
						...defaultButtonStyles,
						label: field.label,
						presentation: 'secondary',
					}));
					this._register(button.onDidClick(() => { const current = this.fields.get(field.id); if (current?.kind === 'action' && current.enabled) { void current.run(); } })); control = button;
				}
				if (copy !== container && copy.firstElementChild) {
					copy.firstElementChild.id = `settingsFieldLabel-${generateUuid()}`;
					container.setAttribute('aria-labelledby', copy.firstElementChild.id);
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
