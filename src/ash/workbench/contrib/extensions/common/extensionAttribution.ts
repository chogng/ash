import { isRecord } from '../../../../base/common/types.js';

/** Publisher identifies a package namespace and must not stand in for authorship. */
export function getExtensionAttribution(manifest: unknown): string {
	if (!isRecord(manifest)) {
		return '';
	}
	return personName(manifest.author) ?? '';
}

function personName(value: unknown): string | undefined {
	const name = isRecord(value) ? value.name : value;
	if (typeof name !== 'string' || name.length > 512) {
		return undefined;
	}
	return name.trim() || undefined;
}
