import './media/themeEditor.css';
import { addDisposableListener, getWindow, h, stopEvent } from '../../../../base/browser/dom.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ColorPicker } from '../../../../base/browser/ui/colorPicker/colorPicker.js';
import { ContextViewFocusRestore } from '../../../../base/browser/ui/contextview/contextview.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { appendLabelIcon } from '../../../../base/browser/ui/iconlabel/iconLabels.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { getThemeColorReferences, ThemePreview, type ThemeColorReferences } from './themePreview.js';
import { SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Color } from '../../../../base/common/color.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { findNodeAtLocation, parseTree } from '../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { Colors } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService, type IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { bindColorTheme } from '../../../../platform/theme/browser/themeStyles.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { TextResourceEditor } from '../../../browser/parts/editor/textResourceEditor.js';
import type { IResourceEditorInput, ISaveOptions } from '../../../common/editor.js';
import { IUserThemeService } from '../../../common/userThemes.js';
import { parseColorThemeDocument, userThemeId } from '../../../services/themes/common/colorThemeData.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IFileTextModelService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';

export const ThemeEditorId = 'workbench.editor.themeEditor';
export const ThemeEditorFocused = new RawContextKey<boolean>('themeEditorFocused', false);

export function createThemeEditorInput(input: IResourceEditorInput): IResourceEditorInput {
	return { ...input, editorId: ThemeEditorId, languageId: 'jsonc' };
}

/** The embedded text pane owns the document, history, working copy and file revision. */
export class ThemeEditor extends EditorPane {
	public readonly id = ThemeEditorId;
	private root: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private list: HTMLElement | undefined;
	private message: HTMLElement | undefined;
	private search: InputBox | undefined;
	private empty: HTMLElement | undefined;
	private readonly groups: ThemeColorGroup[] = [];
	private filtering = false;
	private scrollable: ScrollableElement | undefined;
	private split: SplitView | undefined;
	private preview: ThemePreview | undefined;
	private settingsTabs: TabList<'colors' | 'json'> | undefined;
	private colorPanel: HTMLElement | undefined;
	private jsonPanel: HTMLElement | undefined;
	private readonly rows = new Map<string, ThemeColorRow>();
	private readonly inputLifetime = this._register(new DisposableStore());
	private readonly nameDialog = this._register(new MutableDisposable<DisposableStore>());
	private readonly pickerLifetime = this._register(new MutableDisposable<DisposableStore>());
	private picker: ColorPicker | undefined;
	private pickerRow: ThemeColorRow | undefined;
	private readonly refresh = this._register(new RunOnceScheduler(() => { void this.updatePreview(); }, 60));
	private readonly copiesChanged = this._register(new Emitter<void>());
	public readonly onDidChangeWorkingCopies = this.copiesChanged.event;
	private input: IResourceEditorInput | undefined;
	private compiled: IColorTheme | undefined;
	private valid = false;
	private operation = 0;
	private saving = false;
	private dimension: IDimension = { width: 0, height: 0 };
	private initialSplitLayout = true;

	constructor(
		private readonly textEditor: TextResourceEditor,
		@IWorkbenchThemeService private readonly themes: IWorkbenchThemeService,
		@IUserThemeService private readonly userThemes: IUserThemeService,
		@IFileTextModelService private readonly models: IFileTextModelService,
		@IEditorPartsService private readonly editorParts: IEditorPartsService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IHoverService private readonly hoverService: IHoverService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super(ThemeEditorId, themeService, storageService);
		this._register(toDisposable(() => this.clearInput()));
		this._register(textEditor);
		this._register(toDisposable(() => { for (const row of this.rows.values()) row.dispose(); this.rows.clear(); }));
		// Validate every save path, including Save All and another JSON view of this file.
		this._register(models.addSaveParticipant({
			participate: async model => {
				if (model !== this.getControl()?.getModel()) return;
				const input = this.input;
				let source: string;
				do { source = model.getText(); await this.compile(source, input); } while (model.getText() !== source);
			}
		}));
		this._register(Colors.onDidChange(() => this.renderRows()));
		this._register(themes.onDidColorThemeChange(() => this.renderRows()));
	}

