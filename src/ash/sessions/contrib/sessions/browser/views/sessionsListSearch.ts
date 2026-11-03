import { addDisposableListener, getActiveElement, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';

export class SessionsListSearch extends Disposable {
	private readonly inputLifetime = this._register(new MutableDisposable<DisposableStore>());
	private input: HTMLInputElement | undefined;
	private previousFocus: HTMLElement | undefined;
	private words: readonly string[] = [];

	constructor(private readonly listRoot: HTMLElement, private readonly before: HTMLElement, private readonly update: () => void, private readonly focusResults: () => void) {
		super();
		this._register(addDisposableListener(listRoot, 'keydown', event => {
			if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				event.stopPropagation();
				this.open();
			} else if (event.key === 'Escape' && this.input) {
				event.preventDefault();
				event.stopPropagation();
				this.close();
			}
		}));
	}

	get hasQuery(): boolean { return this.words.length > 0; }

	matches(...fields: readonly (string | undefined)[]): boolean {
		if (!this.hasQuery) return true;
		const values = fields.map(field => field?.toLocaleLowerCase() ?? '');
		return this.words.every(word => values.some(value => value.includes(word)));
	}

	open(): void {
		if (!this.input) {
			const document = this.listRoot.ownerDocument;
			const active = getActiveElement(document);
			this.previousFocus = isHTMLElement(active) && this.listRoot.contains(active) ? active : undefined;
			const input = this.input = h(document, 'input', {
				className: 'ash-sessions-list-search',
				properties: { type: 'search' },
				attributes: { 'aria-label': localize({ bundle: 'ash.sessions', key: 'sessions.list.inlineSearch' }, 'Search sessions in the sidebar') },
			});
			this.before.before(input);
			const lifetime = this.inputLifetime.value = new DisposableStore();
			lifetime.add(toDisposable(() => input.remove()));
			lifetime.add(addDisposableListener(input, 'input', () => {
				this.words = input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
				this.update();
			}));
			lifetime.add(addDisposableListener(input, 'keydown', event => {
				if (event.key === 'ArrowDown' || event.key === 'Enter') {
					event.preventDefault();
					this.focusResults();
				}
			}));
		}
		this.input.focus();
		this.input.select();
	}

	private close(): void {
		this.inputLifetime.clear();
		this.input = undefined;
		this.words = [];
		this.update();
		if (this.previousFocus?.isConnected && !this.previousFocus.closest('[hidden]')) this.previousFocus.focus();
		else this.listRoot.focus();
		this.previousFocus = undefined;
	}
}
