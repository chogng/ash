import { Disposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { ILabelService } from '../../../../platform/label/common/labelService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { WorkbenchModeRegistry } from '../../../common/workbenchMode.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchModeService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';

/** Owns the document title for one window and its window-scoped editor service. */
export class WindowTitle extends Disposable {
	private readonly editorLabelListener = this._register(new MutableDisposable<IDisposable>());
	private readonly titleChanged = this._register(new Emitter<void>());
	public readonly onDidChange = this.titleChanged.event;

	public get value(): string {
		return this.targetWindow.document.title;
	}

	constructor(
		private readonly targetWindow: Window,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@ILabelService private readonly labelService: ILabelService,
		@IWorkbenchModeService private readonly modeService: IWorkbenchModeService,
	) {
		super();
		this._register(editorService.onDidActiveEditorChange(() => this.handleActiveEditorChange()));
		this._register(workspaceService.onDidChangeWorkspace(() => this.updateTitle()));
		this._register(labelService.onDidChangeFormatters(() => this.updateTitle()));
		this._register(workingCopyService.onDidChangeDirty(() => this.updateTitle()));
		this._register(workingCopyService.onDidRegister(() => this.updateTitle()));
		this._register(workingCopyService.onDidUnregister(() => this.updateTitle()));
		this.handleActiveEditorChange();
	}

	private handleActiveEditorChange(): void {
		this.editorLabelListener.value = this.editorService.activeEditor?.onDidChangeLabel?.(() => this.updateTitle());
		this.updateTitle();
	}

	private updateTitle(): void {
		const editor = this.editorService.activeEditor;
		const workspace = this.workspaceService.getWorkspace();
		const segments: string[] = [];
		if (editor) {
			// Working copies remain owned by editor domains; the title only reads their persistence state.
			const dirty = this.workingCopyService.get(editor.resource).some(copy => copy.isDirty);
			const fileName = editor.label ?? this.labelService.getUriBasenameLabel(editor.resource);
			segments.push(`${dirty ? '● ' : ''}${fileName}`);
		}
		const workspaceName = workspace.name ?? workspace.folders.map(folder => folder.name).join(', ');
		if (workspaceName) {
			segments.push(workspaceName);
		}
		segments.push(WorkbenchModeRegistry.get(this.modeService.currentModeId).title);
		const title = segments.join(' — ');
		if (this.targetWindow.document.title !== title) {
			this.targetWindow.document.title = title;
			this.titleChanged.fire();
		}
	}
}
