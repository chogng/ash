import { h } from '../../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { Switch } from '../../../../../../../base/browser/ui/toggle/toggle.js';
import { Disposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { ModelPreferencesUpdate } from '../../../../../../../platform/sessions/common/sessionApi.js';
import { localize } from '../../../../../../../nls.js';
import type { ModelAccelerationOption, ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

export interface IModelCardOptions {
	readonly entry: ModelCatalogEntry;
	readonly setPreferences: (update: ModelPreferencesUpdate) => Promise<void>;
}

/** Configures provider-owned model preferences while retaining the focused switch across catalog refreshes. */
export class ModelCard extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly accelerationControls = this._register(new DisposableMap<string, AccelerationControl>());
	private readonly resetAcceleration = this._register(new MutableDisposable<Button>());
	private readonly context: Switch;
	private readonly contextRow: HTMLElement;
	private readonly contextLabelDomNode: HTMLElement;
	private readonly errorDomNode: HTMLElement;
	private options: IModelCardOptions | undefined;
	private isSaving = false;

	constructor(ownerDocument: Document) {
		super();
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-chat-model-card';
		this.domNode.tabIndex = -1;
		this.contextRow = h(ownerDocument, 'div');
		this.contextRow.className = 'ash-chat-model-card-context';
		this.domNode.append(this.contextRow);
		this.contextLabelDomNode = h(ownerDocument, 'span');
		this.context = this._register(new Switch(this.contextRow, {
			content: this.contextLabelDomNode,
			ariaLabel: localize('chat.modelPicker.longContext', 'Long context'),
			contentPlacement: 'before-control',
		}));
		this.errorDomNode = h(ownerDocument, 'p');
		this.errorDomNode.className = 'ash-chat-model-card-error';
		this.errorDomNode.setAttribute('role', 'status');
		this.errorDomNode.hidden = true;
		this.domNode.append(this.errorDomNode);
		this._register(this.context.onDidChange(longContext => { void this.save({ longContext }); }));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public update(options: IModelCardOptions): void {
		this.options = options;
		this.domNode.setAttribute('aria-label', options.entry.displayName);
		this.render();
	}

	public focus(): void {
		const first = [...this.accelerationControls].map(([, control]) => control).find(control => control.toggle.enabled);
		if (first) { first.toggle.focus(); }
		else if (this.resetAcceleration.value) { this.resetAcceleration.value.domNode.focus(); }
		else if (this.context.enabled && !this.contextRow.hidden) { this.context.focus(); }
		else { this.domNode.focus(); }
	}

	private render(): void {
		const entry = this.options!.entry;
		const canExpand = entry.longContext !== null;
		const label = localize('chat.modelPicker.longContext', 'Long context');
		const options = entry.accelerationOptions ?? [];
		for (const [id] of this.accelerationControls) {
			if (!options.some(option => option.id === id)) { this.accelerationControls.deleteAndDispose(id); }
		}
		let position: ChildNode | null = this.domNode.firstChild;
		for (const option of options) {
			let control = this.accelerationControls.get(option.id);
			if (!control) {
				control = new AccelerationControl(this.domNode, checked => { void this.save({ acceleration: checked ? option.id : null }); });
				this.accelerationControls.set(option.id, control);
			}
			control.update(option, entry.selectedAcceleration === option.id, this.isSaving);
			// Moving a focused input drops focus in Chromium even when its owner is retained.
			for (const element of [control.toggle.element, control.descriptionDomNode]) {
				if (element !== position) { this.domNode.insertBefore(element, position); }
				position = element.nextSibling;
			}
		}
		if (entry.selectedAcceleration && !options.some(option => option.id === entry.selectedAcceleration)) {
			if (!this.resetAcceleration.value) {
				this.resetAcceleration.value = new Button(this.domNode, {
					label: localize('chat.modelPicker.resetAcceleration', 'Turn off acceleration'),
					onClick: () => { void this.save({ acceleration: null }); },
				});
				this.domNode.insertBefore(this.resetAcceleration.value.domNode, this.contextRow);
			}
			this.resetAcceleration.value.enabled = !this.isSaving;
		} else { this.resetAcceleration.clear(); }
		this.context.checked = entry.longContext === true;
		this.context.setAriaLabel(label);
		this.context.input.setAttribute('aria-description', localize('chat.modelPicker.longContextHelp', 'Off by default. Turn on to use the maximum context capacity of the current model connection.'));
		this.context.enabled = canExpand && !this.isSaving;
		this.context.busy = this.isSaving;
		this.contextLabelDomNode.textContent = canExpand ? label : '';
		this.contextRow.hidden = !canExpand;
	}

	private async save(update: ModelPreferencesUpdate): Promise<void> {
		if (this.isSaving) { this.render(); return; }
		const focusedInput = [...[...this.accelerationControls].map(([, control]) => control.toggle.input), this.context.input, this.resetAcceleration.value?.domNode].find(input => input === this.domNode.ownerDocument.activeElement);
		this.isSaving = true;
		this.domNode.setAttribute('aria-busy', 'true');
		this.errorDomNode.hidden = true;
		this.render();
		try {
			await this.options!.setPreferences(update);
		} catch {
			if (this.isDisposed) { return; }
			this.errorDomNode.textContent = localize('chat.modelPicker.preferencesFailed', 'Could not update model settings');
			this.errorDomNode.hidden = false;
		} finally {
			if (!this.isDisposed) {
				this.isSaving = false;
				this.domNode.removeAttribute('aria-busy');
				this.render();
				// Busy switches release focus; do not steal it if the user moved to another control.
				if (focusedInput && this.domNode.ownerDocument.activeElement === this.domNode.ownerDocument.body) { if (focusedInput.isConnected) { focusedInput.focus(); } else { this.focus(); } }
			}
		}
	}
}

/** Retains each option's focus and owns the switch and its explanatory text together. */
class AccelerationControl extends Disposable {
	public readonly toggle: Switch;
	public readonly descriptionDomNode: HTMLElement;
	private readonly labelDomNode: HTMLElement;

	constructor(container: HTMLElement, changed: (checked: boolean) => void) {
		super();
		this.labelDomNode = h(container.ownerDocument, 'span');
		this.toggle = this._register(new Switch(container, { content: this.labelDomNode, ariaLabel: '', contentPlacement: 'before-control' }));
		this.descriptionDomNode = h(container.ownerDocument, 'p');
		this.descriptionDomNode.className = 'ash-chat-model-card-description';
		container.append(this.descriptionDomNode);
		this._register(this.toggle.onDidChange(changed));
		this._register(toDisposable(() => { this.toggle.element.remove(); this.descriptionDomNode.remove(); }));
	}

	public update(option: ModelAccelerationOption, selected: boolean, busy: boolean): void {
		const name = localizeModelOption(option.name);
		const description = localizeModelOption(option.description);
		this.labelDomNode.textContent = name;
		this.toggle.setAriaLabel(name);
		this.toggle.input.setAttribute('aria-description', description);
		this.descriptionDomNode.textContent = description;
		this.descriptionDomNode.hidden = description.length === 0;
		this.toggle.checked = selected;
		this.toggle.enabled = !busy;
		this.toggle.busy = busy;
	}
}

// Translate Ash-owned catalog copy; text supplied by a custom provider retains its own wording.
function localizeModelOption(value: string): string {
	switch (value) {
		case 'Ultra Fast': return localize('chat.modelPicker.ultrafast', 'Ultra Fast');
		case 'Fast': return localize('chat.modelPicker.fast', 'Fast');
		case 'Faster responses, increased usage': return localize('chat.modelPicker.fasterUsage', 'Faster responses, increased usage');
		case 'Priority processing, increased usage': return localize('chat.modelPicker.priorityUsage', 'Priority processing, increased usage');
		case 'Uses a separate high-speed model, increased usage': return localize('chat.modelPicker.highspeedUsage', 'Uses a separate high-speed model, increased usage');
		default: return value;
	}
}
