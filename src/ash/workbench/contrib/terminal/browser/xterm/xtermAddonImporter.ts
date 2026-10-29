import type { SearchAddon } from '@xterm/addon-search';
import type { SerializeAddon } from '@xterm/addon-serialize';

export interface IXtermAddonNameToCtor {
	search: typeof SearchAddon;
	serialize: typeof SerializeAddon;
}

/** Shares constructor loading across screens while each screen owns its addon instance. */
export class XtermAddonImporter {
	private search: Promise<typeof SearchAddon> | undefined;
	private serialize: Promise<typeof SerializeAddon> | undefined;

	importAddon<T extends keyof IXtermAddonNameToCtor>(name: T): Promise<IXtermAddonNameToCtor[T]> {
		if (name === 'serialize') {
			this.serialize ??= import('@xterm/addon-serialize')
				.then(module => module.SerializeAddon)
				.catch(error => {
					this.serialize = undefined;
					throw error;
				});
			return this.serialize as Promise<IXtermAddonNameToCtor[T]>;
		}
		this.search ??= import('@xterm/addon-search')
			.then(module => module.SearchAddon)
			.catch(error => {
				this.search = undefined;
				throw error;
			});
		return this.search as Promise<IXtermAddonNameToCtor[T]>;
	}
}
