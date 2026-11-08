import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { DEFAULT_LOCAL_TRANSCRIPTION_MODEL } from '../../../../platform/localTranscription/common/localTranscription.js';
import './media/localTranscriptionModelControls.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DictationConfiguration } from '../../chat/common/constants.js';
import { ILocalTranscriptionModelService, isModelPreparing, DictationModelState, type ILocalTranscriptionModelSnapshot } from '../../../../platform/localTranscription/common/localTranscription.js';
import { LocalTranscriptionModelStatus, modelProgressText } from './localTranscriptionModelStatus.js';

interface ModelRow extends IDisposable {
	readonly element: HTMLElement;
	readonly state: HTMLElement;
	readonly primary: Button;
	readonly uninstall: Button;
	snapshot: ILocalTranscriptionModelSnapshot;
}

/** Renders the model inventory from process-owned snapshots. */
export class LocalTranscriptionModelControls extends Disposable {
	public readonly domNode: HTMLElement;
	private visible = false;
	private readonly status: LocalTranscriptionModelStatus;
	private readonly table: HTMLTableElement;
	private readonly inventory: HTMLElement;
	private readonly rows = this._register(new DisposableMap<string, ModelRow>());
	private readonly pending = new Set<string>();
	private readonly confirmingRemoval = new Set<string>();
	private modelStatusVersion = 0;

