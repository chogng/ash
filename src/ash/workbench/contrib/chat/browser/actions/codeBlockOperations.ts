import { localize } from '../../../../../nls.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import type { ICodeBlockActionContext } from '../widget/chatContentParts/codeBlockPart.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { canceled } from '../../../../../base/common/errors.js';
import { extUri } from '../../../../../base/common/resources.js';
import type { TextEdit } from '../../../../../editor/common/languages.js';
import { EditSuggestionId } from '../../../../../editor/common/textModelEditSource.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { ICodeMapperService } from '../../common/editing/chatCodeMapperService.js';
import { IChatWidgetService } from '../chat.js';
import { reviewEdits } from './reviewEdits.js';

/** Inserts through the active file's existing Stanza model and undo stack. */
export class InsertCodeBlockOperation {
	constructor(
		@IEditorService private readonly editors: IEditorService,
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
		@IEditorPart private readonly editorPart: IEditorPart,
	) { }

	public async run(context: ICodeBlockActionContext): Promise<void> {
		const input = this.editors.activeEditor;
		const control = this.editorPart.activePane?.getControl();
		const editor = this.codeEditors.listCodeEditors().find(candidate => candidate === control)
			?? this.codeEditors.listDiffEditors().find(candidate => candidate === control)?.getModifiedEditor();
		if (!editor || !input) throw new Error(localize('chat.code.noEditor', 'Open a file editor and place the cursor where the code should be inserted.'));
		if (input.readOnly || editor.getOption(EditorOption.readOnly)) throw new Error(localize('chat.code.readOnly', 'The active file editor is read-only.'));
		const selections = editor.getSelections();
		if (!selections?.length || !context.code) return;
		editor.pushUndoStop();
		if (!editor.executeEdits('chat.insertCodeBlock', selections.map(range => ({ range, text: context.code })))) {
			throw new Error(localize('chat.code.insertFailed', 'The active editor could not insert this code block.'));
		}
		editor.pushUndoStop();
		this.editors.focusActiveEditor();
	}
}

/** Applies model-mapped batches through the same review owner as Agent workspace edits. */
export class ApplyCodeBlockOperation {
	constructor(
		@IEditorService private readonly editors: IEditorService,
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
		@IEditorPart private readonly editorPart: IEditorPart,
		@IChatWidgetService private readonly widgets: IChatWidgetService,
		@ICodeMapperService private readonly mapper: ICodeMapperService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IProgressService private readonly progress: IProgressService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) { }

	async run(context: ICodeBlockActionContext): Promise<void> {
		if (this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
		const widget = this.widgets.lastFocusedWidget;
		const response = widget?.getFocus();
		if (!widget?.visible || response !== context.element || !response?.feedbackSource || response.transient || !context.chatSessionResource) {
			throw new Error(localize('chat.code.mappingSource', 'Apply code from a completed reply to one open file at a time.'));
		}
		const input = this.editors.activeEditor;
		const control = this.editorPart.activePane?.getControl();
		const editor = this.codeEditors.listCodeEditors().find(candidate => candidate === control)
			?? this.codeEditors.listDiffEditors().find(candidate => candidate === control)?.getModifiedEditor();
		const model = editor?.getModel();
		if (!editor || !model || !input) throw new Error(localize('chat.code.noEditor', 'Open a file editor and place the cursor where the code should be inserted.'));
		if (input.readOnly || editor.getOption(EditorOption.readOnly)) throw new Error(localize('chat.code.readOnly', 'The active file editor is read-only.'));
		using cancellation = new CancellationTokenSource();
		await this.progress.withProgress({
			location: ProgressLocation.Notification,
			title: localize('chat.code.applying', 'Applying code to {0}', model.uri.path.split('/').at(-1) ?? model.uri.path),
			cancellable: true,
		}, async () => {
			if (widget.getFocus() !== response) throw canceled();
			const batches: TextEdit[][] = [];
			let ready = new DeferredPromise<void>();
			let done = false;
			let failure: unknown;
			const notify = () => { void ready.complete(undefined); };
			const token = cancellation.token;
			using cancelled = token.onCancellationRequested(notify);
			const stream: AsyncIterable<TextEdit[]> = {
				async *[Symbol.asyncIterator]() {
					for (; ;) {
						if (token.isCancellationRequested) throw canceled();
						const batch = batches.shift();
						if (batch) { yield batch; continue; }
						if (done) { if (failure) throw failure; return; }
						ready = new DeferredPromise<void>();
						await ready.p;
					}
				},
			};
			const mapping = this.mapper.mapCode({
				codeBlocks: [{ code: context.code, resource: model.uri }], chatRequestId: response.feedbackSource!.turnId,
				chatSessionResource: context.chatSessionResource, location: 'editor',
			}, {
				textEdit(resource, edits) {
					if (token.isCancellationRequested) throw canceled();
					if (!extUri.isEqual(resource, model.uri) || batches.length >= 256) throw new Error(localize('chat.code.mappingFormat', 'The model did not return a supported plain-text file.'));
					batches.push(edits);
					notify();
				},
			}, token).then(result => {
				if (!result || result.errorMessage) failure = new Error(result?.errorMessage ?? localize('chat.code.mappingFailed', 'The code mapping did not complete.'));
			}, error => { failure = error; }).finally(() => { done = true; notify(); });
			try {
				await this.instantiation.invokeFunction(reviewEdits, editor, stream, token, EditSuggestionId.newId());
				await mapping;
			} finally {
				cancellation.cancel();
				await mapping;
			}
		}, () => cancellation.cancel());
	}
}
