import { addDisposableListener, h } from "../../../../../base/browser/dom.js";
import { Emitter, type Event } from "../../../../../base/common/event.js";
import { Disposable, type IDisposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import type { SlashCommandCatalog } from "../../common/slashCommands.js";
import type { SkillSelectorCatalog } from '../../common/skillSelectors.js';

/** Construction inputs shared by Chat input editor implementations. */
export interface ChatInputEditorOptions {
	readonly container: HTMLElement;
	readonly placeholder: string;
	readonly ariaLabel: string;
	readonly slashCommands: SlashCommandCatalog;
	readonly skills: SkillSelectorCatalog;
}

/** Text editing contract consumed by the Chat composer. */
export interface IChatInputEditor extends IDisposable {
	readonly element: HTMLElement;
	readonly onDidChange: Event<string>;
	readonly onDidSubmit: Event<void>;
	value: string;
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

	constructor(options: ChatInputEditorOptions) {
		super();
		this.element = h(options.container.ownerDocument, "textarea");
		this.element.className = "ash-chat-textarea-input";
		this.element.rows = 3;
		this.element.placeholder = options.placeholder;
		this.element.setAttribute("aria-label", options.ariaLabel);
		options.container.append(this.element);
		this._register(addDisposableListener(this.element, "input", () => this._onDidChange.fire(this.value)));
		this._register(addDisposableListener(this.element, "keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			this._onDidSubmit.fire();
		}));
		this._register(toDisposable(() => this.element.remove()));
	}

	get value(): string {
		return this.element.value;
	}

	set value(value: string) {
		if (this.element.value === value) return;
		this.element.value = value;
		this._onDidChange.fire(value);
	}

	focus(): void {
		this.element.focus();
	}

	layout(): void {}
}

function validateProvider(provider: IChatInputEditorProvider): void {
	if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(provider.id)) {
		throw new TypeError(`Invalid Chat input editor ID: ${provider.id}`);
	}
}
