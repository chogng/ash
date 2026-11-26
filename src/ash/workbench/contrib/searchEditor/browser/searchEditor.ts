import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { Schemas } from '../../../../base/common/network.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { QueryBuilder, splitGlobPatterns } from '../../../services/search/common/queryBuilder.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { IFileTextModelService, type TextModelInput } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import './media/searchEditor.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { type IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { Range } from '../../../../editor/common/core/range.js';
import { type IPosition } from '../../../../editor/common/core/position.js';
import { MouseTargetType } from '../../../../editor/browser/editorBrowser.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import { localize } from '../../../../nls.js';
import { IWorkspaceContextService, workspaceRelativePath } from '../../../../platform/workspace/common/workspace.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { EditorOpenSource, TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { CODE_EDITOR_ID, type TextResourceEditor } from '../../../browser/parts/editor/textResourceEditor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { SearchWidget } from '../../search/browser/searchWidget.js';
import { SearchResultImpl } from '../../search/browser/searchTreeModel/searchResult.js';
import { SearchEditorID, InSearchEditor } from './constants.js';
import { createSearchEditorResults } from './searchEditorSerialization.js';
import { SearchEditorModel, searchEditorQueryEdit, searchEditorResultsEdit } from './searchEditorModel.js';

const isUntitledBaselineChange: NonNullable<TextModelInput['isUntitledBaselineChange']> = (change, wasDirty) => {
	if (change.detailedReasons.length !== 1) return false;
	const source = change.detailedReasons[0]!.getType();
	// A new result replaces the entire snapshot. Editing the form only replaces its header.
	return source === searchEditorResultsEdit || (source === searchEditorQueryEdit && !wasDirty);
};

/** Connects the shared query controls, Search service, and the editable search results. */
export class SearchEditor extends EditorPane implements IEditorPane {
	public readonly id = SearchEditorID;
	public domNode!: HTMLElement;
	private widget!: SearchWidget;
	private include!: InputBox;
	private exclude!: InputBox;
	private details!: HTMLElement;
	private detailsButton!: Button;
	private contextLines!: InputBox;
	private model: SearchEditorModel | undefined;
	private highlights: IEditorDecorationsCollection | undefined;
	private clickedResult: IPosition | undefined;
	private updatingControls = false;
	private runButton!: Button;
	private stopButton!: Button;
	private status!: HTMLElement;
	private body!: HTMLElement;
	private input: IResourceEditorInput | undefined;
	private controller: AbortController | undefined;
	private readonly inputListeners = this._register(new DisposableStore());
	private dimension: IDimension | undefined;

	constructor(
		private readonly textEditor: TextResourceEditor,
		@ISearchService private readonly search: ISearchService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ITextFileService private readonly textFiles: ITextFileService,
		@IFileTextModelService private readonly textModels: IFileTextModelService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorService private readonly editors: IEditorService,
		@IEditorPartsService private readonly editorParts: IEditorPartsService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(SearchEditorID, themeService, storageService);
		this._register(textEditor);
	}

	public override getControl(): ReturnType<TextResourceEditor['getControl']> { return this.textEditor.getControl(); }
	public get workingCopy(): TextResourceEditor['workingCopy'] { return this.textEditor.workingCopy; }
	public async save(): Promise<void> {
		if (this.input?.resource.scheme === Schemas.untitled) {
			await this.saveDraft();
		} else {
			await this.textEditor.save();
		}
	}
	public saveAs(resource: URI): Promise<void> { return this.textEditor.saveAs(resource); }

	public async saveDraft(): Promise<IResourceEditorInput | undefined> {
		const input = this.input;
		const model = this.model;
		const group = this.editorParts.groups.find(group => group.id === this.group?.id);
		if (!input || !model || !group) return undefined;
		const resource = await this.fileDialogs.pickFileToSave(URI.file('/Search.code-search'));
		if (!resource || this.input !== input) return undefined;
		const version = model.version;
		await this.saveAs(resource);
		if (this.input !== input || this.model !== model || model.version !== version || this.workingCopy?.isDirty) return undefined;
		const replacement = { resource, editorId: SearchEditorID };
		await this.editorParts.replaceEditorResource(group, input, replacement);
		return replacement;
	}

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-search-editor';
		parent.append(this.domNode);
		super.create(this.domNode);
		this._register(toDisposable(() => { this.controller?.abort(); this.domNode.remove(); }));
		const form = h(document, 'form', { className: 'ash-search-editor-form' });
		this.status = h(document, 'div', { className: 'ash-search-editor-status', attributes: { role: 'status' } });
		this.body = h(document, 'div', { className: 'ash-search-editor-results' });
		this.domNode.append(this.status, this.body);
		this.createEditorToolbar(form, this.domNode, this.status);
		this.bindEditorContextKey(this.contextKeys, InSearchEditor, true);

