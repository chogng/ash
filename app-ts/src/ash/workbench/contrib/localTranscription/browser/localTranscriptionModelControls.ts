import './media/localTranscriptionModelControls.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DictationConfiguration } from '../../../../platform/dictation/common/dictationConfiguration.js';
import { ILocalTranscriptionService, LocalTranscriptionModelState, type ILocalTranscriptionModelStatus, type ILocalTranscriptionModelOperation } from '../../../../platform/localTranscription/common/localTranscription.js';

export class LocalTranscriptionModelControls extends Disposable {
	public readonly domNode: HTMLElement;
	private visible = false;
	private readonly localModelStatusDomNode: HTMLElement;
	private readonly modelSource: InputBox;
	private readonly prepareModelButton: Button;
	private readonly importModelButton: Button;
	private readonly cancelModelButton: Button;
	private modelOperation: ILocalTranscriptionModelOperation | undefined;
	private modelStatusVersion = 0;

	constructor(container: HTMLElement,
		@ILocalTranscriptionService private readonly localTranscription: ILocalTranscriptionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const document = container.ownerDocument;
		const localModelRow = h(document, 'div');
		localModelRow.className = 'ash-local-transcription-model-controls';
		this.domNode = localModelRow;
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
		this.prepareModelButton = this._register(new Button(actions, { label: localize('dictation.model.prepare', 'Prepare model'), presentation: 'secondary' }));
		this.importModelButton = this._register(new Button(actions, { label: localize('dictation.model.import', 'Import model'), presentation: 'secondary' }));
		this.cancelModelButton = this._register(new Button(actions, { label: localize('dictation.model.cancel', 'Cancel'), presentation: 'secondary', enabled: false }));
		this.localModelStatusDomNode = h(document, 'p');
		this.localModelStatusDomNode.className = 'ash-local-transcription-model-status';
		this.localModelStatusDomNode.setAttribute('role', 'status');
		this.localModelStatusDomNode.setAttribute('aria-atomic', 'true');
		localModelRow.append(sourceLabel, sourceContainer, actions, this.localModelStatusDomNode);
		container.append(localModelRow);
		this.updateModelControls();
		this._register(this.modelSource.onDidChange(() => this.updateModelControls()));
		this._register(this.prepareModelButton.onDidClick(() => { void this.runModelOperation('prepare'); }));
		this._register(this.importModelButton.onDidClick(() => { void this.runModelOperation('import'); }));
		this._register(this.cancelModelButton.onDidClick(() => { void this.modelOperation?.cancel(); }));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(DictationConfiguration.localModel) && this.visible && !this.modelOperation) { void this.readLocalModelStatus(); }
		}));
		this._register(toDisposable(() => { void this.modelOperation?.cancel(); }));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public setVisible(visible: boolean): void {
		if (visible === this.visible) { return; }
		this.visible = visible;
		this.modelStatusVersion++;
		if (visible && !this.modelOperation) { void this.readLocalModelStatus(); }
		if (!visible) { void this.modelOperation?.cancel(); }
	}

	private updateModelControls(): void {
		const enabled = this.localTranscription.isSupported && !this.modelOperation;
		this.prepareModelButton.enabled = enabled;
		this.importModelButton.enabled = enabled && !!this.modelSource.value.trim();
		this.modelSource.inputElement.disabled = !enabled;
		this.cancelModelButton.enabled = !!this.modelOperation;
	}

	private async readLocalModelStatus(): Promise<void> {
		const version = ++this.modelStatusVersion;
		if (!this.localTranscription.isSupported) {
			this.localModelStatusDomNode.textContent = localize('dictation.connectionUnavailable', 'Dictation connection is unavailable');
			return;
		}
		try {
			const model = this.configurationService.getValue<string>(DictationConfiguration.localModel);
			const status = await this.localTranscription.getModelStatus(model);
			if (version !== this.modelStatusVersion || this.isDisposed) { return; }
			this.localModelStatusDomNode.textContent = status.available
				? localize('dictation.model.installed', 'Model package installed: {0}', status.model)
				: localize('dictation.model.missing', 'Model package not installed: {0}', status.model);
		} catch (error) {
			if (version === this.modelStatusVersion && !this.isDisposed) { this.localModelStatusDomNode.textContent = localize('dictation.model.failed', 'Model preparation failed: {0}', String(error)); }
		}
	}

	private async runModelOperation(kind: 'prepare' | 'import'): Promise<void> {
		if (this.modelOperation) { return; }
		this.modelStatusVersion++;
		try {
			const model = this.configurationService.getValue<string>(DictationConfiguration.localModel);
			const onProgress = (status: ILocalTranscriptionModelStatus): void => {
				if (!this.isDisposed && this.visible) { this.localModelStatusDomNode.textContent = modelProgressText(status); }
			};
			// The transcription service owns the handle; this page borrows it and cancels on close.
			const operation = kind === 'prepare'
				? this.localTranscription.prepareModel(model, onProgress)
				: this.localTranscription.importModel({ model, sourcePath: this.modelSource.value.trim() }, onProgress);
			this.modelOperation = operation;
			this.updateModelControls();
			await operation.completed;
		} catch (error) {
			if (!this.isDisposed && this.visible) { this.localModelStatusDomNode.textContent = localize('dictation.model.failed', 'Model preparation failed: {0}', String(error)); }
		} finally {
			this.modelOperation = undefined;
			if (!this.isDisposed) { this.updateModelControls(); }
		}
	}

}

function modelProgressText(status: ILocalTranscriptionModelStatus): string {
	switch (status.state) {
		case LocalTranscriptionModelState.Checking: return localize('dictation.model.checking', 'Checking model files…');
		case LocalTranscriptionModelState.Downloading: return localize('dictation.model.downloading', 'Downloading {0}: {1} MiB', status.file, (status.downloadedBytes / (1024 * 1024)).toFixed(1));
		case LocalTranscriptionModelState.Loading: return localize('dictation.model.loading', 'Loading model…');
		case LocalTranscriptionModelState.Ready: return localize('dictation.model.ready', 'Model verified and ready to use.');
		case LocalTranscriptionModelState.Cancelled: return localize('dictation.model.cancelled', 'Model preparation cancelled.');
		case LocalTranscriptionModelState.Error: return localize('dictation.model.failed', 'Model preparation failed: {0}', status.error);
	}
}