	public override create(parent: HTMLElement): void {
		const doc = parent.ownerDocument;
		const root = h(doc, 'div');
		root.className = 'ash-theme-editor';
		root.setAttribute('aria-label', localize('themeEditor.title', 'Theme Editor'));
		parent.append(root);
		super.create(root);
		this.root = root;
		this._register(toDisposable(() => root.remove()));
		const scoped = this._register(this.contextKeys.createScoped(root));
		const focused = ThemeEditorFocused.bindTo(scoped);
		this._register(addDisposableListener<FocusEvent>(root, 'focusin', event => {
			focused.set(true);
			if (!event.relatedTarget || !root.contains(event.relatedTarget as Node)) {
				const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.ThemeEditor);
				if (hint) status(hint);
			}
		}));
		this._register(addDisposableListener<FocusEvent>(root, 'focusout', event => {
			if (!event.relatedTarget || (!root.contains(event.relatedTarget as Node) && !this.picker?.domNode.contains(event.relatedTarget as Node))) focused.reset();
		}));
		// Auxiliary controls must resolve help in their owner window before the shared dispatcher.
		this._register(addDisposableListener<KeyboardEvent>(getWindow(root), 'keydown', event => {
			if (!root.contains(event.target as Node) && !this.picker?.domNode.contains(event.target as Node)) return;
			if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'F1' || event.key === 'F2')) {
				stopEvent(event);
				this.accessibleViews.show(event.key === 'F1' ? AccessibleViewType.Help : AccessibleViewType.View, root);
				return;
			}
			if (!event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
				stopEvent(event);
				this.runAction(() => event.shiftKey ? this.saveThemeAs() : this.save());
			}
		}, { capture: true }));
		const toolbar = h(doc, 'div');
		toolbar.className = 'ash-theme-editor-toolbar';
		const title = h(doc, 'h1');
		title.textContent = localize('themeEditor.title', 'Theme Editor');
		toolbar.append(title);
		this._register(new Button(toolbar, { label: localize('themeEditor.save', 'Save'), presentation: 'quiet', onClick: () => this.runAction(() => this.save()) }));
		this._register(new Button(toolbar, { label: localize('themeEditor.saveAs', 'Save as…'), presentation: 'quiet', onClick: () => this.runAction(() => this.saveThemeAs()) }));
		this._register(new Button(toolbar, { label: localize('themeEditor.saveApply', 'Save and Apply'), presentation: 'primary', onClick: () => this.runAction(() => this.saveAndApply()) }));
		this.message = h(doc, 'p');
		this.message.className = 'ash-theme-editor-message';
		this.message.setAttribute('role', 'status');
		this.message.textContent = localize('themeEditor.description', 'Changes appear only in the preview. Save writes the theme; Save and Apply also switches the main window.');
		this.body = h(doc, 'div');
		this.body.className = 'ash-theme-editor-body';
		root.append(toolbar, this.message, this.body);
		const settings = h(doc, 'section', { className: 'ash-theme-editor-settings' });
		this.body.append(settings);
		const tabsHost = h(doc, 'div', { className: 'ash-theme-editor-settings-tabs' });
		settings.append(tabsHost);
		this.settingsTabs = this._register(new TabList(tabsHost, { presentation: 'inset', ariaLabel: localize('themeEditor.settingsTabs', 'Theme editing controls'), onActivate: value => this.selectSettings(value) }));
		const panel = h(doc, 'section');
		this.colorPanel = panel;
		panel.className = 'ash-theme-editor-colors';
		const searchHost = h(doc, 'div', { className: 'ash-theme-editor-search' });
		panel.append(searchHost);
		this.search = this._register(new InputBox(searchHost, { presentation: 'compact', type: 'search', placeholder: localize('themeEditor.search', 'Search colors'), ariaLabel: localize('themeEditor.search', 'Search colors') }));
		this._register(this.search.onDidChange(() => this.renderRows()));
		const scrollHost = h(doc, 'div');
		scrollHost.className = 'ash-theme-editor-scroll';
		panel.append(scrollHost);
		this.scrollable = this._register(new ScrollableElement(scrollHost, { direction: 'vertical', vertical: 'auto', tabIndex: -1 }));
		this.list = h(doc, 'div');
		this.list.className = 'ash-theme-editor-list';
		this.scrollable.append(this.list);
		scrollHost.append(this.scrollable.element);
		const groups = [
			{ id: 'surface', label: localize('themeEditor.group.surface', 'Surface'), pattern: /^(?:background$|workbench\.|widget\.|titleBar\.|commandCenter\.|window\.)/u },
			{ id: 'text', label: localize('themeEditor.group.text', 'Text and borders'), pattern: /^(?:foreground$|description\.|muted\.|disabled|accent\.|error\.|warning\.|success\.|focusBorder$|contrast|border$|icon\.|selection\.|text)/u },
			{ id: 'editor', label: localize('themeEditor.group.editor', 'Editor'), pattern: /^(?:editor(?!Group)|diffEditor|merge\.|peekView|problems\.|searchEditor)/u },
			{ id: 'tabs', label: localize('themeEditor.group.tabs', 'Tabs'), pattern: /^(?:tab\.|tabList\.|editorGroup)/u },
			{ id: 'sidebar', label: localize('themeEditor.group.sidebar', 'Sidebar and navigation'), pattern: /^(?:sideBar|activityBar|breadcrumb|navigation|files\.)/u },
			{ id: 'panel', label: localize('themeEditor.group.panel', 'Panels'), pattern: /^(?:panel|auxiliaryBar|debugConsole|outputView)/u },
			{ id: 'controls', label: localize('themeEditor.group.controls', 'Controls'), pattern: /^(?:input|button|checkbox|radio|dropdown|toolbar|keybinding|sash|badge)/u },
			{ id: 'lists', label: localize('themeEditor.group.lists', 'Lists and menus'), pattern: /^(?:list\.|tree\.|menu\.|menubar\.|quickInput|quickPick)/u },
			{ id: 'status', label: localize('themeEditor.group.status', 'Status and notifications'), pattern: /^(?:statusBar|notification|progressBar)/u },
			{ id: 'terminal', label: localize('themeEditor.group.terminal', 'Terminal'), pattern: /^terminal/u },
			{ id: 'scm', label: localize('themeEditor.group.scm', 'Version control'), pattern: /^(?:git|scm\.|diff\.)/u },
			{ id: 'scrollbar', label: localize('themeEditor.group.scrollbar', 'Scrollbar and minimap'), pattern: /^(?:scrollbar|scrollView|scrollShadow|minimap)/u },
			{ id: 'sessions', label: localize('themeEditor.group.sessions', 'Agent Window'), pattern: /^sessions\./u },
			{ id: 'other', label: localize('themeEditor.group.other', 'Other'), pattern: /./u },
		];
		for (const group of groups) {
			this.groups.push(this._register(new ThemeColorGroup(this.list, group.id, group.label, group.pattern, group.id === 'surface', () => {
				this.pickerLifetime.clear();
				this.scrollable?.layout();
			})));
		}
		this.empty = h(doc, 'p', { className: 'ash-theme-editor-empty', attributes: { role: 'status' } }, localize('themeEditor.noColors', 'No matching colors'));
		this.list.append(this.empty);
		const json = h(doc, 'section');
		this.jsonPanel = json;
		json.className = 'ash-theme-editor-json';
		json.setAttribute('aria-label', localize('themeEditor.json', 'Theme JSON'));
		settings.append(panel, json);
		this.textEditor.create(json);
		this.selectSettings('colors');
		const preview = h(doc, 'section', { className: 'ash-theme-editor-preview-host' });
		this.body.append(preview);
		this.preview = this._register(new ThemePreview(preview, help => {
			if (root.ownerDocument.activeElement !== this.preview?.element) return;
			// Entering an iframe can emit focusout with no related target in the parent document.
			focused.set(true);
			this.accessibleViews.show(help ? AccessibleViewType.Help : AccessibleViewType.View, root);
		}, this.configuration));
		this._register(this.preview.onDidChangeColors(() => this.renderRows()));
		this.split = this._register(new SplitView(this.body, 'horizontal'));
		this.split.addView({ element: settings, minimumSize: 300, maximumSize: 440, onDidChange: Event.None, layout: (width, _offset, height) => { this.scrollable?.layout(); this.textEditor.layout({ width, height: Math.max(0, height - tabsHost.offsetHeight) }); } }, 360);
		this.split.addView({ element: preview, minimumSize: 420, maximumSize: Infinity, onDidChange: Event.None, layout: () => { } }, { type: 'distribute' });
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		this.input = input;
		await this.textEditor.setInput(input, signal);
		if (signal.aborted || this.input !== input) throw new CancellationError();
		const control = this.getControl()!;
		this.inputLifetime.add(control.onDidChangeModelContent(() => { this.valid = false; this.refresh.schedule(); }));
		this.inputLifetime.add(control.onDidChangeCursorSelection(() => this.syncSelection()));
		this.copiesChanged.fire();
		await this.updatePreview();
		this.layout(this.dimension);
	}

	public override clearInput(): void {
		this.pickerLifetime.clear();
		this.operation++;
		this.refresh.cancel();
		this.inputLifetime.clear();
		this.nameDialog.clear();
		this.compiled = undefined;
		this.input = undefined;
		this.valid = false;
		this.textEditor.clearInput();
		this.copiesChanged.fire();
	}

	public get workingCopy() { return this.textEditor.workingCopy; }
	public override getControl() { return this.textEditor.getControl(); }
	public override focus(): void { this.search?.focus(); }
	public override layout(dimension: IDimension): void {
		this.dimension = dimension;
		if (this.body) {
			this.split?.layout(dimension.width, Math.max(0, dimension.height - this.body.offsetTop + (this.root?.offsetTop ?? 0)));
			if (this.initialSplitLayout && dimension.width > 520 && this.split) {
				this.initialSplitLayout = false;
				this.split.resizeView(0, 360);
			}
		}
	}
	public override setVisible(visible: boolean): void {
		if (!visible) this.pickerLifetime.clear();
		super.setVisible(visible);
		this.textEditor.setVisible(visible);
		this.applyPreview();
	}
	public revealRange(range: Range): void { this.textEditor.revealRange(range); }
	public getAccessibleContent(): string {
		if (this.root?.ownerDocument.activeElement === this.preview?.element) return this.preview?.getAccessibleContent() ?? '';
		if (this.picker) return this.pickerRow!.accessibleText + '\n' + this.picker.getAccessibleContent();
		return [this.message?.textContent ?? '', ...[...this.rows.values()].filter(row => !row.element.closest('[hidden]')).map(row => row.accessibleText)].join('\n');
	}

	public async save(options?: ISaveOptions): Promise<void> {
		const input = this.input;
		if (!input) return;
		if (input.resource.scheme === 'untitled') return this.saveThemeAs();
		await this.compile(this.textEditor.getValue());
		if (this.input !== input) throw new CancellationError();
		const id = this.themeIdForResource(input.resource);
		if (id) this.themes.deferColorThemeApplication(id);
		await this.textEditor.save(options);
		await this.userThemes.reload();
		if (this.input !== input) return;
		// Finish a pending color edit before publishing the save result.
		this.refresh.cancel();
		await this.updatePreview();
		this.showMessage(localize('themeEditor.saved', 'Theme saved.'));
	}

	public async saveAs(resource: URI): Promise<void> {
		const input = this.input;
		await this.compile(this.textEditor.getValue());
		if (this.input !== input) throw new CancellationError();
		const id = this.themeIdForResource(resource);
		if (id) this.themes.deferColorThemeApplication(id);
		await this.textEditor.saveAs(resource);
		await this.userThemes.reload();
	}

	private async saveThemeAs(apply = false): Promise<void> {
		const input = this.input;
		const model = this.getControl()?.getModel();
		if (!input || !model) return;
		const name = await this.promptName();
		if (name === undefined || this.input !== input) return;
		const source = model.getText();
		const candidate = applyEdits(source, setProperty(source, ['name'], name.trim(), { insertSpaces: true, tabSize: 2 }));
		await this.compile(candidate);
		const saved = await this.userThemes.saveAs(candidate);
		// A slow write must not replace a document that acquired newer edits meanwhile.
		if (this.input !== input || model.getText() !== source) {
			this.showMessage(localize('themeEditor.copySaved', 'Saved {0}. Newer edits remain in this editor.', saved.file));
			return;
		}
		const group = this.editorParts.groups.find(group => group.inputs.some(candidate => candidate === input));
		let savedEditor: ThemeEditor | undefined = this;
		if (group) {
			const replacement = createThemeEditorInput({ resource: URI.joinPath(this.userThemes.directory!, saved.file), label: saved.file });
			await this.editorParts.replaceEditorResource(group, input, replacement);
			// Saving an untitled copy can replace its pane. Feedback belongs to the saved editor.
			const pane = group.activePane;
			savedEditor = pane instanceof ThemeEditor && pane.input?.resource.toString() === replacement.resource.toString() ? pane : undefined;
		}
		if (apply) await this.themes.setColorTheme(saved.theme.id);
		savedEditor?.showMessage(apply ? localize('themeEditor.applied', 'Theme saved and applied.') : localize('themeEditor.saved', 'Theme saved.'));
	}

	private async promptName(): Promise<string | undefined> {
		if (!this.root) return undefined;
		const lifetime = new DisposableStore();
		this.nameDialog.value = lifetime;
		const content = h(this.root.ownerDocument, 'div');
		const name = lifetime.add(new InputBox(content, { ariaLabel: localize('themeEditor.name', 'Theme name'), placeholder: localize('themeEditor.name', 'Theme name') }));
		const label = this.compiled?.label ?? localize('themeEditor.title', 'Theme Editor');
		name.value = this.input?.resource.scheme === 'untitled' ? label : localize('themeEditor.copyName', '{0} Copy', label);
		const hint = h(content.ownerDocument, 'p');
		hint.textContent = localize('themeEditor.invalidName', 'Enter a theme name of 1 to 256 characters.');
		content.append(hint);
		const actions = h(content.ownerDocument, 'div'); actions.className = 'ash-theme-editor-name-actions'; content.append(actions);
		const dialog = lifetime.add(new Dialog(this.root, { title: localize('themeEditor.saveAs', 'Save as…'), content }));
		const accept = (): void => { if (name.value.trim().length > 0 && name.value.trim().length <= 256) dialog.close('save'); };
		const save = lifetime.add(new Button(actions, { label: localize('themeEditor.save', 'Save'), presentation: 'primary', onClick: accept }));
		lifetime.add(new Button(actions, { label: localize('themeEditor.cancel', 'Cancel'), presentation: 'quiet', onClick: () => dialog.close() }));
		lifetime.add(name.onDidChange(value => { save.enabled = value.trim().length > 0 && value.trim().length <= 256; }));
		lifetime.add(name.onKeyDown(event => { if (event.key === 'Enter') { stopEvent(event); accept(); } }));
		try { return await dialog.show() === 'save' ? name.value.trim() : undefined; }
		finally { if (this.nameDialog.value === lifetime) this.nameDialog.clear(); }
	}

	private compile(source: string, input = this.input): Promise<IColorTheme> {
		return this.userThemes.resolve(source, this.themeIdForResource(input?.resource));
	}

	private themeIdForResource(resource: URI | undefined): string | undefined {
		if (!resource || !this.userThemes.directory) return undefined;
		const id = userThemeId(resource.path.split('/').at(-1)!.replace(/\.json$/iu, ''));
		const existing = this.userThemes.sourceFor(id);
		// An external JSON file must not borrow a profile theme's includes or applied-version state.
		return existing && URI.joinPath(this.userThemes.directory, existing.file).toString() === resource.toString() ? id : undefined;
	}

	private async updatePreview(): Promise<void> {
		const operation = ++this.operation;
		const source = this.textEditor.getValue();
		if (!this.input) return;
		try {
			const theme = await this.compile(source);
			if (operation !== this.operation || this.textEditor.getValue() !== source) return;
			this.compiled = theme;
			this.valid = true;
			this.applyPreview();
			this.renderRows();
			this.showMessage(localize('themeEditor.description', 'Changes appear only in the preview. Save writes the theme; Save and Apply also switches the main window.'));
		} catch (error) {
			if (operation !== this.operation || this.textEditor.getValue() !== source) return;
			this.valid = false;
			this.showMessage(localize('themeEditor.invalidJson', 'Cannot preview this JSON. The last valid preview is retained. {0}', error instanceof Error ? error.message : String(error)), true);
			this.renderRows();
		}
	}

	private applyPreview(): void {
		if (this.compiled && this.valid) this.preview?.update(this.compiled, parseColorThemeDocument(parseJsonc(this.textEditor.getValue(), 'Color theme')).colors ?? {});
	}

	private selectSettings(value: 'colors' | 'json'): void {
		if (!this.colorPanel || !this.jsonPanel) return;
		this.colorPanel.hidden = value !== 'colors';
		this.jsonPanel.hidden = value !== 'json';
		this.settingsTabs?.setTabs([
			{ id: 'colors', value: 'colors', label: localize('themeEditor.colorsTab', 'Colors'), tabId: 'theme-colors-tab' },
			{ id: 'json', value: 'json', label: localize('themeEditor.json', 'Theme JSON'), tabId: 'theme-json-tab' },
		], value);
		this.layout(this.dimension);
	}

	private async saveAndApply(): Promise<void> {
		const input = this.input;
		if (!input) return;
		const id = this.themeIdForResource(input.resource);
		if (!id) {
			return this.saveThemeAs(true);
		}
		const source = this.textEditor.getValue();
		await this.save();
		if (this.input !== input || this.textEditor.getValue() !== source) return;
		await this.themes.setColorTheme(id);
		this.showMessage(localize('themeEditor.applied', 'Theme saved and applied.'));
	}

	private renderRows(): void {
		if (!this.list) return;
		let colors: Readonly<Record<string, string>> = {};
		try { colors = parseColorThemeDocument(parseJsonc(this.textEditor.getValue(), 'Color theme')).colors ?? {}; } catch { }
		const previewColors = new Map(this.preview?.colors.map(entry => [entry.id, entry]));
		const registeredColors = Colors.getColors();
		const registeredIds = new Set(registeredColors.map(entry => entry.id));
		const entries = [...registeredColors, ...[...previewColors.values()].filter(entry => !registeredIds.has(entry.id))];
		const query = (this.search?.value ?? '').trim().toLowerCase();
		// Searching temporarily opens the groups, then restores the user's layout on clear.
		if (!!query !== this.filtering) {
			this.filtering = !!query;
			for (const group of this.groups) group.setFiltering(this.filtering);
		}
		const counts = new Map<ThemeColorGroup, number>();
		const current = this.compiled;
		for (const entry of entries) {
			const group = this.groups.find(group => group.pattern.test(entry.id))!;
			let row = this.rows.get(entry.id);
			if (!row) {
				row = new ThemeColorRow(this.list.ownerDocument, entry.id, entry.description, this.hoverService,
					value => this.editColor(entry.id, value), () => this.revealColor(entry.id), row => this.showColorPicker(row), id => this.revealDesignToken(id));
				this.rows.set(entry.id, row);
				group.body.append(row.element);
			}
			row.element.hidden = !!query && !`${entry.id} ${entry.description} ${group.label}`.toLowerCase().includes(query);
			if (!row.element.hidden) counts.set(group, (counts.get(group) ?? 0) + 1);
			const references = 'defaults' in entry ? current && getThemeColorReferences(current, entry) : entry.references;
			row.update(colors[entry.id], previewColors.get(entry.id)?.value ?? current?.getColor(entry.id), this.valid && !this.input?.readOnly, references);
		}
		for (const group of this.groups) group.setCount(counts.get(group) ?? 0);
		if (this.empty) this.empty.hidden = counts.size > 0;
		if (this.picker && this.pickerRow) {
			if (this.pickerRow.element.closest('[hidden]') || !this.pickerRow.picker.enabled) {
				this.pickerLifetime.clear();
			} else {
				const color = this.pickerRow.color ?? Color.black;
				// JSON edits and Undo win; a serialized echo must not cancel the picker's pointer gesture.
				if (Color.Format.CSS.formatHexA(this.picker.color, true) !== Color.Format.CSS.formatHexA(color, true)) {
					this.picker.setColor(color);
				}
			}
		}
		const identifiers = new Set(entries.map(entry => entry.id));
		for (const [id, row] of this.rows) if (!identifiers.has(id)) { row.dispose(); this.rows.delete(id); }
		this.scrollable?.layout();
	}

	private revealDesignToken(id: string): void {
		const row = this.rows.get(id);
		if (!row || !this.search) return;
		this.search.value = '';
		this.renderRows();
		this.groups.find(group => group.pattern.test(id))?.setExpanded(true);
		this.scrollable?.layout();
		this.scrollable?.reveal(row.element);
		row.focus();
	}

	private editColor(id: string, value: string | undefined): void {
		if (!this.valid || this.input?.readOnly) return;
		const control = this.getControl();
		const model = control?.getModel();
		if (!model || !control) return;
		const edits = setProperty(model.getText(), ['colors', id], value, { insertSpaces: !/^\t/mu.test(model.getText()), tabSize: 2, eol: model.getText().includes('\r\n') ? '\r\n' : '\n' });
		model.pushStackElement();
		control.executeEdits('themeEditor.color', edits.map(edit => ({ range: Range.fromPositions(model.getPositionAt(edit.offset), model.getPositionAt(edit.offset + edit.length)), text: edit.content })));
		model.pushStackElement();
		// The synchronous document edit is complete; a second color gesture can proceed.
		this.valid = true;
		// Picker gestures must read the edited color even while preview compilation is pending.
		this.renderRows();
		this.revealColor(id, false);
	}

	private showColorPicker(row: ThemeColorRow): void {
		this.pickerLifetime.clear();
		const lifetime = new DisposableStore();
		this.pickerLifetime.value = lifetime;
		let visible = false;
		const picker = lifetime.add(new ColorPicker(row.element.ownerDocument));
		picker.domNode.classList.add('ash-theme-editor-color-popup');
		// ContextView can mount outside the auxiliary workbench's themed root.
		lifetime.add(bindColorTheme(this.themes, picker.domNode));
		this.picker = picker;
		this.pickerRow = row;
		picker.setColor(row.color ?? Color.black);
		lifetime.add(this.contextKeys.createScoped(picker.domNode)).createKey(ThemeEditorFocused.key, true);
		lifetime.add(picker.onDidChangeColor(color => this.editColor(row.id, Color.Format.CSS.formatHexA(color, true))));
		lifetime.add(picker.onDidRequestClose(() => {
			this.pickerLifetime.clear();
			// Close is an explicit return to the trigger; outside clicks retain their own focus.
			if (row.picker.domNode.isConnected && row.picker.enabled) row.picker.focus();
		}));
		// Stores dispose in reverse order: hide and restore focus before removing the controls.
		lifetime.add(toDisposable(() => {
			if (visible) this.contextViews.hide();
			this.picker = undefined;
			this.pickerRow = undefined;
		}));
		row.picker.domNode.setAttribute('aria-expanded', 'true');
		row.picker.focus();
		visible = this.contextViews.show({
			anchor: row.picker.domNode,
			content: picker.domNode,
			presentation: 'plain',
			focusRestore: ContextViewFocusRestore.Previous,
			onHide: () => {
				visible = false;
				row.picker.domNode.setAttribute('aria-expanded', 'false');
				this.pickerLifetime.clear();
			},
		});
		if (visible) picker.focus();
		else this.pickerLifetime.clear();
	}

	private revealColor(id: string, focus = true): void {
		const control = this.getControl(); const model = control?.getModel();
		if (!control || !model) return;
		const node = findNodeAtLocation(parseTree(model.getText()), ['colors', id]);
		if (!node) return;
		const range = Range.fromPositions(model.getPositionAt(node.offset), model.getPositionAt(node.offset + node.length));
		control.setSelection(range); control.revealRange?.(range);
		if (focus) { this.selectSettings('json'); control.focus(); }
	}

	private syncSelection(): void {
		const model = this.getControl()?.getModel(); const selection = this.getControl()?.getSelections()?.[0];
		if (!model || !selection) return;
		const offset = model.getOffsetAt(selection.getStartPosition());
		const colors = findNodeAtLocation(parseTree(model.getText()), ['colors']);
		let selected: string | undefined;
		for (const property of colors?.children ?? []) if (offset >= property.offset && offset <= property.offset + property.length) selected = String(property.children?.[0]?.value);
		for (const [id, row] of this.rows) row.element.classList.toggle('selected', id === selected);
	}

	private runAction(action: () => Promise<void>): void {
		if (this.saving) return;
		this.saving = true;
		void action().catch(error => this.showMessage(localize('themeEditor.saveError', 'Could not save the theme. {0}', error instanceof Error ? error.message : String(error)), true)).finally(() => { this.saving = false; });
	}
	private showMessage(message: string, error = false): void {
		if (!this.message) return;
		this.message.textContent = message;
		this.message.classList.toggle('error', error);
		this.layout(this.dimension);
	}
}

