import './media/codeBlockPart.css';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { addDisposableListener, getWindow, h, stopEvent } from '../../../../../../base/browser/dom.js';
import type { ActionViewItemOptions } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getWindowId } from '../../../../../../base/browser/window.js';
import { status } from '../../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { getHoverDelegate } from '../../../../../../base/browser/ui/hover/hoverDelegate.js';
import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import { CancellationError, isCancellationError } from '../../../../../../base/common/errors.js';
import { Event } from '../../../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import type { URI } from '../../../../../../base/common/uri.js';
import { CodeEditorWidget } from '../../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { getChatResultEditorOptions } from '../chatOptions.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../../editor/common/model/textModel.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../../../editor/common/languages/modesRegistry.js';
import { ITreeSitterLibraryService } from '../../../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { localize } from '../../../../../../nls.js';
import { IActionViewItemService } from '../../../../../../platform/actions/browser/actionViewItemService.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { WorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { createTreeSitterSyntaxSession } from '../../../../../services/treeSitter/browser/treeSitterLibraryService.js';
import { CodeEditorConfiguration } from '../../../../codeEditor/common/editorConfiguration.js';
import { CopyCodeBlockActionId } from '../../actions/chatCodeblockActions.js';
import { ChatEditorConfiguration } from '../../../common/constants.js';

export interface ICodeBlockActionContext {
	readonly code: string;
	readonly languageId?: string;
	readonly codeBlockIndex: number;
	readonly element: unknown;
	readonly chatSessionResource: URI | undefined;
}

export interface ICodeBlockRenderOptions {
	readonly maxHeightInLines?: number;
}

export interface ICodeBlockData {
	readonly text: string;
	readonly languageId: string;
	readonly codeBlockIndex: number;
	readonly element: unknown;
	readonly chatSessionResource: URI | undefined;
	readonly renderOptions?: ICodeBlockRenderOptions;
	/** Resolve the owning row at invocation, after a streaming reply may have completed. */
	readonly getActionContext?: () => Pick<ICodeBlockActionContext, 'element' | 'chatSessionResource'>;
}

type CodeBlockAction = Pick<IAction, 'id' | 'label' | 'icon'> & { readonly announcement?: string; };

/** Owns a read-only Stanza document; actions operate on its source text, never rendered markup. */
export class CodeBlockPart extends Disposable {
	public readonly element: HTMLElement;
	private readonly documentModel = this._register(new MutableDisposable<TextModel>());
	private readonly editorContainer: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly language: HTMLElement;
	private readonly pendingActions = new Set<string>();
	private data: ICodeBlockData | undefined;
	private languageId = PLAINTEXT_LANGUAGE_ID;
	private readonly relayout: RunOnceScheduler;
	private editor: CodeEditorWidget | undefined;
	private layoutWidth: number | undefined;
	private visible = true;
	private measuredHeight = false;
	private viewState: ReturnType<CodeEditorWidget['saveViewState']> | undefined;

	constructor(
		document: Document,
		private readonly presentation: 'card' | undefined,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@ILanguageService private readonly languages: ILanguageService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IActionViewItemService private readonly actionViewItems: IActionViewItemService,
		@ITreeSitterLibraryService private readonly syntax: ITreeSitterLibraryService,
		@IThemeService private readonly themes: IThemeService,
	) {
		super();
		this.element = h(document, 'div');
		this.element.className = 'ash-chat-code-block';
		const header = h(document, 'div', { className: 'ash-chat-code-block-toolbar' });
		const toolbarLabel = localize('chat.code.actions', 'Code block actions');
		this.language = h(document, 'span');
		this.language.className = 'ash-chat-code-block-language';
		const copied = localize('chat.code.copied', 'Code copied.');
		const copy: CodeBlockAction = {
			id: CopyCodeBlockActionId,
			label: localize('chat.code.copy', 'Copy'),
			icon: Lxicon.copy,
			announcement: copied,
		};
		const apply: CodeBlockAction = { id: 'workbench.action.chat.applyInEditor', label: localize('chat.code.apply', 'Apply to editor') };
		const edits: CodeBlockAction[] = [
			apply,
			{ id: 'workbench.action.chat.insertCodeBlock', label: localize('chat.code.insert', 'Insert at cursor') },
			{ id: 'workbench.action.chat.insertIntoNewFile', label: localize('chat.code.newFile', 'Open in new file') },
		];
		if (presentation === 'card') {
			this.element.classList.add('ash-chat-code-block-card');
			appendIcon(Lxicon.code, header);
			header.append(this.language);
			this._register(getHoverDelegate().setupDelayedHover(this.language, () => ({
				content: this.language.textContent ?? '',
			})));
			const toolbar = this._register(new WorkbenchToolBar(header, contextMenus, {
				ariaLabel: toolbarLabel,
				tabNavigation: 'each-action',
				moreActionsPlacement: { beforeActionId: copy.id },
				actionViewItemProvider: (entry, options) => entry.id === copy.id ? this.createCopyView(entry, options, header) : undefined,
			}));
			const canApply = () => {
				const data = this.data;
				return !!(data?.getActionContext?.().chatSessionResource ?? data?.chatSessionResource);
			};
			const action = (entry: CodeBlockAction): IAction => ({
				...entry,
				get enabled() { return entry !== apply || canApply(); },
				get tooltip() {
					return this.enabled ? entry.label : localize('chat.code.applyUnavailable', 'Available on completed replies that support applying code.');
				},
				run: () => this.runAction(entry),
			});
			toolbar.setActions([action(copy)], edits.map(action));
			this.toolbar = toolbar.element;
		} else {
			this.toolbar = header;
			header.setAttribute('role', 'toolbar');
			header.setAttribute('aria-label', toolbarLabel);
			header.append(this.language);
			this.createInlineActions(header, [copy, ...edits]);
		}
		this.editorContainer = h(document, 'div', { className: 'ash-chat-code-block-editor' });
		this.element.append(header, this.editorContainer);
		this.relayout = this._register(new RunOnceScheduler(() => this.layout(), 0));
		this._register(this.languages.onDidChange(() => {
			if (this.data) this.updateLanguage(this.data.languageId);
		}));
		this._register(toDisposable(() => this.element.remove()));
	}

