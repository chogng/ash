import './docsEditorPane.css';
import { ArkdownEditorPane } from './arkdown/arkdownEditorPane.js';
import type { ArkdownEditor } from './arkdown/arkdownEditor.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IArtifactAutoSaveService } from '../../../services/artifactAutoSave/common/artifactAutoSaveService.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { Action, Separator } from '../../../../base/common/actions.js';
import { isNative } from '../../../../base/common/platform.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { EditorWorkingCopy } from '../../../../workbench/browser/parts/editor/textResourceEditor.js';
import type { IResourceEditorInput, ISaveOptions } from '../../../../workbench/common/editor.js';
import { resourceFileName, saveResourceAs } from '../../../../workbench/services/files/browser/resourceSave.js';
import { IFileTextModelService } from '../../../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import { IWorkingCopyBackupService } from '../../../../workbench/services/workingCopy/common/workingCopyBackupService.js';
import type { DocumentTextFormat } from '../../../../workbench/services/documentEditor/common/documentCodec.js';
import { DOCS_DEFAULT_MODE_SETTING, DOCS_ARKDOWN_EDITOR_ID, type DocsEditorMode } from '../common/docs.js';
import type { ISessionsEditorPage } from '../../../browser/parts/editorPart.js';
import { ArtifactTitleBarWidget } from '../../artifact/browser/artifactTitleBarWidget.js';
import { ArtifactTitleActions } from '../../artifact/browser/artifactTitleActions.js';
import { ArtifactToolbar } from '../../artifact/browser/widget/artifactToolbar.js';
import { ArtifactContextMenu } from '../../artifact/browser/widget/artifactContextMenu.js';
import { ArtifactKindContext } from '../../../common/contextkeys.js';
import { DocsToolbar } from './docsToolbar.js';
import { DocsSelectionToolbar } from './docsSelectionToolbar.js';
import { DocsCommentsWidget } from './docsCommentsWidget.js';

/** Docs presentation over Arkdown and the shared file-backed text working copy. */
export class ArkdownDocsEditorPane extends EditorPane implements ISessionsEditorPage {
	readonly id = DOCS_ARKDOWN_EDITOR_ID;
	private readonly editor: ArkdownEditorPane;
	private titlebar!: ArtifactTitleBarWidget;
	private root!: HTMLElement;
	private body!: HTMLElement;
	private documentInput: IResourceEditorInput | undefined;
	private readonly autoSaveScope = this._register(new MutableDisposable());
	private exportAction!: Action;
	private toolbar!: ArtifactToolbar;
	private docsToolbar!: DocsToolbar;
	private contextMenu!: ArtifactContextMenu;
	private selectionToolbar!: DocsSelectionToolbar;
	private comments!: DocsCommentsWidget;
	public get titlebarContent(): HTMLElement { return this.titlebar.domNode; }
	public get workingCopy(): EditorWorkingCopy | undefined { return this.editor.workingCopy; }

	constructor(private readonly onSave: (() => Promise<void | boolean>) | undefined,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IArtifactAutoSaveService private readonly autoSave: IArtifactAutoSaveService,
		@IFileTextModelService private readonly models: IFileTextModelService,
		@IWorkingCopyBackupService private readonly backups: IWorkingCopyBackupService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) {
		super(DOCS_ARKDOWN_EDITOR_ID, theme, storage);
		this.editor = this._register(instantiation.createInstance(ArkdownEditorPane, { id: DOCS_ARKDOWN_EDITOR_ID, onSave }));
		this._register(this.editor.onTitleAreaUpdate(() => this.refreshActions()));
	}

