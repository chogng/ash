import { h, type IDimension } from '../../../../base/browser/dom.js';
import { alert as ariaAlert } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import { localize } from '../../../../nls.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISCMService, type ISCMConflictFile, type ISCMConflictProvider, type ISCMConflictResolution } from '../common/scm.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import type { IWorkingCopy } from '../../../services/workingCopy/common/workingCopyService.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import { TextFileEditor } from '../../files/browser/editors/textFileEditor.js';
import { MergeEditor, MergeEditorModel } from '../../mergeEditor/browser/mergeEditor.js';
import { hasMergeConflictMarkers, parseMergeConflictBlocks } from '../common/mergeConflict.js';
import { isScmMergeEditorInput, SCM_MERGE_EDITOR_ID, type ScmMergeEditorInput } from './scmMergeEditorInput.js';

export const ScmMergeFocusedContext = new RawContextKey<boolean>('scmMergeEditorFocused', false);

/** Three index stages and one ordinary file-backed result editor. */
export class ScmMergeEditorPane extends Disposable implements IEditorPane {
	public readonly id = SCM_MERGE_EDITOR_ID;
	private readonly inputListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly modelSlot = this._register(new MutableDisposable<MergeEditorModel>());
	private readonly fileChoiceStore = this._register(new DisposableStore());
	private readonly fileChoiceButtons: Button[] = [];
	private readonly mergeView: MergeEditor;
	private domNode!: HTMLDivElement;
	private fileChoicesDomNode!: HTMLDivElement;
	private statusDomNode!: HTMLDivElement;
	private finishButton!: Button;
	private input: ScmMergeEditorInput | undefined;
	private conflictProvider: ISCMConflictProvider | undefined;
	private stageIds: readonly (string | null)[] | undefined;
	private resultObjectId: string | null | undefined;
	private busy = false;
	private resolved = false;
	private lastBlockCount: number | undefined;
	private resultLoaded = false;
	private mergeStateKey: string | undefined;
	private storedHandledState: string | undefined;

	constructor(
		private readonly resultEditor: TextFileEditor,
		@ISCMService private readonly scmService: ISCMService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.mergeView = this._register(instantiationService.createInstance(MergeEditor, resultEditor));
	}

	public get workingCopy(): IWorkingCopy | undefined { return this.resultEditor.workingCopy; }

