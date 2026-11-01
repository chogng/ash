import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Sash, SashState, Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { localize } from '../../../../nls.js';
import type { DesktopMainEditorPart, IFilesGroupDetails } from '../../../browser/parts/desktopEditorPart.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { EditorGroupView } from '../../../../workbench/browser/parts/editor/editorGroupView.js';
import { EditorHeaderControl } from '../../../../workbench/browser/parts/editor/editorHeaderControl.js';
import { NEW_FILE_TAB_COMMAND_ID } from '../../../common/sessionCommands.js';
import { SessionsExplorerView, SESSIONS_FILES_VIEW_ID } from './filesView.js';

/** Owns the retained Files tree, its group attachment and the Details-only presentation. */
export class FilesGroupDetails extends Disposable implements IFilesGroupDetails {
	private group: EditorGroupView | undefined;
	private retainedGroupId: number | undefined;
	private readonly sash = this._register(new MutableDisposable<Sash>());
	private readonly tree: SessionsExplorerView;
	private readonly element: HTMLElement;
	private readonly empty: HTMLElement;
	private preferredWidth: number;
	private width = 0;
	private dimension: IDimension = { width: 0, height: 0 };
	private hostVisible = true;
	private open = false;
	private editorVisible = true;

	constructor(
		private readonly editor: DesktopMainEditorPart,
		@IInstantiationService services: IInstantiationService,
		@IStorageService private readonly storage: IStorageService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IViewsService views: IViewsService,
		@IContextKeyService contextKeys: IContextKeyService,
		@ICommandService commands: ICommandService,
	) {
		super();
		this.element = h(editor.domNode.ownerDocument, 'aside', { className: 'ash-editor-group-files' });
		this.element.setAttribute('aria-label', localize('sessions.files.title', 'Files'));
		const context = this._register(contextKeys.createScoped(this.element));
		context.createKey('sessionsFilesNavigationFocused', true);
		this.tree = this._register(services.createInstance(SessionsExplorerView, this.element, {
			id: SESSIONS_FILES_VIEW_ID, title: localize('sessions.files.title', 'Files'), canMoveView: false, headerSize: EditorHeaderControl.HEIGHT,
		}));
		this._register(views.registerView(this.tree, {
			id: SESSIONS_FILES_VIEW_ID, title: localize('sessions.files.title', 'Files'), ctorDescriptor: new SyncDescriptor(SessionsExplorerView),
		}, () => commands.executeCommand<void>(NEW_FILE_TAB_COMMAND_ID), () => this.hide()));
		this.empty = h(editor.domNode.ownerDocument, 'p');
		this.empty.className = 'ash-sessions-files-empty-message';
		this.empty.tabIndex = 0;
		this.empty.textContent = localize('sessions.files.noFiles', 'Folders and files will appear here.');
		this.empty.setAttribute('role', 'status');
		this.element.append(this.empty);
		const width = storage.getNumber('sessions.code.filesTreeWidth', StorageScope.PROFILE, 220);
		this.preferredWidth = Number.isFinite(width) && width >= 160 && width <= 800 ? width : 220;
		this.retainedGroupId = storage.getNumber('sessions.code.filesGroup', StorageScope.WORKSPACE);
		this._register(editor.onDidLayout(() => this.layout()));
		this._register(editor.onDidChangeEditors(event => {
			if (event.kind === 'groupChanged' && event.groupId === this.group?.id && event.event.kind === 'activeEditorChanged') this.editorVisible = !!this.group.activeInput;
			if (this.group && !editor.groups.includes(this.group)) {
				// Session restoration chooses the next owning group. Never attach Files to
				// an unrelated visible tool when its previous group leaves the working set.
				this.releaseGroup();
				this.element.remove();
				this.tree.setVisible(false);
			}
			this.layout();
		}));
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.layout()));
	}

	public get isOpen(): boolean { return this.open; }
	public get isEditorVisible(): boolean { return this.editorVisible; }
	public get groupId(): number | undefined { return this.group?.id ?? this.retainedGroupId; }
	public get isVisible(): boolean {
		return this.open && this.hostVisible && !!this.group && this.editor.groups.includes(this.group) && this.editor.isGroupVisible(this.group.id)
			&& (!this.group.activeInput || this.editor.isFileEditor(this.group.activeInput));
	}

	public show(group: EditorGroupView): void {
		this.attach(group);
		this.open = true;
		this.editorVisible = !!group.activeInput;
		this.storage.store('sessions.code.filesVisible', true, StorageScope.PROFILE, StorageTarget.MACHINE);
		this.layout();
	}

	private attach(group: EditorGroupView): void {
		if (this.group === group) return;
		this.releaseGroup();
		this.group = group;
		this.retainedGroupId = group.id;
		this.storage.store('sessions.code.filesGroup', group.id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		group.domNode.append(this.element);
		const sash = new Sash(group.domNode, {
			getVerticalSashLeft: () => this.dimension.width - this.width,
			getVerticalSashTop: () => group.titleHeight.offset,
			getVerticalSashHeight: () => Math.max(0, this.dimension.height - group.titleHeight.offset),
		}, { orientation: Orientation.VERTICAL });
		this.sash.value = sash;
		let startWidth = 0;
		sash.onDidStart(() => { startWidth = this.width; });
		sash.onDidChange(event => {
			this.preferredWidth = startWidth + event.startX - event.currentX;
			this.layout();
		});
		sash.onDidEnd(() => this.storage.store('sessions.code.filesTreeWidth', this.width, StorageScope.PROFILE, StorageTarget.MACHINE));
		sash.onDidReset(() => { this.preferredWidth = 220; this.layout(); });
	}

	public hide(): void {
		this.open = false;
		this.storage.store('sessions.code.filesVisible', false, StorageScope.PROFILE, StorageTarget.MACHINE);
		this.releaseGroup();
		this.element.remove();
		this.tree.setVisible(false);
	}

	private releaseGroup(): void {
		this.sash.clear();
		if (this.group && this.editor.groups.includes(this.group)) {
			this.group.setTitleVisible(true);
			this.group.setContentRightInset(0);
			this.group.setEditorContentVisible(true);
			this.group.layout(this.editor.getSize(this.group));
		}
		this.group = undefined;
	}

	public setHostVisible(visible: boolean): void { this.hostVisible = visible; this.layout(); }
	public setEditorVisible(visible: boolean): void { this.editorVisible = visible; this.layout(); }
	public focus(): void {
		if (this.workspace.getWorkspace().folders.length) this.tree.focus();
		else this.empty.focus();
	}

	private layout(): void {
		const group = this.group;
		if (!group || !this.editor.groups.includes(group)) return;
		this.dimension = this.editor.getSize(group);
		const fileContent = !group.activeInput || this.editor.isFileEditor(group.activeInput);
		const contentVisible = !!group.activeInput && (!fileContent || this.editorVisible);
		// Files-only groups retain their shared group controls without creating an editor tab.
		group.setTitleVisible(true);
		this.tree.setHeaderVisible(false);
		this.width = contentVisible ? Math.min(Math.max(160, this.preferredWidth), Math.max(0, this.dimension.width - 160)) : this.dimension.width;
		const top = group.titleHeight.offset;
		const height = Math.max(0, this.dimension.height - top);
		Object.assign(this.element.style, { top: top + 'px', right: '0px', width: this.width + 'px', height: height + 'px' });
		const visible = this.isVisible;
		this.element.hidden = !visible;
		const hasFolders = this.workspace.getWorkspace().folders.length > 0;
		this.empty.hidden = hasFolders;
		this.empty.style.top = '0px';
		this.element.classList.toggle('ash-editor-group-files-empty', !hasFolders);
		this.tree.setVisible(visible);
		this.tree.layout(height, 0, this.width);
		group.setContentRightInset(visible ? this.width : 0);
		group.setEditorContentVisible(contentVisible);
		group.layout(this.dimension);
		if (this.sash.value) this.sash.value.state = contentVisible && visible ? SashState.Enabled : SashState.Disabled;
		this.sash.value?.layout();
	}

	protected override disposeCore(): void {
		this.releaseGroup();
		this.element.remove();
		super.disposeCore();
	}
}