/** Expansion is inspector state; edits continue to be owned by the theme document. */
class ThemeColorGroup extends Disposable {
	public readonly body: HTMLElement;
	private readonly element: HTMLElement;
	private readonly header: HTMLButtonElement;
	private readonly count: HTMLElement;
	private expandedBeforeSearch = false;

	constructor(parent: HTMLElement, id: string, public readonly label: string, public readonly pattern: RegExp, expanded: boolean, changed: () => void) {
		super();
		const doc = parent.ownerDocument;
		this.element = h(doc, 'section', { className: 'ash-theme-color-group' });
		this.header = h(doc, 'button', { className: 'ash-theme-color-group-heading', attributes: { type: 'button', 'aria-label': label, 'aria-controls': `theme-color-group-${id}` } });
		this.header.append(h(doc, 'span', { className: 'ash-theme-color-group-label' }, label));
		this.header.title = label;
		this.count = h(doc, 'span', { className: 'ash-theme-color-group-count', attributes: { 'aria-hidden': 'true' } });
		this.header.append(this.count);
		const chevron = h(doc, 'span', { className: 'ash-theme-color-group-chevron', attributes: { 'aria-hidden': 'true' } });
		appendLabelIcon(chevron, Lxicon.chevronDown);
		this.header.append(chevron);
		this.body = h(doc, 'div', { className: 'ash-theme-color-group-body', attributes: { id: `theme-color-group-${id}` } });
		this.element.append(this.header, this.body);
		parent.append(this.element);
		this.setExpanded(expanded);
		this._register(addDisposableListener(this.header, 'click', () => { this.setExpanded(!!this.body.hidden); changed(); }));
		this._register(toDisposable(() => this.element.remove()));
	}

