/** Case-insensitive extension identity with the original spelling retained for display. */
export class ExtensionIdentifier {
	public readonly _lower: string;

	constructor(public readonly value: string) {
		this._lower = value.toLowerCase();
	}

	public static toKey(id: ExtensionIdentifier | string): string {
		return typeof id === 'string' ? id.toLowerCase() : id._lower;
	}

	public static equals(a: ExtensionIdentifier | string | null | undefined, b: ExtensionIdentifier | string | null | undefined): boolean {
		if (a == null || b == null) {
			return a == null && b == null;
		}
		return ExtensionIdentifier.toKey(a) === ExtensionIdentifier.toKey(b);
	}
}
