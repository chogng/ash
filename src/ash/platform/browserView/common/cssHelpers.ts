/** CDP's declaration data, kept environment-independent for page observations. */
export interface ICSSStyle {
	cssText?: string;
	cssProperties: Array<{ name: string; value: string; disabled?: boolean; }>;
}

interface RuleMatch {
	rule: { selectorList: { selectors: Array<{ text: string; }>; }; origin: string; style: ICSSStyle; };
}

export interface IMatchedStyles {
	inlineStyle?: ICSSStyle;
	matchedCSSRules?: RuleMatch[];
	inherited?: Array<{ inlineStyle?: ICSSStyle; matchedCSSRules: RuleMatch[]; }>;
	pseudoElements?: Array<{ pseudoType: string; matches: RuleMatch[]; }>;
}

export interface IFormattedStyles {
	rulesText: string;
	referencedVars: Set<string>;
	authorPropertyNames: Set<string>;
	userAgentPropertyNames: Set<string>;
}

export const keyComputedProperties = new Set([
	'display', 'position', 'width', 'height', 'color', 'background-color',
	'font-family', 'font-size', 'font-weight', 'line-height',
	'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
]);

const inheritedProperties = new Set([
	'color', 'cursor', 'direction', 'visibility', 'white-space', 'word-break',
	'overflow-wrap', 'letter-spacing', 'line-height', 'text-align', 'text-indent',
	'text-transform', 'word-spacing', 'writing-mode', 'quotes', 'orphans', 'widows',
]);

function isInherited(name: string): boolean {
	name = name.toLowerCase();
	return name.startsWith('--') || name === 'font' || name.startsWith('font-') || name === 'list-style' || name.startsWith('list-style-') || inheritedProperties.has(name);
}

/** Split declarations only at top-level semicolons, preserving strings and functions. */
function declarations(cssText: string): Array<{ name: string; value: string; }> {
	const result: Array<{ name: string; value: string; }> = [];
	let start = 0;
	let depth = 0;
	let quote = '';
	let comment = false;
	let colon = -1;
	for (let index = 0; index <= cssText.length; index++) {
		const char = cssText[index];
		if (comment) {
			if (char === '*' && cssText[index + 1] === '/') { comment = false; index++; }
			continue;
		}
		if (char === '\\') { index++; continue; }
		if (quote) { if (char === quote) { quote = ''; } continue; }
		if (char === '/' && cssText[index + 1] === '*') { comment = true; index++; continue; }
		if (char === '"' || char === "'") { quote = char; continue; }
		if (char === '(' || char === '[' || char === '{') { depth++; }
		if (char === ')' || char === ']' || char === '}') { depth--; }
		if (char === ':' && depth === 0 && colon < 0) { colon = index; }
		if ((char === ';' || index === cssText.length) && depth === 0) {
			if (colon >= start) {
				const name = cssText.slice(start, colon).replace(/\/\*[\s\S]*?\*\//g, '').trim();
				if (name) { result.push({ name, value: cssText.slice(colon + 1, index).trim() }); }
			}
			start = index + 1;
			colon = -1;
		}
	}
	return result;
}

export function filterInheritableDeclarations(cssText: string): string | undefined {
	const inherited = declarations(cssText).filter(({ name }) => isInherited(name));
	return inherited.length ? inherited.map(({ name, value }) => `${name}: ${value};`).join(' ') : undefined;
}

/** Only complete, unambiguous box longhands can replace a shorthand. */
export function collapseToShorthands(entries: Map<string, string>): string[] {
	const compact = new Map(entries);
	for (const family of ['margin', 'padding']) {
		const names = ['top', 'right', 'bottom', 'left'].map(side => `${family}-${side}`);
		const values = names.map(name => compact.get(name));
		if (compact.has(family) || values.some(value => !value || /\s|var\(/.test(value))) { continue; }
		const [top, right, bottom, left] = values as [string, string, string, string];
		if (values.some(value => /^(inherit|initial|unset|revert|revert-layer)$/.test(value!)) && !values.every(value => value === top)) { continue; }
		const shorthand = top === bottom && right === left ? top === right ? top : `${top} ${right}` : right === left ? `${top} ${right} ${bottom}` : values.join(' ');
		for (const name of names) { compact.delete(name); }
		compact.set(family, shorthand);
	}
	return [...compact].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, value]) => `${name}: ${value};`);
}

/** Keeps author rules distinct from computed values; it does not approximate the cascade. */
export function formatMatchedStyles(matched: IMatchedStyles): IFormattedStyles {
	const result: IFormattedStyles = { rulesText: '', referencedVars: new Set(), authorPropertyNames: new Set(), userAgentPropertyNames: new Set() };
	const blocks: string[] = [];
	const append = (selector: string, style: ICSSStyle, userAgent: boolean, inherited = false): void => {
		const properties = style.cssProperties.filter(property => !property.disabled && (!inherited || isInherited(property.name)));
		for (const { name, value } of properties) {
			(userAgent ? result.userAgentPropertyNames : result.authorPropertyNames).add(name);
		}
		if (userAgent) { return; }
		const text = style.cssText === undefined
			? collapseToShorthands(new Map(properties.map(({ name, value }) => [name, value]))).join(' ')
			: inherited ? filterInheritableDeclarations(style.cssText) : style.cssText;
		if (!text?.trim()) { return; }
		for (const variable of text.matchAll(/var\(\s*(--[\w-]+)/g)) { result.referencedVars.add(variable[1]!); }
		blocks.push(`${selector} { ${text.trim()} }`);
	};
	if (matched.inlineStyle) { append('element.style', matched.inlineStyle, false); }
	for (const { rule } of matched.matchedCSSRules ?? []) {
		append(rule.selectorList.selectors.map(selector => selector.text).join(', '), rule.style, rule.origin === 'user-agent');
	}
	for (const pseudo of matched.pseudoElements ?? []) {
		for (const { rule } of pseudo.matches) {
			append(rule.selectorList.selectors.map(selector => selector.text).join(', '), rule.style, rule.origin === 'user-agent');
		}
	}
	for (const parent of matched.inherited ?? []) {
		if (parent.inlineStyle) { append('inherited element.style', parent.inlineStyle, false, true); }
		for (const { rule } of parent.matchedCSSRules) { append(rule.selectorList.selectors.map(selector => selector.text).join(', '), rule.style, rule.origin === 'user-agent', true); }
	}
	result.rulesText = blocks.join('\n');
	return result;
}
