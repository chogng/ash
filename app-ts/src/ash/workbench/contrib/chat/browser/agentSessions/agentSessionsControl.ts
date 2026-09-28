import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IAgentSessionsModel } from './agentSessionsModel.js';
import { AgentSessionsViewer } from './agentSessionsViewer.js';

/** Search and navigation for the Chat view's Agent Sessions sidebar. */
export class AgentSessionsControl extends Disposable {
	readonly domNode: HTMLElement;
	private readonly searchInput: HTMLInputElement;
	private readonly emptyDomNode: HTMLParagraphElement;
	private readonly viewer: AgentSessionsViewer;

	constructor(container: HTMLElement, private readonly model: IAgentSessionsModel) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-agent-sessions-control';
		this.searchInput = h(document, 'input');
		this.searchInput.type = 'search';
		this.searchInput.className = 'ash-agent-sessions-search';
		this.searchInput.placeholder = localize('sessions.list.search', 'Search sessions');
		this.searchInput.setAttribute('aria-label', this.searchInput.placeholder);
		this.domNode.append(this.searchInput);
		this.viewer = this._register(new AgentSessionsViewer(this.domNode));
		this.emptyDomNode = h(document, 'p');
		this.emptyDomNode.className = 'ash-agent-sessions-empty';
		this.domNode.append(this.emptyDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.searchInput, 'input', () => this.update()));
		this._register(addDisposableListener(this.searchInput, 'keydown', event => {
			if (event.key === 'ArrowDown' && this.viewer.focusFirst()) event.preventDefault();
		}));
		this._register(this.model.onDidChange(() => this.update()));
		this.update();
	}

	focus(): void {
		if (!this.viewer.focusSelected()) this.searchInput.focus();
	}

	private update(): void {
		const query = this.searchInput.value.trim().toLocaleLowerCase();
		const items = this.model.items.filter(item => !query || item.title.toLocaleLowerCase().includes(query) || item.description.toLocaleLowerCase().includes(query));
		this.emptyDomNode.hidden = this.viewer.update(items) > 0;
		this.emptyDomNode.textContent = query
			? localize('sessions.list.noResults', 'No matching sessions')
			: this.model.state === 'loading'
				? localize('chat.sessions.loading', 'Loading sessions…')
				: this.model.error ?? localize('chat.sessions.empty', 'Start a chat to begin.');
	}
}
