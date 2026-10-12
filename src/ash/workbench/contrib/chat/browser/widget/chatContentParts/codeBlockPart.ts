import { addDisposableListener, h, stopEvent } from '../../../../../../base/browser/dom.js';
import { status } from '../../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../../base/common/uri.js';
import { CodeEditorWidget } from '../../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { BareFontInfo, EDITOR_FONT_DEFAULTS } from '../../../../../../editor/common/config/fontInfo.js';
import { TextModel } from '../../../../../../editor/common/model/textModel.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { CodeEditorConfiguration } from '../../../../codeEditor/common/editorConfiguration.js';
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
}

/** Owns a read-only Stanza document; actions operate on its source text, never rendered markup. */
export class CodeBlockPart extends Disposable {
	public readonly element: HTMLElement;
	public readonly editor: CodeEditorWidget;
	private readonly documentModel = this._register(new MutableDisposable<TextModel>());
	private readonly editorContainer: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly language: HTMLElement;
	private readonly buttons: Button[] = [];
	private readonly pendingActions = new Set<Button>();
	private data: ICodeBlockData | undefined;
	private readonly relayout: RunOnceScheduler;

	constructor(
		document: Document,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@ILanguageService private readonly languages: ILanguageService,
	) {
		super();
		this.element = h(document, 'div');
		this.element.className = 'ash-chat-code-block';
		this.toolbar = h(document, 'div');
		this.toolbar.className = 'ash-chat-code-block-toolbar';
		this.toolbar.setAttribute('role', 'toolbar');
		this.toolbar.setAttribute('aria-label', localize('chat.code.actions', 'Code block actions'));
		this.language = h(document, 'span');
		this.language.className = 'ash-chat-code-block-language';
		this.toolbar.append(this.language);
		for (const [command, label, announcement] of [
			['workbench.action.chat.copyCodeBlock', localize('chat.code.copy', 'Copy'), localize('chat.code.copied', 'Code copied.')],
			['workbench.action.chat.insertCodeBlock', localize('chat.code.insert', 'Insert at cursor'), undefined],
			['workbench.action.chat.insertIntoNewFile', localize('chat.code.newFile', 'Open in new file'), undefined],
		] as const) {
			const button = this._register(new Button(this.toolbar, { label, size: 'small' }));
			this.buttons.push(button);
			this._register(button.onDidClick(() => {
				const data = this.data;
				if (!data || this.pendingActions.has(button)) return;
				const context: ICodeBlockActionContext = {
					code: data.text,
					languageId: this.documentModel.value?.getLanguageId(),
					codeBlockIndex: data.codeBlockIndex,
					element: data.element,
					chatSessionResource: data.chatSessionResource,
				};
				this.pendingActions.add(button);
				button.domNode.setAttribute('aria-busy', 'true');
				void this.commands.executeCommand(command, context).then(() => {
					if (!this.isDisposed && announcement) status(announcement);
				}, error => {
					if (!this.isDisposed) this.notifications.error(localize('chat.code.failed', 'Could not perform the code block action: {0}', String(error)));
				}).finally(() => {
					this.pendingActions.delete(button);
					if (!this.isDisposed) button.domNode.removeAttribute('aria-busy');
				});
			}));
		}
		this.editorContainer = h(document, 'div');
		this._register(addDisposableListener(this.toolbar, 'keydown', event => {
			const current = this.buttons.findIndex(button => button.domNode === document.activeElement);
			if (current < 0) return;
			const next = event.key === 'ArrowRight' ? (current + 1) % this.buttons.length
				: event.key === 'ArrowLeft' ? (current + this.buttons.length - 1) % this.buttons.length
					: event.key === 'Home' ? 0 : event.key === 'End' ? this.buttons.length - 1 : undefined;
			if (next === undefined) return;
			stopEvent(event);
			this.buttons[next]?.focus();
		}));
		this.editorContainer.className = 'ash-chat-code-block-editor';
		this.element.append(this.toolbar, this.editorContainer);
		this.editor = this._register(instantiationService.createInstance(CodeEditorWidget, {
			container: this.editorContainer,
			model: null,
			readOnly: true,
			ariaLabel: localize('chat.code.content', 'Response code block'),
			presentation: 'embedded',
			glyphMargin: false,
			lineDecorationsWidth: 0,
			folding: false,
			overviewRulerLanes: 0,
			padding: { top: 8, bottom: 8, left: 8, right: 8 },
			scrollBeyondLastLine: false,
			contributions: [],
		}));
		this.relayout = this._register(new RunOnceScheduler(() => this.layout(), 0));
		this._register(this.configuration.onDidChangeConfiguration(event => {
			const keys = [...Object.values(ChatEditorConfiguration), ...Object.values(CodeEditorConfiguration)];
			if (keys.some(key => event.affectsConfiguration(key))) {
				this.updateOptions();
				this.relayout.schedule();
			}
		}));
		this._register(this.editor.onDidLayoutChange(() => this.relayout.schedule()));
		const resize = new ResizeObserver(() => this.relayout.schedule());
		resize.observe(this.editorContainer);
		this._register(toDisposable(() => resize.disconnect()));
		this._register(toDisposable(() => this.element.remove()));
	}

	public render(data: ICodeBlockData, width: number): void {
		this.data = data;
		this.language.textContent = data.languageId;
		this.toolbar.setAttribute('aria-label', localize('chat.code.numberedActions', 'Code block {0} actions', data.codeBlockIndex + 1));
		const languageId = this.languages.isRegisteredLanguageId(data.languageId) ? data.languageId
			: this.languages.getLanguageIdByLanguageName(data.languageId) ?? 'plaintext';
		if (this.documentModel.value?.getLanguageId() !== languageId) {
			const model = new TextModel(data.text, { languageId });
			this.editor.setModel(model);
			this.documentModel.value = model;
		} else if (this.documentModel.value.getValue() !== data.text) {
			this.documentModel.value.setValue(data.text);
		}
		this.updateOptions();
		this.layout(width);
	}

	public layout(width = this.editorContainer.clientWidth): void {
		if (this.isDisposed || !this.documentModel.value) return;
		const font = this.font();
		const maximum = this.data?.renderOptions?.maxHeightInLines ?? 20;
		const contentHeight = this.editor.getContentHeight() || this.documentModel.value.lineCount * font.lineHeight + 16;
		const height = Math.max(font.lineHeight + 16, Math.min(contentHeight, maximum * font.lineHeight + 16));
		this.editorContainer.style.height = `${height}px`;
		this.editor.layout({ width, height });
	}

	private updateOptions(): void {
		const font = this.font();
		this.editor.updateOptions({
			fontFamily: font.getMassagedFontFamily(), fontSize: font.fontSize, lineHeight: font.lineHeight,
			wordWrap: this.configuration.getValue<string>(ChatEditorConfiguration.wordWrap) === 'on' ? 'on' : 'off',
		});
	}

	private font(): BareFontInfo {
		const family = this.configuration.getValue<string>(ChatEditorConfiguration.fontFamily)
			|| this.configuration.getValue<string>(CodeEditorConfiguration.fontFamily) || EDITOR_FONT_DEFAULTS.fontFamily;
		const size = this.configuration.getValue<number>(ChatEditorConfiguration.fontSize)
			|| this.configuration.getValue<number>(CodeEditorConfiguration.fontSize);
		const height = this.configuration.getValue<number>(ChatEditorConfiguration.lineHeight)
			|| this.configuration.getValue<number>(CodeEditorConfiguration.lineHeight);
		return BareFontInfo._create(family, 'normal', size, 'normal', 'normal', height, 0, 1, true);
	}
}
