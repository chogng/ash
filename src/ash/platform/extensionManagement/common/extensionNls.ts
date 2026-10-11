/** Resolves declaration placeholders while preserving untranslated values for the owning consumer. */
export function localizeManifest<T>(manifest: T, translations: Readonly<Record<string, unknown>>): T {
	const visit = (value: unknown): unknown => {
		if (typeof value === 'string') { return value.replace(/%([^%]+)%/g, (match, key) => typeof translations[key] === 'string' ? translations[key] as string : match); }
		if (Array.isArray(value)) { return value.map(visit); }
		if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)])); }
		return value;
	};
	return visit(manifest) as T;
}
