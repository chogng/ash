export interface Matcher<T> { (input: T): number; }
export interface MatcherWithPriority<T> {
	readonly matcher: Matcher<T>;
	readonly priority: -1 | 0 | 1;
}

/** Compiles scope expressions; negative scores mean the expression does not match. */
export function createMatchers<T>(selector: string, matchesName: (names: string[], input: T) => number, results: MatcherWithPriority<T>[]): void {
	const tokens = selector.match(/[LR]:|[\w.*][\w.*:-]*|[-(),|]/gu) ?? [];
	if (tokens.join('') !== selector.replace(/\s/gu, '')) { throw new TypeError('Invalid scope selector'); }
	let index = 0;
	const expression = (allowComma = false): Matcher<T> => {
		const alternatives: Matcher<T>[] = [conjunction()];
		while (tokens[index] === '|' || allowComma && tokens[index] === ',') {
			index++;
			alternatives.push(conjunction());
		}
		return input => Math.max(...alternatives.map(match => match(input)));
	};
	const conjunction = (): Matcher<T> => {
		const terms: Matcher<T>[] = [];
		while (index < tokens.length && ![')', '|', ','].includes(tokens[index]!)) {
			const token = tokens[index++]!;
			if (token === '-') {
				const excluded = operand();
				terms.push(input => excluded(input) >= 0 ? -1 : 0);
			} else if (token === '(') {
				terms.push(expression(true));
				if (tokens[index++] !== ')') { throw new TypeError(`Invalid scope selector: ${selector}`); }
			} else {
				const names = [token];
				while (index < tokens.length && !['-', '(', ')', '|', ','].includes(tokens[index]!)) { names.push(tokens[index++]!); }
				terms.push(input => matchesName(names, input));
			}
		}
		if (terms.length === 0) { throw new TypeError(`Invalid scope selector: ${selector}`); }
		return input => {
			let score = 0;
			for (const match of terms) {
				const value = match(input);
				if (value < 0) { return -1; }
				score = Math.max(score, value);
			}
			return score;
		};
	};
	const operand = (): Matcher<T> => {
		if (tokens[index] === '(') {
			index++;
			const match = expression(true);
			if (tokens[index++] !== ')') { throw new TypeError(`Invalid scope selector: ${selector}`); }
			return match;
		}
		const name = tokens[index++];
		if (!name || ['-', ')', '|', ','].includes(name)) { throw new TypeError(`Invalid scope selector: ${selector}`); }
		return input => matchesName([name], input);
	};
	while (index < tokens.length) {
		const priority = tokens[index] === 'R:' ? 1 : tokens[index] === 'L:' ? -1 : 0;
		if (priority !== 0) { index++; }
		const matcher = expression();
		results.push({ matcher, priority });
		if (index < tokens.length && tokens[index++] !== ',') { throw new TypeError('Invalid scope selector'); }
	}
}