	override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.root = h(document, 'section', { className: 'ash-docs-workspace', attributes: { 'data-artifact-mode': 'docs', 'data-docs-format': 'markdown' } });
		this.titlebar = this._register(this.instantiation.createInstance(ArtifactTitleBarWidget, document, localize({ bundle: 'ash.docs', key: 'actions' }, 'Docs actions'), undefined));
		const titleActions = this.instantiation.createInstance(ArtifactTitleActions);
		this._register(titleActions.onDidChangeHandoffAvailability(() => { this.titlebar.closeTitleMenu(); this.titlebar.refreshTitleActions(); }));
		this.titlebar.setTitleActions(() => this.documentInput ? [
			...this.docsToolbar.getDocumentActions(), new Separator(),
			...titleActions.getActions({ title: this.documentInput.label ?? basename(this.documentInput.resource), getCodeAttachment: () => ({ name: resourceFileName(basename(this.documentInput!.resource), 'text/markdown'), content: this.editor.getControl()?.getText() ?? '' }) }),
		] : []);
		this.body = h(document, 'div', { className: 'ash-docs-workspace-body' });
		const context = this._register(this.contextKeys.createScoped(this.root));
		ArtifactKindContext.bindTo(context).set('docs');
		const scopedInstantiation = this._register(this.instantiation.createChild(new ServiceCollection([IContextKeyService, context])));
		this.toolbar = this._register(scopedInstantiation.createInstance(ArtifactToolbar, document, {
			menuClassName: 'ash-docs-format-menu ash-docs-insert-menu', menuIconPlacement: 'leading-with-trailing-check',
		}));
		const main = h(document, 'div', { className: 'ash-docs-workspace-main' }, this.body);
		this.comments = this._register(scopedInstantiation.createInstance(DocsCommentsWidget, main));
		this._register(this.comments.onDidChangeVisibility(() => {
			this.editor.layout({ width: this.body.clientWidth, height: this.body.clientHeight });
			this.selectionToolbar?.update();
		}));
		this.docsToolbar = this._register(scopedInstantiation.createInstance(DocsToolbar, this.editor, this.toolbar, () => this.documentInput?.label ?? (this.documentInput ? basename(this.documentInput.resource) : ''), () => this.comments.show()));
		this.toolbar.setWorkspaceContext(this);
		this.contextMenu = this._register(scopedInstantiation.createInstance(ArtifactContextMenu, {
			getActions: () => this.docsToolbar.getContextActions(),
			getActionsContext: () => this,
			menuClassName: 'ash-docs-format-menu ash-docs-insert-menu',
		}));
		this.root.append(main, this.toolbar.domNode);
		parent.append(this.root);
		this.editor.create(this.body);
		this.selectionToolbar = this._register(scopedInstantiation.createInstance(DocsSelectionToolbar, this.root, () => this.editor.getControl(), () => this.docsToolbar.getSelectionActions()));
		// The source editor retains its own text-editing menu; the rich document uses Artifact actions.
		const isDocumentTarget = (target: EventTarget | null): boolean => !!target && this.editor.getControl()?.getMode() === 'rich' && this.body.contains(target as Node);
		this._register(addDisposableListener(this.body, 'contextmenu', event => {
			if (event.defaultPrevented || !isDocumentTarget(event.target)) return;
			event.preventDefault();
			event.stopPropagation();
			if (this.selectionToolbar.show()) return;
			this.contextMenu.show({ x: event.clientX, y: event.clientY, targetWindow: document.defaultView! }, () => this.editor.focus());
		}));
		this._register(addDisposableListener(this.body, 'keydown', event => {
			if (event.defaultPrevented || !isDocumentTarget(event.target) || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
			event.preventDefault();
			event.stopPropagation();
			if (this.selectionToolbar.show(true)) return;
			this.contextMenu.show(this.editor.getControl()!.domNode, () => this.editor.focus());
		}));
		super.create(this.root);
		this.exportAction = this._register(new Action('sessions.docs.export.markdown', localize({ bundle: 'ash.docs', key: 'exportMarkdown' }, 'Markdown file (.md)'), '', true, () => this.exportMarkdown()));
		this.refreshActions();
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.titlebar.closeTitleMenu();
		this.hideMenus();
		// Existing shared models already own live edits. New models can recover a migrated draft.
		const backup = this.models.getModel(input.resource) ? undefined : await this.backups.resolve(input.resource);
		signal.throwIfAborted();
		await this.editor.setInput(input, signal);
		if (backup?.kind === 'text' && this.workingCopy && !this.workingCopy.isDirty) this.workingCopy.restoreBackup(backup.content);
		this.documentInput = input;
		this.comments.setEditor(this.editor.getControl());
		if (this.workingCopy) this.autoSaveScope.value = this.autoSave.register(this.workingCopy);
		this.editor.setMode(this.configuration.getValue<DocsEditorMode>(DOCS_DEFAULT_MODE_SETTING) ?? 'rich');
		this.titlebar.setTitle(input.label ?? basename(input.resource));
		this.titlebar.refreshTitleActions();
		this.refreshActions();
	}