	public create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-scm-merge-editor';
		this.domNode.setAttribute('role', 'region');
		this.updateAriaLabel();
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.ScmMerge)) this.updateAriaLabel();
		}));
		parent.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const scopedContext = this._register(this.contextKeys.createScoped(this.domNode));
		ScmMergeFocusedContext.bindTo(scopedContext).set(true);

		const header = h(document, 'header');
		header.className = 'ash-scm-merge-header';
		const title = h(document, 'h2');
		title.textContent = localize({ bundle: 'ash', key: 'git.mergeTitle' }, 'Resolve merge conflict');
		this.statusDomNode = h(document, 'div');
		this.statusDomNode.className = 'ash-scm-merge-status';
		this.statusDomNode.setAttribute('role', 'status');
		this.statusDomNode.setAttribute('aria-live', 'polite');
		const actions = h(document, 'div');
		actions.className = 'ash-scm-merge-actions';
		this.finishButton = this._register(new Button(actions, {
			label: localize({ bundle: 'ash', key: 'git.completeMerge' }, 'Complete Merge'),
			presentation: 'primary',
			onClick: () => void this.completeMerge(),
		}));
		header.append(title, this.statusDomNode, actions);
		this.fileChoicesDomNode = h(document, 'div');
		this.domNode.append(header, this.fileChoicesDomNode);
		this.mergeView.create(this.domNode);
	}

	public async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (!isScmMergeEditorInput(input)) throw new TypeError('SCM merge editor requires a conflict input');
		const conflictProvider = this.scmService.getRepository(input.repositoryId)?.provider.mergeProvider;
		if (!conflictProvider) throw new Error(`SCM repository '${input.repositoryId}' cannot resolve merge conflicts`);
		const file = await conflictProvider.resolve(input.path);
		if (signal.aborted) throw new Error('SCM merge editor loading was cancelled');
		this.clearInput();
		this.input = input;
		this.conflictProvider = conflictProvider;
		this.mergeStateKey = `ash.scm.merge.${digest(`${input.repositoryId}\0${input.path}`)}`;
		this.resolved = false;
		this.stageIds = file.stageIds;
		this.resultObjectId = file.resultObjectId;
		if (file.current.kind !== 'text' || file.incoming.kind !== 'text' || file.result.kind !== 'text') this.renderFileChoices(file);
		const hasTextSources = file.current.kind === 'text' && file.incoming.kind === 'text' && file.base.kind !== 'binary';
		if (!hasTextSources || file.result.kind !== 'text') {
			this.mergeView.showUnavailableSources(
				this.sourceText(file.base),
				this.sourceText(file.current),
				this.sourceText(file.incoming),
				file.result.kind === 'text' ? undefined : this.sourceText(file.result),
			);
		}
		if (file.result.kind === 'text') {
			this.finishButton.enabled = true;
			await this.resultEditor.setInput({ resource: input.resultResource, label: input.label }, signal);
			this.resultLoaded = true;
			const listeners = new DisposableStore();
			const copy = this.resultEditor.workingCopy;
			if (copy) listeners.add(copy.onDidChangeContent(() => this.updateStatus()));
			this.inputListeners.value = listeners;
			if (hasTextSources) {
				const resultModel = this.resultEditor.getControl()?.getModel();
				if (!resultModel) throw new Error('Merge result model is not loaded');
				const model = this.modelSlot.value = this.createModel(file, resultModel);
				await model.initialize(signal);
				if (signal.aborted) throw new Error('SCM merge editor loading was cancelled');
				this.mergeView.setModel(model);
				listeners.add(model.onDidChange(() => {
					this.updateStatus();
					if (model.isReady) this.saveMergeState(model);
				}));
				if (copy) listeners.add(copy.onDidChangeDirty(() => {
					if (!copy.isDirty) this.saveMergeState(model);
				}));
				this.saveMergeState(model);
			}
			this.updateStatus();
		} else {
			this.resultLoaded = false;
			this.finishButton.enabled = false;
			this.setStatus(localize({ bundle: 'ash', key: 'git.mergeNonText' }, 'Choose which file version to keep. This also stages the choice.'));
		}
	}

	public clearInput(): void {
		this.inputListeners.clear();
		this.fileChoiceStore.clear();
		this.fileChoiceButtons.length = 0;
		this.mergeView.clearInput();
		this.modelSlot.clear();
		this.fileChoicesDomNode?.replaceChildren();
		this.input = undefined;
		this.conflictProvider = undefined;
		this.stageIds = undefined;
		this.resultObjectId = undefined;
		this.resultLoaded = false;
		this.mergeStateKey = undefined;
		this.storedHandledState = undefined;
		this.resolved = false;
		this.lastBlockCount = undefined;
		this.finishButton.enabled = false;
	}

	public layout(dimension: IDimension): void {
		this.mergeView.layout(dimension);
	}

	public setVisible(visibility: EditorPaneVisibility): void {
		this.domNode.hidden = visibility === EditorPaneVisibility.Hidden;
		this.mergeView.setVisible(visibility);
	}

	public focus(): void {
		if (this.resultLoaded) this.mergeView.focus();
		else this.fileChoiceButtons[0]?.focus();
	}

	public async save(): Promise<void> { await this.resultEditor.save(); }

	public getAccessibleContent(): string {
		const input = this.input;
		if (!input) return '';
		return `${input.path}\n\n${this.mergeView.getAccessibleContent()}`;
	}

	private sourceText(content: ISCMConflictFile['base']): string {
		return content.kind === 'text' ? content.text : content.kind === 'binary'
			? localize({ bundle: 'ash', key: 'git.mergeBinary' }, 'Binary file')
			: localize({ bundle: 'ash', key: 'git.mergeDeleted' }, 'File deleted');
	}

	private createModel(file: ISCMConflictFile, result: TextModel): MergeEditorModel {
		return this.instantiationService.createInstance(
			MergeEditorModel,
			file.base.kind === 'text' ? file.base.text : '',
			file.current.kind === 'text' ? file.current.text : '',
			file.incoming.kind === 'text' ? file.incoming.text : '',
			result,
			this.loadMergeState(file, result),
		);
	}

	private loadMergeState(file: ISCMConflictFile, result: TextModel): readonly boolean[] | undefined {
		const raw = this.mergeStateKey && this.storageService.get(this.mergeStateKey, StorageScope.WORKSPACE);
		if (!raw) return undefined;
		let value: unknown;
		try { value = JSON.parse(raw); } catch { return undefined; }
		if (!value || typeof value !== 'object') return undefined;
		const state = value as Record<string, unknown>;
		if (state.version !== 1 || state.resultHash !== digest(result.getValue())) return undefined;
		if (!Array.isArray(state.stageIds) || state.stageIds.length !== file.stageIds.length || !state.stageIds.every((id, index) => id === file.stageIds[index])) return undefined;
		if (!Array.isArray(state.handled) || !state.handled.every(flag => typeof flag === 'boolean')) return undefined;
		return state.handled;
	}

	private saveMergeState(model: MergeEditorModel): void {
		if (!this.mergeStateKey || !this.stageIds || !model.isReady) return;
		const handledStates = model.getHandledState();
		const handled = JSON.stringify(handledStates);
		if (this.resultEditor.isDirty && this.storedHandledState === handled) return;
		this.storageService.store(this.mergeStateKey, JSON.stringify({
			version: 1,
			stageIds: this.stageIds,
			resultHash: digest(model.result.getValue()),
			handled: handledStates,
		}), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.storedHandledState = handled;
	}

	private updateStatus(): void {
		const text = this.resultEditor.getControl()?.getValue();
		if (text === undefined) return;
		const model = this.modelSlot.value;
		if (model?.error) {
			this.setStatus(model.error.message);
			return;
		}
		const unresolved = model?.isReady ? model.hunks.filter(hunk => hunk.unresolved).length : parseMergeConflictBlocks(text).length;
		if (this.lastBlockCount !== unresolved) {
			this.setStatus(unresolved === 0
				? localize({ bundle: 'ash', key: 'git.mergeNoBlocks' }, 'All conflicts are handled. Review the result, then complete the merge.')
				: localize({ bundle: 'ash', key: 'git.mergeBlockCount' }, '{0} conflicts remain.', unresolved));
			this.lastBlockCount = unresolved;
		}
	}

	private renderFileChoices(file: ISCMConflictFile): void {
		this.fileChoiceStore.clear();
		this.fileChoiceButtons.length = 0;
		this.fileChoicesDomNode.replaceChildren();
		const actions = h(this.domNode.ownerDocument, 'div');
		actions.className = 'ash-scm-merge-file-choices';
		this.fileChoiceButtons.push(this.fileChoiceStore.add(new Button(actions, {
			label: file.current.kind === 'missing'
				? localize({ bundle: 'ash', key: 'git.keepCurrentDeletion' }, 'Keep Current Deletion')
				: localize({ bundle: 'ash', key: 'git.useCurrentFile' }, 'Use Current File'),
			onClick: () => void this.chooseFile({ kind: 'current' }),
		})));
		this.fileChoiceButtons.push(this.fileChoiceStore.add(new Button(actions, {
			label: file.incoming.kind === 'missing'
				? localize({ bundle: 'ash', key: 'git.keepIncomingDeletion' }, 'Keep Incoming Deletion')
				: localize({ bundle: 'ash', key: 'git.useIncomingFile' }, 'Use Incoming File'),
			onClick: () => void this.chooseFile({ kind: 'incoming' }),
		})));
		this.fileChoicesDomNode.append(actions);
	}

	private async chooseFile(resolution: ISCMConflictResolution): Promise<void> {
		const input = this.input;
		const provider = this.conflictProvider;
		const stageIds = this.stageIds;
		const resultObjectId = this.resultObjectId;
		if (!input || !provider || !stageIds || resultObjectId === undefined || this.busy || this.resolved) return;
		this.busy = true;
		for (const button of this.fileChoiceButtons) button.enabled = false;
		try {
			if (this.resultEditor.isDirty) {
				const decision = await this.dialogs.confirm({
					message: localize({ bundle: 'ash', key: 'git.replaceUnsavedMergeResult' }, 'Replace your unsaved result edits with the selected file version?'),
					primaryButton: localize({ bundle: 'ash', key: 'git.replaceMergeResult' }, 'Replace Result'),
				});
				if (!decision.confirmed) return;
			}
			await provider.complete(input.path, stageIds, resultObjectId, resolution);
			if (this.mergeStateKey) this.storageService.remove(this.mergeStateKey, StorageScope.WORKSPACE);
			this.resolved = true;
			this.fileChoiceStore.clear();
			this.fileChoicesDomNode.replaceChildren();
			this.mergeView.clearInput();
			this.modelSlot.clear();
			this.resultLoaded = false;
			this.finishButton.enabled = false;
			this.setStatus(localize({ bundle: 'ash', key: 'git.mergeCompleted' }, 'Merge completed and result staged.'));
		} catch (error) {
			const message = provider.errorMessage(error);
			this.setStatus(message);
			ariaAlert(message);
		} finally {
			this.busy = false;
			if (!this.resolved) for (const button of this.fileChoiceButtons) button.enabled = true;
		}
	}

	private async completeMerge(): Promise<void> {
		const input = this.input;
		const provider = this.conflictProvider;
		const stageIds = this.stageIds;
		const control = this.resultEditor.getControl();
		if (!input || !provider || !stageIds || !control || this.busy || this.resolved) return;
		const model = this.modelSlot.value;
		if (hasMergeConflictMarkers(control.getValue()) || (model && (!model.isReady || model.unresolvedCount > 0))) {
			this.setStatus(localize({ bundle: 'ash', key: 'git.mergeUnresolved' }, 'Review or resolve every conflict before completing the merge.'));
			this.focus();
			return;
		}
		this.busy = true;
		this.finishButton.enabled = false;
		control.updateOptions({ readOnly: true });
		try {
			if (this.resultEditor.hasExternalChange) throw new Error(localize({ bundle: 'ash', key: 'git.mergeFileChanged' }, 'The result file changed outside this editor. Review it before completing the merge.'));
			if (this.resultEditor.isDirty) await this.resultEditor.save();
			const saved = await provider.resolve(input.path);
			if (JSON.stringify(saved.stageIds) !== JSON.stringify(stageIds) || saved.result.kind !== 'text' || saved.result.text !== control.getValue()) {
				throw new Error(localize({ bundle: 'ash', key: 'git.mergeIndexChanged' }, 'The conflict changed in Git. Reopen this merge editor to review the new versions.'));
			}
			await provider.complete(input.path, stageIds, saved.resultObjectId, { kind: 'edited', text: control.getValue() });
			if (this.mergeStateKey) this.storageService.remove(this.mergeStateKey, StorageScope.WORKSPACE);
			this.resolved = true;
			this.setStatus(localize({ bundle: 'ash', key: 'git.mergeCompleted' }, 'Merge completed and result staged.'));
		} catch (error) {
			const message = provider.errorMessage(error);
			this.setStatus(message);
			ariaAlert(message);
		} finally {
			control.updateOptions({ readOnly: false });
			this.busy = false;
			this.finishButton.enabled = !this.resolved;
		}
	}

	private setStatus(message: string): void { this.statusDomNode.textContent = message; }

	private updateAriaLabel(): void {
		const title = localize({ bundle: 'ash', key: 'git.mergeTitle' }, 'Resolve merge conflict');
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.ScmMerge);
		this.domNode.setAttribute('aria-label', hint ? `${title}. ${hint}` : title);
	}
}

function digest(value: string): string {
	const hash = new StringSHA1();
	hash.update(value);
	return hash.digest();
}
