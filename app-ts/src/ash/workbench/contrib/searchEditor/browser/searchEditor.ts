import './media/searchEditor.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { LabelActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import { localize } from '../../../../nls.js';
import { IContentSearchService, type IContentSearchQuery } from '../../../../platform/search/common/search.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { EditorOpenSource, TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import { CODE_EDITOR_ID, type TextResourceEditor } from '../../../browser/parts/editor/textResourceEditor.js';
import { IEditorService, type EditorInput } from '../../../services/editor/common/editorService.js';
import { SearchResultImpl } from '../../search/browser/searchTreeModel/searchResult.js';
import { SearchEditorID, InSearchEditor } from './constants.js';
import { parseSearchEditor, searchEditorLocation, serializeSearchResultForEditor } from './searchEditorSerialization.js';

/** Query controls own transient input; the shared text editor owns the editable, saved search document. */
export class SearchEditor extends Disposable implements IEditorPane {
	public readonly id = SearchEditorID;
	public domNode!: HTMLElement;
	private queryInput!: HTMLTextAreaElement;
	private include!: InputBox;
	private exclude!: InputBox;
	private options!: ActionBar;
	private runButton!: Button;
	private stopButton!: Button;
	private status!: HTMLElement;
	private body!: HTMLElement;
	private query!: IContentSearchQuery;
	private controller: AbortController | undefined;
	private readonly inputListeners = this._register(new DisposableStore());
	private dimension: IDimension | undefined;

	constructor(
		private readonly textEditor: TextResourceEditor,
		@IContentSearchService private readonly search: IContentSearchService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorService private readonly editors: IEditorService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
	) {
		super();
		this._register(textEditor);
	}

	public getControl(): ReturnType<TextResourceEditor['getControl']> { return this.textEditor.getControl(); }
	public get workingCopy(): TextResourceEditor['workingCopy'] { return this.textEditor.workingCopy; }
	public save(): Promise<void> { return this.textEditor.save(); }
	public saveAs(resource: URI): Promise<void> { return this.textEditor.saveAs(resource); }

