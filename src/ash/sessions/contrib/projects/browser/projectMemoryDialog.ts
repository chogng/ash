import { addDisposableListener, getActiveElement, getWindow, h, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { EditorCoreCommandId } from '../../../../editor/browser/coreCommands.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EndOfLinePreference, type ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IMemoriesService, Memory, MemoryScope, MemorySummary } from '../../../../platform/memories/common/memoriesService.js';
import { defaultButtonStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../../workbench/browser/parts/dialogs/dialog.js';
import type { CatalogProjectMemoryEditor } from '../../chat/browser/chatListModel.js';

type ProjectMemorySource =
	| { readonly scope: MemoryScope; readonly memories: IMemoriesService; }
	| { readonly open: (signal: AbortSignal) => Promise<CatalogProjectMemoryEditor>; };

/** Edits local memory records or a project memory document supplied by the catalog. */
export class ProjectMemoryDialog extends Disposable {
	private readonly dialog: Dialog;
	private readonly pickerRow: HTMLElement;
	private readonly picker: SelectBox;
	private readonly more: Button;
	private readonly retryRow: HTMLElement;
	private readonly title: InputBox;
	private readonly initialTitle: string;
	private readonly bodyModel: ITextModel;
	private readonly bodyEditor: CodeEditorWidget;
	private readonly fields: HTMLElement;
	private readonly feedback: HTMLElement;
	private readonly status: HTMLElement;
	private readonly validation: HTMLElement;
	private readonly save: Button;
	private readonly cancel: Button;
	private entries: readonly MemorySummary[] = [];
	private cursor: string | undefined;
	private selected: Memory | undefined;
	private catalogMemory: CatalogProjectMemoryEditor | undefined;
	private loaded = false;
	private retryLoad: (() => Promise<void>) | undefined;
	private busy = false;
	private saving = false;
	private commandId = generateUuid();

	constructor(owner: HTMLElement, private readonly source: ProjectMemorySource | undefined,
		@IModelService models: IModelService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const document = owner.ownerDocument;
		const form = h(document, 'form', { className: 'ash-projects-form' });
		form.id = generateUuid();
		const pickerRow = this.pickerRow = h(document, 'div', { className: 'ash-project-memory-picker' });
		this.status = h(document, 'p', { className: 'ash-projects-muted', attributes: { role: 'status' } });
		this.fields = h(document, 'div', { className: 'ash-projects-form' });
		this.validation = h(document, 'p', { className: 'ash-projects-form-error', attributes: { role: 'status' } });
		this.feedback = h(document, 'p', { className: 'ash-projects-form-error', attributes: { role: 'alert' } });
		const retryRow = this.retryRow = h(document, 'div', { properties: { hidden: true } });
		form.append(pickerRow, this.status, this.fields, this.validation, this.feedback, retryRow);
		const statusText = h(document, 'span', { attributes: { role: 'status' } });
		const memoryStatus = h(document, 'div', { className: 'ash-project-memory-status', properties: { hidden: true } });
		appendIcon(Lxicon.brain, memoryStatus);
		memoryStatus.append(statusText);
		const actions = h(document, 'div', { className: 'ash-sessions-form-actions' });
		const footer = h(document, 'div', { className: 'ash-project-creation-footer' }, memoryStatus, actions);
		this.dialog = this._register(new Dialog(owner, localize('projects.projectMemories', 'Project memory'), [], createWorkbenchDialogOptions({
			extraClasses: ['ash-projects-dialog', 'ash-project-memory-dialog'],
			layout: 'form',
			modal: false,
			closeOnBackdropClick: true,
			disableDefaultAction: true,
			canClose: () => !this.saving,
			shouldConfirmDiscard: () => this.dirty,
			renderBody: body => body.append(form),
			renderFooter: container => container.append(footer),
		})));
		this.picker = this._register(new SelectBox(pickerRow, {
			options: [],
			ariaLabel: localize('projects.savedMemories', 'Saved memories'),
			presentation: 'field',
		}, defaultSelectBoxStyles));
		this.more = this._register(new Button(pickerRow, {
			label: localize('projects.moreMemories', 'Load more memories'),
			size: 'small',
			onClick: () => void this.loadPage(this.cursor),
		}));
		this._register(new Button(retryRow, {
			label: localize('projects.retry', 'Try again'),
			presentation: 'secondary',
			onClick: () => void this.retryLoad?.(),
		}));
		const titleLabel = h(document, 'label', {}, localize('projects.textTitle', 'Title'));
		const titleField = h(document, 'div', { className: 'ash-project-form-field' }, titleLabel);
		titleField.hidden = !source || !('memories' in source);
		this.title = this._register(new InputBox(titleField, { presentation: 'field', inputBoxStyles: defaultInputBoxStyles }));
		this.title.inputElement.id = titleLabel.htmlFor = generateUuid();
		this.initialTitle = this.title.value = localize('projects.projectMemories', 'Project memory');
		const contentLabel = localize('projects.textContent', 'Content');
		const bodyLabel = h(document, 'label', {}, contentLabel);
		const viewport = h(document, 'div', { className: 'ash-project-text-viewport' });
		const host = h(document, 'div', { className: 'ash-project-memory-editor' }, viewport);
		const bodyField = h(document, 'div', { className: 'ash-project-form-field' }, bodyLabel, host);
		const style = getWindow(owner).getComputedStyle(owner);
		const fontSize = Number.parseFloat(style.fontSize);
		this.bodyModel = this._register(models.createModel('', null, undefined, true));
		this.bodyEditor = this._register(instantiation.createInstance(CodeEditorWidget, {
			container: viewport,
			model: this.bodyModel,
			presentation: 'embedded',
			ariaLabel: contentLabel,
			fontFamily: style.fontFamily,
			fontSize,
			lineHeight: Math.round(fontSize * 1.5),
			automaticLayout: true,
			tabFocusMode: true,
			multiCursorLimit: 1,
			lineDecorationsWidth: 0,
			folding: false,
			glyphMargin: false,
			overviewRulerLanes: 0,
			wordWrap: 'on',
			scrollBeyondLastLine: false,
			padding: { top: 12, bottom: 12 },
			contributionIds: [EditorCoreCommandId.selectAll, 'editor.contrib.codeServices'],
		}));
		const bodyInput = this.bodyEditor.controller.textArea ?? this.bodyEditor.controller.element;
		bodyInput.id = bodyLabel.htmlFor = generateUuid();
		this.fields.append(titleField, bodyField);
		this.cancel = this._register(new Button(actions, {
			...defaultButtonStyles,
			label: localize('projects.cancel', 'Cancel'),
			presentation: 'secondary',
			onClick: () => void this.dialog.requestClose(),
		}));
		this.save = this._register(new Button(actions, {
			...defaultButtonStyles,
			label: localize('projects.saveMemory', 'Save'),
			presentation: 'primary',
			type: 'submit',
			enabled: false,
		}));
		this.save.domNode.setAttribute('form', form.id);
		this._register(addDisposableListener(form, 'submit', event => {
			event.preventDefault();
			void this.saveMemory();
		}));
		this._register(this.picker.onDidSelect(({ value }) => {
			const entry = this.entries.find(memory => memory.id === value);
			if (entry) void this.loadMemory(entry);
		}));
		const edited = () => {
			this.commandId = generateUuid();
			this.updateControls();
		};
		this._register(this.title.onDidChange(edited));
		this._register(this.bodyModel.onDidChangeContent(edited));
		if (source && 'memories' in source) void source.memories.readModelMemoryEnabled().then(({ chat: enabled }) => {
			if (this.isDisposed || enabled === undefined) return;
			statusText.textContent = enabled ? localize('projects.memoryOn', 'Memory is on') : localize('projects.memoryOff', 'Memory is off');
			memoryStatus.hidden = false;
		}, () => undefined);
		this.updateControls();
	}

	show(): Promise<unknown> {
		if (this.source && 'memories' in this.source) void this.loadPage();
		const result = this.dialog.show();
		if (this.source && 'open' in this.source) {
			// Keep keyboard focus on a stable control while the remote editor loads.
			this.cancel.focus();
			const { open } = this.source;
			const controller = new AbortController();
			this._register(toDisposable(() => controller.abort()));
			const load = async () => {
				await this.load(async () => {
					const memory = await open(controller.signal);
					if (this.isDisposed) return;
					this.catalogMemory = memory;
					this.bodyModel.setValue(memory.body);
					this.loaded = true;
				}, load);
				if (this.isDisposed) return;
				this._register(scheduleAtNextAnimationFrame(getWindow(this.fields), () => {
					const document = this.fields.ownerDocument;
					const focused = getActiveElement(document);
					if (focused === document.body || (this.loaded && focused === this.cancel.domNode)) this.bodyEditor.focus();
				}));
			};
			void load();
		}
		return result;
	}

	private get bodyValue(): string {
		return this.bodyModel.getValue(EndOfLinePreference.LF);
	}

	private get canEdit(): boolean {
		if (!this.loaded) return false;
		if (this.source && 'memories' in this.source) return !!this.selected || !this.entries.length;
		return !!this.catalogMemory?.save;
	}

	private get dirty(): boolean {
		if (!this.canEdit) return false;
		const originalBody = this.selected?.body ?? this.catalogMemory?.body ?? '';
		return this.bodyValue !== originalBody.replace(/\r\n?/g, '\n')
			|| this.title.value !== (this.selected?.title ?? this.initialTitle);
	}

	private updateControls(): void {
		const dirty = this.dirty;
		const local = this.source && 'memories' in this.source;
		const body = this.bodyValue;
		const valid = new TextEncoder().encode(body).length <= 16384
			&& (!local || (!!this.title.value.trim() && Array.from(this.title.value).length <= 256 && !!body.trim()));
		this.pickerRow.hidden = !this.entries.length;
		this.picker.enabled = !this.busy && !dirty;
		this.more.hidden = !this.cursor;
		this.more.enabled = !this.busy && !dirty;
		this.retryRow.hidden = !this.retryLoad;
		const readOnly = this.busy || !this.canEdit;
		this.title.readOnly = readOnly;
		this.bodyEditor.updateOptions({ readOnly, domReadOnly: readOnly });
		this.save.hidden = !this.source || (this.loaded && !this.canEdit);
		this.save.enabled = !this.busy && dirty && valid;
		const status = !this.source ? localize('projects.memoryEditingUnavailable', 'Project memory editing is unavailable.')
			: !this.loaded && this.busy ? localize('projects.loadingMemories', 'Loading project memory…')
				: this.catalogMemory?.storageDescription
				?? (this.loaded && local && !this.entries.length ? localize('projects.createFirstMemory', 'Enter content to save the first memory for this project.') : '');
		this.status.hidden = !status;
		if (this.status.textContent !== status) this.status.textContent = status;
		const validation = dirty && !valid ? (local
			? localize('projects.invalidMemory', 'Enter a title of up to 256 characters and content of up to 16 KiB.')
			: localize('projects.memoryContentTooLong', 'Keep the project memory to 16 KiB or less.')) : '';
		if (this.validation.textContent !== validation) this.validation.textContent = validation;
	}

	private async loadPage(cursor?: string): Promise<void> {
		if (!this.source || !('memories' in this.source)) return;
		const { memories, scope } = this.source;
		await this.load(async () => {
			const page = await memories.list(scope, undefined, cursor);
			if (this.isDisposed) return;
			this.entries = [...new Map([...this.entries, ...page.memories].map(memory => [memory.id, memory])).values()];
			this.cursor = page.cursor;
			this.picker.setOptions(this.entries.map(memory => ({ value: memory.id, label: memory.title })));
			if (!this.selected && this.entries[0]) await this.read(this.entries[0]);
			this.loaded = true;
		}, () => this.loadPage(cursor));
	}

	private async loadMemory(entry: MemorySummary): Promise<void> {
		await this.load(() => this.read(entry), () => this.loadMemory(entry));
		const document = this.fields.ownerDocument;
		if (!this.isDisposed && this.picker.enabled && getActiveElement(document) === document.body) this.picker.focus();
	}

	private async read(entry: MemorySummary): Promise<void> {
		if (!this.source || !('memories' in this.source)) return;
		const memory = await this.source.memories.read(entry);
		if (this.isDisposed) return;
		this.selected = memory;
		this.picker.value = memory.id;
		this.title.value = memory.title;
		this.bodyModel.setValue(memory.body);
		this.loaded = true;
	}

	private async load(operation: () => Promise<void>, retry: () => Promise<void>): Promise<void> {
		if (this.busy || this.dirty) return;
		this.busy = true;
		this.feedback.textContent = '';
		this.retryLoad = undefined;
		this.updateControls();
		try {
			await operation();
		} catch (error) {
			if (this.isDisposed) return;
			this.picker.value = this.selected?.id;
			this.feedback.textContent = toErrorMessage(error);
			this.retryLoad = retry;
		} finally {
			this.busy = false;
			if (!this.isDisposed) this.updateControls();
		}
	}

	private async saveMemory(): Promise<void> {
		if (!this.source || !this.save.enabled) return;
		this.busy = this.saving = true;
		this.feedback.textContent = '';
		this.updateControls();
		try {
			if ('memories' in this.source) {
				const { memories, scope } = this.source;
				if (this.selected) await memories.update(this.selected, this.title.value, this.bodyValue, this.commandId);
				else await memories.add(scope, this.title.value, this.bodyValue, this.commandId);
			} else {
				await this.catalogMemory?.save?.(this.bodyValue);
			}
			if (!this.isDisposed) this.dialog.dispose();
		} catch (error) {
			if (!this.isDisposed) this.feedback.textContent = toErrorMessage(error);
		} finally {
			this.busy = this.saving = false;
			if (!this.isDisposed && !this.dialog.isDisposed) {
				this.updateControls();
				const document = this.fields.ownerDocument;
				if (this.save.enabled && getActiveElement(document) === document.body) this.save.focus();
			}
		}
	}
}