	private createCopyView(action: IAction, options: ActionViewItemOptions, host: HTMLElement) {
		const factory = this.actionViewItems.lookUp(MenuId.ChatCodeBlockToolbar, action.id);
		return factory?.({
			...action,
			run: () => {
				if (!this.data) throw new CancellationError();
				return this.executeAction(action.id, this.data);
			},
		}, options, this.instantiationService, getWindowId(getWindow(host)) ?? 0);
	}

	private createInlineActions(toolbar: HTMLElement, actions: readonly CodeBlockAction[]): void {
		const buttons = actions.map(action => {
			if (action.id === CopyCodeBlockActionId) {
				const view = this.createCopyView({ ...action, tooltip: action.label, enabled: true, run: () => this.runAction(action) },
					{ buttonStyles: defaultButtonStyles, iconOnly: false }, toolbar);
				if (view) {
					const host = h(toolbar.ownerDocument, 'span');
					toolbar.append(host);
					this._register(view).render(host);
					return { element: host, focus: () => view.focus() };
				}
			}
			const button = this._register(new Button(toolbar, { ...defaultButtonStyles, label: action.label, size: 'small' }));
			this._register(button.onDidClick(() => { void this.runAction(action, button.domNode); }));
			return { element: button.domNode, focus: () => button.focus() };
		});
		this._register(addDisposableListener(toolbar, 'keydown', event => {
			const current = buttons.findIndex(button => button.element.contains(toolbar.ownerDocument.activeElement));
			if (current < 0) return;
			const next = event.key === 'ArrowRight' ? (current + 1) % buttons.length
				: event.key === 'ArrowLeft' ? (current + buttons.length - 1) % buttons.length
					: event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined;
			if (next === undefined) return;
			stopEvent(event);
			buttons[next]?.focus();
		}));
	}

	private executeAction(id: string, data: ICodeBlockData): Promise<unknown> {
		const context: ICodeBlockActionContext = {
			code: data.text,
			languageId: this.documentModel.value?.getLanguageId(),
			codeBlockIndex: data.codeBlockIndex,
			element: data.element,
			chatSessionResource: data.chatSessionResource,
			...data.getActionContext?.(),
		};
		return this.commands.executeCommand(id, context);
	}

	private reportActionError(error: unknown): void {
		if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(localize('chat.code.failed', 'Could not perform the code block action: {0}', String(error)));
	}

	private async runAction(action: CodeBlockAction, trigger?: HTMLElement): Promise<void> {
		const data = this.data;
		if (!data || this.pendingActions.has(action.id)) return;
		this.pendingActions.add(action.id);
		trigger?.setAttribute('aria-busy', 'true');
		try {
			await this.executeAction(action.id, data);
			if (!this.isDisposed && action.announcement) status(action.announcement);
		} catch (error) {
			this.reportActionError(error);
		} finally {
			this.pendingActions.delete(action.id);
			if (!this.isDisposed) trigger?.removeAttribute('aria-busy');
		}
	}

	public get model(): TextModel | undefined { return this.documentModel.value; }

	private createEditor(): CodeEditorWidget {
		// Offscreen history only needs the toolbar and reserved block height.
		const editor = this._register(this.instantiationService.createInstance(CodeEditorWidget, {
			container: this.editorContainer,
			model: null,
			readOnly: true,
			ariaLabel: localize('chat.code.content', 'Response code block'),
			presentation: 'embedded',
			// The block supplies its measured width and capped height after attaching
			// the model. Skip the interim synchronous paint at the old dimensions.
			dimension: { width: 0, height: 0 },
			glyphMargin: false,
			lineDecorationsWidth: 0,
			folding: false,
			overviewRulerLanes: 0,
			padding: { top: 8, bottom: 8, left: 8, right: 8 },
			scrollBeyondLastLine: false,
			contributions: [],
		}));
		this._register(this.configuration.onDidChangeConfiguration(event => {
			const keys = [...Object.values(ChatEditorConfiguration), ...Object.values(CodeEditorConfiguration)];
			if (keys.some(key => event.affectsConfiguration(key))) {
				this.updateOptions(editor);
				this.relayout.schedule();
			}
		}));
		this._register(editor.onDidContentSizeChange(event => {
			if (event.contentHeightChanged) this.relayout.schedule();
		}));
		const resize = new ResizeObserver(([entry]) => {
			if (this.model && Math.round(entry.contentRect.width) !== this.layoutWidth) this.relayout.schedule();
		});
		resize.observe(this.editorContainer);
		this._register(toDisposable(() => resize.disconnect()));
		return editor;
	}

