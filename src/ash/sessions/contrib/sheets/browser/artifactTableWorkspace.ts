import './artifactTableWorkspace.css';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ArtifactTableDraft, IArtifactTableDrafts } from './artifactTableDrafts.js';
import type { IArtifactWorkspace } from '../../artifact/browser/artifactWorkspaceRegistry.js';

export class ArtifactTableWorkspace extends Disposable implements IArtifactWorkspace {
	public readonly domNode: HTMLElement;
	public readonly exportActions: readonly Action[];
	private readonly tableControls = this._register(new DisposableStore());
	private readonly titleChanged = this._register(new Emitter<void>());
	public readonly onDidChangeTitle = this.titleChanged.event;
	public get title(): string {
		return this.source.title.get() ?? this.defaultTitle;
	}
	public get rename(): ((title: string) => Promise<void>) | undefined {
		const { source } = this;
		return title => this.drafts.rename(source, title);
	}
	public get delete(): (() => Promise<void>) | undefined {
		const { source } = this;
		return () => this.drafts.delete(source);
	}

	constructor(
		ownerDocument: Document,
		private readonly defaultTitle: string,
		private readonly source: ArtifactTableDraft,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IFileService private readonly files: IFileService,
		@INotificationService private readonly notifications: INotificationService,
		@IArtifactTableDrafts private readonly drafts: IArtifactTableDrafts,
	) {
		super();
		const { kind } = source;
		this.domNode = h(ownerDocument, 'section', {
			className: `ash-artifact-table-workspace ${kind}`,
			attributes: { 'aria-label': this.title, 'data-creator-mode': kind, tabindex: '0' },
		});
		this._register(toDisposable(() => this.domNode.remove()));
		this.exportActions = [this._register(new Action('sessions.artifacts.table.exportCsv',
			localize({ bundle: 'ash.artifacts', key: 'exportCsv' }, 'Export CSV'), '', true, () => this.exportCsv()))];
		this.domNode.classList.add('editable');
		this.renderDraft(source);
		this._register(autorun(reader => {
			source.title.read(reader);
			this.domNode.setAttribute('aria-label', this.title);
			this.domNode.querySelector('table')?.setAttribute('aria-label', this.title);
			this.titleChanged.fire();
		}));
	}

	public getAccessibilityHelp(): string {
		return localize({ bundle: 'ash.artifacts', key: 'tableHelp' }, 'In an editable table, use Tab to move between cells and reach Add row and Add column. Choose Export CSV from Export in the window title bar. Changes save automatically and you can reopen the table from Artifacts.') + '\n\n';
	}

	private renderDraft(draft: ArtifactTableDraft, focus?: { row: number; column: number; }): void {
		this.tableControls.clear();
		const document = this.domNode.ownerDocument;
		const table = h(document, 'table', { attributes: { 'aria-label': this.title } });
		const headings = table.createTHead().insertRow();
		headings.append(h(document, 'td'));
		for (let column = 0; column < draft.columnCount; column++) {
			headings.append(h(document, 'th', { attributes: { scope: 'col' } }, getColumnName(column)));
		}
		this.addTableButton(headings.insertCell(), localize({ bundle: 'ash.artifacts', key: 'addColumn' }, 'Add column'), () => {
			draft.addColumn();
			this.renderDraft(draft, { row: 0, column: draft.columnCount - 1 });
		});
		const body = table.createTBody();
		let active: HTMLInputElement | undefined;
		for (const [row, values] of draft.rows.entries()) {
			const line = body.insertRow();
			line.append(h(document, 'th', { attributes: { scope: 'row' } }, String(row + 1)));
			for (const [column, value] of values.entries()) {
				const input = h(document, 'input', {
					properties: { value },
					attributes: { 'aria-label': localize({ bundle: 'ash.artifacts', key: 'cell' }, 'Cell {0}', `${getColumnName(column)}${row + 1}`) },
				});
				input.oninput = () => { draft.setCell(row, column, input.value); };
				line.insertCell().append(input);
				if (focus?.row === row && focus.column === column) active = input;
			}
		}
		const footer = table.createTFoot().insertRow();
		const addRowCell = footer.insertCell();
		addRowCell.colSpan = draft.columnCount + 2;
		this.addTableButton(addRowCell, localize({ bundle: 'ash.artifacts', key: 'addRow' }, 'Add row'), () => {
			draft.addRow();
			this.renderDraft(draft, { row: draft.rows.length - 1, column: 0 });
		});
		this.domNode.replaceChildren(table);
		active?.focus();
	}

	private addTableButton(container: HTMLElement, label: string, onClick: () => void): void {
		const button = this.tableControls.add(new Button(container, { ...defaultButtonStyles, label, title: label, iconOnly: true, size: 'small', onClick }));
		button.icon = Lxicon.add;
	}

	private async exportCsv(): Promise<void> {
		try {
			const resource = await this.dialogs.showSaveDialog({
				title: localize({ bundle: 'ash.artifacts', key: 'exportCsv' }, 'Export CSV'),
				filters: [{ name: 'CSV', extensions: ['csv'] }],
			});
			if (!resource || this.isDisposed) { return; }
			await this.files.writeFile({ resource, content: this.toCsv() });
		} catch (error) {
			this.notifications.error(error instanceof Error ? error : String(error));
		}
	}

	public getCodeAttachment(): { readonly name: string; readonly content: string; } {
		return { name: `${this.title}.csv`, content: this.toCsv() };
	}

	private toCsv(): string {
		const rows = this.source.rows;
		return rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
	}

	public create(container: HTMLElement): void { container.append(this.domNode); }
	public setVisible(_visible: boolean): void { }
	public layout(_dimension: IDimension): void { }
	public focus(): void { this.domNode.focus(); }
	public getAccessibleContent(): string {
		return this.source.rows.map(row => row.join('\t')).join('\n');
	}
}

function getColumnName(column: number): string {
	let name = '';
	for (let index = column + 1; index > 0; index = Math.floor((index - 1) / 26)) {
		name = String.fromCharCode(65 + (index - 1) % 26) + name;
	}
	return name;
}
