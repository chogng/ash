import { EditorPane } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput, IEditorPane, IEditorExtensionApi } from '../../../src/ash/workbench/common/editor.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { IDialogService, IFileDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { addDisposableListener, h, type IDimension } from '../../../src/ash/base/browser/dom.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { localize } from '../../../src/ash/nls.js';
import type { EditorClientInstantiation } from '../../../src/ash/workbench/services/extensions/browser/extensionEditor.js';
import { registerResourceEditorAccessibility } from '../../../src/ash/workbench/services/extensions/browser/resourceEditorAccessibility.js';
import { createLibraryEntry, emptyLibrary, formatReference, importRecords, LIBRARY_EDITOR_ID, replaceEntry, serializeLibrary, type LibraryEntry } from '../common/library.js';
import { parseRis, RisParseError } from '../common/ris.js';
import { isReferenceLibraryCopy, ReferenceLibraryWorkingCopy } from './referenceLibraryWorkingCopy.js';
import './media/referenceLibrary.css';

/** Library state lives in the retained working copy, never in a second Academy document model. */
export class ReferenceLibraryEditor extends EditorPane {
	readonly id = LIBRARY_EDITOR_ID;
	private readonly inputLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly interactions = this._register(new DisposableStore());
	private copy: ReferenceLibraryWorkingCopy | undefined;
	private controller = new AbortController();
	private root: HTMLElement | undefined;
	private list: HTMLElement | undefined;
	private detail: HTMLElement | undefined;
	private status: HTMLElement | undefined;
	private search: HTMLInputElement | undefined;
	private targets: HTMLSelectElement | undefined;
	private selected: string | undefined;
	private input: IResourceEditorInput | undefined;
	private busy = false;
	private readonly buttons = new Map<string, HTMLButtonElement>();
	get workingCopy() { return this.copy; }

