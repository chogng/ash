import { h, type IDimension } from '../../../../base/browser/dom.js';
import { alert as ariaAlert } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Range } from '../../../../editor/common/core/range.js';
import { localize } from '../../../../nls.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IGitService, type GitConflictFile, type GitConflictResolution } from '../../../services/git/common/gitService.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import type { IWorkingCopy } from '../../../services/workingCopy/common/workingCopyService.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import { TextFileEditor } from '../../files/browser/editors/textFileEditor.js';
import { hasMergeConflictMarkers, parseMergeConflictBlocks, type MergeConflictBlock } from '../common/mergeConflict.js';
import { isScmMergeEditorInput, SCM_MERGE_EDITOR_ID, type ScmMergeEditorInput } from './scmMergeEditorInput.js';
import { gitErrorMessage } from './scmError.js';

export const ScmMergeFocusedContext = new RawContextKey<boolean>('scmMergeEditorFocused', false);

/** Three index stages and one ordinary file-backed result editor. */
export class ScmMergeEditorPane extends Disposable implements IEditorPane {
	public readonly id = SCM_MERGE_EDITOR_ID;
	private readonly inputListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly blockButtons = this._register(new DisposableStore());
	private readonly fileChoiceStore = this._register(new DisposableStore());
	private readonly fileChoiceButtons: Button[] = [];
	private domNode!: HTMLDivElement;
	private sidesDomNode!: HTMLDivElement;
	private fileChoicesDomNode!: HTMLDivElement;
	private blocksDomNode!: HTMLDivElement;
	private resultDomNode!: HTMLDivElement;
	private statusDomNode!: HTMLDivElement;
	private finishButton!: Button;
	private input: ScmMergeEditorInput | undefined;
	private stageIds: readonly (string | null)[] | undefined;
	private resultObjectId: string | null | undefined;
	private busy = false;
	private resolved = false;
	private lastBlocksSignature: string | undefined;
	private lastBlockCount: number | undefined;
	private resultLoaded = false;
	private dimension: IDimension = { width: 0, height: 0 };

	constructor(
		private readonly resultEditor: TextFileEditor,
		@IGitService private readonly gitService: IGitService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
	) {
		super();
		this._register(resultEditor);
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
		this.sidesDomNode = h(document, 'div');
		this.sidesDomNode.className = 'ash-scm-merge-sides';
		this.fileChoicesDomNode = h(document, 'div');
		this.blocksDomNode = h(document, 'div');
		this.blocksDomNode.className = 'ash-scm-merge-blocks';
		const resultSection = h(document, 'section');
		resultSection.className = 'ash-scm-merge-result';
		const resultTitle = h(document, 'h3');
		resultTitle.textContent = localize({ bundle: 'ash', key: 'git.mergeResult' }, 'Result');
		this.resultDomNode = h(document, 'div');
		this.resultDomNode.className = 'ash-scm-merge-result-editor';
		this._register(observeElementSize(this.resultDomNode, size => {
			if (this.resultLoaded) this.resultEditor.layout(size);
		}));
		resultSection.append(resultTitle, this.resultDomNode);
		this.domNode.append(header, this.sidesDomNode, this.fileChoicesDomNode, this.blocksDomNode, resultSection);
		this.resultEditor.create(this.resultDomNode);
	}

