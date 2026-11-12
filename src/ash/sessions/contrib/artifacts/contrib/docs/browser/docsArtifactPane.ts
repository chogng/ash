import './docsArtifactPane.css';
import { h, type IDimension } from '../../../../../../base/browser/dom.js';
import { Action } from '../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { basename } from '../../../../../../base/common/resources.js';
import { localize } from '../../../../../../nls.js';
import { WorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IEditorPart } from '../../../../../../workbench/browser/parts/editor/editorPart.js';
import { ViewPane, type IViewPaneOptions } from '../../../../../../workbench/browser/parts/views/viewPane.js';
import type { IResourceEditorInput } from '../../../../../../workbench/common/editor.js';
import { ViewContainerLocation } from '../../../../../../workbench/common/views.js';
import { DocumentEditorPane, type EditorPaneOptions } from '../../../../../../workbench/contrib/documentEditor/browser/documentEditorPane.js';
import { IDocumentEditorTextModelService } from '../../../../../../workbench/services/documentEditor/common/documentTypes.js';
import { IEditorService } from '../../../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../../../workbench/services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../../../workbench/services/views/common/viewsService.js';
import { DOCS_TOOLS_CONTAINER_ID } from '../common/docs.js';

/** The Artifacts presentation borrows the same document working copy and editor controls. */
export class DocsArtifactPane extends DocumentEditorPane {
	private root!: HTMLElement;
	private header!: HTMLElement;
	private title!: HTMLElement;
	private toolbar!: WorkbenchToolBar;
	public controlsElement!: HTMLElement;
	private back!: Action;
	private saveAction!: Action;
	private tools!: Action;
	private readOnly = false;

	constructor(
		options: EditorPaneOptions,
		@IDialogService dialogs: IDialogService,
		@IDocumentEditorTextModelService models: IDocumentEditorTextModelService,
		@IInstantiationService instantiation: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@ICommandService private readonly commands: ICommandService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly views: IViewsService,
	) {
		super(options, dialogs, models, instantiation, theme, storage);
	}

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.root = h(document, 'section', { className: 'ash-docs-workspace', attributes: { 'data-creator-mode': 'docs' } });
		this.header = h(document, 'header', { className: 'ash-docs-workspace-header' });
		this.title = h(document, 'h1', { className: 'ash-docs-workspace-title' });
		const actions = h(document, 'div', { className: 'ash-docs-workspace-actions' });
		const body = h(document, 'div', { className: 'ash-docs-workspace-body' });
		this.controlsElement = h(document, 'div', { className: 'ash-docs-workspace-controls' });
		this.header.append(this.title, actions);
		this.root.append(this.header, body);
		parent.append(this.root);
		this.toolbar = this._register(new WorkbenchToolBar(actions, this.contextMenus, { ariaLabel: localize({ bundle: 'ash.docs', key: 'actions' }, 'Docs actions'), highlightToggledItems: true }));
		this.back = this._register(new Action('sessions.docs.back', localize({ bundle: 'ash.docs', key: 'back' }, 'Back to Artifacts'), '', true, () => this.run(() => this.commands.executeCommand('sessions.show.creator'))));
		this.back.icon = Lxicon.arrowLeft;
		this.saveAction = this._register(new Action('sessions.docs.save', localize('sessions.creator.save', 'Save document'), '', true, () => this.run(() => this.save())));
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
		await super.setInput(input, signal);
		signal.throwIfAborted();
		this.readOnly = input.readOnly === true;
		this.title.textContent = input.label ?? basename(input.resource);
		this.toolbar.setActions(this.readOnly ? [this.back, this.tools] : [this.back, this.saveAction, this.tools]);
	}

	public override async save(): Promise<void> {
		if (!this.readOnly) await super.save();
	}

	public override layout(dimension: IDimension): void {
		super.layout({ width: dimension.width, height: Math.max(0, dimension.height - this.header.offsetHeight) });
	}

	public override containsAccessibilityFocus(target: HTMLElement): boolean {
		return this.root.contains(target) || this.controlsElement.contains(target);
	}

	public override getAccessibilityHelp(): readonly string[] {
		return [
			localize({ bundle: 'ash.docs', key: 'workspaceHelp' }, 'Use the Docs actions toolbar above the document to return to Artifacts or open Document tools. Document tools opens formatting, find, and the outline in the right sidebar.'),
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
