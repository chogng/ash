import { h } from '../../../../../../../base/browser/dom.js';
import { Switch } from '../../../../../../../base/browser/ui/toggle/toggle.js';
import { Disposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { ModelPreferencesUpdate } from '../../../../../../../platform/sessions/common/sessionApi.js';
import { localize } from '../../../../../../../nls.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

export interface IModelCardOptions {
	readonly entry: ModelCatalogEntry;
	readonly setPreferences: (update: ModelPreferencesUpdate) => Promise<void>;
}

/** Configures provider-owned model preferences while retaining the focused switch across catalog refreshes. */
export class ModelCard extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly fast: Switch;
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
		this.fast = this._register(new Switch(this.domNode, {
			label: localize('chat.modelPicker.fast', 'Fast'),
			ariaLabel: localize('chat.modelPicker.fast', 'Fast'),
			contentPlacement: 'before-control',
		}));
		this.contextRow = h(ownerDocument, 'div');
		this.contextRow.className = 'ash-chat-model-card-context';
		this.domNode.append(this.contextRow);
		this.contextLabelDomNode = h(ownerDocument, 'span');
		this.context = this._register(new Switch(this.contextRow, {
			content: this.contextLabelDomNode,
			ariaLabel: localize('chat.modelPicker.largeContext', '1M context'),
			contentPlacement: 'before-control',
		}));
		this.errorDomNode = h(ownerDocument, 'p');
		this.errorDomNode.className = 'ash-chat-model-card-error';
		this.errorDomNode.setAttribute('role', 'status');
		this.errorDomNode.hidden = true;
		this.domNode.append(this.errorDomNode);
		this._register(this.fast.onDidChange(fast => { void this.save({ fast }); }));
		this._register(this.context.onDidChange(large => { void this.save({ contextWindow: large ? 1_000_000 : 272_000 }); }));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public update(options: IModelCardOptions): void {
		this.options = options;
		this.domNode.setAttribute('aria-label', options.entry.displayName);
		this.render();
	}

	public focus(): void {
		if (this.fast.enabled) { this.fast.focus(); }
		else if (this.context.enabled && !this.contextRow.hidden) { this.context.focus(); }
		else { this.domNode.focus(); }
	}

	private render(): void {
		const entry = this.options!.entry;
		const canExpand = (entry.maximumContextWindow ?? 0) >= 1_000_000;
		const capacity = entry.contextWindow;
		const label = capacity ? (capacity >= 1_000_000 ? `${Number((capacity / 1_000_000).toFixed(2))}M` : `${Number((capacity / 1_000).toFixed(1))}k`) : '';
		this.fast.checked = entry.fast === true;
		this.fast.enabled = entry.supportsFast === true && !this.isSaving;
		this.fast.busy = this.isSaving;
		this.context.checked = (capacity ?? 0) >= 1_000_000;
		this.context.enabled = canExpand && !this.isSaving;
		this.context.busy = this.isSaving;
		this.contextLabelDomNode.textContent = canExpand ? label : '';
		this.contextRow.hidden = !canExpand || !capacity;
	}

	private async save(update: ModelPreferencesUpdate): Promise<void> {
		if (this.isSaving) { this.render(); return; }
		const focusedInput = [this.fast.input, this.context.input].find(input => input === this.domNode.ownerDocument.activeElement);
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
				if (focusedInput && this.domNode.ownerDocument.activeElement === this.domNode.ownerDocument.body) { focusedInput.focus(); }
			}
		}
	}
}
