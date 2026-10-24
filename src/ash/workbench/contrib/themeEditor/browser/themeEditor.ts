import type { IAction } from '../../../../base/common/actions.js';
import { MenuId, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import './media/themeEditor.css';
import { addDisposableListener, getWindow, h, isHTMLElement, stopEvent } from '../../../../base/browser/dom.js';
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
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { TextResourceEditor } from '../../../browser/parts/editor/textResourceEditor.js';
import type { IResourceEditorInput, ISaveOptions } from '../../../common/editor.js';
import { IUserThemeService } from '../../../common/userThemes.js';
import { parseColorThemeDocument, serializeUserColorThemeDraft, userThemeId } from '../../../services/themes/common/colorThemeData.js';
import { defaultButtonStyles, defaultInputBoxStyles, defaultDialogStyles, defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IFileTextModelService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { IExtensionService, type ExtensionThemeContribution } from '../../../services/extensions/common/extensionService.js';
import { createExtensionWorkbenchColorTheme, extensionWorkbenchThemeId, loadExtensionTheme, parseExtensionTheme } from '../../../services/extensions/common/extensionTheme.js';
import { IExtensionResourceLoaderService, toExtensionResourceURI } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';

export const ThemeEditorId = 'workbench.editor.themeEditor';
export const ThemeEditorFocused = new RawContextKey<boolean>('themeEditorFocused', false);

export function createThemeEditorInput(input: IResourceEditorInput): IResourceEditorInput {
	return { ...input, editorId: ThemeEditorId, languageId: 'jsonc' };
}

/** Resolve the original contribution, including its include boundary and package generation. */
export function getThemeEditorSource(extensions: IExtensionService, target: string | URI) {
	for (const entry of extensions.getExtensionPointContributions<readonly ExtensionThemeContribution[]>('themes')) {
		for (const [index, contribution] of entry.value.entries()) {
			const id = extensionWorkbenchThemeId(entry.description.id, contribution.id, index);
			const request = { generation: extensions.currentCatalog.generation, extensionId: entry.description.id, path: contribution.path };
			const resource = entry.description.extensionLocation
				? URI.joinPath(entry.description.extensionLocation, contribution.path)
				: toExtensionResourceURI(request);
			// Package generations select read capabilities, not a second editor identity.
			if (typeof target === 'string' ? target === id : [resource, toExtensionResourceURI(request)].some(candidate => target.with({ query: '' }).toString() === candidate.with({ query: '' }).toString())) {
				return { resource, request, contribution, index, id };
			}
		}
	}
	return undefined;
}

/** The embedded text pane owns the document, history, working copy and file revision. */
export class ThemeEditor extends EditorPane {
	public readonly id = ThemeEditorId;
	public readonly prefersEditorTitleHidden = true;
	public readonly prefersStatusbarHidden = true;
	public readonly prefersCompactTitlebar = true;
	readonly prefersWindowCloseConfirmation = true;
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
	private picker: ColorPicker | undefined;
	private pickerRow: ThemeColorRow | undefined;
	private readonly refresh = this._register(new RunOnceScheduler(() => { void this.updatePreview(); }, 60));
	private readonly copiesChanged = this._register(new Emitter<void>());
	public readonly onDidChangeWorkingCopies = this.copiesChanged.event;
	private input: IResourceEditorInput | undefined;
	private compiled: IColorTheme | undefined;
	private compiledSource: string | undefined;
	/** Only shared within an in-flight save; the next save rechecks included files. */
	private saveValidation: { input: IResourceEditorInput; source: string; theme: IColorTheme; } | undefined;
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
		@IExtensionService private readonly extensions: IExtensionService,
		@IExtensionResourceLoaderService private readonly extensionResources: IExtensionResourceLoaderService,
	) {
		super(ThemeEditorId, themeService, storageService);
		this._register(toDisposable(() => this.clearInput()));
		this._register(textEditor);
		this._register(toDisposable(() => { for (const row of this.rows.values()) row.dispose(); this.rows.clear(); }));
		// Validation and applied-version retention belong to the shared save path,
		// including close confirmation, Save All and another JSON view of this file.
		this._register(models.addSaveParticipant({
			participate: async (model, _reason, signal) => {
				if (model !== this.getControl()?.getModel()) return;
				await this.validateSave(signal);
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
			if (!event.relatedTarget || (!root.contains(event.relatedTarget as Node) && !(isHTMLElement(event.relatedTarget) && this.picker && ColorPicker.getFocused(event.relatedTarget) === this.picker))) focused.reset();
		}));
		// Auxiliary controls must resolve help in their owner window before the shared dispatcher.
		this._register(addDisposableListener<KeyboardEvent>(getWindow(root), 'keydown', event => {
			if (!root.contains(event.target as Node) && !(isHTMLElement(event.target) && this.picker && ColorPicker.getFocused(event.target) === this.picker)) return;
			if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'F1' || event.key === 'F2')) {
				stopEvent(event);
				this.accessibleViews.show(event.key === 'F1' ? AccessibleViewType.Help : AccessibleViewType.View, root);
				return;
			}
			if (!event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
				stopEvent(event);
				void this.runAction(() => event.shiftKey ? this.saveThemeAs() : this.save());
			}
		}, { capture: true }));
		const toolbar = h(doc, 'div');
		toolbar.className = 'ash-theme-editor-toolbar';
		const title = h(doc, 'h1');
		title.textContent = localize('themeEditor.title', 'Theme Editor');
		toolbar.append(title);

		this.message = h(doc, 'p');
		this.message.className = 'ash-theme-editor-message';
		this.message.setAttribute('role', 'status');
		this.message.textContent = localize('themeEditor.description', 'Draft changes are saved automatically and appear only in the preview. Save and Apply updates the theme and the main window.');
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
		this.search = this._register(new InputBox(searchHost, {
			inputBoxStyles: defaultInputBoxStyles,
			presentation: 'compact',
			type: 'search',
			placeholder: localize('themeEditor.search', 'Search colors'),
			ariaLabel: localize('themeEditor.search', 'Search colors'),
		}));
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
				this.picker?.cancel();
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
		this.inputLifetime.add(control.onDidChangeModelContent(() => {
			this.valid = false;
			this.updateTitleArea();
			// Continuous picker input must update the preview before the gesture
			// ends. Keep the current deadline and compile the latest document.
			if (!this.refresh.isScheduled()) this.refresh.schedule();
		}));
		this.inputLifetime.add(control.onDidChangeCursorSelection(() => this.syncSelection()));
		this.copiesChanged.fire();
		this.updateTitleArea();
		await this.updatePreview();
		this.layout(this.dimension);
	}

	public override clearInput(): void {
		this.picker?.cancel();
		this.operation++;
		this.refresh.cancel();
		this.inputLifetime.clear();
		this.nameDialog.clear();
		this.compiled = undefined;
		this.compiledSource = undefined;
		this.saveValidation = undefined;
		this.input = undefined;
		this.valid = false;
		this.textEditor.clearInput();
		this.copiesChanged.fire();
		this.updateTitleArea();
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
		if (!visible) this.picker?.cancel();
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

	public override getActions(): readonly IAction[] {
		const model = this.getControl()?.getModel();
		const historyAction = (redo: boolean): IAction => ({
			id: redo ? 'themeEditor.redo' : 'themeEditor.undo',
			label: redo ? localize('themeEditor.redo', 'Redo') : localize('themeEditor.undo', 'Undo'),
			tooltip: redo ? localize('themeEditor.redo', 'Redo') : localize('themeEditor.undo', 'Undo'),
			icon: redo ? Lxicon.redo : Lxicon.discard,
			enabled: !this.saving && !this.input?.readOnly && (redo ? model?.canRedo() : model?.canUndo()) === true,
			run: () => { if (redo) model?.redo(); else model?.undo(); },
		});
		const saveAction = (id: string, label: string, run: () => Promise<void>): IAction => ({
			id,
			label,
			tooltip: label,
			enabled: !!this.input && (!this.input.readOnly || id === 'themeEditor.saveAs') && !this.saving,
			icon: id === 'themeEditor.saveAndApply' ? Lxicon.check : undefined,
			run: () => this.runAction(run),
		});
		return [
			historyAction(false),
			historyAction(true),
			new SubmenuItemAction({
				title: localize('themeEditor.saveActions', 'Theme save actions'),
				submenu: MenuId.for('ThemeEditorSaveActions'),
				isSplitButton: true,
			}, [
				saveAction('themeEditor.saveAndApply', localize('themeEditor.saveApply', 'Save and Apply'), () => this.saveAndApply()),
				saveAction('themeEditor.saveAs', localize('themeEditor.saveAs', 'Save as…'), () => this.saveThemeAs()),
				saveAction('themeEditor.save', localize('themeEditor.save', 'Save'), () => this.save()),
			]),
		];
	}

	public async save(options?: ISaveOptions): Promise<void> {
		const input = this.input;
		if (!input || input.readOnly) return;
		if (input.resource.scheme === 'untitled') return this.saveThemeAs();
		// Keep theme validation errors in this editor, before generic file-error dialogs.
		const validation = await this.validateSave(new AbortController().signal, true);
		if (this.input !== input) throw new CancellationError();
		this.saveValidation = validation;
		try {
			await this.textEditor.save(options);
			// Extension source saves are already observed by their theme registration owner.
			if (!getThemeEditorSource(this.extensions, input.resource)) await this.userThemes.reload();
			if (this.input !== input) return;
			// Finish a pending color edit before publishing the save result.
			this.refresh.cancel();
			await this.updatePreview();
			this.showMessage(localize('themeEditor.saved', 'Theme saved.'));
		} finally {
			if (this.saveValidation === validation) this.saveValidation = undefined;
		}
	}

	private async validateSave(signal: AbortSignal, fresh = false): Promise<{ input: IResourceEditorInput; source: string; theme: IColorTheme; }> {
		const input = this.input;
		const model = this.getControl()?.getModel();
		if (!input || !model) throw new CancellationError();
		let source: string;
		let theme: IColorTheme;
		do {
			source = model.getText();
			const prepared = fresh ? undefined : this.saveValidation;
			theme = prepared?.input === input && prepared.source === source ? prepared.theme : await this.compile(source, input);
			if (signal.aborted) throw new CancellationError();
		} while (model.getText() !== source);
		const id = this.themeIdForResource(input.resource);
		if (id) this.themes.deferColorThemeApplication(id);
		if (this.input === input && model === this.getControl()?.getModel()) {
			this.refresh.cancel();
			await this.updatePreview(theme);
		}
		return { input, source, theme };
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
		// Exporting an extension theme is explicit. Resolve its package-relative
		// includes here; the original source editor keeps the original document.
		const candidate = getThemeEditorSource(this.extensions, input.resource)
			? serializeUserColorThemeDraft(await this.compile(source, input), name.trim())
			: applyEdits(source, setProperty(source, ['name'], name.trim(), { insertSpaces: true, tabSize: 2 }));
		await this.compile(candidate);
		const saved = await this.userThemes.saveAs(candidate);
		// A slow write must not replace a document that acquired newer edits meanwhile.
		if (this.input !== input || model.isDisposed() || model.getText() !== source) {
			this.showMessage(localize('themeEditor.copySaved', 'Saved {0}. Newer edits remain in this editor.', saved.file));
			return;
		}
		if (this.workingCopy?.isDirty) {
			// Revert the shared source only after its captured edits are durable in the copy.
			// Cancel the read if another view edits the source while the revert is pending.
			const cancellation = new AbortController();
			using edits = Event.once(model.onDidChangeContent)(() => cancellation.abort());
			await this.workingCopy.revert(cancellation.signal);
		}
		if (this.input !== input || model.isDisposed() || this.workingCopy?.isDirty) {
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
		const name = lifetime.add(new InputBox(content, {
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: localize('themeEditor.name', 'Theme name'),
			placeholder: localize('themeEditor.name', 'Theme name'),
		}));
		const label = this.compiled?.label ?? localize('themeEditor.title', 'Theme Editor');
		name.value = this.input?.resource.scheme === 'untitled' ? label : localize('themeEditor.copyName', '{0} Copy', label);
		const hint = h(content.ownerDocument, 'p');
		hint.textContent = localize('themeEditor.invalidName', 'Enter a theme name of 1 to 256 characters.');
		content.append(hint);
		let save!: Button;
		const dialog = lifetime.add(new Dialog(this.root, localize('themeEditor.saveAs', 'Save as…'), [
			localize('themeEditor.save', 'Save'), localize('themeEditor.cancel', 'Cancel'),
		], {
			buttonStyles: defaultButtonStyles,
			checkboxStyles: defaultCheckboxStyles,
			inputBoxStyles: defaultInputBoxStyles,
			dialogStyles: defaultDialogStyles,
			cancelId: 1,
			renderBody: body => body.append(content),
			buttonOptions: [{ styleButton: button => { save = button; save.enabled = name.value.trim().length > 0 && name.value.trim().length <= 256; } }],
		}));
		lifetime.add(name.onDidChange(value => { save.enabled = value.trim().length > 0 && value.trim().length <= 256; }));
		try { return (await dialog.show()).button === 0 ? name.value.trim() : undefined; }
		finally { if (this.nameDialog.value === lifetime) this.nameDialog.clear(); }
	}

	private async compile(source: string, input = this.input): Promise<IColorTheme> {
		const extension = input && getThemeEditorSource(this.extensions, input.resource);
		if (extension) {
			const definition = await loadExtensionTheme(path => path === extension.contribution.path
				? Promise.resolve(new TextEncoder().encode(source))
				: this.extensionResources.readExtensionResourceBytes({ ...extension.request, path }), extension.request.extensionId, extension.contribution, extension.index);
			return createExtensionWorkbenchColorTheme(definition);
		}
		return this.userThemes.resolve(source, this.themeIdForResource(input?.resource));
	}

	private themeIdForResource(resource: URI | undefined): string | undefined {
		const extension = resource && getThemeEditorSource(this.extensions, resource);
		if (extension) return extension.id;
		if (!resource || !this.userThemes.directory) return undefined;
		const id = userThemeId(resource.path.split('/').at(-1)!.replace(/\.json$/iu, ''));
		const existing = this.userThemes.sourceFor(id);
		// An external JSON file must not borrow a profile theme's includes or applied-version state.
		return existing && URI.joinPath(this.userThemes.directory, existing.file).toString() === resource.toString() ? id : undefined;
	}

	private async updatePreview(validatedTheme?: IColorTheme): Promise<void> {
		const operation = ++this.operation;
		const source = this.textEditor.getValue();
		if (!this.input) return;
		try {
			// A successful save participant already compiled this unchanged model.
			// Reuse that result instead of loading its includes again after publication.
			const theme = validatedTheme ?? (this.compiledSource === source && this.compiled ? this.compiled : await this.compile(source));
			if (operation !== this.operation || this.textEditor.getValue() !== source) return;
			this.compiled = theme;
			this.compiledSource = source;
			this.valid = true;
			this.applyPreview();
			this.renderRows();
			this.showMessage(this.input.readOnly
				? localize('themeEditor.readOnlySource', 'This theme source is read-only. Use Save as to create an editable user theme.')
				: localize('themeEditor.description', 'Draft changes are saved automatically and appear only in the preview. Save and Apply updates the theme and the main window.'));
		} catch (error) {
			if (operation !== this.operation || this.textEditor.getValue() !== source) return;
			this.valid = false;
			this.showMessage(localize('themeEditor.invalidJson', 'Cannot preview this JSON. The last valid preview is retained. {0}', error instanceof Error ? error.message : String(error)), true);
			this.renderRows();
		}
	}

	private applyPreview(): void {
		if (this.compiled && this.valid) this.preview?.update(this.compiled, this.authoredColors());
	}

	private authoredColors(): Readonly<Record<string, string>> {
		const source = parseJsonc(this.textEditor.getValue(), 'Color theme');
		const extension = this.input && getThemeEditorSource(this.extensions, this.input.resource);
		// Use the format owner to validate theme fields and normalize publisher metadata.
		return extension
			? parseExtensionTheme(source, extension.id, extension.request.extensionId, extension.contribution.label, extension.contribution.uiTheme, extension.contribution.path).colors
			: parseColorThemeDocument(source).colors ?? {};
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
		await this.save();
		// Save participants can change the document. Only edits not acknowledged by
		// the shared working copy should prevent applying the newly saved theme.
		if (this.input !== input || this.workingCopy?.isDirty) return;
		await this.themes.setColorTheme(id);
		this.showMessage(localize('themeEditor.applied', 'Theme saved and applied.'));
	}

	private renderRows(): void {
		if (!this.list) return;
		let colors: Readonly<Record<string, string>> = {};
		try { colors = this.authoredColors(); } catch { }
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
					value => this.editColor(entry.id, value), () => this.revealColor(entry.id), row => this.createColorPicker(row), id => this.revealDesignToken(id));
				this.rows.set(entry.id, row);
				group.body.append(row.element);
			}
			const hidden = !!query && !`${entry.id} ${entry.description} ${group.label}`.toLowerCase().includes(query);
			if (row.element.hidden !== hidden) row.element.hidden = hidden;
			if (!row.element.hidden) counts.set(group, (counts.get(group) ?? 0) + 1);
			const references = 'defaults' in entry ? current && getThemeColorReferences(current, entry) : entry.references;
			row.update(colors[entry.id], previewColors.get(entry.id)?.value ?? current?.getColor(entry.id), this.valid && !this.input?.readOnly, references);
		}
		for (const group of this.groups) group.setCount(counts.get(group) ?? 0);
		if (this.empty) this.empty.hidden = counts.size > 0;
		if (this.pickerRow?.element.closest('[hidden]')) this.picker?.cancel();
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
		if (edits.length === 0) return;
		model.pushStackElement();
		control.executeEdits('themeEditor.color', edits.map(edit => ({ range: Range.fromPositions(model.getPositionAt(edit.offset), model.getPositionAt(edit.offset + edit.length)), text: edit.content })));
		model.pushStackElement();
		// The synchronous document edit is complete; a second color gesture can proceed.
		this.valid = true;
		// Picker gestures must read the edited color even while preview compilation is pending.
		const row = this.rows.get(id);
		if (row) row.update(value, row.color, true, undefined);
		this.revealColor(id, false);
	}

	private createColorPicker(row: ThemeColorRow): ColorPicker {
		const picker = new ColorPicker(row.element.ownerDocument, 'input', {
			color: localize('themeEditor.pickColor', 'Choose color for {0}', row.id),
			value: localize('themeEditor.hexColor', 'Hex color for {0}', row.id),
			opacity: localize('themeEditor.colorOpacity', 'Opacity for {0} (%)', row.id),
			popup: {
				show: (anchor, panel, onHide) => {
					const visible = this.contextViews.show({
						anchor, content: panel, presentation: 'plain', focusRestore: ContextViewFocusRestore.Previous, onHide: () => {
							if (this.picker === picker) { this.picker = undefined; this.pickerRow = undefined; }
							onHide(false);
						}
					});
					if (visible) { this.picker = picker; this.pickerRow = row; }
					return visible;
				},
				hide: () => this.contextViews.hide(),
				configure: panel => {
					const lifetime = new DisposableStore();
					panel.classList.add('ash-theme-editor-color-popup');
					lifetime.add(this.contextKeys.createScoped(panel)).createKey(ThemeEditorFocused.key, true);
					return lifetime;
				},
			},
		});
		picker.domNode.classList.add('ash-theme-color-input');
		return picker;
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

	private async runAction(action: () => Promise<void>): Promise<void> {
		if (this.saving) return;
		this.saving = true;
		this.updateTitleArea();
		await action().catch(error => this.showMessage(localize('themeEditor.saveError', 'Could not save the theme. {0}', error instanceof Error ? error.message : String(error)), true)).finally(() => { this.saving = false; this.updateTitleArea(); });
	}
	private showMessage(message: string, error = false): void {
		if (!this.message) return;
		if (this.message.textContent === message && this.message.classList.contains('error') === error) return;
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
		if (this.count.textContent !== String(count)) this.count.textContent = String(count);
		if (this.element.hidden !== (count === 0)) this.element.hidden = count === 0;
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
	public readonly picker: ColorPicker;
	private readonly reset: Button;
	private readonly source: HTMLElement;
	private readonly sourceLifetime = this._register(new DisposableStore());
	private sourceKey: string | undefined;
	private currentColor: Color | undefined;
	private documentValue: string | undefined;
	private renderedState: string | undefined;
	private editable = false;
	public get accessibleText(): string { return `${this.id}: ${this.picker.getAccessibleContent()}. ${this.source.textContent ?? ''}`; }
	public get color(): Color | undefined { return this.currentColor; }

	constructor(doc: Document, public readonly id: string, description: string, hover: IHoverService, edit: (value: string | undefined) => void, reveal: () => void, createPicker: (row: ThemeColorRow) => ColorPicker, private readonly navigate: (id: string) => void) {
		super();
		this.element = h(doc, 'div'); this.element.className = 'ash-theme-color';
		this.name = h(doc, 'button', { className: 'ash-theme-color-name', attributes: { type: 'button' } }, id);
		this.element.append(this.name);
		this._register(addDisposableListener(this.name, 'click', reveal));
		this._register(hover.setupHover({ target: this.name, content: `${id}\n${description}` }));
		this.picker = this._register(createPicker(this));
		this._register(this.picker.onDidChangeColor(color => edit(Color.Format.CSS.formatHexA(color, true))));
		this._register(this.picker.onDidCommitColor(color => edit(Color.Format.CSS.formatHexA(color, true))));
		this.element.append(this.picker.domNode);
		this.source = h(doc, 'p'); this.source.className = 'ash-theme-color-source'; this.element.append(this.source);
		this.reset = this._register(new Button(this.element, {
			...defaultButtonStyles,
			label: localize('themeEditor.reset', 'Reset'),
			icon: Lxicon.discard,
			iconOnly: true,
			size: 'small',
			presentation: 'quiet',
			ariaLabel: localize('themeEditor.resetColor', 'Remove the override for {0}', id),
			title: localize('themeEditor.resetColor', 'Remove the override for {0}', id),
			onClick: () => edit(undefined),
		}));
		this.reset.domNode.classList.add('ash-theme-color-reset');
		this._register(toDisposable(() => this.element.remove()));
	}

	public focus(): void { if (this.editable) this.picker.focus(); else this.name.focus({ preventScroll: true }); }

	public update(authored: string | undefined, effective: Color | undefined, enabled: boolean, references: ThemeColorReferences | undefined): void {
		const value = authored ?? (effective ? Color.Format.CSS.formatHexA(effective, true) : '');
		const state = JSON.stringify([authored, effective ? Color.Format.CSS.formatHexA(effective, true) : undefined, enabled, references]);
		if (state === this.renderedState) return;
		this.renderedState = state;
		this.currentColor = authored ? Color.fromHex(authored) : effective;
		// Keep incomplete input through preview refreshes; actual document changes (including Undo) win.
		if (this.documentValue !== value) this.picker.setColor(this.currentColor ?? Color.transparent, this.id);
		this.documentValue = value;
		this.editable = enabled;
		this.picker.enabled = enabled;
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