	public create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-search-editor';
		parent.append(this.domNode);
		this._register(toDisposable(() => { this.controller?.abort(); this.domNode.remove(); }));
		const scope = this._register(this.contextKeys.createScoped(this.domNode));
		const focused = InSearchEditor.bindTo(scope);
		this._register(addDisposableListener(this.domNode, 'focusin', () => focused.set(true)));
		this._register(addDisposableListener(this.domNode, 'focusout', event => {
			if (!this.domNode.contains(event.relatedTarget as Node | null)) { focused.set(false); }
		}));
		const form = h(document, 'form');
		form.className = 'ash-search-editor-form';
		const field = h(document, 'div');
		field.className = 'ash-search-editor-query-field';
		this.queryInput = h(document, 'textarea');
		this.queryInput.className = 'ash-search-editor-query';
		this.queryInput.rows = 2;
		this.queryInput.spellcheck = false;
		this.queryInput.setAttribute('aria-label', localize('searchEditor.query', 'Search editor query'));
		field.append(this.queryInput);
		const optionLabels: Readonly<Record<string, string>> = { case: 'Aa', word: 'ab', regex: '.*' };
		this.options = this._register(new ActionBar(field, {
			ariaLabel: localize('search.options', 'Search options'),
			highlightToggledItems: true,
			actionViewItemProvider: action => new LabelActionViewItem(action, {
				label: optionLabels[action.id]!,
				ariaLabel: action.label,
			}),
		}));
		form.append(field);
		this.include = this._register(new InputBox(form, {
			presentation: 'compact',
			ariaLabel: localize('search.includesLabel', 'Files to include'),
			placeholder: localize('search.includes', 'files to include'),
		}));
		this.exclude = this._register(new InputBox(form, {
			presentation: 'compact',
			ariaLabel: localize('search.excludesLabel', 'Files to exclude'),
			placeholder: localize('search.excludes', 'files to exclude'),
		}));
		const buttons = h(document, 'div');
		buttons.className = 'ash-search-editor-buttons';
		this.runButton = this._register(new Button(buttons, {
			label: localize('searchEditor.run', 'Search again'),
			onClick: () => { void this.runSearch(); },
		}));
		this.stopButton = this._register(new Button(buttons, {
			label: localize('search.stop', 'Stop search'),
			presentation: 'secondary',
			onClick: () => this.controller?.abort(),
		}));
		this.stopButton.enabled = false;
		form.append(buttons);
		this.status = h(document, 'div');
		this.status.className = 'ash-search-editor-status';
		this.status.setAttribute('role', 'status');
		this.body = h(document, 'div');
		this.body.className = 'ash-search-editor-results';
		this.domNode.append(form, this.status, this.body);
		this.textEditor.create(this.body);
		this._register(observeElementSize(this.body, size => this.textEditor.layout(size)));
		const updateHint = () => this.queryInput.setAttribute('aria-description', this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Find)
			? localize('search.helpHint', 'Press Alt+F1 for search accessibility help.') : '');
		updateHint();
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.Find)) { updateHint(); }
		}));
		for (const input of [this.queryInput, this.include.inputElement, this.exclude.inputElement]) {
			this._register(addDisposableListener(input, 'input', () => this.writeQuery()));
		}
		this._register(addDisposableListener(form, 'submit', event => {
			event.preventDefault();
			void this.runSearch();
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.isComposing) { return; }
			if (event.key === 'Escape' && this.controller) { event.preventDefault(); this.controller.abort(); }
			if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) { return; }
			event.preventDefault();
			event.stopPropagation();
			if (form.contains(event.target as Node)) { void this.runSearch(); }
			else { void this.openResult(); }
		}, true));
	}

	public async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		await this.textEditor.setInput({ ...input, editorId: CODE_EDITOR_ID, languageId: 'plaintext', showBreadcrumbs: false }, signal);
		this.readQuery();
		this.inputListeners.add(this.getControl()!.onDidChangeModelContent(() => this.readQuery()));
		this.inputListeners.add(this.workspace.onDidChangeWorkspace(() => this.controller?.abort()));
		if (this.dimension) { this.layout(this.dimension); }
	}

	public clearInput(): void {
		this.controller?.abort();
		this.controller = undefined;
		this.inputListeners.clear();
		this.textEditor.clearInput();
		this.runButton.enabled = true;
		this.stopButton.enabled = false;
		this.status.textContent = '';
	}
	public focus(): void { this.queryInput.focus(); }
	public setVisible(visibility: EditorPaneVisibility): void {
		// Editor hosts become visible after their initial layout; measurements taken
		// while the tab is hidden cannot size the results editor.
		if (visibility === EditorPaneVisibility.Visible && this.dimension) { this.layout(this.dimension); }
		this.textEditor.setVisible(visibility);
	}
	public layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.domNode.style.width = `${dimension.width}px`;
		this.domNode.style.height = `${dimension.height}px`;
		this.textEditor.layout({ width: this.body.clientWidth, height: this.body.clientHeight });
	}

	private readQuery(): void {
		try {
			this.query = parseSearchEditor(this.getControl()!.getValue());
			if (this.queryInput.value !== this.query.text) { this.queryInput.value = this.query.text; }
			if (this.domNode.ownerDocument.activeElement !== this.include.inputElement) { this.include.value = this.query.includePatterns.join(', '); }
			if (this.domNode.ownerDocument.activeElement !== this.exclude.inputElement) { this.exclude.value = this.query.excludePatterns.join(', '); }
			this.updateOptions();
		} catch {
			this.status.textContent = localize('searchEditor.invalid', 'Invalid search document. Restore its Search header before searching again.');
		}
	}

	private updateOptions(): void {
		this.options.setActions([
			{
				id: 'case', label: localize('search.matchCase', 'Match Case'), tooltip: '', enabled: true,
				checked: this.query.caseSensitivity === 'sensitive',
				run: () => {
					this.query = { ...this.query, caseSensitivity: this.query.caseSensitivity === 'sensitive' ? 'insensitive' : 'sensitive' };
					this.writeQuery();
				},
			},
			{
				id: 'word', label: localize('search.wholeWord', 'Match Whole Word'), tooltip: '', enabled: true,
				checked: Boolean(this.query.wholeWord),
				run: () => {
					this.query = { ...this.query, wholeWord: !this.query.wholeWord };
					this.writeQuery();
				},
			},
			{
				id: 'regex', label: localize('search.useRegex', 'Use Regular Expression'), tooltip: '', enabled: true,
				checked: this.query.patternKind === 'regex',
				run: () => {
					this.query = { ...this.query, patternKind: this.query.patternKind === 'regex' ? 'literal' : 'regex' };
					this.writeQuery();
				},
			},
		]);
	}

	private writeQuery(): void {
		const control = this.getControl();
		const model = control?.getModel();
		if (!model) { return; }
		this.query = {
			...this.query,
			text: this.queryInput.value,
			includePatterns: this.include.value.split(',').map(value => value.trim()).filter(Boolean),
			excludePatterns: this.exclude.value.split(',').map(value => value.trim()).filter(Boolean),
		};
		const header = serializeSearchResultForEditor(this.query).split('\n', 1)[0]!;
		control!.executeEdits('searchEditor.query', [{ range: new Range(1, 1, 1, model.getLineMaxColumn(1)), text: header }]);
	}

	private async runSearch(): Promise<void> {
		const control = this.getControl()!;
		const model = control.getModel()!;
		let query: IContentSearchQuery;
		try {
			query = parseSearchEditor(model.getText());
		} catch {
			this.status.textContent = localize('searchEditor.invalid', 'Invalid search document. Restore its Search header before searching again.');
			return;
		}
		if (!query.text) { this.status.textContent = localize('search.enterQuery', 'Enter text to search.'); return; }
		this.controller?.abort();
		const controller = new AbortController();
		this.controller = controller;
		this.runButton.enabled = false;
		this.stopButton.enabled = true;
		const version = model.version;
		this.status.textContent = localize('search.searching', 'Searching workspace…');
		const result = new SearchResultImpl(this.workspace.getWorkspace().folders);
		try {
			const complete = await this.search.search(query, { signal: controller.signal, onProgress: matches => result.add(matches) });
			if (this.isDisposed || controller.signal.aborted || this.controller !== controller) { return; }
			if (complete.error) { this.status.textContent = complete.error; return; }
			// Keep edits made while the search was running until the user accepts replacing them.
			if (model.version !== version) {
				const confirmed = await this.dialogs.confirm({
					message: localize('searchEditor.changed', 'This search document changed while searching. Replace it with the new results?'),
					primaryButton: localize('searchEditor.update', 'Update results'),
				});
				if (!confirmed.confirmed || controller.signal.aborted || this.isDisposed) { return; }
			}
			control.executeEdits('searchEditor.results', [{ range: model.getFullModelRange(), text: serializeSearchResultForEditor(query, result) }]);
			this.status.textContent = complete.limitHit
				? localize('search.limitReached', '{0} results (result limit reached)', result.count)
				: localize('search.results', '{0} results', result.count);
		} catch (error) {
			if (!this.isDisposed && this.controller === controller) {
				if (controller.signal.aborted) {
					this.status.textContent = localize('search.cancelled', 'Search stopped. {0} results retained.', 0);
				} else {
					this.status.textContent = error instanceof Error ? error.message : String(error);
				}
			}
		} finally {
			if (!this.isDisposed && this.controller === controller) {
				this.controller = undefined;
				this.runButton.enabled = true;
				this.stopButton.enabled = false;
			}
		}
	}

	private async openResult(): Promise<void> {
		const control = this.getControl()!;
		const selection = control.getSelections()?.[0];
		if (!selection) { return; }
		try {
			const location = searchEditorLocation(control.getValue(), selection.startLineNumber);
			if (location) {
				await this.editors.openEditor({ resource: location.resource }, {
					source: EditorOpenSource.USER,
					selection: location.range,
					selectionSource: TextEditorSelectionSource.NAVIGATION,
					pinned: true,
				});
			}
		} catch (error) {
			this.status.textContent = error instanceof Error ? error.message : String(error);
		}
	}
}
