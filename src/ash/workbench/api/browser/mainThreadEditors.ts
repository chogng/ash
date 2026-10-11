import { URI } from '../../../base/common/uri.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { IEditorPart } from '../../browser/parts/editor/editorPart.js';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceOpenService } from '../../services/workspaces/browser/workspaceOpenService.js';
import { IWorkingCopyService } from '../../services/workingCopy/common/workingCopyService.js';
import { IViewsService } from '../../services/views/common/viewsService.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { normalizeExtensionHostPayload } from '../../../platform/agentHost/browser/extensionHostProtocol.js';
import { type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import type { IResourceEditorInput } from '../../common/editor.js';
import { isEditorPaneWithSelection } from '../../common/editor.js';
import { parseExtensionEditorInput } from './mainThreadEditorInput.js';
import { TextEditorSelectionSource } from '../../../platform/editor/common/editor.js';
import type { EditorOpenOptions } from '../../services/editor/common/editorService.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { MainThreadEditorChanges } from './mainThreadEditorChanges.js';
import { Range } from '../../../editor/common/core/range.js';
import { ITextFileService } from '../../services/textfile/common/textfiles.js';
/** Editor models, working copies and UI always stay in the client. */
export class MainThreadEditors {
	constructor(
		@IEditorService
		private readonly editors: IEditorService,
		@IEditorPart
		private readonly part: IEditorPart,
		@IQuickInputService
		private readonly quickInput: IQuickInputService,
		@IDialogService
		private readonly dialogs: IDialogService,
		@IWorkspaceOpenService
		private readonly workspace: IWorkspaceOpenService,
		@IWorkingCopyService
		private readonly workingCopies: IWorkingCopyService,
		@IViewsService
		private readonly views: IViewsService,
		@IClipboardService
		private readonly clipboard: IClipboardService,
		@IOpenerService
		private readonly opener: IOpenerService,
		@ICodeEditorService
		private readonly codeEditors: ICodeEditorService,
		@ITextFileService
		private readonly files: ITextFileService) { }
	public async handle(value: JsonValue, signal: AbortSignal): Promise<JsonValue> {
		const request = record(value);
		signal.throwIfAborted();
		switch (request.method) {
			case 'hostFacts': return { canClone: this.workspace.canOpenWorkspace, canOpenWorkspace: this.workspace.canOpenWorkspace };
			case 'input': {
				using cancellation = new CancellationTokenSource();
				const abort = () => cancellation.cancel();
				signal.addEventListener('abort', abort, { once: true });
				try {
					const result = await this.quickInput.input({ title: optionalText(request.title), placeHolder: optionalText(request.placeHolder), value: optionalText(request.value), password: request.password === true }, cancellation.token);
					signal.throwIfAborted();
					return result ?? null;
				}
				finally {
					signal.removeEventListener('abort', abort);
				}
			}
			case 'confirm': {
				const result = await this.dialogs.confirm({ title: optionalText(request.title), message: text(request.message), detail: optionalText(request.detail), primaryButton: optionalText(request.primaryButton) });
				signal.throwIfAborted();
				return { confirmed: result.confirmed };
			}
			case 'pickFolder': {
				const folder = await this.workspace.pickFolder();
				signal.throwIfAborted();
				return folder ?? null;
			}
			case 'openWorkspace':
				await this.workspace.openWorkspace(text(request.path));
				return null;
			case 'openView':
				await this.views.openView(text(request.id), request.focus === true);
				return null;
			case 'clipboard':
				await this.clipboard.writeText(text(request.text));
				return null;
			case 'openExternal':
				await this.opener.open(URI.parse(text(request.uri)), { openExternal: true, fromUserGesture: true, allowContributedOpeners: true });
				return null;
			case 'save': {
				await Promise.all(this.workingCopies.get(URI.parse(text(request.uri))).map(copy => copy.save(signal)));
				signal.throwIfAborted();
				return null;
			}
			case 'activeEditor': {
				const context = request.context == null ? undefined : record(request.context);
				const group = typeof context?.groupId === 'string' ? this.part.groups.find(group => group.id === context.groupId) : this.part.activeGroup;
				const index = context?.editorIndex;
				if (index != null && (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)) {
					throw new TypeError('Invalid editor index');
				}
				const input = typeof index === 'number' ? group?.inputs[index] : group?.activeInput;
				const pane = input === group?.activeInput ? group?.activePane : undefined;
				const selection = isEditorPaneWithSelection(pane) ? pane.getSelection() : undefined;
				return normalizeExtensionHostPayload({ input: input ? { resource: input.resource.toString(), modified: 'modified' in input ? { resource: (input.modified as IResourceEditorInput).resource.toString() } : null } : null, selection: selection ?? null });
			}
			case 'dirty':
			case 'diffChange':
			case 'readTextFile':
			case 'saveTextFile': return new MainThreadEditorChanges(this.codeEditors, this.workingCopies, this.files).handle(value, signal);
			case 'open': {
				const options = parseOptions(request.options);
				const input = parseExtensionEditorInput(request.input);
				await this.editors.openEditor(input, options, request.sideBySide === true ? 'sideGroup' : undefined);
				signal.throwIfAborted();
				return null;
			}
			default: throw new TypeError('Unsupported extension editor operation');
		}
	}
}
function record(value: JsonValue): Record<string, JsonValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Expected extension editor object');
	} return value as Record<string, JsonValue>;
}
function text(value: JsonValue, limit = 16 * 1024 * 1024): string {
	if (typeof value !== 'string' || value.length > limit || value.includes('\0')) {
		throw new TypeError('Invalid extension editor text');
	} return value;
}
function optionalText(value: JsonValue | undefined): string | undefined { return value == null ? undefined : text(value); }
function positiveInteger(value: JsonValue): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new TypeError('Invalid editor coordinate');
	} return value;
}
function parseRange(value: JsonValue): Range { const range = record(value); return new Range(positiveInteger(range.startLineNumber), positiveInteger(range.startColumn), positiveInteger(range.endLineNumber), positiveInteger(range.endColumn)); }
function selectionSource(value: JsonValue): TextEditorSelectionSource {
	if (value === TextEditorSelectionSource.PROGRAMMATIC || value === TextEditorSelectionSource.NAVIGATION || value === TextEditorSelectionSource.JUMP) {
		return value;
	} throw new TypeError('Invalid editor selection source');
}
function parseOptions(value: JsonValue): EditorOpenOptions {
	if (value == null) {
		return {};
	}
	const entry = record(value);
	return { pinned: entry.pinned === true, revealIfOpened: entry.revealIfOpened === true, preserveFocus: entry.preserveFocus === true, selection: entry.selection == null ? undefined : parseRange(entry.selection), selectionSource: entry.selectionSource == null ? undefined : selectionSource(entry.selectionSource) };
}
