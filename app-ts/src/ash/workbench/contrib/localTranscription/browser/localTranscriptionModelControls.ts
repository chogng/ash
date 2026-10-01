import './media/localTranscriptionModelControls.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Table } from '../../../../base/browser/ui/table/tableWidget.js';
import type { ITableRenderer } from '../../../../base/browser/ui/table/table.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DEFAULT_LOCAL_DICTATION_MODEL, DictationConfiguration } from '../../../../platform/dictation/common/dictationConfiguration.js';
import { ILocalTranscriptionService, isModelPreparing, LocalTranscriptionModelState, type ILocalTranscriptionModelSnapshot } from '../../../../platform/localTranscription/common/localTranscription.js';
import { LocalTranscriptionModelStatus, modelProgressText } from './localTranscriptionModelStatus.js';

interface ModelCell {
	readonly model: ILocalTranscriptionModelSnapshot;
	readonly column: 'name' | 'size' | 'status' | 'actions';
}

interface CellTemplate {
	readonly resources: DisposableStore;
	readonly use: Button;
	readonly install: Button;
	readonly cancel: Button;
	readonly uninstall: Button;
	model: ILocalTranscriptionModelSnapshot | undefined;
}

/** Model operations stay process-owned; the table retains controls while snapshots change. */
export class LocalTranscriptionModelControls extends Disposable {
	public readonly domNode: HTMLElement;
	private visible = false;
	private readonly status: LocalTranscriptionModelStatus;
	private readonly modelSource: InputBox;
	private readonly importModelButton: Button;
	private readonly table: Table<ILocalTranscriptionModelSnapshot>;
	private readonly pending = new Set<string>();
	private readonly confirmingRemoval = new Set<string>();
	private modelStatusVersion = 0;

