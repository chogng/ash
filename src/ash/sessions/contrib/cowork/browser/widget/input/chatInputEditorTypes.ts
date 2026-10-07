import type { Event } from '../../../../../../base/common/event.js';
import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import type { SlashCommandCatalog } from '../../../common/slashCommands.js';
import type { SkillSelectorCatalog } from '../../../../../../workbench/contrib/chat/common/skillSelectors.js';

/** Construction inputs shared by Chat input editor implementations. */
export interface ChatInputEditorOptions {
	readonly container: HTMLElement;
	readonly placeholder: string;
	readonly ariaLabel: string;
	readonly slashCommands: SlashCommandCatalog;
	readonly skills: SkillSelectorCatalog;
	readonly height?: { readonly minimum: number; readonly maximum: number; };
}

/** Text editing contract consumed by the Chat composer. */
export interface IChatInputEditor extends IDisposable {
	readonly element: HTMLElement;
	readonly onDidChange: Event<string>;
	readonly onDidSubmit: Event<void>;
	value: string;
	/** Insert recognized text at the current selection using the editor's edit lifecycle. */
	insertText(text: string): void;
	focus(): void;
	layout(): void;
}

/** Product-selected implementation of the Chat text editing surface. */
export interface IChatInputEditorProvider {
	readonly id: string;
	create(options: ChatInputEditorOptions): IChatInputEditor;
}