		const row = h(document, 'div', { className: 'ash-search-editor-main' });
		form.append(row);
		this.widget = this._register(this.instantiation.createInstance(SearchWidget, row, {
			label: localize('searchEditor.query', 'Search editor query'),
			showReplace: false,
		}));
		const actions = h(document, 'div', { className: 'ash-search-editor-buttons' });
		row.append(actions);
		const run = localize('searchEditor.run', 'Search again');
		this.runButton = this._register(new Button(actions, {
			...defaultButtonStyles, label: run, title: run, icon: Lxicon.refresh, iconOnly: true, size: 'small',
			onClick: () => { void this.runSearch(); },
		}));
		const stop = localize('search.stop', 'Stop search');
		this.stopButton = this._register(new Button(actions, {
			...defaultButtonStyles, label: stop, title: stop, icon: Lxicon.close, iconOnly: true, size: 'small',
			onClick: () => this.controller?.abort(),
		}));
		this.stopButton.enabled = false;
		const toggleDetails = localize('search.details', 'Toggle Search Details');
		this.detailsButton = this._register(new Button(actions, {
			...defaultButtonStyles, label: toggleDetails, title: toggleDetails, icon: Lxicon.ellipsis, iconOnly: true, size: 'small',
			onClick: () => this.setDetailsExpanded(!!this.details.hidden),
		}));
		this.details = h(document, 'div', {
			className: 'ash-search-editor-details',
			properties: { id: `ash-search-details-${this.widget.searchInput.inputBox.inputElement.id}` },
		});
		form.append(this.details);
		this.detailsButton.domNode.setAttribute('aria-controls', this.details.id);
		this.setDetailsExpanded(false);
		const createFilter = (label: string, ariaLabel: string, type: 'text' | 'number' = 'text') => {
			const field = h(document, 'label', { className: 'ash-search-editor-filter' });
			field.textContent = label;
			this.details.append(field);
			const input = this._register(new InputBox(field, { inputBoxStyles: defaultInputBoxStyles, presentation: 'compact', ariaLabel, type }));
			this._register(input.onDidChange(() => this.writeQuery()));
			return input;
		};
		this.include = createFilter(localize('search.includes', 'files to include'), localize('search.includesLabel', 'Files to include'));
		this.exclude = createFilter(localize('search.excludes', 'files to exclude'), localize('search.excludesLabel', 'Files to exclude'));
		const contextLines = localize('searchEditor.contextLines', 'Context lines');
		this.contextLines = createFilter(contextLines, contextLines, 'number');
		this.contextLines.inputElement.setAttribute('min', '0');
		this.contextLines.inputElement.setAttribute('max', '20');

