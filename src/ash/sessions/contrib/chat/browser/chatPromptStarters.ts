import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import './media/chatPromptStarters.css';

export function getChatPromptStartersHelp(): string {
	return localize('sessions.chat.starters.help', 'In an empty Chat draft, Tab to Conversation starters and choose a category. Focus a suggestion to preview it. Press Enter or Space to put it in your draft, or Escape to return to the categories.');
}

function getCategories() {
	return [
		{
			label: localize('sessions.chat.starters.write', 'Write'), icon: Lxicon.edit,
			prompts: [
				{ label: localize('sessions.chat.starters.email', 'Draft an email'), text: localize('sessions.chat.starters.emailPrompt', 'Help me draft an email. Ask who it is for and what I want it to accomplish.') },
				{ label: localize('sessions.chat.starters.revise', 'Revise a draft'), text: localize('sessions.chat.starters.revisePrompt', 'Help me make a draft clearer. Ask me to share it and tell you who will read it.') },
			],
		},
		{
			label: localize('sessions.chat.starters.learn', 'Learn'), icon: Lxicon.book,
			prompts: [
				{ label: localize('sessions.chat.starters.explain', 'Explain a topic'), text: localize('sessions.chat.starters.explainPrompt', 'Help me understand a topic. Ask what I want to learn and use an example that matches what I already know.') },
				{ label: localize('sessions.chat.starters.practice', 'Practice a skill'), text: localize('sessions.chat.starters.practicePrompt', 'Give me a short practice exercise. Ask what skill I want to practice and give me feedback after I try.') },
			],
		},
		{
			label: localize('sessions.chat.starters.code', 'Code'), icon: Lxicon.code,
			prompts: [
				{ label: localize('sessions.chat.starters.debug', 'Debug a problem'), text: localize('sessions.chat.starters.debugPrompt', 'Help me debug a problem. Ask for the error, what I expected, and a small example that reproduces it.') },
				{ label: localize('sessions.chat.starters.review', 'Review a snippet'), text: localize('sessions.chat.starters.reviewPrompt', 'Review a code snippet for correctness and readability. Ask me to share the snippet and explain what it should do.') },
			],
		},
		{
			label: localize('sessions.chat.starters.plan', 'Plan'), icon: Lxicon.sparkle,
			prompts: [
				{ label: localize('sessions.chat.starters.breakDown', 'Break down a task'), text: localize('sessions.chat.starters.breakDownPrompt', 'Help me turn a task into a plan I can follow. Ask about the goal, the deadline, and any constraints.') },
				{ label: localize('sessions.chat.starters.compare', 'Compare options'), text: localize('sessions.chat.starters.comparePrompt', 'Help me compare options for a decision. Ask what I am choosing between and which tradeoffs matter most.') },
			],
		},
	];
}

/** Composes the Chat welcome suggestions with the existing editor and draft. */
export class ChatPromptStarters extends Disposable {
	private readonly panel = this._register(new DisposableStore());
	private readonly element: HTMLElement;
	private readonly categories: HTMLElement;
	private draftId: string | undefined;
	private activeCategory: Button | undefined;

	constructor(container: HTMLElement, private readonly input: ChatInputPart) {
		super();
		const document = container.ownerDocument;
		this.element = h(document, 'div', { className: 'ash-chat-prompt-starters', properties: { hidden: true } });
		this.categories = h(document, 'div', { className: 'ash-chat-prompt-starter-categories' });
		this.categories.setAttribute('role', 'group');
		this.categories.setAttribute('aria-label', localize('sessions.chat.starters.label', 'Conversation starters'));
		this.element.append(this.categories);
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		for (const category of getCategories()) {
			const button = this._register(new Button(this.categories, {
				...defaultButtonStyles, label: category.label, icon: category.icon, presentation: 'secondary', size: 'small',
				onClick: () => this.openCategory(category, button),
			}));
			button.domNode.setAttribute('aria-expanded', 'false');
		}
		const editor = input.inputEditor;
		if (editor) this._register(editor.onDidChangeModelContent(() => this.updateVisibility()));
	}

	setDraft(draftId: string | undefined): void {
		if (draftId !== this.draftId) this.closeCategory();
		this.draftId = draftId;
		this.updateVisibility();
	}

	private updateVisibility(): void {
		this.element.hidden = !this.draftId || !!this.input.inputEditor?.getModel()?.getValueLength();
		if (this.element.hidden) this.closeCategory();
	}

	private openCategory(category: ReturnType<typeof getCategories>[number], trigger: Button): void {
		this.activeCategory = trigger;
		trigger.domNode.setAttribute('aria-expanded', 'true');
		this.categories.hidden = true;
		const document = this.element.ownerDocument;
		const panel = h(document, 'div', { className: 'ash-chat-prompt-starter-panel' });
		panel.setAttribute('role', 'group');
		panel.setAttribute('aria-label', category.label);
		const heading = h(document, 'div', { className: 'ash-chat-prompt-starter-heading' });
		heading.textContent = category.label;
		panel.append(heading);
		this.element.append(panel);
		this.panel.add(toDisposable(() => panel.remove()));
		this.panel.add(new Button(heading, {
			...defaultButtonStyles, label: localize('sessions.chat.starters.close', 'Close conversation starters'),
			icon: Lxicon.close, iconOnly: true, size: 'small', onClick: () => this.closeCategory(true),
		}));
		this.panel.add(addDisposableListener(panel, 'keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.closeCategory(true);
			}
		}));
		const editor = this.input.inputEditor;
		const placeholder = editor?.getOption(EditorOption.placeholder) ?? '';
		const preview = (text: string) => editor?.updateOptions({ placeholder: text });
		this.panel.add(toDisposable(() => preview(placeholder)));
		let firstPrompt: Button | undefined;
		for (const prompt of category.prompts) {
			const button = this.panel.add(new Button(panel, {
				...defaultButtonStyles, label: prompt.label, title: prompt.label,
				onClick: () => {
					this.closeCategory();
					this.input.appendToDraft(prompt.text);
					this.input.focus();
				},
			}));
			button.domNode.setAttribute('aria-description', prompt.text);
			this.panel.add(addDisposableListener(button.domNode, 'mouseenter', () => preview(prompt.text)));
			this.panel.add(addDisposableListener(button.domNode, 'mouseleave', () => {
				if (document.activeElement !== button.domNode) preview(placeholder);
			}));
			this.panel.add(addDisposableListener(button.domNode, 'focus', () => preview(prompt.text)));
			this.panel.add(addDisposableListener(button.domNode, 'blur', () => preview(placeholder)));
			firstPrompt ??= button;
		}
		firstPrompt?.domNode.focus();
	}

	private closeCategory(restoreFocus = false): void {
		const trigger = this.activeCategory;
		if (!trigger) return;
		this.activeCategory = undefined;
		this.panel.clear();
		this.categories.hidden = false;
		trigger.domNode.setAttribute('aria-expanded', 'false');
		if (restoreFocus) trigger.domNode.focus();
	}
}
