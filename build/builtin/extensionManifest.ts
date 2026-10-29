/** Preserve author-declared UI metadata without inferring it from an extension's technical type. */
export function readExtensionUiTargets(value: unknown): readonly ('ide' | 'agents')[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || !value.length || value.length > 2 || new Set(value).size !== value.length || value.some(target => target !== 'ide' && target !== 'agents')) {
		throw new TypeError('ashUiTargets must contain ide, agents, or both without duplicates');
	}
	return value;
}
