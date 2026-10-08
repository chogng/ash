import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';

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
			icon: Lxicon.filter,
			ariaLabel: localize({ bundle: 'ash.settings', key: 'search.filter' }, 'Filter Settings'),
			title: localize({ bundle: 'ash.settings', key: 'search.filter' }, 'Filter Settings'),
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
		const hasFilters = tokens.some(token => token.startsWith('@'));
		const actions: readonly IAction[] = [
			{
				id: 'settings.search.modified',
				label: localize({ bundle: 'ash.settings', key: 'search.modified' }, 'Modified'),
				tooltip: localize({ bundle: 'ash.settings', key: 'search.modifiedTooltip' }, 'Show settings configured in local user settings'),
				enabled: true,
				run: () => this.updateTokens([...tokens.filter(token => token.toLocaleLowerCase() !== '@modified'), '@modified']),
			},
			{
				id: 'settings.search.id',
				label: localize({ bundle: 'ash.settings', key: 'search.id' }, 'Setting ID…'),
				tooltip: localize({ bundle: 'ash.settings', key: 'search.idTooltip' }, 'Filter by setting identifier'),
				enabled: true,
				run: () => this.updateTokens([...tokens.filter(token => !token.toLocaleLowerCase().startsWith('@id:')), '@id:']),
			},
			new Separator(),
			{
				id: 'settings.search.clearFilters',
				label: localize({ bundle: 'ash.settings', key: 'search.clear' }, 'Clear Filters'),
				tooltip: localize({ bundle: 'ash.settings', key: 'search.clearTooltip' }, 'Remove Settings search filters'),
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
