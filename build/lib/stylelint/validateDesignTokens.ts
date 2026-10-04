export interface DesignTokenSuggestion {
	readonly offset: number;
	readonly category: string;
	readonly message: string;
}

const spacingRamp = [0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 36, 40];
const radiusRamp = [2, 4, 6, 8, 12, 9999];
const fontRamp = [10, 11, 12, 13, 18, 26];

/** Advisory checks identify design decisions; they never rewrite CSS or fail a build. */
export function validateDesignTokens(contents: string): DesignTokenSuggestion[] {
	const suggestions: DesignTokenSuggestion[] = [];
	const source = contents.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, value => ' '.repeat(value.length));
	for (const match of source.matchAll(/(?:^|[;{}])\s*([\w-]+)\s*:\s*([^;{}]+)/g)) {
		const property = match[1]!.toLowerCase();
		const value = match[2]!.trim().replace(/\s*!important\s*$/i, '');
		const offset = match.index + match[0].indexOf(match[1]!);
		const add = (category: string, message: string): void => { suggestions.push({ offset, category, message }); };
		// Expressions may encode computed geometry or configuration values, rather than a design literal.
		if (/\b(?:var|calc|min|max|clamp)\(/i.test(value)) { continue; }
		const lengths = [...value.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)px(?=\s|\/|$)/g)].map(length => Number(length[1]));
		if (/^(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?$|^(?:gap|row-gap|column-gap)$/.test(property)) {
			const offRamp = lengths.filter(length => !spacingRamp.includes(length));
			if (offRamp.length > 0) {
				add('spacing', `${property}: ${value} is off the spacing ramp; review against ${spacingRamp.join(', ')}px`);
			}
		} else if (property === 'font-weight') {
			if (/^\d+$|^(?:normal|bold)$/.test(value)) {
				const weight = value === 'normal' ? 400 : value === 'bold' ? 700 : Number(value);
				const token = weight < 500 ? 'regular' : 'semiBold';
				add('weight', `${property}: ${value}; use var(--ash-fontWeight-${token}) for the intended text role`);
			}
		} else if (property === 'font-size' && lengths.length === 1) {
			const block = source.lastIndexOf('{', match.index);
			const selector = source.slice(Math.max(source.lastIndexOf('}', block - 1), source.lastIndexOf('{', block - 1)) + 1, block);
			if (/\.lxicon(?:[\s.:#\[]|$|-)/.test(selector)) {
				const token = lengths[0] === 12 ? '--ash-lxiconFontSize-compact' : '--ash-lxiconFontSize';
				add('icon', `font-size: ${value}; use var(${token}) and review the base or compact glyph`);
			} else {
				const detail = fontRamp.includes(lengths[0]!) ? 'choose a heading, body, or label role' : 'review the type ramp and choose a heading, body, or label role';
				add('font-size', `font-size: ${value}; ${detail}`);
			}
		} else if (/^border(?:-(?:top-left|top-right|bottom-left|bottom-right|start-start|start-end|end-start|end-end))?-radius$/.test(property) && lengths.some(length => length > 0)) {
			const detail = lengths.every(length => radiusRamp.includes(length)) ? 'choose a radius token by surface tier' : 'review the radius ramp and surface tier';
			add('radius', `${property}: ${value}; ${detail}; use the circle token for pills`);
		} else if (/^(?:border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?(?:-width)?|outline(?:-width)?)$/.test(property) && lengths.includes(1)) {
			add('stroke', `${property}: ${value}; use var(--ash-strokeThickness) for a standard 1px stroke`);
		}
	}
	return suggestions;
}