	constructor(container: HTMLElement,
		@ILocalTranscriptionService private readonly localTranscription: ILocalTranscriptionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-local-transcription-model-controls';
		container.append(this.domNode);
		const tableContainer = h(document, 'div');
		tableContainer.className = 'ash-local-transcription-model-inventory';
		this.domNode.append(tableContainer);
		const renderer: ITableRenderer<ModelCell, CellTemplate> = {
			templateId: 'model',
			renderTemplate: cell => {
				const resources = new DisposableStore();
				const actions = h(document, 'div');
				actions.className = 'ash-local-transcription-model-actions';
				cell.append(actions);
				const use = resources.add(new Button(actions, { label: localize('dictation.model.use', 'Use model'), presentation: 'secondary' }));
				const install = resources.add(new Button(actions, { label: localize('dictation.model.install', 'Install'), presentation: 'secondary' }));
				const cancel = resources.add(new Button(actions, { label: localize('dictation.model.cancel', 'Cancel'), presentation: 'secondary' }));
				const uninstall = resources.add(new Button(actions, { label: localize('dictation.model.uninstall', 'Uninstall'), presentation: 'secondary' }));
				const template: CellTemplate = { resources, use, install, cancel, uninstall, model: undefined };
				resources.add(use.onDidClick(() => { void this.perform(template.model!.model, () => this.configurationService.updateValue(DictationConfiguration.localModel, template.model!.model)); }));
				resources.add(install.onDidClick(() => { void this.perform(template.model!.model, () => this.localTranscription.prepareModel(template.model!.model, () => {}).completed); }));
				resources.add(cancel.onDidClick(() => {
					void this.localTranscription.cancelModel(template.model!.model).catch(error => {
						if (!this.isDisposed) { this.status.setMessage(String(error)); }
					});
				}));
				resources.add(uninstall.onDidClick(() => {
					const model = template.model!.model;
					if (!this.confirmingRemoval.has(model)) {
						this.confirmingRemoval.add(model);
						this.status.setMessage(localize('dictation.model.uninstallDetail', 'Uninstall {0}? The original import directory is kept.', model));
						this.table.rerender();
						return;
					}
					this.confirmingRemoval.delete(model);
					void this.perform(model, () => this.localTranscription.deleteModel(model));
				}));
				return template;
			},
			renderElement: (cell, _index, template) => {
				template.model = cell.model;
				this.renderCell(cell, template);
			},
			disposeTemplate: template => template.resources.dispose(),
		};
		const textRenderer: ITableRenderer<ModelCell, HTMLElement> = {
			templateId: 'model-text',
			renderTemplate: cell => {
				const text = h(document, 'span');
				text.className = 'ash-local-transcription-model-cell-text';
				cell.append(text);
				return text;
			},
			renderElement: (cell, _index, text) => { text.textContent = this.cellText(cell); text.title = text.textContent; },
			disposeTemplate: () => {},
		};
		const labels = [
			{ column: 'name', label: localize('dictation.model.column.name', 'Model'), weight: 3, minimumWidth: 180 },
			{ column: 'size', label: localize('dictation.model.column.size', 'Size'), weight: 1, minimumWidth: 80 },
			{ column: 'status', label: localize('dictation.model.column.status', 'Status'), weight: 2, minimumWidth: 130 },
			{ column: 'actions', label: localize('dictation.model.column.actions', 'Actions'), weight: 2, minimumWidth: 200 },
		] as const;
		this.table = this._register(new Table('LocalTranscriptionModelControls', tableContainer, { headerRowHeight: 36, getHeight: () => 48 }, labels.map(column => ({
			...column,
			templateId: column.column === 'actions' ? 'model' : 'model-text',
			project: (model: ILocalTranscriptionModelSnapshot): ModelCell => ({ model, column: column.column }),
		})), [renderer, textRenderer], {
			ariaLabel: localize('dictation.model.table', 'Local dictation models'),
			identityProvider: { getId: model => model.model },
		}));
		const imports = h(document, 'details');
		const summary = h(document, 'summary');
		summary.textContent = localize('dictation.model.import', 'Import model');
		imports.append(summary);
		const sourceLabel = h(document, 'label');
		sourceLabel.textContent = localize('dictation.model.source', 'Prepared Paraformer model directory');
		const sourceContainer = h(document, 'div');
		sourceContainer.className = 'ash-local-transcription-model-source';
		this.modelSource = this._register(new InputBox(sourceContainer, {
			presentation: 'field',
			ariaLabel: localize('dictation.model.source', 'Prepared Paraformer model directory'),
			placeholder: localize('dictation.model.sourcePlaceholder', 'Absolute directory containing dictation-model.json'),
		}));
		this.modelSource.inputElement.id = generateUuid();
		sourceLabel.htmlFor = this.modelSource.inputElement.id;
		const actions = h(document, 'div');
		actions.className = 'ash-local-transcription-model-actions';
		this.importModelButton = this._register(new Button(actions, { label: localize('dictation.model.import', 'Import model'), presentation: 'secondary', enabled: false }));
		imports.append(sourceLabel, sourceContainer, actions);
		this.domNode.append(imports);
		this.status = this._register(new LocalTranscriptionModelStatus(this.domNode));
		this._register(this.modelSource.onDidChange(() => this.updateImport()));
		this._register(this.importModelButton.onDidClick(() => {
			const model = this.model;
			void this.perform(model, () => this.localTranscription.importModel({ model, sourcePath: this.modelSource.value.trim() }, () => {}).completed);
		}));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(DictationConfiguration.localModel) && this.visible) {
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
		return [localize('dictation.model.table', 'Local dictation models'), ...Array.from({ length: this.table.length }, (_, index) => {
			const model = this.table.row(index);
			return ['name', 'size', 'status'].map(column => this.cellText({ model, column: column as ModelCell['column'] })).join(' · ');
		})].join('\n');
	}

	public setAriaDescription(description: string | undefined): void {
		if (description) { this.table.domNode.setAttribute('aria-description', description); }
		else { this.table.domNode.removeAttribute('aria-description'); }
	}

