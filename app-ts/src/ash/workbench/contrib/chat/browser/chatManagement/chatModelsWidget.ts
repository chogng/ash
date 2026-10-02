import './media/chatModelsWidget.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox } from '../../../../../base/browser/ui/selectbox/selectbox.js';
import { Switch } from '../../../../../base/browser/ui/toggle/toggle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { CustomModelProvider, ModelProviderApiFormat } from '../../../../../platform/sessions/common/sessionApi.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { ChatModelsViewModel, type ProviderModelItem } from './chatModelsViewModel.js';

// A stored credential is represented by a mask, never retrieved into the settings renderer.
const SavedKeyMask = '••••••••';

export class ProviderApiKeyInput extends Disposable {
	public readonly input: InputBox;
	private dirty = false;
	private saving: Promise<void> | undefined;
	private allowed = true;

	constructor(container: HTMLElement, private readonly connection: string, name: string, configured: boolean, private readonly beforeSave: () => Promise<void>, @ILanguageModelsService private readonly chat: ILanguageModelsService, @INotificationService private readonly notifications: INotificationService) {
		super();
		this.input = this._register(new InputBox(container, {
			type: 'password', presentation: 'field',
			placeholder: localize('chat.providerKeys.inputPlaceholder', 'Paste an API key'),
			ariaLabel: localize('chat.providerKeys.inputTitle', 'API key for {0}', name),
		}));
		this.input.value = configured ? SavedKeyMask : '';
		this._register(this.input.onDidChange(() => { this.dirty = true; }));
		this._register(this.input.onDidBlur(() => { void this.save().catch(error => { if (!this.isDisposed) { this.notifications.error(localize('models.keys.saveError', 'Could not update API key: {0}', error instanceof Error ? error.message : String(error))); } }); }));
		this._register(this.input.onKeyDown(event => {
			if (event.key === 'Enter') { event.preventDefault(); this.input.inputElement.blur(); }
		}));
	}

	public setEnabled(enabled: boolean): void {
		this.allowed = enabled;
		this.input.enabled = enabled && !this.saving;
	}

	public updateConfigured(configured: boolean): void {
		if (this.dirty || this.saving || this.input.hasFocus()) { return; }
		this.input.value = configured ? SavedKeyMask : '';
		this.dirty = false;
	}

	public save(): Promise<void> {
		if (this.saving) { return this.saving; }
		if (!this.dirty) { return Promise.resolve(); }
		const operation = Promise.resolve().then(() => this.saveKey());
		this.saving = operation;
		void operation.finally(() => { this.saving = undefined; }).catch(() => {});
		return operation;
	}

	private async saveKey(): Promise<void> {
		const key = this.input.value.trim();
		this.input.enabled = false;
		try {
			await this.beforeSave();
			if (key) {
				await this.chat.setModelProviderApiKey(this.connection, key);
			} else {
				await this.chat.removeModelProviderApiKey(this.connection);
			}
			this.input.value = key ? SavedKeyMask : '';
			this.dirty = false;
			this.input.showValidation('');
			await this.chat.refreshModels();
		} catch (error) {
			this.input.showValidation(this.dirty
				? localize('models.keys.saveFailed', 'Could not save API key. Change the field or leave it again to retry.')
				: localize('chat.providerKeys.refreshFailed', 'API key saved, but models could not be refreshed'));
			throw error;
		} finally {
			this.input.enabled = this.allowed;
		}
	}
}