	override clearInput(): void { this.titlebar?.closeTitleMenu(); this.hideMenus(); this.comments?.setEditor(undefined); this.autoSaveScope.clear(); this.documentInput = undefined; this.editor.clearInput(); }
	override layout(dimension: IDimension): void {
		this.root.style.width = `${dimension.width}px`;
		this.root.style.height = `${dimension.height}px`;
		this.editor.layout({ width: this.body.clientWidth, height: this.body.clientHeight });
		this.selectionToolbar.update();
	}
	override focus(): void { this.editor.focus(); }
	override setVisible(visible: boolean): void { super.setVisible(visible); this.editor.setVisible(visible); if (!visible) { this.titlebar?.closeTitleMenu(); this.hideMenus(); } }
	override getControl(): ArkdownEditor | undefined { return this.editor.getControl(); }
	get isDirty(): boolean { return this.editor.isDirty; }
	get hasExternalChange(): boolean { return this.editor.hasExternalChange; }
	async save(options?: ISaveOptions): Promise<void> { await this.editor.save(options); }
	async saveAs(resource: URI): Promise<void> { await this.editor.saveAs(resource); }
	containsAccessibilityFocus(target: HTMLElement): boolean { return this.root.contains(target) || this.editor.containsAccessibilityFocus(target); }
	getAccessibleContent(): string { return [this.editor.getAccessibleContent(), this.comments?.getAccessibleContent()].filter(Boolean).join('\n\n'); }
	getAccessibilityHelp(): readonly string[] {
		return [...this.editor.getAccessibilityHelp(), localize({ bundle: 'ash.docs', key: 'imageHelp' }, 'Insert image opens a local PNG, JPEG, GIF or WebP file. Images can also be pasted or dropped and are embedded in the document. Use Tab to focus an image. Its toolbar offers alignment; More provides Copy image, Edit image description, Set image size and Delete image. Drag a side handle to resize proportionally. Focus a handle and use Left or Right to change width, Shift for larger steps, Home for the minimum and End to fit the text column. Escape cancels a drag or returns to the document. Delete removes the selected image. Image edits support undo and redo. Each local image can be up to 8 MB.'), localize({ bundle: 'ash.docs', key: 'editingToolsHelp' }, 'The bottom toolbar provides Font, Table, Image, Checklist, Dropdown, More, Comments and Ask Ash. Use Tab to reach it and arrow keys to choose an action. Font opens paragraph and heading choices. More contains lists, code blocks, dividers, dates and page width. The document title menu and document context menu provide Markdown source and Discuss document. Page width changes only this editor view. Checklist is an insertion action; the selection list menu reports the current list format. Dropdown inserts a labeled choice block; its selection saves with the document and supports undo. Discuss document opens the conversation. Ask Ash adds the selection or document to the chat draft without sending. Selecting text opens a formatting toolbar above the selection. The selection toolbar provides underline, text colors, highlight and list indentation. Control or Command+U toggles underline. In list text, Tab and Shift+Tab increase or decrease indentation. Default clears text color; No highlight clears the highlight. Right-click the selection or press Shift+F10 to reach its formatting controls; use arrow keys to choose an action. Escape closes the toolbar and returns to the selection. Right-click outside a selection to open the document context menu.'), localize({ bundle: 'ash.docs', key: 'commentsHelp' }, 'Select text and choose Add comment, or press Control or Command+Alt+M. At a comment, this shortcut opens its thread. Comments opens the sidebar; New comment starts a document comment. Tab reaches each thread and its reply, edit, delete, resolve and reopen controls. Enter posts a comment; Shift+Enter or Alt+Enter inserts a new line. Escape closes the sidebar and returns to the document. Unsent input is retained while the sidebar is closed. Filters show open, resolved or all threads. Comment changes save with the document and support undo and redo. Read-only documents allow reading comments. The accessible view includes all comment threads.')];
	}
	exportText(format: DocumentTextFormat): string { return (format === 'markdown' ? this.editor.getControl()?.getText() : this.editor.getControl()?.getPlainText()) ?? ''; }
	getArtifactFormats() { return [{ id: 'markdown', label: localize({ bundle: 'ash.docs', key: 'exportMarkdown' }, 'Markdown file (.md)'), extension: 'md', mimeType: 'text/markdown', canImport: false }]; }
	async exportArtifact(format: string, signal: AbortSignal): Promise<Uint8Array> {
		signal.throwIfAborted();
		if (format !== 'markdown') throw new Error(localize('document.output.unavailable', 'This document provider does not support the selected output.'));
		return new TextEncoder().encode(this.exportText('markdown'));
	}

	private refreshActions(): void {
		if (!this.exportAction) return;
		const editing = this.editor.getEditingActions();
		this.docsToolbar.update();
		this.comments?.update();
		this.selectionToolbar?.update();
		this.titlebar.setActions(this.editor.getActions().filter(action => !editing.some(edit => edit.id === action.id)), [this.exportAction]);
	}
	private hideMenus(): void {
		this.toolbar?.hideMenu();
		this.contextMenu?.hide();
		this.selectionToolbar?.close();
	}
	private async exportMarkdown(): Promise<void> {
		const input = this.documentInput;
		if (!input || !this.editor.getControl()) return;
		const name = resourceFileName(basename(input.resource), 'text/markdown');
		await this.instantiation.invokeFunction(saveResourceAs, new TextEncoder().encode(this.editor.getControl()!.getText()), name, this.root.ownerDocument, {
			selectTarget: isNative ? async () => {
				const target = await this.fileDialogs.pickFileToSave(URI.file('/' + name));
				if (this.documentInput !== input || this.isDisposed) return undefined;
				if (target && extUri.isEqual(target, input.resource)) throw new Error(localize('document.output.sourceTarget', 'Choose a separate output file to preserve the open document.'));
				return target;
			} : undefined
		});
	}
}
