import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IEditorPartsService } from '../../../../workbench/browser/parts/editor/editorParts.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import type { ISessionsEditorPage } from '../../../browser/parts/editorPart.js';
import { ArtifactTitleBarWidget } from './artifactTitleBarWidget.js';
import { ArtifactTitleActions } from './artifactTitleActions.js';
import { IArtifactPins } from './artifactPins.js';
import { getArtifactTitle } from './artifactKindPresentation.js';
import { IArtifactTableService } from '../common/artifactTableService.js';
import type { ArtifactTableModel } from '../common/artifactTableModel.js';
import { ArtifactTableEditorWidget } from './artifactTableEditorWidget.js';

const panes = new WeakMap<Element, ArtifactTableEditor>();

/** Opens one persisted Sheet or Data file through the normal editor lifecycle. */
export class ArtifactTableEditor extends EditorPane implements ISessionsEditorPage {
	public static readonly ID = 'sessions.editor.table';
	public readonly id = ArtifactTableEditor.ID;
	private body!: HTMLElement;
	private titlebar!: ArtifactTitleBarWidget;
	private readonly widget = this._register(new MutableDisposable<ArtifactTableEditorWidget>());
	private readonly titleObserver = this._register(new MutableDisposable());
	private source: ArtifactTableModel | undefined;
	public get titlebarContent(): HTMLElement { return this.titlebar.domNode; }
	public override getTitleControl(): HTMLElement | undefined { return this.titlebar?.domNode; }

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IArtifactTableService private readonly tables: IArtifactTableService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IFileService private readonly files: IFileService,
		@INotificationService private readonly notifications: INotificationService,
		@IArtifactPins private readonly pins: IArtifactPins,
		@IEditorPartsService private readonly editorParts: IEditorPartsService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) { super(ArtifactTableEditor.ID, theme, storage); }

	override create(parent: HTMLElement): void {
		this.body = h(parent.ownerDocument, 'div', { className: 'ash-table-editor-pane' });
		parent.append(this.body);
		super.create(this.body);
		this.titlebar = this._register(this.instantiation.createInstance(ArtifactTitleBarWidget, parent.ownerDocument,
			getArtifactTitle('sheet'), undefined));
		panes.set(this.body, this);
		panes.set(this.titlebar.domNode, this);
		const titleActions = this.instantiation.createInstance(ArtifactTitleActions);
		this._register(titleActions.onDidChangeHandoffAvailability(() => {
			this.titlebar.closeTitleMenu();
			this.titlebar.refreshTitleActions();
		}));
		this.titlebar.setTitleActions(() => {
			const source = this.source;
			if (!source) return [];
			return titleActions.getActions({
				title: this.getDocumentTitle(source), identity: { type: 'table', id: source.id },
				getCodeAttachment: () => ({ name: `${this.getDocumentTitle(source)}.csv`, content: this.toCsv(source) }),
				rename: () => this.titlebar.beginRename(),
				popOut: async () => {
					const editor = this.group?.editors.find(editor => extUri.isEqual(editor.input.resource, this.tables.resource(source)));
					if (editor) await this.editorParts.openEditorsInNewWindow([editor], 'move');
				},
				delete: async () => {
					await this.tables.delete(source);
					this.pins.setPinned({ type: 'table', id: source.id }, false);
					if (this.source === source) await this.group?.closeEditor({ resource: this.tables.resource(source), editorId: ArtifactTableEditor.ID });
				},
			});
		}, () => {
			const source = this.source;
			return source ? title => this.tables.rename(source, title) : undefined;
		});
		const exportCsv = this._register(new Action('sessions.artifacts.table.exportCsv',
			localize({ bundle: 'ash.artifacts', key: 'exportCsv' }, 'Export CSV'), '', true, () => this.exportCsv()));
		this.titlebar.setActions([], [exportCsv]);
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		await this.tables.ready;
		signal.throwIfAborted();
		const source = [...this.tables.drafts.get().values()].find(draft => extUri.isEqual(this.tables.resource(draft), input.resource));
		if (!source) throw new Error(localize({ bundle: 'ash.artifacts', key: 'tableMissing' }, 'The table file could not be opened.'));
		this.source = source;
		const widget = this.widget.value = new ArtifactTableEditorWidget(this.body.ownerDocument, this.getDocumentTitle(source), source);
		this.body.append(widget.domNode);
		widget.layout(this.body.clientWidth - 48);
		this.titleObserver.value = autorun(reader => {
			source.title.read(reader);
			const title = this.getDocumentTitle(source);
			widget.setTitle(title);
			this.titlebar.setTitle(title);
			this.titlebar.refreshTitleActions();
		});
	}

	override clearInput(): void {
		this.titlebar?.closeTitleMenu();
		this.titleObserver.clear();
		this.widget.clear();
		this.source = undefined;
	}
	override setVisible(visible: boolean): void {
		if (!visible) this.titlebar.closeTitleMenu();
		super.setVisible(visible);
	}
	override layout(dimension: IDimension): void {
		this.body.style.width = `${dimension.width}px`;
		this.body.style.height = `${dimension.height}px`;
		this.widget.value?.layout(dimension.width - 48);
	}
	override focus(): void { this.widget.value?.focus(); }
	public static getFocused(element: HTMLElement): ArtifactTableEditor | undefined {
		const root = element.closest('.ash-table-editor-pane, .ash-sessions-titlebar-editor-page');
		return root ? panes.get(root) : undefined;
	}
	public getAccessibilityHelp(): string {
		return localize({ bundle: 'ash.artifacts', key: 'tableHelp' }, 'In an editable table, use Tab and Shift+Tab to move between cells. At the first and last cells, Tab leaves the table. Use Up, Down and Enter to move between rows. Left and Right move the text cursor. Paste tab-separated rows to fill a cell range; the table expands as needed. Add row and Add column extend the table. Delete row and Delete column remove the active cell’s row or column; the last row and column are preserved. Choose Export CSV from Export in the window title bar. Changes save automatically and you can reopen the table from Artifacts.') + '\n\n';
	}

	public getAccessibleContent(): string { return this.widget.value?.getAccessibleContent() ?? ''; }

	private getDocumentTitle(source: ArtifactTableModel): string {
		return source.title.get() ?? localize('sessions.creator.untitled', 'Untitled {0}', getArtifactTitle(source.kind));
	}
	private toCsv(source: ArtifactTableModel): string {
		return source.rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
	}
	private async exportCsv(): Promise<void> {
		const source = this.source;
		if (!source) return;
		try {
			const resource = await this.dialogs.showSaveDialog({
				title: localize({ bundle: 'ash.artifacts', key: 'exportCsv' }, 'Export CSV'),
				filters: [{ name: 'CSV', extensions: ['csv'] }],
			});
			if (!resource || this.isDisposed) return;
			if (extUri.isEqual(resource, this.tables.resource(source))) {
				throw new Error(localize('document.output.sourceTarget', 'Choose a separate output file to preserve the open document.'));
			}
			await this.files.writeFile({ resource, content: this.toCsv(source) });
		} catch (error) { this.notifications.error(error instanceof Error ? error : String(error)); }
	}
}