	private get model(): string { return this.configurationService.getValue<string>(DictationConfiguration.localModel); }

	private updateImport(): void {
		const selected = Array.from({ length: this.table.length }, (_, index) => this.table.row(index)).find(model => model.model === this.model);
		this.importModelButton.enabled = this.localTranscription.isSupported && !this.pending.has(this.model) && !isModelPreparing(selected?.status) && !selected?.available && !!this.modelSource.value.trim();
		this.modelSource.enabled = this.localTranscription.isSupported && !this.pending.has(this.model);
	}

	private async readLocalModels(): Promise<void> {
		const version = ++this.modelStatusVersion;
		if (!this.localTranscription.isSupported) {
			this.status.setMessage(localize('dictation.connectionUnavailable', 'Dictation connection is unavailable'));
			this.updateImport();
			return;
		}
		try {
			const inventory = await this.localTranscription.listModels();
			// A configured imported package can have been removed outside Ash; keep its real status visible.
			const models = inventory.some(model => model.model === this.model) ? inventory : [...inventory, await this.localTranscription.getModelStatus(this.model)];
			if (version !== this.modelStatusVersion || this.isDisposed) { return; }
			this.table.splice(0, this.table.length, models);
			this.table.layout();
			const selected = models.find(model => model.model === this.model);
			if (selected) { this.status.render(selected); }
			this.updateImport();
		} catch (error) {
			if (version === this.modelStatusVersion && !this.isDisposed) { this.status.setMessage(String(error)); }
		}
	}

	private renderCell(cell: ModelCell, template: CellTemplate): void {
		const model = cell.model;
		const preparing = isModelPreparing(model.status);
		const selected = model.model === this.model;
		const busy = this.pending.has(model.model);
		const enabled = this.localTranscription.isSupported && !busy;
		template.use.hidden = cell.column !== 'actions' || !model.available;
		template.install.hidden = cell.column !== 'actions' || model.available || preparing;
		template.cancel.hidden = cell.column !== 'actions' || !preparing;
		template.uninstall.hidden = cell.column !== 'actions' || !model.available;
		template.use.label = selected ? localize('dictation.model.current', 'Current') : localize('dictation.model.use', 'Use model');
		template.use.enabled = enabled && !selected && !preparing;
		template.install.enabled = enabled && model.model === DEFAULT_LOCAL_DICTATION_MODEL;
		template.cancel.enabled = this.localTranscription.isSupported;
		template.uninstall.enabled = enabled && !preparing;
		template.uninstall.label = this.confirmingRemoval.has(model.model) ? localize('dictation.model.confirmUninstall', 'Confirm uninstall') : localize('dictation.model.uninstall', 'Uninstall');
	}

	private cellText(cell: ModelCell): string {
		const model = cell.model;
		switch (cell.column) {
			case 'name': return model.model;
			case 'size': return model.available ? localize('dictation.model.size', '{0} MiB', (model.sizeBytes / (1024 * 1024)).toFixed(1)) : '—';
			case 'status':
				if (isModelPreparing(model.status) || model.status?.state === LocalTranscriptionModelState.Error) { return modelProgressText(model.status!); }
				if (!model.available) { return localize('dictation.model.notInstalled', 'Not installed'); }
				if (model.model === this.model) { return localize('dictation.model.current', 'Current'); }
				return localize('dictation.model.installedState', 'Installed');
			case 'actions': return '';
		}
	}

	private async perform(model: string, action: () => Promise<unknown>): Promise<void> {
		if (this.pending.has(model)) { return; }
		this.pending.add(model);
		this.table.rerender();
		this.updateImport();
		try { await action(); }
		catch (error) {
			if (!this.isDisposed) { this.status.setMessage(String(error)); }
			return;
		} finally {
			this.pending.delete(model);
			if (!this.isDisposed) { this.table.rerender(); this.updateImport(); }
		}
		if (this.visible && !this.isDisposed) { await this.readLocalModels(); }
	}
}