	constructor(container: HTMLElement,
		@ILocalTranscriptionModelService private readonly localTranscription: ILocalTranscriptionModelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-local-transcription-model-controls';
		container.append(this.domNode);
		this.domNode.setAttribute('role', 'group');
		this.domNode.setAttribute('aria-label', localize('dictation.model.table', 'Local dictation models'));
		this.domNode.tabIndex = 0;
		const heading = h(document, 'h4', localize('dictation.model.heading', 'Dictation models'));
		heading.className = 'ash-local-transcription-model-heading';
		this.domNode.append(heading);
		this.table = h(document, 'table');
		this.table.hidden = true;
		this.table.className = 'ash-local-transcription-model-table';
		const header = this.table.createTHead().insertRow();
		for (const label of [
			localize('dictation.model.column.name', 'Model'),
			localize('dictation.model.column.languages', 'Best for'),
			localize('dictation.model.column.actions', 'Actions'),
		]) {
			const column = h(document, 'th', label);
			column.scope = 'col';
			header.append(column);
		}
		this.inventory = this.table.createTBody();
		this.domNode.append(this.table);
		this.status = this._register(new LocalTranscriptionModelStatus(this.domNode));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(DictationConfiguration.model) && this.visible) {
				void this.readLocalModels();
			}
		}));
		this._register(this.localTranscription.onDidChangeModels(() => {
			if (this.visible) {
				void this.readLocalModels();
			}
		}));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public setVisible(visible: boolean): void {
		if (visible === this.visible) { return; }
		this.visible = visible;
		this.modelStatusVersion++;
		if (visible) { void this.readLocalModels(); }
	}

	public getAccessibleContent(): string {
		return [localize('dictation.model.table', 'Local dictation models'), ...Array.from(this.rows, ([, { snapshot }]) => {
			const size = snapshot.available ? localize('dictation.model.size', '{0} MiB', (snapshot.sizeBytes / (1024 * 1024)).toFixed(1)) : '—';
			return [this.modelName(snapshot.model), size, this.modelState(snapshot), this.modelLanguages(snapshot.model)].filter(Boolean).join(' · ');
		})].join('\n');
	}

	public setAriaDescription(description: string | undefined): void {
		if (description) { this.domNode.setAttribute('aria-description', description); }
		else { this.domNode.removeAttribute('aria-description'); }
	}

	private get model(): string { return this.configurationService.getValue<string>(DictationConfiguration.model); }

	private async readLocalModels(): Promise<void> {
		const version = ++this.modelStatusVersion;
		if (!this.localTranscription.isSupported) {
			this.renderModels([]);
			this.status.setMessage(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable'));
			return;
		}
		try {
			const inventory = await this.localTranscription.listModels();
			// A configured imported package can have been removed outside Ash; keep its real status visible.
			const models = inventory.some(model => model.model === this.model) ? inventory : [...inventory, await this.localTranscription.getModel(this.model)];
			if (version !== this.modelStatusVersion || this.isDisposed) { return; }
			this.renderModels(models);
			const selected = models.find(model => model.model === this.model);
			if (selected) { this.status.render(selected); }
		} catch (error) {
			if (version === this.modelStatusVersion && !this.isDisposed) { this.status.setMessage(String(error)); }
		}
	}

	private renderModels(models: readonly ILocalTranscriptionModelSnapshot[]): void {
		this.table.hidden = !models.length;
		const ids = new Set(models.map(model => model.model));
		for (const id of this.rows.keys()) {
			if (!ids.has(id)) this.rows.deleteAndDispose(id);
		}
		let next = this.inventory.firstElementChild;
		for (const snapshot of models) {
			const row = this.rows.get(snapshot.model) ?? this.rows.set(snapshot.model, this.createRow(snapshot));
			row.snapshot = snapshot;
			this.updateRow(row);
			if (row.element !== next) this.inventory.insertBefore(row.element, next);
			next = row.element.nextElementSibling;
		}
	}

	private createRow(snapshot: ILocalTranscriptionModelSnapshot): ModelRow {
		const document = this.domNode.ownerDocument;
		const resources = new DisposableStore();
		const element = h(document, 'tr');
		element.dataset.modelId = snapshot.model;
		resources.add(toDisposable(() => element.remove()));

		const modelCell = h(document, 'th');
		modelCell.scope = 'row';
		const title = h(document, 'span');
		const state = h(document, 'span');
		state.className = 'ash-local-transcription-model-row-state';
		modelCell.append(title, state);
		const languages = h(document, 'td');
		languages.textContent = this.modelLanguages(snapshot.model) ?? '—';
		const actions = h(document, 'div');
		actions.className = 'ash-local-transcription-model-actions';
		const actionCell = h(document, 'td');
		actionCell.append(actions);
		element.append(modelCell, languages, actionCell);

		const primary = resources.add(new Button(actions, { ...defaultButtonStyles, label: '', presentation: 'secondary' }));
		const uninstall = resources.add(new Button(actions, {
			...defaultButtonStyles,
			label: localize('dictation.model.uninstall', 'Uninstall'),
			presentation: 'danger',
		}));
		title.textContent = this.modelName(snapshot.model);
		const row: ModelRow = Object.assign(toDisposable(() => resources.dispose()), { element, state, primary, uninstall, snapshot });
		resources.add(primary.onDidClick(() => { void this.runPrimary(row); }));
		resources.add(uninstall.onDidClick(() => { void this.confirmUninstall(row); }));
		return row;
	}

	private updateRow(row: ModelRow): void {
		const model = row.snapshot;
		const preparing = isModelPreparing(model.status);
		const selected = model.model === this.model;
		const available = this.localTranscription.isSupported;
		const busy = this.pending.has(model.model);
		row.state.textContent = this.modelState(model);
		// Available actions already distinguish installed from uninstalled models visually.
		row.state.classList.toggle('ash-aria-live', !(preparing || model.status?.state === DictationModelState.Error || model.available && selected));
		row.primary.hidden = !preparing && model.available && selected;
		row.primary.label = preparing ? localize('dictation.model.cancel', 'Cancel')
			: model.available ? localize('dictation.model.use', 'Use model') : localize('dictation.model.install', 'Install');
		row.primary.enabled = available && (preparing || !busy && (model.available || model.model === DEFAULT_LOCAL_TRANSCRIPTION_MODEL));
		row.uninstall.hidden = !model.available || preparing;
		row.uninstall.enabled = available && !busy;
	}

	private async runPrimary({ snapshot }: ModelRow): Promise<void> {
		const model = snapshot.model;
		if (isModelPreparing(snapshot.status)) {
			try { await this.localTranscription.cancelModel(model); }
			catch (error) { if (!this.isDisposed) this.status.setMessage(String(error)); }
		} else if (snapshot.available) {
			await this.perform(model, () => this.configurationService.updateValue(DictationConfiguration.model, model));
		} else {
			await this.perform(model, () => this.localTranscription.prepareModel(model, () => { }).completed);
		}
	}

	private async confirmUninstall(row: ModelRow): Promise<void> {
		const model = row.snapshot.model;
		if (this.confirmingRemoval.has(model)) return;
		this.confirmingRemoval.add(model);
		try {
			const result = await this.dialogs.confirm({
				message: localize('dictation.model.uninstallDetail', 'Uninstall {0}?', this.modelName(model)),
				primaryButton: localize('dictation.model.uninstall', 'Uninstall'),
				custom: true,
			});
			if (result.confirmed && !this.isDisposed && this.visible && this.rows.get(model)?.snapshot.available) {
				await this.perform(model, () => this.localTranscription.deleteModel(model));
			}
		} catch (error) {
			if (!this.isDisposed) this.status.setMessage(String(error));
		} finally {
			this.confirmingRemoval.delete(model);
		}
	}

	private modelName(model: string): string {
		return model === DEFAULT_LOCAL_TRANSCRIPTION_MODEL ? 'Paraformer' : model;
	}

	private modelLanguages(model: string): string | undefined {
		if (model === DEFAULT_LOCAL_TRANSCRIPTION_MODEL) {
			return localize('dictation.model.paraformer.languages', 'Mandarin Chinese');
		}
		return undefined;
	}

	private modelState(model: ILocalTranscriptionModelSnapshot): string {
		if (isModelPreparing(model.status) || model.status?.state === DictationModelState.Error) return modelProgressText(model.status!);
		if (!model.available) return localize('dictation.model.notInstalled', 'Not installed');
		return model.model === this.model ? localize('dictation.model.readyState', 'Ready') : localize('dictation.model.installedState', 'Installed');
	}

	private async perform(model: string, action: () => Promise<unknown>): Promise<void> {
		if (this.pending.has(model)) { return; }
		this.pending.add(model);
		const row = this.rows.get(model);
		if (row) this.updateRow(row);
		try { await action(); }
		catch (error) {
			if (!this.isDisposed) { this.status.setMessage(String(error)); }
			return;
		} finally {
			this.pending.delete(model);
			if (!this.isDisposed) {
				const current = this.rows.get(model);
				if (current) this.updateRow(current);
			}
		}
		if (this.visible && !this.isDisposed) { await this.readLocalModels(); }
	}
}