	constructor(private readonly provider: AbortSignal, private readonly construct: EditorClientInstantiation,
		@IFileService private readonly files: IFileService, @IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IDialogService private readonly dialogs: IDialogService, @IEditorService private readonly editors: IEditorService,
		@IWorkingCopyService private readonly copies: IWorkingCopyService, @IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService theme: IThemeService, @IStorageService storage: IStorageService) {
		super(LIBRARY_EDITOR_ID, theme, storage);
		this._register(addDisposableListener(provider, 'abort', () => { this.controller.abort(); this.render(); this.message(localize('references.retired', 'Reference Manager is unavailable. This library and unsaved changes are preserved; re-enable the extension and reopen it.')); }, { once: true }));
		this._register(editors.onDidVisibleEditorsChange(() => this.refreshTargets()));
		this._register(editors.onDidActiveEditorChange(() => this.refreshTargets()));
		this._register(toDisposable(() => { this.controller.abort(); this.root?.remove(); }));
	}
	override create(parent: HTMLElement): void {
		const root = h(parent.ownerDocument, 'section'); root.className = 'stanza-reference-library'; root.setAttribute('aria-label', localize('references.title', 'Reference library')); root.tabIndex = -1;
		const toolbar = h(parent.ownerDocument, 'div'); toolbar.className = 'reference-library-toolbar'; toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', localize('references.actions', 'Library actions'));
		const actions: readonly [string, string, () => Promise<unknown>][] = [
			['new', localize('references.new', 'New library'), () => this.newLibrary()],
			['import', localize('references.import', 'Import RIS'), () => this.importRis()],
			['add', localize('references.add', 'Add reference'), () => this.edit(true)],
			['edit', localize('references.edit', 'Edit reference'), () => this.edit(false)],
			['delete', localize('references.delete', 'Delete reference'), () => this.remove()],
			['save', localize('references.save', 'Save library'), () => this.save()],
			['saveAs', localize('references.saveAs', 'Save library as'), () => this.chooseSaveAs()],
			['reload', localize('references.reload', 'Reload library'), () => this.reload()],
			['attach', localize('references.attach', 'Attach PDF'), () => this.attachPdf()],
			['pdf', localize('references.pdf', 'Open PDF'), () => this.openPdf()],
		];
		for (const [id, label, run] of actions) this.button(toolbar, id, label, run);
		const citationBar = h(parent.ownerDocument, 'div'); citationBar.className = 'reference-library-toolbar';
		const targetLabel = h(parent.ownerDocument, 'label'); targetLabel.textContent = localize('references.target', 'Academy document');
		this.targets = h(parent.ownerDocument, 'select'); this.targets.setAttribute('aria-label', localize('references.target', 'Academy document')); targetLabel.append(this.targets); citationBar.append(targetLabel);
		this.button(citationBar, 'openDocument', localize('references.openDocument', 'Open Academy document'), () => this.openDocument());
		this.button(citationBar, 'insert', localize('references.insert', 'Insert citation'), () => this.citations('insert'));
		this.button(citationBar, 'update', localize('references.update', 'Update citations'), () => this.citations('update'));
		this._register(addDisposableListener(this.targets, 'change', () => this.updateButtons()));
		this.search = h(parent.ownerDocument, 'input'); this.search.type = 'search'; this.search.placeholder = localize('references.search', 'Search references'); this.search.setAttribute('aria-label', this.search.placeholder);
		this._register(addDisposableListener(this.search, 'input', () => { this.renderEntries(); this.updateButtons(); }));
		const content = h(parent.ownerDocument, 'div'); content.className = 'reference-library-content';
		this.list = h(parent.ownerDocument, 'div'); this.list.className = 'reference-library-list'; this.list.setAttribute('role', 'listbox'); this.list.setAttribute('aria-label', localize('references.list', 'References'));
		this.detail = h(parent.ownerDocument, 'article'); this.detail.className = 'reference-library-detail';
		this.status = h(parent.ownerDocument, 'div'); this.status.className = 'reference-library-status'; this.status.setAttribute('role', 'status');
		content.append(this.list, this.detail); root.append(toolbar, citationBar, this.search, content, this.status); parent.append(root); super.create(root); this.root = root;
		this._register(registerResourceEditorAccessibility(root, this.configuration,
			() => this.copy ? this.copy.library.entries.map(entry => `${entry.key}\n${formatReference(entry)}\n${entry.abstract}`).join('\n\n') : '',
			() => localize('references.help', 'Reference Manager imports RIS into an independent library. Open a .ris file to start, then save as .ash-library. Tab reaches actions, the Academy target, search, references and details. Use arrow keys, Home and End in the list, and Enter to select an entry. Add or Edit opens a metadata dialog. Save persists the library; conflicts retain unsaved changes for Save as or Reload. Save the library before inserting citations. Open an Academy document beside the library, place its caret, and select the target. Insert citation adds the entry and citation in one undo step; Update citations updates linked bibliography text and keys in one undo step. Deleting a library entry keeps document content. Attach PDF selects a local resource; Open PDF uses the separately installed PDF Viewer. Disabling freezes the library. Accessible View reads the library as text.')));
		this.refreshTargets(); this.render();
	}
	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput(); this.provider.throwIfAborted(); signal.throwIfAborted(); this.input = input;
		const scope = new DisposableStore(); this.inputLifetime.value = scope;
		const candidates = this.copies.get(input.resource).filter(isReferenceLibraryCopy);
		let copy = candidates.find(value => !value.providerSignal.aborted);
		const previous = candidates.find(value => value.providerSignal.aborted && value.isDirty);
		if (!copy) copy = this.construct(ReferenceLibraryWorkingCopy, input, this.provider);
		scope.add(copy.retain(input.readOnly === true)); this.copy = copy;
		try {
			await copy.ready;
			if (signal.aborted || scope.isDisposed) { signal.throwIfAborted(); throw new Error('retired input'); }
			if (previous && !input.readOnly) { const recovery = previous.peekRecovery(); if (recovery) { copy.acceptRecovery(recovery); previous.acknowledgeRecovery(); } }
			scope.add(copy.onDidChangeContent(() => this.render()));
			this.selected = copy.library.entries[0]?.id; this.render();
		} catch (error) { if (this.copy === copy) this.clearInput(); throw error; }
	}
	override clearInput(): void { this.controller.abort(); this.controller = new AbortController(); this.inputLifetime.clear(); this.copy = undefined; this.input = undefined; this.selected = undefined; this.busy = false; this.render(); }
	override layout(_dimension: IDimension): void { }
	override focus(): void { this.search?.focus(); }
	private signal(): AbortSignal { return AbortSignal.any([this.controller.signal, this.provider]); }
	private writable(): boolean { return !!this.copy && !this.copy.readOnly && !this.input?.readOnly && !this.busy; }
	private entry(): LibraryEntry | undefined { return this.copy?.library.entries.find(entry => entry.id === this.selected); }
	private button(parent: HTMLElement, id: string, label: string, run: () => Promise<unknown>): void {
		const button = h(parent.ownerDocument, 'button'); button.type = 'button'; button.textContent = label; button.dataset.action = id; parent.append(button); this.buttons.set(id, button);
		this._register(addDisposableListener(button, 'click', () => { void this.run(run); }));
	}
	private async run(action: () => Promise<unknown>): Promise<void> {
		if (this.busy || this.provider.aborted) return;
		const lifetime = this.controller.signal; this.busy = true; this.updateButtons();
		try { await action(); }
		catch (error) { if (!lifetime.aborted) this.message(error instanceof RisParseError ? localize('references.risError', 'RIS import failed at line {0}: {1}', error.line, risErrorText(error.code)) : localize('references.failed', 'The action failed. Your library changes are retained: {0}', error instanceof Error ? error.message : String(error))); }
		finally { if (!lifetime.aborted) { this.busy = false; this.updateButtons(); } }
	}
	private message(text: string): void { if (this.status) this.status.textContent = text; }
	private render(): void {
		this.renderEntries(); this.updateButtons();
		if (this.copy) this.message(this.copy.isDirty ? localize('references.unsaved', 'Unsaved library changes') : localize('references.count', '{0} references saved', this.copy.library.entries.length));
	}
	private renderEntries(): void {
		if (!this.list || !this.detail) return;
		const focused = this.list.contains(this.list.ownerDocument.activeElement);
		this.interactions.clear(); this.list.replaceChildren(); this.detail.replaceChildren();
		const query = this.search?.value.normalize('NFKC').toLowerCase().trim() ?? '';
		const entries = this.copy?.library.entries.filter(entry => !query || [entry.key, entry.title, entry.authors.join(' '), entry.year, entry.doi, entry.journal, entry.keywords.join(' ')].join(' ').normalize('NFKC').toLowerCase().includes(query)) ?? [];
		if (!entries.some(entry => entry.id === this.selected)) this.selected = entries[0]?.id;
		for (const [index, entry] of entries.entries()) {
			const item = h(this.list.ownerDocument, 'button'); item.type = 'button'; item.className = 'reference-library-entry'; item.dataset.entryId = entry.id; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(entry.id === this.selected)); item.tabIndex = entry.id === this.selected || !entries.some(entry => entry.id === this.selected) && index === 0 ? 0 : -1;
			item.textContent = `${entry.key} — ${entry.title || localize('references.untitled', 'Untitled reference')}`;
			const select = () => { this.selected = entry.id; this.renderEntries(); this.updateButtons(); this.list?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus(); };
			this.interactions.add(addDisposableListener(item, 'click', select));
			this.interactions.add(addDisposableListener(item, 'keydown', event => {
				const next = event.key === 'ArrowDown' ? Math.min(index + 1, entries.length - 1) : event.key === 'ArrowUp' ? Math.max(index - 1, 0) : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : -1;
				if (next >= 0) { event.preventDefault(); this.selected = entries[next].id; this.renderEntries(); this.updateButtons(); this.list?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus(); }
			})); this.list.append(item);
		}
		const entry = this.entry();
		if (entry) {
			const heading = h(this.detail.ownerDocument, 'h2'); heading.textContent = entry.title || localize('references.untitled', 'Untitled reference');
			const summary = h(this.detail.ownerDocument, 'p'); summary.textContent = formatReference(entry);
			const abstract = h(this.detail.ownerDocument, 'p'); abstract.textContent = entry.abstract;
			const attachments = h(this.detail.ownerDocument, 'p'); attachments.textContent = entry.attachments.join('\n'); this.detail.append(heading, summary, abstract, attachments);
		} else this.detail.textContent = localize('references.empty', 'Import RIS or add a reference to begin.');
		if (focused) this.list.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
	}
	private refreshTargets(): void {
		if (!this.targets) return;
		const selected = this.targets.value; this.targets.replaceChildren();
		for (const pane of this.editors.visibleEditorPanes) {
			if (!pane.getExtensionApi?.('academy.citations.v1') || !pane.workingCopy) continue;
			const option = h(this.targets.ownerDocument, 'option'); option.value = pane.workingCopy.resource.toString(); option.textContent = pane.workingCopy.resource.path.split('/').pop() ?? option.value; this.targets.append(option);
		}
		if ([...this.targets.options].some(option => option.value === selected)) this.targets.value = selected;
		this.updateButtons();
	}
	private target(): IEditorPane | undefined { return this.editors.visibleEditorPanes.find(pane => pane.workingCopy?.resource.toString() === this.targets?.value && !!pane.getExtensionApi?.('academy.citations.v1')); }
	private updateButtons(): void {
		const writable = this.writable(); const selected = !!this.entry();
		for (const [id, button] of this.buttons) {
			button.disabled = !writable;
			if (['edit', 'delete', 'attach'].includes(id)) button.disabled ||= !selected;
			if (id === 'pdf') button.disabled = this.provider.aborted || this.busy || !this.entry()?.attachments.length;
			if (id === 'insert' || id === 'update') button.disabled ||= !this.copy?.persisted || this.copy.isDirty || !this.target() || this.target()?.getExtensionApi?.('academy.citations.v1')?.readOnly === true || id === 'insert' && !selected;
		}
	}
	private async persist(): Promise<void> { if (this.copy?.persisted) await this.copy.save(this.signal()); }
	async save(): Promise<void> {
		const copy = this.editableCopy(); await copy.save(this.signal());
		if (copy.persisted && copy.resource.toString() !== this.input?.resource.toString()) await this.editors.openEditor({ resource: copy.resource }, { preferredEditorId: LIBRARY_EDITOR_ID });
	}
	async saveAs(resource: URI): Promise<void> { await this.editableCopy().saveAs(resource, this.signal()); }
	private editableCopy(): ReferenceLibraryWorkingCopy {
		if (!this.copy || this.input?.readOnly) throw new Error(localize('references.readOnly', 'This library is read-only or its extension is unavailable.'));
		return this.copy;
	}
	private async newLibrary(): Promise<void> {
		const target = await this.fileDialogs.showSaveDialog({ title: localize('references.new', 'New library'), filters: [{ name: localize('references.libraryFiles', 'Reference libraries'), extensions: ['ash-library'] }] });
		if (!target) return; this.signal().throwIfAborted();
		if (!/\.ash-library$/iu.test(target.path)) throw new Error(localize('references.extension', 'Choose a file ending in .ash-library.'));
		await this.files.writeFile({ resource: target, content: serializeLibrary(emptyLibrary()) }, { create: true, overwrite: false }, this.signal());
		await this.editors.openEditor({ resource: target }, { preferredEditorId: LIBRARY_EDITOR_ID }, 'sideGroup');
	}
	private async importRis(): Promise<void> {
		const source = await this.fileDialogs.showOpenDialog({ canSelectFiles: true, canSelectMany: false, filters: [{ name: 'RIS', extensions: ['ris'] }] });
		if (!source?.[0]) return; const signal = this.signal(); const copy = this.copy!;
		const content = await this.files.readFile(source[0]); signal.throwIfAborted();
		const imported = importRecords(copy.library, parseRis(content.content)); copy.replace(imported.library); await this.persist();
		this.selected ??= imported.library.entries[0]?.id; this.render(); this.message(localize('references.imported', 'Imported {0} references; skipped {1} duplicates.', imported.added, imported.duplicates));
	}
	private async edit(add: boolean): Promise<void> {
		const copy = this.copy!; const signal = this.signal(); const current = add ? createLibraryEntry() : this.entry();
		if (!current) return;
		const labels = [localize('references.key', 'Reference key'), localize('references.metadataTitle', 'Title'), localize('references.authors', 'Authors (separated by semicolons)'), localize('references.year', 'Year'), 'DOI', localize('references.journal', 'Journal or book title'), localize('references.volume', 'Volume'), localize('references.issue', 'Issue'), localize('references.startPage', 'Start page'), localize('references.endPage', 'End page'), 'URL', localize('references.abstract', 'Abstract'), localize('references.keywords', 'Keywords (separated by semicolons)')];
		const values = [current.key, current.title, current.authors.join('; '), current.year, current.doi, current.journal, current.volume, current.issue, current.startPage, current.endPage, current.url, current.abstract, current.keywords.join('; ')];
		const result = await this.dialogs.input({ title: add ? localize('references.add', 'Add reference') : localize('references.edit', 'Edit reference'), message: localize('references.metadataHelp', 'Edit the fields below. Separate multiple authors or keywords with semicolons.'), inputs: labels.map((placeholder, index) => ({ placeholder, value: values[index] })) });
		if (!result.confirmed || !result.values) return; signal.throwIfAborted();
		const [key, title, authors, year, doi, journal, volume, issue, startPage, endPage, url, abstract, keywords] = result.values.map(value => value.trim());
		const entry: LibraryEntry = { ...current, id: current.id, key, title, authors: authors.split(';').map(value => value.trim()).filter(Boolean), year, doi, journal, volume, issue, startPage, endPage, url, abstract, keywords: keywords.split(';').map(value => value.trim()).filter(Boolean) };
		copy.replace(replaceEntry(copy.library, entry)); this.selected = entry.id; await this.persist(); this.render();
	}
	private async remove(): Promise<void> {
		const entry = this.entry(); if (!entry) return; const copy = this.copy!; const signal = this.signal();
		const result = await this.dialogs.confirm({ title: localize('references.delete', 'Delete reference'), message: localize('references.deleteConfirm', 'Delete {0} from this library? Citations and bibliography entries already in documents will be retained.', entry.key) });
		if (!result.confirmed) return; signal.throwIfAborted(); copy.replace({ ...copy.library, entries: copy.library.entries.filter(value => value.id !== entry.id) }); this.selected = copy.library.entries[0]?.id; await this.persist(); this.render();
	}
	private async chooseSaveAs(): Promise<void> {
		const destination = await this.fileDialogs.showSaveDialog({ title: localize('references.saveLibrary', 'Save reference library'), filters: [{ name: localize('references.libraryFiles', 'Reference libraries'), extensions: ['ash-library'] }] });
		if (!destination) return; await this.saveAs(destination); await this.editors.openEditor({ resource: destination }, { preferredEditorId: LIBRARY_EDITOR_ID });
	}
	private async reload(): Promise<void> {
		if (this.copy?.isDirty && !(await this.dialogs.confirm({ title: localize('references.reload', 'Reload library'), message: localize('references.discard', 'Discard unsaved library changes and reload the saved file?') })).confirmed) return;
		await this.copy?.revert(this.signal()); this.render();
	}
	private async attachPdf(): Promise<void> {
		const entry = this.entry(); if (!entry) return; const copy = this.copy!; const signal = this.signal();
		const attachments = await this.fileDialogs.showOpenDialog({ canSelectFiles: true, canSelectMany: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
		if (!attachments?.length) return; signal.throwIfAborted(); copy.replace(replaceEntry(copy.library, { ...entry, attachments: [...new Set([...entry.attachments, ...attachments.map(value => value.toString())])] })); await this.persist();
	}
	private async openPdf(): Promise<void> {
		const attachment = this.entry()?.attachments[0]; if (!attachment) return;
		if (!EditorPanes.getEditorPanes().some(pane => pane.id === 'ash.workbench.pdfViewer')) throw new Error(localize('references.pdfUnavailable', 'Install, enable and authorize PDF Viewer to open this attachment.'));
		await this.editors.openEditor({ resource: URI.parse(attachment), contentType: 'application/pdf' }, { preferredEditorId: 'ash.workbench.pdfViewer' }, 'sideGroup');
	}
	private async openDocument(): Promise<void> {
		if (!EditorPanes.getEditorPanes().some(pane => pane.id === 'stanza.editor.document')) throw new Error(localize('references.academyUnavailable', 'Install, enable and authorize Academy first.'));
		const resource = await this.fileDialogs.showOpenDialog({ canSelectFiles: true, filters: [{ name: 'Academy', extensions: ['ash-academic', 'ash-paper'] }] });
		if (!resource?.[0]) return; this.signal().throwIfAborted(); await this.editors.openEditor({ resource: resource[0] }, { preferredEditorId: 'stanza.editor.document' }, 'sideGroup'); this.refreshTargets();
	}
	private async citations(operation: 'insert' | 'update'): Promise<void> {
		const target = this.target(); const api: IEditorExtensionApi | undefined = target?.getExtensionApi?.('academy.citations.v1');
		if (!api || api.readOnly || !this.copy?.persisted || this.copy.isDirty) throw new Error(localize('references.chooseTarget', 'Save the library and choose an editable Academy document.'));
		const entries = operation === 'insert' ? [this.entry()!] : this.copy.library.entries;
		const result = await api.invoke({ version: 1, operation, libraryId: this.copy.library.id, references: entries.map(entry => ({ id: entry.id, key: entry.key, text: formatReference(entry) })) }, this.signal());
		if (typeof result !== 'object' || result === null || !('version' in result) || result.version !== 1 || !('changed' in result) || !Number.isSafeInteger(result.changed) || !('missing' in result) || !Array.isArray(result.missing) || result.missing.some(value => typeof value !== 'string')) throw new Error(localize('references.invalidResponse', 'Academy returned an incompatible citation response.'));
		this.message(localize('references.citationsUpdated', 'Updated {0} bibliography entries. Missing library entries: {1}.', result.changed as number, result.missing.length));
	}
}

function risErrorText(code: RisParseError['code']): string {
	switch (code) {
		case 'emptyInput': return localize('references.ris.empty', 'No RIS records were found.');
		case 'missingType': return localize('references.ris.type', 'A record must start with TY.');
		case 'missingEnd': return localize('references.ris.end', 'A record is missing ER.');
		case 'unexpectedType': return localize('references.ris.nested', 'A new record starts before the previous record ends.');
		case 'invalidTag': return localize('references.ris.tag', 'A field or continuation line is malformed.');
		case 'limit': return localize('references.ris.limit', 'The RIS import exceeds the supported size or record limit.');
	}
}
