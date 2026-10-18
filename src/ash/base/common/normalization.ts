/** Canonical composition for Unicode text; compatibility characters retain their identity. */
export function normalizeNFC(str: string): string {
	return str.normalize('NFC');
}
