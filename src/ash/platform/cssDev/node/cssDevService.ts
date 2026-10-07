import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

export interface ICSSDevelopmentService {
	readonly _serviceBrand: undefined;
	readonly isEnabled: boolean;
	getCssModules(): Promise<string[]>;
}

interface CSSDevelopmentOptions {
	readonly sourceRoot: string;
	readonly isBuilt: boolean;
}

/** Discovers source-relative CSS modules once for a development host's lifetime. */
export class CSSDevelopmentService implements ICSSDevelopmentService {
	declare readonly _serviceBrand: undefined;
	public readonly isEnabled: boolean;
	private readonly sourceRoot: string;
	private modules: Promise<string[]> | undefined;

	constructor(options: CSSDevelopmentOptions) {
		this.sourceRoot = resolve(options.sourceRoot);
		this.isEnabled = !options.isBuilt;
	}

	public getCssModules(): Promise<string[]> {
		this.modules ??= this.isEnabled ? this.scan() : Promise.resolve([]);
		return this.modules;
	}

	private async scan(): Promise<string[]> {
		// Directory entries avoid following symlinks outside the host's source root.
		const entries = await readdir(this.sourceRoot, { recursive: true, withFileTypes: true });
		return entries.filter(entry => entry.isFile() && entry.name.endsWith('.css'))
			.map(entry => relative(this.sourceRoot, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/'))
			.sort();
	}
}