	public setCount(count: number): void {
		this.count.textContent = String(count);
		this.element.hidden = count === 0;
	}

	public setFiltering(filtering: boolean): void {
		if (filtering) this.expandedBeforeSearch = !this.body.hidden;
		this.setExpanded(filtering || this.expandedBeforeSearch);
	}

	public setExpanded(expanded: boolean): void {
		this.header.setAttribute('aria-expanded', String(expanded));
		this.header.classList.toggle('collapsed', !expanded);
		this.body.hidden = !expanded;
	}
}

class ThemeColorRow extends Disposable {
	public readonly element: HTMLElement;
	private readonly name: HTMLButtonElement;
	private readonly hex: HTMLInputElement;
	public readonly picker: Button;
	private readonly swatch: HTMLElement;
	private readonly reset: Button;
	private readonly source: HTMLElement;
	private readonly sourceLifetime = this._register(new DisposableStore());
	private sourceKey: string | undefined;
	private currentColor: Color | undefined;
	private documentValue: string | undefined;
	public get accessibleText(): string { return `${this.id}: ${this.hex.value}. ${this.source.textContent ?? ''}`; }
	public get color(): Color | undefined { return this.currentColor; }

	constructor(doc: Document, public readonly id: string, description: string, hover: IHoverService, edit: (value: string | undefined) => void, reveal: () => void, pick: (row: ThemeColorRow) => void, private readonly navigate: (id: string) => void) {
		super();
		this.element = h(doc, 'div'); this.element.className = 'ash-theme-color';
		this.picker = this._register(new Button(this.element, { label: '', iconOnly: true, ariaLabel: localize('themeEditor.pickColor', 'Choose color for {0}', id), onClick: () => pick(this) }));
		this.picker.domNode.classList.add('ash-theme-color-picker');
		this.picker.domNode.setAttribute('aria-haspopup', 'dialog');
		this.picker.domNode.setAttribute('aria-expanded', 'false');
		this.swatch = h(doc, 'span', { className: 'ash-theme-color-swatch', attributes: { 'aria-hidden': 'true' } });
		this.picker.domNode.append(this.swatch);
		this.name = h(doc, 'button', { className: 'ash-theme-color-name', attributes: { type: 'button' } }, id);
		this.element.append(this.name);
		this._register(addDisposableListener(this.name, 'click', reveal));
		this._register(hover.setupHover({ target: this.name, content: `${id}\n${description}` }));
		this.hex = h(doc, 'input', { className: 'ash-theme-color-hex', attributes: { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': localize('themeEditor.hexColor', 'Hex color for {0}', id) } });
		this.element.append(this.hex);
		this._register(addDisposableListener(this.hex, 'input', () => {
			const value = this.hex.value;
			const valid = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(value);
			this.hex.setAttribute('aria-invalid', String(!valid));
			if (valid) edit(value);
		}));
		this.source = h(doc, 'p'); this.source.className = 'ash-theme-color-source'; this.element.append(this.source);
		this.reset = this._register(new Button(this.element, { label: localize('themeEditor.reset', 'Reset'), icon: Lxicon.discard, iconOnly: true, size: 'small', presentation: 'quiet', ariaLabel: localize('themeEditor.resetColor', 'Remove the override for {0}', id), title: localize('themeEditor.resetColor', 'Remove the override for {0}', id), onClick: () => edit(undefined) }));
		this.reset.domNode.classList.add('ash-theme-color-reset');
		this._register(toDisposable(() => this.element.remove()));
	}

	public focus(): void { (this.hex.disabled ? this.name : this.hex).focus({ preventScroll: true }); }

	public update(authored: string | undefined, effective: Color | undefined, enabled: boolean, references: ThemeColorReferences | undefined): void {
		this.currentColor = authored ? Color.fromHex(authored) : effective;
		const value = authored ?? (effective ? Color.Format.CSS.formatHexA(effective, true) : '');
		// Document changes (including Undo in JSON) win over the focused control.
		// An incomplete hex input survives unrelated preview/catalog refreshes.
		if (this.documentValue !== value || this.element.ownerDocument.activeElement !== this.hex) {
			this.hex.value = value;
			this.hex.removeAttribute('aria-invalid');
		}
		this.documentValue = value;
		this.swatch.style.backgroundColor = this.color ? Color.Format.CSS.formatHexA(this.color, true) : 'transparent';
		this.picker.enabled = enabled;
		this.hex.disabled = !enabled;
		this.reset.enabled = enabled && authored !== undefined;
		this.element.classList.toggle('modified', authored !== undefined);
		const relation = authored === undefined ? references : undefined;
		const final = effective ? Color.Format.CSS.formatHexA(effective, true) : undefined;
		let label = authored === undefined ? localize('themeEditor.inherited', 'Inherited / default') : localize('themeEditor.explicit', 'Set in this file');
		if (authored && final && !Color.fromHex(authored).equals(effective!)) label += ' · ' + localize('themeEditor.effective', 'Effective: {0}', final);
		const key = JSON.stringify(relation ?? label);
		// Keep focused links and their listeners stable across preview refreshes.
		if (this.sourceKey === key) return;
		this.sourceKey = key;
		this.sourceLifetime.clear();
		this.source.replaceChildren();
		this.element.classList.toggle('linked', !!relation);
		if (!relation) {
			this.source.textContent = label;
			this.source.title = label;
			return;
		}
		const format = (tokens: string) => relation.kind === 'linked'
			? localize('themeEditor.linkedTo', 'Linked to {0}', tokens)
			: localize('themeEditor.derivedFrom', 'Derived from {0}', tokens);
		this.source.title = format(relation.tokens.join(', '));
		const icon = h(this.source.ownerDocument, 'span', { className: 'ash-theme-color-link-icon', attributes: { 'aria-hidden': 'true' } });
		appendLabelIcon(icon, Lxicon.link);
		this.source.append(icon);
		// Insert controls at the translated placeholder; languages can put the label on either side.
		const [before, after] = format('\uFFFC').split('\uFFFC');
		this.source.append(before!);
		for (const [index, token] of relation.tokens.entries()) {
			if (index) this.source.append(', ');
			const link = h(this.source.ownerDocument, 'button', {
				className: 'ash-theme-color-link',
				attributes: { type: 'button', 'aria-label': localize('themeEditor.goToToken', 'Go to design token {0}', token) },
			}, token);
			this.source.append(link);
			this.sourceLifetime.add(addDisposableListener(link, 'click', () => this.navigate(token)));
		}
		if (after) this.source.append(after);
	}
}
