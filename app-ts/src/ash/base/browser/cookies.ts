/** Reads and decodes one cookie value from an explicit document. */
export function getCookieValue(
	ownerDocument: Document,
	name: string,
): string | undefined {
	const prefix = `${encodeURIComponent(name)}=`;
	for (const cookie of ownerDocument.cookie.split(";")) {
		const candidate = cookie.trim();
		if (candidate.startsWith(prefix)) {
			return decodeURIComponent(candidate.slice(prefix.length));
		}
	}
	return undefined;
}