	public async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (!isScmMergeEditorInput(input)) throw new TypeError('SCM merge editor requires a conflict input');
		const file = await this.gitService.conflictFile(input.path, input.repositoryId);
		if (signal.aborted) throw new Error('SCM merge editor loading was cancelled');
		this.clearInput();
		this.input = input;
		this.resolved = false;
		this.stageIds = file.stageIds;
		this.resultObjectId = file.resultObjectId;
		this.renderSides(file);
		if (file.current.kind !== 'text' || file.incoming.kind !== 'text' || file.result.kind !== 'text') this.renderFileChoices(file);
		if (file.result.kind === 'text') {
			this.finishButton.enabled = true;
			await this.resultEditor.setInput({ resource: input.resultResource, label: input.label }, signal);
			this.resultLoaded = true;
			const listeners = new DisposableStore();
			const copy = this.resultEditor.workingCopy;
			if (copy) listeners.add(copy.onDidChangeContent(() => this.renderBlocks()));
			this.inputListeners.value = listeners;
			this.resultEditor.layout(this.resultDimension());
			this.renderBlocks();
		} else {
			this.resultLoaded = false;
			this.finishButton.enabled = false;
			this.setStatus(localize({ bundle: 'ash', key: 'git.mergeNonText' }, 'Choose which file version to keep. This also stages the choice.'));
		}
	}

	public clearInput(): void {
		this.inputListeners.clear();
		this.blockButtons.clear();
		this.fileChoiceStore.clear();
		this.fileChoiceButtons.length = 0;
		this.resultEditor.clearInput();
		this.sidesDomNode?.replaceChildren();
		this.blocksDomNode?.replaceChildren();
		this.fileChoicesDomNode?.replaceChildren();
		this.input = undefined;
		this.stageIds = undefined;
		this.resultObjectId = undefined;
		this.resultLoaded = false;
		this.resolved = false;
		this.lastBlocksSignature = undefined;
		this.lastBlockCount = undefined;
		this.finishButton.enabled = false;
	}

	public layout(dimension: IDimension): void {
		this.dimension = dimension;
		if (this.resultLoaded) this.resultEditor.layout(this.resultDimension());
	}

	public setVisible(visibility: EditorPaneVisibility): void {
		this.domNode.hidden = visibility === EditorPaneVisibility.Hidden;
		this.resultEditor.setVisible(visibility);
	}

	public focus(): void {
		if (this.resultLoaded) this.resultEditor.focus();
		else this.sidesDomNode.querySelector<HTMLElement>('[tabindex]')?.focus();
	}

	public async save(): Promise<void> { await this.resultEditor.save(); }

	public getAccessibleContent(): string {
		const input = this.input;
		if (!input) return '';
		const sides = [...this.sidesDomNode.querySelectorAll('pre')].map(element => element.textContent ?? '');
		return [
			input.path,
			`${localize({ bundle: 'ash', key: 'git.mergeBase' }, 'Base')}\n${sides[0] ?? ''}`,
			`${localize({ bundle: 'ash', key: 'git.mergeCurrent' }, 'Current')}\n${sides[1] ?? ''}`,
			`${localize({ bundle: 'ash', key: 'git.mergeIncoming' }, 'Incoming')}\n${sides[2] ?? ''}`,
			`${localize({ bundle: 'ash', key: 'git.mergeResult' }, 'Result')}\n${this.resultEditor.getControl()?.getValue() ?? ''}`,
		].join('\n\n');
	}

	private resultDimension(): IDimension {
		return { width: Math.max(0, this.resultDomNode.clientWidth || this.dimension.width), height: Math.max(0, this.resultDomNode.clientHeight) };
	}

	private renderSides(file: GitConflictFile): void {
		this.sidesDomNode.replaceChildren();
		const labels = [
			localize({ bundle: 'ash', key: 'git.mergeBase' }, 'Base'),
			localize({ bundle: 'ash', key: 'git.mergeCurrent' }, 'Current'),
			localize({ bundle: 'ash', key: 'git.mergeIncoming' }, 'Incoming'),
		];
		for (const [index, content] of [file.base, file.current, file.incoming].entries()) {
			const section = h(this.domNode.ownerDocument, 'section');
			section.className = 'ash-scm-merge-side';
			const heading = h(this.domNode.ownerDocument, 'h3');
			heading.textContent = labels[index];
			const body = h(this.domNode.ownerDocument, 'pre');
			body.tabIndex = 0;
			body.setAttribute('aria-label', labels[index]);
			body.textContent = content.kind === 'text' ? content.text : content.kind === 'binary'
				? localize({ bundle: 'ash', key: 'git.mergeBinary' }, 'Binary file')
				: localize({ bundle: 'ash', key: 'git.mergeDeleted' }, 'File deleted');
			section.append(heading, body);
			this.sidesDomNode.append(section);
		}
	}

	private renderBlocks(): void {
		const text = this.resultEditor.getControl()?.getValue();
		if (text === undefined) return;
		const blocks = parseMergeConflictBlocks(text);
		if (this.lastBlockCount !== blocks.length) {
			this.setStatus(blocks.length === 0
				? localize({ bundle: 'ash', key: 'git.mergeNoBlocks' }, 'No conflict blocks remain. Review the result, then complete the merge.')
				: localize({ bundle: 'ash', key: 'git.mergeBlockCount' }, '{0} conflict blocks remain.', blocks.length));
			this.lastBlockCount = blocks.length;
		}
		const signature = JSON.stringify(blocks);
		if (signature === this.lastBlocksSignature) return;
		this.lastBlocksSignature = signature;
		this.blockButtons.clear();
		this.blocksDomNode.replaceChildren();
		for (const [index, block] of blocks.entries()) this.renderBlock(block, index);
	}

	private renderFileChoices(file: GitConflictFile): void {
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

	private async chooseFile(resolution: GitConflictResolution): Promise<void> {
		const input = this.input;
		const stageIds = this.stageIds;
		const resultObjectId = this.resultObjectId;
		if (!input || !stageIds || resultObjectId === undefined || this.busy || this.resolved) return;
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
			await this.gitService.completeConflict(input.path, stageIds, resultObjectId, resolution, input.repositoryId);
			this.resolved = true;
			this.fileChoiceStore.clear();
			this.fileChoicesDomNode.replaceChildren();
			this.blockButtons.clear();
			this.blocksDomNode.replaceChildren();
			this.resultEditor.clearInput();
			this.resultLoaded = false;
			this.finishButton.enabled = false;
			this.setStatus(localize({ bundle: 'ash', key: 'git.mergeCompleted' }, 'Merge completed and result staged.'));
		} catch (error) {
			const message = gitErrorMessage(error);
			this.setStatus(message);
			ariaAlert(message);
		} finally {
			this.busy = false;
			if (!this.resolved) for (const button of this.fileChoiceButtons) button.enabled = true;
		}
	}

	private renderBlock(block: MergeConflictBlock, index: number): void {
		const document = this.domNode.ownerDocument;
		const section = h(document, 'section');
		section.className = 'ash-scm-merge-block';
		const heading = h(document, 'h4');
		heading.textContent = localize({ bundle: 'ash', key: 'git.mergeBlock' }, 'Conflict {0}', index + 1);
		const sources = h(document, 'div');
		sources.className = 'ash-scm-merge-block-sources';
		for (const [label, value] of [
			[localize({ bundle: 'ash', key: 'git.mergeCurrent' }, 'Current'), block.current],
			[localize({ bundle: 'ash', key: 'git.mergeIncoming' }, 'Incoming'), block.incoming],
		] as const) {
			const source = h(document, 'pre');
			source.setAttribute('aria-label', label);
			source.textContent = value;
			sources.append(source);
		}
		const actions = h(document, 'div');
		actions.className = 'ash-scm-merge-block-actions';
		for (const [label, value] of [
			[localize({ bundle: 'ash', key: 'git.acceptCurrent' }, 'Accept Current'), block.current],
			[localize({ bundle: 'ash', key: 'git.acceptIncoming' }, 'Accept Incoming'), block.incoming],
			[localize({ bundle: 'ash', key: 'git.acceptBoth' }, 'Accept Both'), block.current + block.incoming],
		] as const) {
			this.blockButtons.add(new Button(actions, { label, onClick: () => this.acceptBlock(block, value) }));
		}
		section.append(heading, sources, actions);
		this.blocksDomNode.append(section);
	}

	private acceptBlock(block: MergeConflictBlock, value: string): void {
		const control = this.resultEditor.getControl();
		if (!control) return;
		const text = control.getValue();
		if (!parseMergeConflictBlocks(text).some(candidate => candidate.start === block.start && candidate.end === block.end && candidate.current === block.current && candidate.incoming === block.incoming)) {
			this.renderBlocks();
			return;
		}
		const model = control.getModel();
		if (!model) return;
		control.executeEdits('mergeEditor', [{ range: Range.fromPositions(model.positionAt(block.start), model.positionAt(block.end)), text: value }]);
	}

	private async completeMerge(): Promise<void> {
		const input = this.input;
		const stageIds = this.stageIds;
		const control = this.resultEditor.getControl();
		if (!input || !stageIds || !control || this.busy || this.resolved) return;
		if (hasMergeConflictMarkers(control.getValue())) {
			this.setStatus(localize({ bundle: 'ash', key: 'git.mergeUnresolved' }, 'Resolve every conflict marker before completing the merge.'));
			this.focus();
			return;
		}
		this.busy = true;
		this.finishButton.enabled = false;
		control.updateOptions({ readOnly: true });
		try {
			if (this.resultEditor.hasExternalChange) throw new Error(localize({ bundle: 'ash', key: 'git.mergeFileChanged' }, 'The result file changed outside this editor. Review it before completing the merge.'));
			if (this.resultEditor.isDirty) await this.resultEditor.save();
			const saved = await this.gitService.conflictFile(input.path, input.repositoryId);
			if (JSON.stringify(saved.stageIds) !== JSON.stringify(stageIds) || saved.result.kind !== 'text' || saved.result.text !== control.getValue()) {
				throw new Error(localize({ bundle: 'ash', key: 'git.mergeIndexChanged' }, 'The conflict changed in Git. Reopen this merge editor to review the new versions.'));
			}
			await this.gitService.completeConflict(input.path, stageIds, saved.resultObjectId, { kind: 'edited', text: control.getValue() }, input.repositoryId);
			this.resolved = true;
			this.setStatus(localize({ bundle: 'ash', key: 'git.mergeCompleted' }, 'Merge completed and result staged.'));
		} catch (error) {
			const message = gitErrorMessage(error);
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
