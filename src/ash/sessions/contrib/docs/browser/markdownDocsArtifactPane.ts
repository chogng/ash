import './docsArtifactPane.css';
import { h } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { isNative } from '../../../../base/common/platform.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorLineWrapping } from '../../../../editor/common/config/editorOptions.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TextResourceEditor, type EditorPaneOptions } from '../../../../workbench/browser/parts/editor/textResourceEditor.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IFilesConfigurationService } from '../../../../workbench/services/filesConfiguration/common/filesConfigurationService.js';
import { ITextModelResourceService } from '../../../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import { resourceFileName, saveResourceAs } from '../../../../workbench/services/files/browser/resourceSave.js';
import type { ITextResourceStore } from '../../../../workbench/services/textmodelResolver/common/textResourceStore.js';
import { DOCS_MARKDOWN_EDITOR_ID } from '../common/docs.js';
import type { ISessionsEditorPage } from '../../../browser/parts/editorPart.js';
import { ArtifactTitleBarWidget } from '../../artifact/browser/artifactTitleBarWidget.js';
import { ArtifactTitleActions } from '../../artifact/browser/artifactTitleActions.js';

/** Markdown keeps its text working copy and uses the Docs presentation in Sessions. */
export class MarkdownDocsArtifactPane extends TextResourceEditor implements ISessionsEditorPage {
	private titlebar!: ArtifactTitleBarWidget;
	public get titlebarContent(): HTMLElement { return this.titlebar.domNode; }
	private saveAction!: Action;
	private documentInput: IResourceEditorInput | undefined;

	constructor(
		store: ITextResourceStore,
		options: EditorPaneOptions,
		@ITextModelResourceService models: ITextModelResourceService,
		@IInstantiationService private readonly artifactInstantiation: IInstantiationService,
		@IConfigurationService configuration: IConfigurationService,
		@ITextModelService textModels: ITextModelService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@INotificationService private readonly notifications: INotificationService,
		@IFilesConfigurationService private readonly filesConfiguration: IFilesConfigurationService,
	) {
		super(store, { ...options, editorId: DOCS_MARKDOWN_EDITOR_ID, minimap: { enabled: false }, lineNumbers: 'off', lineWrapping: EditorLineWrapping.On }, models, artifactInstantiation, configuration, textModels, theme, storage);
		this._register(filesConfiguration.onDidChangeReadonly(() => this.updateReadOnly()));
	}

	override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		const root = h(document, 'section', { className: 'ash-docs-workspace', attributes: { 'data-creator-mode': 'docs', 'data-docs-format': 'markdown' } });
		this.titlebar = this._register(this.artifactInstantiation.createInstance(ArtifactTitleBarWidget, document,
			localize({ bundle: 'ash.docs', key: 'actions' }, 'Docs actions'), undefined));
		const titleActions = this.artifactInstantiation.createInstance(ArtifactTitleActions);
		this._register(titleActions.onDidChangeHandoffAvailability(() => {
			this.titlebar.closeTitleMenu();
			this.titlebar.refreshTitleActions();
		}));
		this.titlebar.setTitleActions(() => {
			const input = this.documentInput;
			if (!input) return [];
			const title = input.label ?? basename(input.resource);
			return titleActions.getActions({
				title, getCodeAttachment: () => ({
					name: resourceFileName(basename(input.resource), 'text/markdown'),
					content: this.getControl()?.getValue() ?? '',
				}),
			});
		});
		const body = h(document, 'div', { className: 'ash-docs-workspace-body' });
		root.append(body);
		parent.append(root);
		this.saveAction = this._register(new Action('sessions.docs.save', localize('sessions.creator.save', 'Save document'), '', true, async () => {
			try { await this.save(); }
			catch (error) { if (!isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error)); }
		}));
		this.saveAction.icon = Lxicon.save;
		const exportMarkdown = this._register(new Action('sessions.docs.export.markdown',
			localize({ bundle: 'ash.docs', key: 'exportMarkdown' }, 'Markdown file (.md)'), '', true, () => this.exportMarkdown(document)));
		this.titlebar.setActions([this.saveAction], [exportMarkdown]);
		super.create(body);
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.titlebar.closeTitleMenu();
		await super.setInput(input, signal);
		signal.throwIfAborted();
		this.documentInput = input;
		this.titlebar.setTitle(input.label ?? basename(input.resource));
		this.titlebar.refreshTitleActions();
		this.updateReadOnly();
	}

	override clearInput(): void {
		this.titlebar?.closeTitleMenu();
		this.documentInput = undefined;
		super.clearInput();
	}

	override setVisible(visible: boolean): void {
		if (!visible) this.titlebar?.closeTitleMenu();
		super.setVisible(visible);
	}

	private async exportMarkdown(document: Document): Promise<void> {
		const input = this.documentInput;
		const text = this.getControl()?.getValue();
		if (!input || text === undefined) return;
		const name = resourceFileName(basename(input.resource), 'text/markdown');
		await this.artifactInstantiation.invokeFunction(saveResourceAs, new TextEncoder().encode(text), name, document, {
			selectTarget: isNative ? async () => {
				const target = await this.fileDialogs.pickFileToSave(URI.file('/' + name));
				if (this.documentInput !== input || this.isDisposed) return undefined;
				if (target && extUri.isEqual(target, input.resource)) {
					throw new Error(localize('document.output.sourceTarget', 'Choose a separate output file to preserve the open document.'));
				}
				return target;
			} : undefined,
		});
	}

	private updateReadOnly(): void {
		const input = this.documentInput;
		if (!input) { return; }
		const readOnly = input.readOnly === true || !!this.filesConfiguration.isReadonly(input.resource);
		this.getControl()?.updateOptions({ readOnly });
		this.saveAction.enabled = !readOnly;
	}
}
