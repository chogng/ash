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
	get query(): string | undefined { return this.input?.value; }
	get focused(): boolean { return this.input !== undefined && this.input === getActiveElement(this.listRoot.ownerDocument); }

	matches(...fields: readonly (string | undefined)[]): boolean {
		if (!this.hasQuery) return true;
		const values = fields.map(field => field?.toLocaleLowerCase() ?? '');
		return this.words.every(word => values.some(value => value.includes(word)));
	}

	open(): void {
		if (!this.input) {
			const active = getActiveElement(this.listRoot.ownerDocument);
			this.previousFocus = isHTMLElement(active) && this.listRoot.contains(active) ? active : undefined;
		}
		const input = this.ensureInput();
		input.focus();
		input.select();
	}

	restore(query: string, focus: boolean): void {
		const input = this.ensureInput();
		if (input.value !== query) input.value = query;
		this.setQuery(query);
		if (focus) input.focus({ preventScroll: true });
	}

	private ensureInput(): HTMLInputElement {
		if (this.input) return this.input;
		const input = this.input = h(this.listRoot.ownerDocument, 'input', {
			className: 'ash-sessions-list-search',
			properties: { type: 'search' },
			attributes: { 'aria-label': localize({ bundle: 'ash.sessions', key: 'sessions.list.inlineSearch' }, 'Search sessions in the sidebar') },
		});
		this.before.before(input);
		const lifetime = this.inputLifetime.value = new DisposableStore();
		lifetime.add(toDisposable(() => input.remove()));
		lifetime.add(addDisposableListener(input, 'input', () => {
			this.setQuery(input.value);
			this.update();
		}));
		lifetime.add(addDisposableListener(input, 'keydown', event => {
			if (event.key === 'ArrowDown' || event.key === 'Enter') {
				event.preventDefault();
				this.focusResults();
			}
		}));
		return input;
	}

	private setQuery(query: string): void {
		this.words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
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