/** Owns the provider form and table DOM; the view model owns declarations and test progress. */
export class ChatModelsWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly viewModel: ChatModelsViewModel;
	private readonly name: InputBox;
	private readonly baseUrl: InputBox;
	private readonly key: ProviderApiKeyInput;
	private readonly format: SelectBox;
	private readonly modelBody: HTMLElement;
	private readonly feedback: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly test: Button;
	private readonly refresh: Button;
	private readonly add: Button;
	private readonly editor: HTMLElement;
	private readonly modelId: InputBox;
	private readonly contextWindow: InputBox;
	private readonly upstreamModel: InputBox;
	private readonly largeContext: Switch;
	private readonly saveModel: Button;
	private readonly cancel: Button;
	private readonly tableResources = this._register(new DisposableStore());
	private readonly rowControls = new Map<string, { toggle: Switch; status: HTMLElement; edit: Button; remove?: Button }>();
	private structure = '';
	private editing = false;
	private savingModel = false;

	constructor(document: Document, provider: CustomModelProvider, configured: boolean, private readonly isNew: boolean,
		@IContextViewService contextView: IContextViewService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.viewModel = this._register(instantiation.createInstance(ChatModelsViewModel, provider, this.isNew));
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-chat-models-widget';
		this.domNode.dataset.providerId = provider.id;
		this.name = this.textField(localize('models.provider.name', 'Provider name'), provider.name);
		this.baseUrl = this.textField(localize('models.provider.baseUrl', 'Base URL'), provider.baseUrl);
		this.key = this._register(instantiation.createInstance(ProviderApiKeyInput, this.field(localize('models.keys.title', 'API key')), provider.id, provider.name || localize('models.provider.new', 'New provider'), configured, () => this.saveProvider()));
		this.format = this._register(new SelectBox(this.field(localize('models.provider.apiFormat', 'API format')), {
			presentation: 'field', selectedValue: provider.apiFormat, contextViewProvider: contextView,
			ariaLabel: localize('models.provider.apiFormat', 'API format'),
			options: [
				{ value: 'responses', label: 'OpenAI Responses' },
				{ value: 'chatCompletions', label: 'OpenAI Chat Completions' },
				{ value: 'anthropicMessages', label: 'Anthropic Messages' },
			],
		}));
		this._register(this.format.onDidSelect(() => this.saveInBackground()));
		const toolbar = h(document, 'div');
		toolbar.className = 'ash-chat-models-toolbar';
		const title = h(document, 'span');
		title.textContent = localize('sessions.settings.models', 'Models');
		const actions = h(document, 'div');
		actions.className = 'ash-chat-models-actions';
		toolbar.append(title, actions);
		this.refresh = this._register(new Button(actions, { label: localize('models.provider.refresh', 'Refresh models'), icon: Lxicon.refresh, iconOnly: true, presentation: 'quiet' }));
		this.add = this._register(new Button(actions, { label: localize('models.provider.addModel', 'Add model'), presentation: 'quiet' }));
		this.test = this._register(new Button(actions, { label: localize('models.provider.testModels', 'Test models'), presentation: 'secondary' }));
		const table = h(document, 'table');
		table.className = 'ash-chat-models-table';
		table.setAttribute('aria-label', localize('models.provider.models', 'Provider models'));
		const head = h(document, 'thead');
		const headings = h(document, 'tr');
		for (const label of [localize('models.provider.modelName', 'Model name'), localize('models.provider.status', 'Status'), localize('models.provider.actions', 'Actions'), localize('models.provider.enabled', 'Enabled')]) {
			const cell = h(document, 'th');
			cell.scope = 'col';
			cell.textContent = label;
			headings.append(cell);
		}
		head.append(headings);
		this.modelBody = h(document, 'tbody');
		table.append(head, this.modelBody);
		this.empty = h(document, 'p');
		this.empty.className = 'ash-chat-models-note';
		this.empty.textContent = localize('models.provider.notLoaded', 'Test models fetches the endpoint list when this table is empty.');
		this.editor = h(document, 'div');
		this.editor.className = 'ash-chat-models-editor';
		this.editor.hidden = true;
		this.modelId = this._register(new InputBox(this.editor, { presentation: 'field', ariaLabel: localize('models.provider.modelId', 'Model ID'), placeholder: localize('models.provider.modelId', 'Model ID') }));
		this.upstreamModel = this._register(new InputBox(this.editor, { presentation: 'field', ariaLabel: localize('models.provider.upstreamModel', 'Upstream Model ID (optional)'), placeholder: localize('models.provider.upstreamModel', 'Upstream Model ID (optional)') }));
		this.contextWindow = this._register(new InputBox(this.editor, { type: 'number', presentation: 'field', ariaLabel: localize('models.provider.contextWindow', 'Context window (tokens)'), placeholder: localize('models.provider.contextWindow', 'Context window (tokens)') }));
		this.largeContext = this._register(new Switch(this.editor, { checked: false, label: localize('models.provider.context', '1M context'), ariaLabel: localize('models.provider.context', '1M context') }));
		const editorActions = h(document, 'div');
		editorActions.className = 'ash-chat-models-actions';
		this.saveModel = this._register(new Button(editorActions, { label: localize('models.provider.saveModel', 'Save model'), presentation: 'secondary' }));
		this.cancel = this._register(new Button(editorActions, { label: localize('models.provider.cancel', 'Cancel'), presentation: 'quiet' }));
		this.editor.append(editorActions);
		this.feedback = h(document, 'p');
		this.feedback.className = 'ash-chat-models-note';
		this.feedback.setAttribute('role', 'status');
		this.domNode.append(toolbar, table, this.empty, this.editor, this.feedback);
		this._register(this.add.onDidClick(() => this.openEditor()));
		this._register(this.cancel.onDidClick(() => this.closeEditor()));
		this._register(this.largeContext.onDidChange(() => {
			if (this.largeContext.checked) { this.contextWindow.value = '1000000'; }
			this.contextWindow.enabled = !this.largeContext.checked;
		}));
		this._register(this.saveModel.onDidClick(() => {
			this.savingModel = true;
			this.render();
			void (async () => {
				try {
					await this.saveProvider();
					await this.viewModel.addModel(this.modelId.value.trim(), Number(this.contextWindow.value), this.upstreamModel.value.trim() || undefined);
					this.closeEditor();
				} catch (error) { this.viewModel.report(error); }
				finally {
					this.savingModel = false;
					if (!this.isDisposed) { this.render(); }
				}
			})();
		}));
		const before = async (): Promise<void> => { await this.saveProvider(); await this.key.save(); };
		this._register(this.test.onDidClick(() => { void this.viewModel.testModels(before); }));
		this._register(this.refresh.onDidClick(() => { void this.viewModel.refresh(before); }));
		this._register(addDisposableListener(this.key.input.inputElement, 'input', () => this.viewModel.invalidateTests()));
		this._register(this.viewModel.onDidChange(() => this.render()));
	}

	public async initialize(): Promise<void> {
		this.render();
		if (!this.isNew) { await this.viewModel.initialize(); }
	}

	public focus(): void { this.name.focus(); }
	public get title(): string { return this.name.value.trim() || localize('models.provider.new', 'New provider'); }
	public updateKeyConfigured(configured: boolean): void { this.key.updateConfigured(configured); }

	public getAccessibleContent(): string {
		return [this.title, this.viewModel.message, ...this.viewModel.rows.map(row => {
			const status = this.rowControls.get(row.id)?.status.textContent ?? '';
			const enabled = this.viewModel.isEnabled(row.id) ? localize('models.provider.enabled', 'Enabled') : localize('models.provider.disabled', 'Disabled');
			return `${row.name}, ${row.id}, ${enabled}, ${status}${row.contextWindow ? `, ${localize('models.provider.contextTokens', '{0} tokens', row.contextWindow.toLocaleString())}` : ''}${row.upstreamModel ? `, ${row.upstreamModel}` : ''}`;
		})].filter(Boolean).join('\n');
	}

	private field(label: string): HTMLElement {
		const row = h(this.domNode.ownerDocument, 'div');
		row.className = 'ash-chat-models-field';
		const name = h(this.domNode.ownerDocument, 'span');
		name.textContent = label;
		const controls = h(this.domNode.ownerDocument, 'div');
		controls.className = 'ash-chat-models-control';
		row.append(name, controls);
		this.domNode.append(row);
		return controls;
	}

	private textField(label: string, value: string): InputBox {
		const input = this._register(new InputBox(this.field(label), { presentation: 'field', ariaLabel: label }));
		input.value = value;
		this._register(input.onDidChange(() => this.viewModel.invalidateTests()));
		this._register(input.onDidBlur(() => this.saveInBackground()));
		return input;
	}

	private saveProvider(): Promise<void> {
		this.viewModel.updateProvider({ name: this.name.value.trim(), baseUrl: this.baseUrl.value.trim(), apiFormat: this.format.value as ModelProviderApiFormat });
		return this.viewModel.save();
	}

	private saveInBackground(): void {
		if (!this.name.value.trim() || !this.baseUrl.value.trim()) { return; }
		void this.saveProvider().catch(error => { if (!this.isDisposed) { this.viewModel.report(error); } });
	}

	private openEditor(model?: ProviderModelItem): void {
		this.editing = !!model;
		this.modelId.value = model?.id ?? '';
		this.upstreamModel.value = model?.upstreamModel ?? '';
		this.modelId.enabled = !this.editing;
		this.contextWindow.value = model?.contextWindow?.toString() ?? '';
		this.largeContext.checked = model?.contextWindow === 1_000_000;
		this.contextWindow.enabled = !this.largeContext.checked;
		this.editor.hidden = false;
		if (this.editing) { this.contextWindow.focus(); }
		else { this.modelId.focus(); }
	}

	private closeEditor(): void {
		this.editor.hidden = true;
		this.add.focus();
	}

	private render(): void {
		const busy = this.viewModel.busy || this.savingModel;
		for (const control of [this.name, this.baseUrl, this.format, this.test, this.refresh, this.add, this.cancel, this.saveModel]) { control.enabled = !busy; }
		this.key.setEnabled(!busy);
		this.modelId.enabled = !busy && !this.editing;
		this.upstreamModel.enabled = !busy;
		this.contextWindow.enabled = !busy && !this.largeContext.checked;
		this.largeContext.enabled = !busy;
		this.domNode.setAttribute('aria-busy', String(busy));
		this.feedback.hidden = !this.viewModel.message;
		this.feedback.textContent = this.viewModel.message;
		this.feedback.classList.toggle('is-error', this.viewModel.isError);
		this.empty.hidden = !!this.viewModel.rows.length;
		const structure = JSON.stringify(this.viewModel.rows.map(row => [row.id, row.name, row.contextWindow, row.manual, row.upstreamModel]));
		if (structure !== this.structure) {
			this.structure = structure;
			this.tableResources.clear();
			this.rowControls.clear();
			this.modelBody.replaceChildren();
			for (const model of this.viewModel.rows) { this.createRow(model); }
		}
		for (const model of this.viewModel.rows) {
			const controls = this.rowControls.get(model.id)!;
			controls.toggle.checked = this.viewModel.isEnabled(model.id);
			controls.toggle.enabled = !busy;
			controls.edit.enabled = !busy;
			if (controls.remove) { controls.remove.enabled = !busy; }
			controls.status.classList.toggle('passed', model.status === 'passed');
			controls.status.textContent = model.status === 'passed' ? localize('models.provider.passed', 'Model test passed')
				: model.status === 'failed' ? localize('models.provider.testFailed', 'Model test failed: {0}', model.message ?? '')
				: model.status === 'testing' ? localize('models.provider.testing', 'Testing model…') : localize('models.provider.untested', 'Not tested');
		}
	}

	private createRow(model: ProviderModelItem): void {
		const document = this.domNode.ownerDocument;
		const row = h(document, 'tr');
		row.dataset.modelId = model.id;
		const identity = h(document, 'td');
		const name = h(document, 'span');
		name.textContent = model.name;
		const detail = h(document, 'small');
		detail.textContent = model.contextWindow ? `${model.id} · ${localize('models.provider.contextTokens', '{0} tokens', model.contextWindow.toLocaleString())}` : model.id;
		if (model.upstreamModel) { detail.textContent += ` → ${model.upstreamModel}`; }
		identity.append(name, detail);
		const status = h(document, 'td');
		status.className = 'ash-chat-models-test-status';
		const actions = h(document, 'td');
		const edit = this.tableResources.add(new Button(actions, { label: localize('models.provider.editModel', 'Edit context for {0}', model.id), icon: Lxicon.edit, iconOnly: true, presentation: 'quiet' }));
		this.tableResources.add(edit.onDidClick(() => this.openEditor(model)));
		let remove: Button | undefined;
		if (model.manual) {
			remove = this.tableResources.add(new Button(actions, { label: localize('models.provider.removeModel', 'Delete model {0}', model.id), icon: Lxicon.trash, iconOnly: true, presentation: 'quiet' }));
			this.tableResources.add(remove.onDidClick(() => {
				this.add.focus();
				void this.viewModel.removeModel(model.id).catch(error => this.viewModel.report(error));
			}));
		}
		const enabled = h(document, 'td');
		const toggle = this.tableResources.add(new Switch(enabled, { checked: this.viewModel.isEnabled(model.id), ariaLabel: localize('models.provider.enableModel', 'Enable {0}', model.id) }));
		this.tableResources.add(toggle.onDidChange(() => { void this.viewModel.setEnabled(model.id, toggle.checked); }));
		row.append(identity, status, actions, enabled);
		this.modelBody.append(row);
		this.rowControls.set(model.id, { toggle, status, edit, remove });
	}
}
