import { h, type IDimension } from '../../../../base/browser/dom.js';
import { type IAction } from '../../../../base/common/actions.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorWorkingCopy } from '../../../browser/parts/editor/textResourceEditor.js';
import type { IResourceEditorInput, ISaveOptions } from '../../../common/editor.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { ITextModelResourceService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { TextFileSaveErrorHandler } from '../../files/browser/editors/textFileSaveErrorHandler.js';
import { loadArkdown } from './arkdown.js';
import { ArkdownEditor, type ArkdownEditorMode } from './arkdownEditor.js';

export const MARKDOWN_EDITOR_ID = 'ash.editor.markdown';

export function createMarkdownEditorInput(source: IResourceEditorInput): IResourceEditorInput {
	if (source.editorId === MARKDOWN_EDITOR_ID && source.rename) return source;
	return {
		...source, editorId: MARKDOWN_EDITOR_ID, languageId: 'markdown', contentType: 'text/markdown',
		rename: resource => createMarkdownEditorInput({ resource }),
	};
}

/** File lifecycle shared by IDE Markdown documents and the Sessions Docs shell. */
export class MarkdownEditorPane extends EditorPane {
	readonly id: string;
	private root!: HTMLElement;
	private readonly inputLifetime = this._register(new MutableDisposable<DisposableStore>());
	private widget: ArkdownEditor | undefined;
	private copy: EditorWorkingCopy | undefined;
	private input: IResourceEditorInput | undefined;
	private readOnly = false;
	private readonly saveErrors: TextFileSaveErrorHandler;

	constructor(
		private readonly options: { readonly id: string; readonly onSave?: () => Promise<void | boolean>; },
		@ITextModelResourceService private readonly models: ITextModelResourceService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@INotificationService private readonly notifications: INotificationService,
		@IFilesConfigurationService private readonly filesConfiguration: IFilesConfigurationService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IOpenerService private readonly opener: IOpenerService,
	) {
		super(options.id, theme, storage);
		this.id = options.id;
		this.saveErrors = instantiation.createInstance(TextFileSaveErrorHandler);
		this._register(filesConfiguration.onDidChangeReadonly(() => this.updateReadOnly()));
	}

	override create(parent: HTMLElement): void {
		this.root = h(parent.ownerDocument, 'div', { className: 'stanza-markdown-editor-pane' });
		this.root.style.height = '100%';
		parent.append(this.root);
		this._register(toDisposable(() => this.root.remove()));
		super.create(this.root);
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		const runtime = await loadArkdown();
		signal.throwIfAborted();
		const reference = await this.models.acquire({ ...input, languageId: 'markdown' }, signal, { waitForSyntax: false });
		const lifetime = new DisposableStore();
		try {
			const copy = lifetime.add(new EditorWorkingCopy(reference, input, this.workingCopies, this.options.onSave));
			const widget = lifetime.add(this.instantiation.createInstance(ArkdownEditor, this.root, reference.model, runtime, 'rich',
				(error: unknown) => this.notifications.error(error instanceof Error ? error : String(error)),
				(url: string) => { void this.opener.open(URI.parse(url), { openExternal: true }).catch(error => this.notifications.error(String(error))); }));
			signal.throwIfAborted();
			this.inputLifetime.value = lifetime;
			this.widget = widget;
			this.copy = copy;
			this.input = input;
			lifetime.add(widget.onDidChangeMode(() => this.updateTitleArea()));
			this.updateReadOnly();
		} catch (error) { lifetime.dispose(); reference.dispose(); throw error; }
	}

	get workingCopy(): EditorWorkingCopy | undefined { return this.copy; }
	get isDirty(): boolean { return this.copy?.isDirty ?? false; }
	get hasExternalChange(): boolean { return this.copy?.hasExternalChange ?? false; }
	get isReadonly(): boolean { return this.readOnly; }
	setMode(mode: ArkdownEditorMode): void { this.widget?.setMode(mode); }
	private getMode(): ArkdownEditorMode { return this.widget?.getMode() ?? 'rich'; }
	override getControl(): ArkdownEditor | undefined { return this.widget; }
	override focus(): void { this.widget?.focus(); }
	override layout(dimension: IDimension): void { this.widget?.layout({ width: this.root.clientWidth || dimension.width, height: this.root.clientHeight || dimension.height }); }
	override clearInput(): void { this.widget = undefined; this.copy = undefined; this.input = undefined; this.inputLifetime.clear(); }
	async save(options?: ISaveOptions): Promise<void> {
		try { await this.copy?.save(new AbortController().signal, options); }
		catch (error) { if (isCancellationError(error)) throw error; if (!await this.saveErrors.onSaveError(error, this.copy?.resource)) throw new CancellationError(undefined, error); }
	}
	async saveAs(resource: URI): Promise<void> { await this.copy?.saveAs(resource, new AbortController().signal); }
	containsAccessibilityFocus(target: HTMLElement): boolean { return this.getMode() === 'rich' && this.root.contains(target); }
	getAccessibleContent(): string { return this.widget?.getAccessibleText() ?? ''; }
	getAccessibilityHelp(): readonly string[] { return [localize({ bundle: 'ash.markdown', key: 'arkdownHelp' }, 'Edit the document directly. Use Control or Command+B for bold, Control or Command+I for italic, and Control or Command+Z to undo. Show Markdown source opens the code editor on the same document; Show document returns to the formatted document. <keybinding:workbench.action.files.save> saves the file. Read-only files cannot be edited.')]; }

	override getActions(): readonly IAction[] {
		const source = this.getMode() === 'markdown';
		const bold = localize({ bundle: 'ash.markdown', key: 'bold' }, 'Bold');
		const italic = localize({ bundle: 'ash.markdown', key: 'italic' }, 'Italic');
		const mode = source
			? localize({ bundle: 'ash.markdown', key: 'showDocument' }, 'Show document')
			: localize({ bundle: 'ash.markdown', key: 'showSource' }, 'Show Markdown source');
		return [
			{
				id: 'markdown.editor.bold', label: bold, tooltip: bold, icon: Lxicon.bold,
				enabled: !!this.widget && !this.readOnly, run: () => this.widget?.format('**'),
			},
			{
				id: 'markdown.editor.italic', label: italic, tooltip: italic, icon: Lxicon.italic,
				enabled: !!this.widget && !this.readOnly, run: () => this.widget?.format('_'),
			},
			{
				id: 'markdown.editor.toggleMode', label: mode, tooltip: mode,
				icon: source ? Lxicon.fileText : Lxicon.code, enabled: !!this.widget,
				run: () => this.setMode(source ? 'rich' : 'markdown'),
			},
		];
	}

	private updateReadOnly(): void {
		if (!this.input) return;
		this.readOnly = this.input.readOnly === true || !!this.filesConfiguration.isReadonly(this.input.resource);
		this.widget?.setReadOnly(this.readOnly);
		this.updateTitleArea();
	}
}
