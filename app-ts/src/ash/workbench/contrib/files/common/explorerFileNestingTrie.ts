interface NestingRule {
	readonly parent: RegExp;
	readonly children: readonly string[];
}

export const enum ExplorerFileNestingSettingId {
	Enabled = 'explorer.fileNesting.enabled',
	Patterns = 'explorer.fileNesting.patterns',
}

function escapePattern(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function patternRegex(pattern: string, capture: boolean): RegExp {
	const parts = pattern.split('*');
	if (parts.length > 2) {
		throw new TypeError(`File nesting pattern has more than one wildcard: ${pattern}`);
	}
	return new RegExp(`^${parts.map(escapePattern).join(capture ? '(.*)' : '.*')}$`);
}

function substitute(pattern: string, values: Record<string, string>): string {
	return pattern.replace(
		/\$\{(capture|basename|dirname|extname)\}|\$\((capture|basename|dirname|extname)\)/g,
		(_, brace: string | undefined, paren: string | undefined) => values[brace ?? paren ?? ''] ?? '',
	);
}

/** Resolves configured parent and child patterns into one-level Explorer nests. */
export class ExplorerFileNestingTrie {
	private readonly rules: readonly NestingRule[];

	constructor(config: readonly (readonly [string, readonly string[]])[]) {
		this.rules = config.map(([parent, children]) => ({ parent: patternRegex(parent, true), children }));
	}

	public nest(files: string[], dirname: string): Map<string, Set<string>> {
		const candidates: { readonly parent: string; readonly child: string }[] = [];
		const fileSet = new Set(files);
		for (const rule of this.rules) {
			for (const parent of files) {
				const match = rule.parent.exec(parent);
				if (!match) {
					continue;
				}
				const dot = parent.lastIndexOf('.');
				const attributes = {
					basename: dot > 0 ? parent.slice(0, dot) : parent,
					extname: dot > 0 ? parent.slice(dot + 1) : '',
					dirname,
					capture: match[1] ?? '',
				};
				for (const childPattern of rule.children) {
					const resolved = substitute(childPattern, attributes);
					let childNames: readonly string[];
					if (resolved.includes('*')) {
						const matcher = patternRegex(resolved, false);
						childNames = files.filter(file => matcher.test(file));
					} else {
						childNames = fileSet.has(resolved) ? [resolved] : [];
					}
					for (const child of childNames) {
						if (child !== parent) {
							candidates.push({ parent, child });
						}
					}
				}
			}
		}

		const parentOf = new Map<string, string>();
		for (const { parent, child } of candidates) {
			if (parentOf.has(child)) {
				continue;
			}
			let ancestor: string | undefined = parent;
			while (ancestor && ancestor !== child) {
				ancestor = parentOf.get(ancestor);
			}
			if (ancestor !== child) {
				parentOf.set(child, parent);
			}
		}

		const result = new Map<string, Set<string>>();
		for (const file of files) {
			let root = file;
			while (parentOf.has(root)) {
				root = parentOf.get(root)!;
			}
			let children = result.get(root);
			if (!children) {
				result.set(root, children = new Set());
			}
			if (file !== root) {
				children.add(file);
			}
		}
		return result;
	}
}
