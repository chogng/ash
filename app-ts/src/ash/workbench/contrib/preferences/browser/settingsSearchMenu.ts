import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { lxiconsLibrary } from '../../../../base/common/lxiconsLibrary.js';

export interface SettingsSearchMenuOptions {
	readonly getValue: () => string;
	readonly setValue: (value: string) => void;
	readonly focus: () => void;
	readonly contextMenuProvider: IContextMenuProvider;
}

/** Owns filter actions for the Settings search input. */
export class SettingsSearchMenu extends Disposable {
	public readonly domNode: HTMLButtonElement;
	private readonly button: Button;

	constructor(container: HTMLElement, private readonly options: SettingsSearchMenuOptions) {
		super();
		this.button = this._register(new Button(container, {
			label: '',
			icon: lxiconsLibrary.filter,
			ariaLabel: 'Filter Settings',
			title: 'Filter Settings',
			onClick: () => this.show(),
		}));
		this.domNode = this.button.domNode;
		this.button.toggleClassName('ash-settings-search-filter', true);
		this.domNode.setAttribute('aria-haspopup', 'menu');
		this.domNode.setAttribute('aria-expanded', 'false');
	}

	private show(): void {
		if (this.domNode.classList.contains('is-open')) return;
		const tokens = this.options.getValue().trim().split(/\s+/u).filter(Boolean);
		const hasModified = tokens.some(token => token.toLocaleLowerCase() === '@modified');
		const hasFilters = tokens.some(token => token.startsWith('@'));
		const actions: readonly IAction[] = [
			{
				id: 'settings.search.modified',
				label: 'Modified',
				tooltip: 'Show settings changed from their defaults',
				enabled: true,
				checked: hasModified,
				run: () => this.updateTokens(hasModified
					? tokens.filter(token => token.toLocaleLowerCase() !== '@modified')
					: [...tokens, '@modified']),
			},
			{
				id: 'settings.search.id',
				label: 'Setting ID…',
				tooltip: 'Filter by setting identifier',
				enabled: true,
				run: () => this.updateTokens([...tokens.filter(token => !token.toLocaleLowerCase().startsWith('@id:')), '@id:']),
			},
			new Separator(),
			{
				id: 'settings.search.clearFilters',
				label: 'Clear Filters',
				tooltip: 'Remove Settings search filters',
				enabled: hasFilters,
				run: () => this.updateTokens(tokens.filter(token => !token.startsWith('@'))),
			},
		];
		this.setOpen(true);
		try {
			this.options.contextMenuProvider.showContextMenu({
				getAnchor: () => this.domNode,
				getActions: () => actions,
				onHide: () => this.setOpen(false),
			});
		} catch (error) {
			this.setOpen(false);
			throw error;
		}
	}

	private updateTokens(tokens: readonly string[]): void {
		this.options.setValue(tokens.join(' ').trim());
		this.options.focus();
	}

	private setOpen(open: boolean): void {
		this.domNode.classList.toggle('is-open', open);
		this.domNode.setAttribute('aria-expanded', String(open));
	}
}
