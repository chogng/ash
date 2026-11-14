import './docsEditorPane.css';
import { ArkdownEditorPane } from './arkdown/arkdownEditorPane.js';
import type { ArkdownEditor } from './arkdown/arkdownEditor.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IArtifactAutoSaveService } from '../../../services/artifactAutoSave/common/artifactAutoSaveService.js';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { isNative } from '../../../../base/common/platform.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
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
		this.titlebar.setTitleActions(() => this.documentInput ? titleActions.getActions({ title: this.documentInput.label ?? basename(this.documentInput.resource), getCodeAttachment: () => ({ name: resourceFileName(basename(this.documentInput!.resource), 'text/markdown'), content: this.editor.getControl()?.getText() ?? '' }) }) : []);
		this.body = h(document, 'div', { className: 'ash-docs-workspace-body' });
		this.root.append(this.body);
		parent.append(this.root);
		this.editor.create(this.body);
		super.create(this.root);
		this.exportAction = this._register(new Action('sessions.docs.export.markdown', localize({ bundle: 'ash.docs', key: 'exportMarkdown' }, 'Markdown file (.md)'), '', true, () => this.exportMarkdown()));
		this.refreshActions();
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.titlebar.closeTitleMenu();
		// Existing shared models already own live edits. New models can recover a migrated draft.
		const backup = this.models.getModel(input.resource) ? undefined : await this.backups.resolve(input.resource);
		signal.throwIfAborted();
		await this.editor.setInput(input, signal);
		if (backup?.kind === 'text' && this.workingCopy && !this.workingCopy.isDirty) this.workingCopy.restoreBackup(backup.content);
		this.documentInput = input;
		if (this.workingCopy) this.autoSaveScope.value = this.autoSave.register(this.workingCopy);
		this.editor.setMode(this.configuration.getValue<DocsEditorMode>(DOCS_DEFAULT_MODE_SETTING) ?? 'rich');
		this.titlebar.setTitle(input.label ?? basename(input.resource));
		this.titlebar.refreshTitleActions();
		this.refreshActions();
	}

	override clearInput(): void { this.titlebar?.closeTitleMenu(); this.autoSaveScope.clear(); this.documentInput = undefined; this.editor.clearInput(); }
	override layout(dimension: IDimension): void { this.root.style.width = `${dimension.width}px`; this.root.style.height = `${dimension.height}px`; this.editor.layout(dimension); }
	override focus(): void { this.editor.focus(); }
	override setVisible(visible: boolean): void { super.setVisible(visible); this.editor.setVisible(visible); if (!visible) this.titlebar?.closeTitleMenu(); }
	override getControl(): ArkdownEditor | undefined { return this.editor.getControl(); }
	get isDirty(): boolean { return this.editor.isDirty; }
	get hasExternalChange(): boolean { return this.editor.hasExternalChange; }
	async save(options?: ISaveOptions): Promise<void> { await this.editor.save(options); }
	async saveAs(resource: URI): Promise<void> { await this.editor.saveAs(resource); }
	containsAccessibilityFocus(target: HTMLElement): boolean { return this.editor.containsAccessibilityFocus(target); }
	getAccessibleContent(): string { return this.editor.getAccessibleContent(); }
	getAccessibilityHelp(): readonly string[] { return this.editor.getAccessibilityHelp(); }
	exportText(format: DocumentTextFormat): string { return (format === 'markdown' ? this.editor.getControl()?.getText() : this.editor.getControl()?.getPlainText()) ?? ''; }
	getArtifactFormats() { return [{ id: 'markdown', label: localize({ bundle: 'ash.docs', key: 'exportMarkdown' }, 'Markdown file (.md)'), extension: 'md', mimeType: 'text/markdown', canImport: false }]; }
	async exportArtifact(format: string, signal: AbortSignal): Promise<Uint8Array> {
		signal.throwIfAborted();
		if (format !== 'markdown') throw new Error(localize('document.output.unavailable', 'This document provider does not support the selected output.'));
		return new TextEncoder().encode(this.exportText('markdown'));
	}

	private refreshActions(): void {
		if (!this.exportAction) return;
		this.titlebar.setActions([
			...this.editor.getActions(),
		], [this.exportAction]);
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
