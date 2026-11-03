/** Window-local visits and traversal. The window supplies resolution and opening for each destination. */
export class SessionsNavigation<T> {
	private entries: T[] = [];
	private index = -1;
	private navigating = false;

	constructor(
		private readonly key: (entry: T) => string | undefined,
		private readonly canOpen: (entry: T) => boolean,
		private readonly open: (entry: T) => boolean,
		private readonly onNavigate: () => void,
	) { }

	get canGoBack(): boolean { return this.find(-1) !== undefined; }
	get canGoForward(): boolean { return this.find(1) !== undefined; }

	recordOpened(entry: T): void {
		if (this.navigating) {
			return;
		}
		const key = this.key(entry);
		this.entries = this.entries.filter(candidate => this.key(candidate) !== key);
		this.entries.push(entry);
		this.index = this.entries.length - 1;
	}

	restorePreviousVisits(entries: readonly T[], current: T): boolean {
		if (this.entries.length !== 0) return false;
		const index = entries.findIndex(entry => this.key(entry) === this.key(current));
		if (index < 0) return false;
		this.entries = [...entries];
		this.entries[index] = current;
		this.index = index;
		return true;
	}

	insertBeforeInitialVisit(entry: T, matches: (entry: T) => boolean): void {
		if (this.entries.length === 1 && matches(this.entries[0]!)) {
			this.entries.unshift(entry);
			this.index++;
		}
	}

	updateEntries(update: (entry: T) => T): void {
		const current = this.entries[this.index];
		const currentKey = current === undefined ? undefined : this.key(update(current));
		const byKey = new Map<string | undefined, T>();
		for (const entry of this.entries.map(update)) {
			const key = this.key(entry);
			byKey.delete(key);
			byKey.set(key, entry);
		}
		this.entries = [...byKey.values()];
		this.index = this.entries.findIndex(entry => this.key(entry) === currentKey);
	}

	goBack(): void { this.navigate(-1); }
	goForward(): void { this.navigate(1); }

	private navigate(direction: -1 | 1): void {
		let target = this.find(direction);
		if (target === undefined) {
			return;
		}
		let origin = this.index;
		this.navigating = true;
		try {
			while (target !== undefined) {
				this.index = target;
				if (this.open(this.entries[target]!)) {
					return;
				}
				// A destination can disappear between recording the visit and reopening it.
				this.entries.splice(target, 1);
				if (target < origin) {
					origin--;
				}
				this.index = origin;
				target = this.find(direction);
			}
		} catch (error) {
			this.index = origin;
			throw error;
		} finally {
			this.navigating = false;
			this.onNavigate();
		}
	}

	private find(direction: -1 | 1): number | undefined {
		for (let index = this.index + direction; index >= 0 && index < this.entries.length; index += direction) {
			if (this.canOpen(this.entries[index]!)) {
				return index;
			}
		}
		return undefined;
	}
}
