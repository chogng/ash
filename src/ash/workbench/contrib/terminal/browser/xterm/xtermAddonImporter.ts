import type { SearchAddon } from '@xterm/addon-search';

export interface IXtermAddonNameToCtor {
	search: typeof SearchAddon;
}

/** Shares constructor loading across screens while each screen owns its addon instance. */
export class XtermAddonImporter {
	private search: Promise<typeof SearchAddon> | undefined;

	importAddon<T extends keyof IXtermAddonNameToCtor>(_name: T): Promise<IXtermAddonNameToCtor[T]> {
		this.search ??= import('@xterm/addon-search').then(module => module.SearchAddon).catch(error => {
			this.search = undefined;
			throw error;
		});
		return this.search;
	}
}