	private updateLanguage(info: string): void {
		const resolved = this.languages.getRegisteredLanguageIds().includes(info) ? info : this.languages.getLanguageIdByLanguageName(info);
		this.languageId = resolved ?? PLAINTEXT_LANGUAGE_ID;
		let label = info;
		if (this.presentation === 'card') {
			const name = resolved ? this.languages.getLanguageName(resolved) : null;
			label = info ? name ?? (info.charAt(0).toUpperCase() + info.slice(1)) : localize('chat.code.plainLabel', 'Code');
		}
		if (this.language.textContent !== label) this.language.textContent = label;
		const model = this.documentModel.value;
		if (model && model.getLanguageId() !== this.languageId) model.setLanguage(this.languageId);
	}

	public render(data: ICodeBlockData, width?: number): void {
		if (this.data?.languageId !== data.languageId) this.updateLanguage(data.languageId);
		this.data = data;
		this.toolbar.setAttribute('aria-label', localize('chat.code.numberedActions', 'Code block {0} actions', data.codeBlockIndex + 1));
		if (!this.visible) {
			if (!this.measuredHeight) {
				// Reserve normal-flow geometry before the viewport admits a document.
				// Stop counting at the visible line limit, even for very large fences.
				const { font } = getChatResultEditorOptions(this.configuration);
				const maximum = data.renderOptions?.maxHeightInLines ?? 20;
				const lines = data.text.split(/\r\n|\r|\n/, maximum).length;
				this.editorContainer.style.height = `${Math.max(1, lines) * font.lineHeight + 16}px`;
			}
			return;
		}
		const editor = this.editor ??= this.createEditor();
		const model = this.documentModel.value;
		if (!model) {
			const created = new TextModel(data.text, {
				languageId: this.languageId,
				tokenization: {
					createSyntaxSession: model => createTreeSitterSyntaxSession(model, this.configuration, this.syntax, this.themes),
					onDidChangeSyntaxBackend: this.syntax.onDidChange,
					onDidChangeLanguageSupport: Event.map(this.themes.onDidColorThemeChange, () => undefined),
				},
			});
			editor.setModel(created);
			this.documentModel.value = created;
		} else {
			const previous = model.getValue();
			if (previous !== data.text) {
				const selections = editor.getSelections();
				if (model.getEOL() === '\n' && !data.text.includes('\r') && data.text.startsWith(previous)) {
					// Streamed appends keep the existing buffer and invalidate only the added text.
					// Reset corrections and other EOL inputs so the model still detects/normalizes their EOL.
					const end = model.getPositionAt(previous.length);
					model.applyEdits([{ range: Range.fromPositions(end), text: data.text.slice(previous.length) }]);
				} else { model.setValue(data.text); }
				if (selections) editor.setSelections(selections);
			}
		}
		this.updateOptions(editor);
		this.layout(width);
	}

	/** Hidden transcripts retain source and selection, without a second live editor document. */
	public get hasFocus(): boolean { return this.element.contains(this.element.ownerDocument.activeElement); }

	public focus(): void {
		if (this.isDisposed) { return; }
		this.setVisible(true);
		this.editor?.focus();
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (!visible) {
			this.viewState = this.editor?.saveViewState() ?? undefined;
			this.relayout.cancel();
			this.editor?.setModel(null);
			this.documentModel.clear();
		} else if (this.data) {
			this.render(this.data, this.editorContainer.clientWidth);
			this.editor?.restoreViewState(this.viewState ?? null);
			this.viewState = undefined;
		}
	}

	public layout(width?: number): void {
		const model = this.model;
		const editor = this.editor;
		if (this.isDisposed || !model || !editor) return;
		width ??= this.editorContainer.clientWidth;
		this.layoutWidth = width;
		const { font } = getChatResultEditorOptions(this.configuration);
		const maximum = this.data?.renderOptions?.maxHeightInLines ?? 20;
		const contentHeight = editor.getContentHeight() || model.lineCount * font.lineHeight + 16;
		const height = Math.max(font.lineHeight + 16, Math.min(contentHeight, maximum * font.lineHeight + 16));
		this.editorContainer.style.height = `${height}px`;
		this.measuredHeight = true;
		editor.layout({ width, height });
	}

	private updateOptions(editor: CodeEditorWidget): void {
		const { font, wordWrap } = getChatResultEditorOptions(this.configuration);
		editor.updateOptions({
			fontFamily: font.getMassagedFontFamily(), fontSize: font.fontSize, lineHeight: font.lineHeight,
			wordWrap,
		});
	}

}
