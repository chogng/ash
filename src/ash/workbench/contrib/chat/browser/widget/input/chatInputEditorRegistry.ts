import { addDisposableListener, h } from "../../../../../../base/browser/dom.js";
import { Emitter, type Event } from "../../../../../../base/common/event.js";
import { Disposable, type IDisposable, toDisposable } from "../../../../../../base/common/lifecycle.js";
import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import type { ITextModel } from '../../../../../../editor/common/model.js';
import type { SlashCommandCatalog } from "../../../common/slashCommands.js";
import type { SkillSelectorCatalog } from '../../../common/skillSelectors.js';
import type { ChatContextAttachment } from '../../../../../services/chat/common/chatContextService.js';

/** Construction inputs shared by Chat input editor implementations. */
export interface ChatInputEditorOptions {
	readonly container: HTMLElement;
	readonly placeholder: string;
	readonly ariaLabel: string;
	readonly slashCommands: SlashCommandCatalog;
	readonly skills: SkillSelectorCatalog;
	readonly height?: { readonly minimum: number; readonly maximum: number; };
	/** Move to the next control with Tab instead of inserting indentation. */
	readonly tabFocusMode?: boolean;
}

export interface ChatInputEditorSelection {
	readonly anchor: number;
	readonly active: number;
}

/** Text editing contract consumed by the Chat composer. */
export interface IChatInputEditor extends IDisposable {
	readonly element: HTMLElement;
	readonly onDidChange: Event<string>;
	readonly onDidSubmit: Event<void>;
	value: string;
	getSelection(): ChatInputEditorSelection;
	setSelection(selection: ChatInputEditorSelection): void;
	isAtHistoryBoundary(direction: 'previous' | 'next'): boolean;
	/** Insert recognized text at the current selection using the editor's edit lifecycle. */
	insertText(text: string): void;
	/** Rich inputs expose their own model for reference decorations and undo tracking. */
	getModel?(): ITextModel;
	/** Rich inputs render context actions in the space reserved by reference decorations. */
	renderContextReferences?(references: readonly ChatContextAttachment[], remove: (id: string) => void): void;
	focus(): void;
	layout(): void;
}

/** Product-selected implementation of the Chat text editing surface. */
export interface IChatInputEditorProvider {
	readonly id: string;
	create(options: ChatInputEditorOptions): IChatInputEditor;
}

/** Selects one optional rich Chat editor while retaining a textarea fallback. */
export class ChatInputEditorRegistry {
	private provider: IChatInputEditorProvider | undefined;

	register(provider: IChatInputEditorProvider): IDisposable {
		this.add(provider);
		return toDisposable(() => {
			if (this.provider === provider) this.provider = undefined;
		});
	}

	/** Registers a provider that intentionally lives for the module realm. */
	registerStatic(provider: IChatInputEditorProvider): void {
		this.add(provider);
	}

	create(options: ChatInputEditorOptions): IChatInputEditor {
		return this.provider?.create(options) ?? new TextareaChatInputEditor(options);
	}

	get activeProviderId(): string {
		return this.provider?.id ?? "textarea";
	}

	private add(provider: IChatInputEditorProvider): void {
		validateProvider(provider);
		if (this.provider) {
			throw new Error(`Chat input editor is already registered: ${this.provider.id}`);
		}
		this.provider = provider;
	}
}

/** Realm-scoped Chat input editor selected by the active product graph. */
export const ChatInputEditors = new ChatInputEditorRegistry();

class TextareaChatInputEditor extends Disposable implements IChatInputEditor {
	readonly element: HTMLTextAreaElement;
	private readonly _onDidChange = this._register(new Emitter<string>());
	private readonly _onDidSubmit = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	readonly onDidSubmit = this._onDidSubmit.event;
	private readonly minimumHeight: number;
	private readonly maximumHeight: number;

	constructor(options: ChatInputEditorOptions) {
		super();
		this.minimumHeight = options.height?.minimum ?? 40;
		this.maximumHeight = options.height?.maximum ?? 314;
		this.element = h(options.container.ownerDocument, "textarea");
		this.element.className = "ash-chat-textarea-input";
		this.element.rows = 2;
		this.element.style.minHeight = `${this.minimumHeight}px`;
		this.element.style.height = `${this.minimumHeight}px`;
		this.element.placeholder = options.placeholder;
		this.element.setAttribute("aria-label", options.ariaLabel);
		options.container.append(this.element);
		this._register(addDisposableListener(this.element, "input", () => {
			this.layout();
			this._onDidChange.fire(this.value);
		}));
		this._register(addDisposableListener(this.element, "keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			this._onDidSubmit.fire();
		}));
		this._register(toDisposable(() => this.element.remove()));
		const layout = this._register(new RunOnceScheduler(() => this.layout(), 0));
		const observer = new ResizeObserver(() => layout.schedule());
		this._register(toDisposable(() => observer.disconnect()));
		observer.observe(this.element);
	}

	get value(): string {
		return this.element.value;
	}

	set value(value: string) {
		if (this.element.value === value) return;
		this.element.value = value;
		this.layout();
		this._onDidChange.fire(value);
	}

	getSelection(): ChatInputEditorSelection {
		return this.element.selectionDirection === 'backward'
			? { anchor: this.element.selectionEnd, active: this.element.selectionStart }
			: { anchor: this.element.selectionStart, active: this.element.selectionEnd };
	}

	setSelection(selection: ChatInputEditorSelection): void {
		this.element.setSelectionRange(Math.min(selection.anchor, selection.active), Math.max(selection.anchor, selection.active), selection.anchor > selection.active ? 'backward' : 'forward');
	}

	isAtHistoryBoundary(direction: 'previous' | 'next'): boolean {
		if (this.element.selectionStart !== this.element.selectionEnd) return false;
		const offset = this.element.selectionStart;
		// Native textareas do not expose visual caret rows; only their exact endpoints are unambiguous when text wraps.
		return direction === 'previous' ? offset === 0 : offset === this.value.length;
	}

	focus(): void {
		this.element.focus();
	}

	public insertText(text: string): void {
		const before = this.value.slice(0, this.element.selectionStart);
		const separator = /[A-Za-z0-9]$/u.test(before) && /^[A-Za-z0-9]/u.test(text) ? ' ' : '';
		this.element.setRangeText(separator + text, this.element.selectionStart, this.element.selectionEnd, 'end');
		this.layout();
		this._onDidChange.fire(this.value);
	}

	layout(): void {
		if (this.element.clientWidth <= 0) return;
		const scrollTop = this.element.scrollTop;
		this.element.style.height = `${this.minimumHeight}px`;
		const height = Math.min(this.maximumHeight, Math.max(this.minimumHeight, this.element.scrollHeight));
		this.element.style.height = `${height}px`;
		this.element.scrollTop = scrollTop;
	}
}

function validateProvider(provider: IChatInputEditorProvider): void {
	if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(provider.id)) {
		throw new TypeError(`Invalid Chat input editor ID: ${provider.id}`);
	}
}
