import './media/chatViewWelcome.css';
import { h } from '../../../../../base/browser/dom.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

export interface IChatViewWelcomeContent {
	readonly title: string;
	readonly message: string;
}

export class ChatViewWelcomePart {
	readonly element: HTMLElement;
	private readonly title: HTMLHeadingElement;
	private readonly message: HTMLParagraphElement;

	constructor(document: Document) {
		this.element = h(document, 'div', { className: 'ash-chat-welcome' });
		this.element.hidden = true;
		const icon = h(document, 'span', { attributes: { 'aria-hidden': 'true' } });
		icon.classList.add('ash-chat-welcome-icon', ...ThemeIcon.asClassNameArray(Lxicon.sparkle));
		this.title = h(document, 'h2');
		this.message = h(document, 'p');
		this.element.append(icon, this.title, this.message);
	}

	render(content: IChatViewWelcomeContent | undefined): void {
		this.element.hidden = content === undefined;
		if (content && (this.title.textContent !== content.title || this.message.textContent !== content.message)) {
			this.title.textContent = content.title;
			this.message.textContent = content.message;
		}
	}
}
