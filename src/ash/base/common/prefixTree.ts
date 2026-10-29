interface PrefixBranch<T> {
	readonly branches: Map<string, PrefixBranch<T>>;
	entry?: { readonly value: T };
}

/** Stores values at exact segment paths, keeping adjacent text prefixes distinct. */
export class WellDefinedPrefixTree<V> {
	private readonly tree: PrefixBranch<V> = { branches: new Map() };

	public insert(key: Iterable<string>, value: V): void {
		let branch = this.tree;
		for (const segment of key) {
			let child = branch.branches.get(segment);
			if (!child) {
				child = { branches: new Map() };
				branch.branches.set(segment, child);
			}
			branch = child;
		}
		branch.entry = { value };
	}

	/** Reports whether an inserted path is an inclusive prefix of this key. */
	public hasKeyOrParent(key: Iterable<string>): boolean {
		let branch = this.tree;
		for (const segment of key) {
			const child = branch.branches.get(segment);
			if (!child) return false;
			if (child.entry) return true;
			branch = child;
		}
		return false;
	}

	/** Reports whether this path exists, including implicit parents of stored keys. */
	public hasKeyOrChildren(key: Iterable<string>): boolean {
		let branch = this.tree;
		for (const segment of key) {
			const child = branch.branches.get(segment);
			if (!child) return false;
			branch = child;
		}
		return true;
	}
}
