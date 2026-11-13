import './docsArtifactPane.css';
import { h } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { DocumentEditorPane, type EditorPaneOptions } from '../../../../workbench/contrib/documentEditor/browser/documentEditorPane.js';
import { IDocumentEditorTextModelService } from '../../../../workbench/services/documentEditor/common/documentTypes.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { DOCS_TOOLS_CONTAINER_ID } from '../common/docs.js';
import type { ISessionsEditorPage } from '../../../browser/parts/editorPart.js';
import { ArtifactTitleBarWidget } from '../../artifact/browser/artifactTitleBarWidget.js';
import { ArtifactTitleActions } from '../../artifact/browser/artifactTitleActions.js';

/** The Artifacts presentation borrows the same document working copy and editor controls. */
export class DocsArtifactPane extends DocumentEditorPane implements ISessionsEditorPage {
	private root!: HTMLElement;
	private titlebar!: ArtifactTitleBarWidget;
	public get titlebarContent(): HTMLElement { return this.titlebar.domNode; }
	public controlsElement!: HTMLElement;
	private saveAction!: Action;
	private tools!: Action;
	private readOnly = false;

	constructor(
		options: EditorPaneOptions,
		@IDialogService dialogs: IDialogService,
		@IDocumentEditorTextModelService models: IDocumentEditorTextModelService,
		@IInstantiationService private readonly artifactInstantiation: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly views: IViewsService,
	) {
		super(options, dialogs, models, artifactInstantiation, theme, storage);
	}

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.root = h(document, 'section', { className: 'ash-docs-workspace', attributes: { 'data-creator-mode': 'docs' } });
		this.titlebar = this._register(this.artifactInstantiation.createInstance(ArtifactTitleBarWidget, document,
			localize({ bundle: 'ash.docs', key: 'actions' }, 'Docs actions'), undefined));
		const titleActions = this.artifactInstantiation.createInstance(ArtifactTitleActions);
		this._register(titleActions.onDidChangeHandoffAvailability(() => {
			this.titlebar.closeTitleMenu();
			this.titlebar.refreshTitleActions();
		}));
		this.titlebar.setTitleActions(() => {
			const copy = this.workingCopy;
			if (!copy) return [];
			const title = basename(copy.resource);
			return titleActions.getActions({
				title, getCodeAttachment: () => ({ name: title.replace(/\.ash-doc$/iu, '') + '.md', content: this.exportText('markdown') }),
			});
		});
		const body = h(document, 'div', { className: 'ash-docs-workspace-body' });
		this.controlsElement = h(document, 'div', { className: 'ash-docs-workspace-controls' });
		this.root.append(body);
		parent.append(this.root);
		this.saveAction = this._register(new Action('sessions.docs.save', localize('sessions.creator.save', 'Save document'), '', true, () => this.run(() => this.save())));
		this.saveAction.icon = Lxicon.save;
		this.tools = this._register(new Action('sessions.docs.tools', localize({ bundle: 'ash.docs', key: 'tools' }, 'Document tools'), '', true, () => {
			if (this.tools.checked) { this.layoutService.hidePart('auxiliarybar'); }
			else return this.revealTools();
		}));
		this.tools.icon = Lxicon.layoutSidebarRight;
		const updateTools = () => {
			this.tools.checked = this.layoutService.isPartVisible('auxiliarybar')
				&& this.views.getVisibleViewContainer(ViewContainerLocation.AuxiliaryBar)?.id === DOCS_TOOLS_CONTAINER_ID;
		};
		this._register(this.layoutService.onDidChangePartVisibility(({ partId }) => { if (partId === 'auxiliarybar') updateTools(); }));
		this._register(this.views.onDidChangeViewContainerVisibility(updateTools));
		updateTools();
		super.create(body);
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.titlebar.closeTitleMenu();
		await super.setInput(input, signal);
		signal.throwIfAborted();
		this.readOnly = input.readOnly === true;
		this.titlebar.setTitle(input.label ?? basename(input.resource));
		this.titlebar.refreshTitleActions();
		this.titlebar.setActions(this.readOnly ? [this.tools] : [this.saveAction, this.tools], this.getArtifactFormats().map(format => ({
			id: `sessions.docs.export.${format.id}`, label: format.label, enabled: true, tooltip: format.label,
			run: () => this.commands.executeCommand('workbench.action.document.export.file', format.id),
		})));
	}

	public override async save(): Promise<void> {
		if (!this.readOnly) await super.save();
	}

	public override setVisible(visible: boolean): void {
		if (!visible) this.titlebar?.closeTitleMenu();
		super.setVisible(visible);
	}

	public override containsAccessibilityFocus(target: HTMLElement): boolean {
		return this.root.contains(target) || this.titlebarContent.contains(target) || this.controlsElement.contains(target);
	}

	public override getAccessibilityHelp(): readonly string[] {
		return [
			localize({ bundle: 'ash.docs', key: 'workspaceHelp' }, 'When the title is a button, press Enter to open its artifact actions and Escape to return to the title. In the window title bar, use Export, Maximize artifact, or Close artifact. Document tools opens formatting, find, and the outline in the right sidebar.'),
			...super.getAccessibilityHelp(),
		];
	}

	protected override getControlsHost() {
		return { container: this.controlsElement, reveal: () => this.revealTools() };
	}

	private async revealTools(): Promise<void> {
		await this.run(() => this.views.openViewContainer(DOCS_TOOLS_CONTAINER_ID, false));
	}

	private async run(action: () => Promise<unknown>): Promise<void> {
		try { await action(); }
		catch (error) { this.notifications.error(String(error)); }
	}
}

/** The dock mounts editor-owned controls for the active document. */
export class DocsToolsView extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions, @IEditorPart editors: IEditorPart, @IEditorService editorService: IEditorService) {
		super(container, options);
		this.contentElement.classList.add('ash-docs-tools-view');
		this.contentElement.tabIndex = 0;
		const update = () => {
			const pane = editors.activePane;
			const controls = pane instanceof DocsArtifactPane ? pane.controlsElement : undefined;
			if (this.contentElement.firstChild !== (controls ?? null)) this.contentElement.replaceChildren(...(controls ? [controls] : []));
		};
		this._register(editorService.onDidActiveEditorChange(update));
		update();
	}
	public override focus(): void { this.contentElement.focus(); }
}
