import { defaultButtonStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/localTranscriptionModelControls.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { setAriaAttribute, status as announceStatus } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { DictationConfiguration } from '../../chat/common/constants.js';
import { ILocalTranscriptionModelService, isModelPreparing, preferredInstalledModel, DictationModelState, type ILocalTranscriptionModelSnapshot } from '../../../../platform/localTranscription/common/localTranscription.js';
import { LocalTranscriptionModelStatus, modelDownloadProgress, modelPreparationText, modelProgressText } from './localTranscriptionModelStatus.js';

interface ModelRow extends IDisposable {
	readonly element: HTMLElement;
	readonly state: HTMLElement;
	readonly language: HTMLTableCellElement;
	readonly languageTags: HTMLElement;
	readonly size: HTMLTableCellElement;
	readonly action: Button;
	readonly cancelLabel: HTMLElement;
	snapshot: ILocalTranscriptionModelSnapshot;
}

/** Renders the model inventory from process-owned snapshots. */
export class LocalTranscriptionModelControls extends Disposable {
	public readonly domNode: HTMLElement;
	private visible = false;
	private readonly status: LocalTranscriptionModelStatus;
	private readonly selector: SelectBox;
	private readonly table: HTMLTableElement;
	private readonly inventory: HTMLElement;
	private readonly rows = this._register(new DisposableMap<string, ModelRow>());
	private readonly pending = new Map<string, 'install' | 'uninstall'>();
	private readonly confirmingRemoval = new Set<string>();
	private modelStatusVersion = 0;
	private selectedModel: string | undefined;
	private savingSelection = false;

	constructor(container: HTMLElement,
		@ILocalTranscriptionModelService private readonly localTranscription: ILocalTranscriptionModelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IContextViewService contextViewProvider: IContextViewService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-local-transcription-model-controls';
		container.append(this.domNode);
		this.domNode.setAttribute('role', 'group');
		this.domNode.setAttribute('aria-label', localize('dictation.model.table', 'Local dictation models'));
		this.domNode.tabIndex = 0;
		const title = localize('dictation.model.heading', 'Dictation models');
		const heading = h(document, 'h4', title);
		heading.className = 'ash-configuration-setting-title ash-local-transcription-model-heading';
		const selection = h(document, 'div');
		selection.className = 'ash-configuration-setting ash-local-transcription-model-selection';
		selection.append(heading);
		this.selector = this._register(new SelectBox(selection, {
			options: [], ariaLabel: title, presentation: 'field', contextViewProvider,
		}, defaultSelectBoxStyles));
		this.updateSelection([]);
		this._register(this.selector.onDidSelect(({ value }) => { void this.selectModel(value); }));
		this.domNode.append(selection);
		this.table = h(document, 'table');
		this.table.hidden = true;
		this.table.className = 'ash-local-transcription-model-table';
		const header = this.table.createTHead().insertRow();
		for (const label of [
			localize('dictation.model.column.name', 'Model'),
			localize('dictation.model.column.languages', 'Best for'),
			localize('dictation.model.column.downloadSize', 'Size'),
		]) {
			const column = h(document, 'th', label);
			column.scope = 'col';
			header.append(column);
		}
		const actionsLabel = localize('dictation.model.column.actions', 'Actions');
		header.append(h(document, 'th', { attributes: { scope: 'col', 'aria-label': actionsLabel } },
			h(document, 'span', { className: 'ash-local-transcription-model-actions-label', attributes: { 'aria-hidden': 'true' } }, actionsLabel)));
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
			const languages = snapshot.recommendedLanguages?.map(language => this.languageLabel(language)).join(', ');
			return [snapshot.model, this.modelSize(snapshot), this.modelState(snapshot), languages].filter(Boolean).join(' · ');
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
			const operation = models.find(model => isModelPreparing(model.status))
				?? models.find(model => model.model === this.model);
			if (operation) { this.status.render(operation); }
		} catch (error) {
			if (version === this.modelStatusVersion && !this.isDisposed) { this.status.setMessage(String(error)); }
		}
	}

	private renderModels(models: readonly ILocalTranscriptionModelSnapshot[]): void {
		this.updateSelection(models);
		this.table.hidden = !models.length;
		const ids = new Set(models.map(model => model.model));
		for (const id of this.rows.keys()) {
			if (!ids.has(id)) this.rows.deleteAndDispose(id);
		}
		let next = this.inventory.firstElementChild;
		for (const snapshot of models) {
			const row = this.rows.get(snapshot.model) ?? this.rows.set(snapshot.model, this.createRow(snapshot));
			const wasCancelled = row.snapshot.status?.state === DictationModelState.Cancelled;
			row.snapshot = snapshot;
			this.updateRow(row);
			if (row.element !== next) this.inventory.insertBefore(row.element, next);
			next = row.element.nextElementSibling;
			if (!wasCancelled && snapshot.status?.state === DictationModelState.Cancelled) {
				announceStatus(modelProgressText(snapshot));
			}
		}
	}

	private updateSelection(models: readonly ILocalTranscriptionModelSnapshot[]): void {
		this.selectedModel = preferredInstalledModel(models, this.model)?.model;
		const installed = models.filter(model => model.available);
		const ids = installed.length ? installed.map(model => model.model) : [''];
		if (this.selector.options.length !== ids.length || this.selector.options.some((option, index) => option.value !== ids[index])) {
			this.selector.setOptions(installed.length
				? installed.map(model => ({ value: model.model, label: model.model }))
				: [{ value: '', label: localize('dictation.model.none', 'None') }]);
		}
		const selected = this.selectedModel ?? '';
		if (this.selector.value !== selected) this.selector.value = selected;
		this.selector.enabled = installed.length > 1 && !this.savingSelection;
	}

	private async selectModel(model: string): Promise<void> {
		if (this.savingSelection || !this.rows.get(model)?.snapshot.available) return;
		this.savingSelection = true;
		try {
			await this.configurationService.updateValue(DictationConfiguration.model, model);
		} catch (error) {
			if (!this.isDisposed) this.status.setMessage(String(error));
		} finally {
			this.savingSelection = false;
			if (!this.isDisposed) this.updateSelection(Array.from(this.rows, ([, row]) => row.snapshot));
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
		const state = h(document, 'span');
		state.className = 'ash-local-transcription-model-row-state';
		modelCell.append(snapshot.model, state);
		const language = h(document, 'td');
		const languageTags = h(document, 'div', { className: 'ash-local-transcription-model-language-tags' });
		language.append(languageTags);
		resources.add(getHoverDelegate().setupDelayedHover(languageTags, () => ({
			content: languageTags.scrollWidth > languageTags.clientWidth ? language.getAttribute('aria-label') ?? '' : '',
		})));
		const size = h(document, 'td');
		const actions = h(document, 'div');
		actions.className = 'ash-local-transcription-model-actions';
		const actionCell = h(document, 'td');
		actionCell.append(actions);
		element.append(modelCell, language, size, actionCell);

		const action = resources.add(new Button(actions, { ...defaultButtonStyles, label: '', supportShortLabel: true, presentation: 'secondary' }));
		action.toggleClassName('ash-local-transcription-model-action', true);
		const cancelLabel = h(document, 'span', {
			className: 'ash-local-transcription-model-cancel-label',
			attributes: { 'aria-hidden': 'true' },
		}, localize('dictation.model.cancel', 'Cancel'));
		// Let localized preparation labels size the button without exposing them as status text.
		const widthSamples = h(document, 'span', {
			className: 'ash-local-transcription-model-width-samples',
			attributes: { 'aria-hidden': 'true' },
		}, ...[
			modelPreparationText(DictationModelState.Checking),
			modelPreparationText(DictationModelState.Downloading),
			modelPreparationText(DictationModelState.Downloading, 1),
			modelPreparationText(DictationModelState.Loading),
		].map(label => h(document, 'span', label)));
		action.domNode.append(cancelLabel, widthSamples);
		const row: ModelRow = Object.assign(toDisposable(() => resources.dispose()), { element, state, language, languageTags, size, action, cancelLabel, snapshot });
		resources.add(addDisposableListener(action.domNode, 'pointerleave', () => action.toggleClassName('awaiting-pointer-exit', false)));
		resources.add(action.onDidClick(event => {
			const model = row.snapshot.model;
			if (isModelPreparing(row.snapshot.status) || this.pending.get(model) === 'install') {
				if (event.pointerType !== 'mouse' || !action.domNode.classList.contains('awaiting-pointer-exit')) {
					void this.cancelPreparation(model);
				}
			} else if (row.snapshot.available) {
				void this.confirmUninstall(row);
			} else {
				// Let the initial click reveal progress even while the pointer is still over Install.
				action.toggleClassName('awaiting-pointer-exit', event.pointerType === 'mouse');
				void this.perform(model, 'install', () => this.localTranscription.prepareModel(model, () => { }).completed);
			}
		}));
		return row;
	}

	private updateRow(row: ModelRow): void {
		const model = row.snapshot;
		const preparing = isModelPreparing(model.status);
		const available = this.localTranscription.isSupported;
		const busy = this.pending.get(model.model);
		const installing = preparing || busy === 'install';
		const uninstalling = busy === 'uninstall';
		const showUninstall = uninstalling || (!installing && model.available);
		const modelState = this.modelState(model);
		row.state.textContent = uninstalling || installing ? '' : modelState;
		const languageLabels = model.recommendedLanguages?.map(language => this.languageLabel(language)) ?? [];
		const languageText = languageLabels.join(', ') || '—';
		if (row.language.getAttribute('aria-label') !== languageText) {
			row.language.setAttribute('aria-label', languageText);
			row.languageTags.replaceChildren(...(languageLabels.length
				? languageLabels.map(label => h(row.language.ownerDocument, 'span', { className: 'ash-local-transcription-model-language-tag' }, label))
				: ['—']));
		}
		row.size.textContent = this.modelSize(model);
		// The selector shows the active model and the available actions indicate installation.
		row.state.classList.toggle('ash-aria-live', model.status?.state !== DictationModelState.Error);
		const progress = installing ? modelDownloadProgress(model) : undefined;
		const label = installing || uninstalling ? modelState
			: showUninstall ? localize('dictation.model.uninstall', 'Uninstall')
				: localize('dictation.model.install', 'Install');
		const action = row.action;
		if (action.label !== label) action.label = label;
		action.labelShort = progress === undefined ? '' : localize('dictation.model.compactPercent', '{0}%', Math.floor(progress * 100));
		action.enabled = available && !uninstalling && (installing || showUninstall || model.downloadSizeBytes !== undefined);
		action.presentation = showUninstall ? 'danger' : 'secondary';
		action.toggleClassName('ash-local-transcription-model-install-progress', installing);
		if (!installing) action.toggleClassName('awaiting-pointer-exit', false);
		if (progress === undefined) action.domNode.style.removeProperty('--ash-dictation-download-progress');
		else action.domNode.style.setProperty('--ash-dictation-download-progress', `${progress * 100}%`);
		setAriaAttribute(action.domNode, 'label', installing ? row.cancelLabel.textContent : undefined);
		if (installing) {
			if (action.domNode.getAttribute('aria-description') !== modelState) action.domNode.setAttribute('aria-description', modelState);
		} else {
			action.domNode.removeAttribute('aria-description');
		}
	}

	private async cancelPreparation(model: string): Promise<void> {
		try { await this.localTranscription.cancelModel(model); }
		catch (error) { if (!this.isDisposed) this.status.setMessage(String(error)); }
	}

	private async confirmUninstall(row: ModelRow): Promise<void> {
		const model = row.snapshot.model;
		if (this.confirmingRemoval.has(model)) return;
		this.confirmingRemoval.add(model);
		try {
			const result = await this.dialogs.confirm({
				message: localize('dictation.model.uninstallDetail', 'Uninstall {0}?', model),
				primaryButton: localize('dictation.model.uninstall', 'Uninstall'),
				custom: true,
				destructive: true,
			});
			if (result.confirmed && !this.isDisposed && this.visible && this.rows.get(model)?.snapshot.available) {
				await this.perform(model, 'uninstall', () => this.localTranscription.deleteModel(model));
			}
		} catch (error) {
			if (!this.isDisposed) this.status.setMessage(String(error));
		} finally {
			this.confirmingRemoval.delete(model);
		}
	}

	private modelSize(model: ILocalTranscriptionModelSnapshot): string {
		return model.downloadSizeBytes === undefined ? '—' : localize('dictation.model.size', '{0} MiB', (model.downloadSizeBytes / (1024 * 1024)).toFixed(1));
	}

	private languageLabel(language: string): string {
		if (language === 'cmn') {
			return localize('dictation.model.language.cmn', 'Mandarin Chinese');
		}
		try {
			const locale = this.domNode.ownerDocument.documentElement.lang || 'en';
			return new Intl.DisplayNames([locale], { type: 'language' }).of(language) ?? language;
		} catch {
			return language;
		}
	}

	private modelState(model: ILocalTranscriptionModelSnapshot): string {
		if (this.pending.get(model.model) === 'uninstall') return localize('dictation.model.uninstalling', 'Uninstalling…');
		if (isModelPreparing(model.status) || model.status?.state === DictationModelState.Error) return modelProgressText(model);
		if (this.pending.get(model.model) === 'install') return modelPreparationText(DictationModelState.Checking);
		if (!model.available) return localize('dictation.model.notInstalled', 'Not installed');
		return model.model === this.selectedModel ? localize('dictation.model.readyState', 'Ready') : localize('dictation.model.installedState', 'Installed');
	}

	private async perform(model: string, operation: 'install' | 'uninstall', action: () => Promise<unknown>): Promise<void> {
		if (this.pending.has(model)) { return; }
		this.pending.set(model, operation);
		const row = this.rows.get(model);
		if (row) this.updateRow(row);
		if (operation === 'uninstall') announceStatus(localize('dictation.model.uninstallStarted', 'Uninstalling {0}…', model));
		try {
			await action();
			if (this.visible && !this.isDisposed) {
				await this.readLocalModels();
				if (operation === 'uninstall' && this.visible && !this.isDisposed) announceStatus(localize('dictation.model.uninstalled', '{0} was uninstalled.', model));
			}
		} catch (error) {
			if (!this.isDisposed) { this.status.setMessage(String(error)); }
			return;
		} finally {
			this.pending.delete(model);
			if (!this.isDisposed) {
				const current = this.rows.get(model);
				if (current) this.updateRow(current);
			}
		}
	}
}
