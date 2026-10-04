interface Selector {
	readonly text: string;
	readonly offset: number;
}

function selectors(contents: string): Selector[] {
	// Keep offsets while excluding examples and braces embedded in strings.
	const source = contents.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, value => ' '.repeat(value.length));
	return [...source.matchAll(/([^{};]+)\{/g)].filter(match => !match[1]!.trimStart().startsWith('@')).map(match => ({ text: match[1]!, offset: match.index }));
}

export function findRootAnchoredHas(contents: string): number | undefined {
	for (const selector of selectors(contents)) {
		for (const root of selector.text.matchAll(/(?:^|[\s,>+~])(?:body|html|:root|\.ash-workbench)(?![\w-])/g)) {
			let depth = 0;
			for (let index = root.index + root[0].length; index < selector.text.length; index++) {
				const character = selector.text[index]!;
				if (depth === 0 && /[\s,>+~]/.test(character)) { break; }
				if (depth === 0 && selector.text.slice(index).startsWith(':has(')) {
					return selector.offset + index;
				}
				if (character === '(') { depth++; }
				if (character === ')') { depth--; }
			}
		}
	}
	return undefined;
}

export function findClassAttributeSubstringSelector(contents: string): number | undefined {
	for (const selector of selectors(contents)) {
		const match = /\[\s*class\s*[*^$]\s*=/i.exec(selector.text);
		if (match) { return selector.offset + match.index; }
	}
	return undefined;
}

export function findWorkbenchSelector(contents: string): number | undefined {
	for (const selector of selectors(contents)) {
		const match = /\.ash-workbench(?![\w-])/.exec(selector.text);
		if (match) { return selector.offset + match.index; }
	}
	return undefined;
}
