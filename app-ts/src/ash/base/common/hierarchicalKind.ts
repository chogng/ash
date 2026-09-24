export class HierarchicalKind {
	static readonly sep = '.';
	static readonly separator = HierarchicalKind.sep;
	static readonly None = new HierarchicalKind('@@none@@');
	static readonly Empty = new HierarchicalKind('');

	constructor(readonly value: string) {}

	equals(other: HierarchicalKind): boolean { return this.value === other.value; }
	contains(other: HierarchicalKind): boolean {
		return this.equals(other) || this.value === '' || other.value.startsWith(`${this.value}${HierarchicalKind.sep}`);
	}
	intersects(other: HierarchicalKind): boolean { return this.contains(other) || other.contains(this); }
	append(...parts: string[]): HierarchicalKind {
		return new HierarchicalKind([...(this.value ? [this.value] : []), ...parts].join(HierarchicalKind.sep));
	}
}