		this.textEditor.create(this.body);
		this._register(observeElementSize(this.body, size => this.textEditor.layout(size)));
		const query = this.widget.searchInput.inputBox.inputElement;
		const updateHint = () => query.setAttribute('aria-description', this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Find)
			? localize('search.helpHint', 'Press Alt+F1 for search accessibility help.') : '');
		updateHint();
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.Find)) updateHint();
		}));
		this._register(this.widget.onDidChange(() => this.writeQuery()));
		this._register(this.widget.onSearchSubmit(() => { void this.runSearch(); }));
		this._register(addDisposableListener(form, 'submit', event => {
			event.preventDefault();
			void this.runSearch();
		}));
		this._register(addDisposableListener(this.body, 'dblclick', () => {
			if (this.clickedResult) void this.openResult(this.clickedResult);
		}));
		this.registerEditorKeydown(event => {
			if (event.isComposing) return;
			if (event.key === 'Escape' && this.controller) {
				event.preventDefault();
				this.controller.abort();
				return;
			}
			if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
			const inQuery = form.contains(event.target as Node);
			const inFilter = this.details.contains(event.target as Node);
			const modified = event.ctrlKey || event.metaKey;
			if (!modified && !inFilter) return;
			event.preventDefault();
			event.stopPropagation();
			if (inQuery) void this.runSearch();
			else void this.openResult();
		}, true);
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		const workspace = this.workspace;
		let model: SearchEditorModel | undefined;
		await this.textEditor.setInput({
			...input,
			editorId: CODE_EDITOR_ID,
			languageId: 'plaintext',
			showBreadcrumbs: false,
			isUntitledBaselineChange,
			resolveEditorModel: backing => {
				model = SearchEditorModel.resolve(backing, resource => {
					const folder = workspace.getWorkspaceFolder(resource);
					return folder ? workspaceRelativePath(folder.uri, resource) : resource.path;
				});
				return model.results;
			},
		}, signal);
		this.input = input;
		this.model = model!;
		const control = this.getControl()!;
		control.updateOptions({ lineNumbers: 'off', minimap: { enabled: false } });
		this.highlights = control.createDecorationsCollection();
		if (control.onMouseUp) {
			this.inputListeners.add(control.onMouseUp(({ event, target }) => {
				this.clickedResult = event.leftButton && target.type === MouseTargetType.CONTENT_TEXT ? target.position : undefined;
			}));
		}
		this.setDetailsExpanded(Boolean(model?.query && (model.query.includePatterns.length || model.query.excludePatterns.length || model.query.contextLines)));
		this.readQuery();
		this.renderHighlights();
		this.inputListeners.add(model!.onDidChange(change => {
			if (change !== 'results') this.readQuery();
			if (change !== 'query') this.renderHighlights();
		}));
		this.inputListeners.add(this.workspace.onDidChangeWorkspace(() => this.controller?.abort()));
		if (this.dimension) this.layout(this.dimension);
	}

	public override clearInput(): void {
		this.input = undefined;
		this.model = undefined;
		this.controller?.abort();
		this.controller = undefined;
		this.inputListeners.clear();
		this.highlights?.clear();
		this.highlights = undefined;
		this.clickedResult = undefined;
		this.textEditor.clearInput();
		if (this.runButton) this.runButton.enabled = true;
		if (this.stopButton) this.stopButton.enabled = false;
		if (this.status) this.status.textContent = '';
	}
	public override focus(): void { this.widget.focus(); }
	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		// Editor hosts become visible after their initial layout; measurements taken
		// while the tab is hidden cannot size the results editor.
		if (visibility && this.dimension) { this.layout(this.dimension); }
		this.textEditor.setVisible(visibility);
	}
	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.domNode.style.width = `${dimension.width}px`;
		this.domNode.style.height = `${dimension.height}px`;
		this.textEditor.layout({ width: this.body.clientWidth, height: this.body.clientHeight });
	}

	private setDetailsExpanded(expanded: boolean): void {
		if (!expanded && this.details.contains(this.details.ownerDocument.activeElement)) this.detailsButton.domNode.focus();
		this.details.hidden = !expanded;
		this.detailsButton.domNode.setAttribute('aria-expanded', String(expanded));
	}

	private readQuery(): void {
		const query = this.model?.query;
		this.runButton.enabled = !!query && !this.controller;
		if (!query) {
			this.status.textContent = localize('searchEditor.invalid', 'Invalid search document. Open it as text to repair its Search header.');
			return;
		}
		this.updatingControls = true;
		try {
			const input = this.widget.searchInput.inputBox;
			if (input.value !== query.text) input.value = query.text;
			const active = this.domNode.ownerDocument.activeElement;
			if (active !== this.include.inputElement) this.include.value = query.includePatterns.join(', ');
			if (active !== this.exclude.inputElement) this.exclude.value = query.excludePatterns.join(', ');
			if (active !== this.contextLines.inputElement) this.contextLines.value = String(query.contextLines ?? 0);
			this.widget.setQueryOptions(query.caseSensitivity === 'sensitive', query.patternKind === 'regex', Boolean(query.wholeWord));
		} finally {
			this.updatingControls = false;
		}
	}

	private writeQuery(): void {
		const query = this.model?.query;
		if (!query || this.updatingControls) return;
		const lines = Number(this.contextLines.value);
		this.model!.updateQuery({
			...query,
			text: this.widget.searchInput.inputBox.value,
			caseSensitivity: this.widget.matchCase ? 'sensitive' : query.caseSensitivity === 'smart' ? 'smart' : 'insensitive',
			patternKind: this.widget.useRegex ? 'regex' : 'literal',
			wholeWord: this.widget.wholeWord,
			includePatterns: splitGlobPatterns(this.include.value),
			excludePatterns: splitGlobPatterns(this.exclude.value),
			contextLines: Number.isInteger(lines) && lines >= 0 && lines <= 20 ? lines : query.contextLines,
		});
	}

	private renderHighlights(): void {
		const decorations = [];
		for (const row of this.model?.rows ?? []) {
			if (row.header) {
				decorations.push({ range: new Range(row.line, 1, row.line, row.text.length + 1), options: { description: 'search-editor-file', inlineClassName: 'ash-search-editor-file' } });
				continue;
			}
			if (!row.matches.length) {
				decorations.push({ range: new Range(row.line, 1, row.line, row.text.length + 1), options: { description: 'search-editor-context', inlineClassName: 'ash-search-editor-context' } });
			}
			for (const match of row.matches) {
				const start = row.offset + match.start;
				const end = Math.min(row.offset + match.end, row.text.length);
				if (start < end) decorations.push({ range: new Range(row.line, start + 1, row.line, end + 1), options: { description: 'search-editor-match', inlineClassName: 'ash-search-editor-match' } });
			}
		}
		this.highlights?.set(decorations);
	}

	private async readContext(result: SearchResultImpl, contextLines: number, signal: AbortSignal): Promise<ReadonlyMap<string, ReadonlyMap<number, string>>> {
		const context = new Map<string, ReadonlyMap<number, string>>();
		const files = result.files;
		for (let index = 0; index < files.length && !signal.aborted; index += 8) {
			await Promise.all(files.slice(index, index + 8).map(async file => {
				const open = this.textModels.getModel(file.resource);
				if (!open && file.resource.scheme === Schemas.untitled) return;
				try {
					const text = open?.getText() ?? (await this.textFiles.resolve({ resource: file.resource }, signal)).text;
					if (signal.aborted) return;
					const lines = text.split(/\r\n|\r|\n/);
					const selected = new Map<number, string>();
					for (const { range } of file.matches) {
						for (let line = Math.max(1, range.startLineNumber - contextLines); line <= Math.min(lines.length, range.endLineNumber + contextLines); line++) {
							selected.set(line, lines[line - 1]!);
						}
					}
					context.set(file.resource.toString(), selected);
				} catch {
					// A file can change or become unavailable after its search result was emitted.
				}
			}));
		}
		return context;
	}

	private async runSearch(): Promise<void> {
		const model = this.model;
		const query = model?.query;
		if (!model || !query) return;
		if (!query.text) { this.status.textContent = localize('search.enterQuery', 'Enter text to search.'); return; }
		const folders = this.workspace.getWorkspace().folders;
		const scopedFolders = query.workspaceRoot === undefined ? folders : folders.filter(folder => folder.uri.toString() === query.workspaceRoot);
		if (query.workspaceRoot !== undefined && !scopedFolders.length) {
			this.status.textContent = localize('search.folderOutsideWorkspace', 'Search folder is outside the current workspace.');
			return;
		}
		this.controller?.abort();
		const controller = new AbortController();
		this.controller = controller;
		this.runButton.enabled = false;
		this.stopButton.enabled = true;
		const version = model.version;
		this.status.textContent = localize('search.searching', 'Searching workspace…');
		const result = new SearchResultImpl(scopedFolders);
		try {
			using cancellation = new CancellationTokenSource();
			const cancel = (): void => cancellation.cancel();
			controller.signal.addEventListener('abort', cancel, { once: true });
			using listener = toDisposable(() => controller.signal.removeEventListener('abort', cancel));
			const textQuery = new QueryBuilder().text({
				pattern: query.text, isRegExp: query.patternKind === 'regex', isWordMatch: query.wholeWord,
				isCaseSensitive: query.caseSensitivity === 'sensitive' || query.caseSensitivity === 'smart' && /\p{Lu}/u.test(query.text),
			}, scopedFolders.map(folder => folder.uri), {
				includePattern: query.includePatterns.join(','), excludePattern: query.excludePatterns.join(','), maxResults: query.maxResults,
				// Generated search drafts contain the query in their header and must not search themselves.
				extraFileResources: query.workspaceRoot === undefined
					? this.textModels.getModels().filter(model => !model.uri.path.endsWith('.code-search')).map(model => model.uri)
					: undefined,
			});
			const complete = await this.search.textSearch(textQuery, cancellation.token, progress => {
				if (!controller.signal.aborted && !this.isDisposed && 'resource' in progress) { result.addFileMatch(progress); }
			});
			if (this.isDisposed || controller.signal.aborted || this.controller !== controller) return;
			if (complete.messages.length) { this.status.textContent = complete.messages.map(message => message.text).join('\n'); return; }
			const contextLines = query.contextLines ?? 0;
			const context = contextLines ? await this.readContext(result, contextLines, controller.signal) : undefined;
			if (this.isDisposed || controller.signal.aborted || this.controller !== controller) return;
			// Keep edits made while the search was running until the user accepts replacing them.
			if (model.version !== version) {
				const confirmed = await this.dialogs.confirm({
					message: localize('searchEditor.changed', 'This search document changed while searching. Replace it with the new results?'),
					primaryButton: localize('searchEditor.update', 'Update results'),
				});
				if (!confirmed.confirmed || controller.signal.aborted || this.isDisposed || this.controller !== controller) { return; }
			}
			model.replaceResults(createSearchEditorResults(result, contextLines, context));
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

	private async openResult(position?: IPosition): Promise<void> {
		const target = position ?? this.getControl()?.getSelections()?.[0]?.getPosition();
		if (!target) return;
		try {
			const location = this.model?.location(target.lineNumber, target.column);
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
