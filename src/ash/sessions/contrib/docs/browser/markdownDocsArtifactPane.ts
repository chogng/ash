import './docsArtifactPane.css';
import { h } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { basename } from '../../../../base/common/resources.js';
import { EditorLineWrapping } from '../../../../editor/common/config/editorOptions.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TextResourceEditor, type EditorPaneOptions } from '../../../../workbench/browser/parts/editor/textResourceEditor.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IFilesConfigurationService } from '../../../../workbench/services/filesConfiguration/common/filesConfigurationService.js';
import { ITextModelResourceService } from '../../../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import type { ITextResourceStore } from '../../../../workbench/services/textmodelResolver/common/textResourceStore.js';
import { DOCS_MARKDOWN_EDITOR_ID } from '../common/docs.js';
import type { ISessionsEditorPage } from '../../../browser/parts/editorPart.js';
import { ArtifactTitleBarWidget } from '../../artifact/browser/artifactTitleBarWidget.js';

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
		@ICommandService private readonly commands: ICommandService,
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
		const body = h(document, 'div', { className: 'ash-docs-workspace-body' });
		root.append(body);
		parent.append(root);
		const back = this._register(new Action('sessions.docs.back', localize({ bundle: 'ash.docs', key: 'back' }, 'Back to Artifacts'), '', true, () => this.commands.executeCommand('sessions.show.creator')));
		back.icon = Lxicon.arrowLeft;
		this.saveAction = this._register(new Action('sessions.docs.save', localize('sessions.creator.save', 'Save document'), '', true, async () => {
			try { await this.save(); }
			catch (error) { if (!isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error)); }
		}));
		this.saveAction.icon = Lxicon.save;
		this.titlebar.setActions([this.saveAction, back]);
		super.create(body);
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		await super.setInput(input, signal);
		signal.throwIfAborted();
		this.documentInput = input;
		this.titlebar.setTitle(input.label ?? basename(input.resource));
		this.updateReadOnly();
	}

	override clearInput(): void {
		this.documentInput = undefined;
		super.clearInput();
	}

	private updateReadOnly(): void {
		const input = this.documentInput;
		if (!input) { return; }
		const readOnly = input.readOnly === true || !!this.filesConfiguration.isReadonly(input.resource);
		this.getControl()?.updateOptions({ readOnly });
		this.saveAction.enabled = !readOnly;
	}
}
