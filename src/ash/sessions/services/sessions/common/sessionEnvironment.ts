/** Parses .env assignments as data, without shell evaluation or variable expansion. */
export function parseSessionEnvironment(source: string): { readonly variables: Readonly<Record<string, string>>; } | { readonly invalidLine: number; } {
	const lines = source.replace(/\r\n?/g, '\n').split('\n');
	const variables: Record<string, string> = Object.create(null);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!.trim();
		if (!line || line.startsWith('#')) continue;
		const entry = /^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/u.exec(line);
		if (!entry || line.includes('\0')) return { invalidLine: index + 1 };
		const [, name, raw = ''] = entry;
		const quote = raw[0];
		if (quote !== '"' && quote !== "'" && quote !== '`') {
			variables[name!] = raw.split('#', 1)[0]!.trimEnd();
			continue;
		}
		const start = index;
		let part = raw.slice(1);
		let value = '';
		for (; ;) {
			let closing = 0;
			for (; closing < part.length; closing++) {
				if (quote === '"' && part[closing] === '\\') { closing++; continue; }
				if (part[closing] === quote) break;
			}
			if (closing < part.length) {
				if (!/^\s*(?:#.*)?$/u.test(part.slice(closing + 1))) return { invalidLine: index + 1 };
				value += part.slice(0, closing);
				variables[name!] = quote === '"' ? value.replace(/\\([nrt"\\])/gu, (match, escaped: string) => {
					switch (escaped) {
						case 'n': return '\n';
						case 'r': return '\r';
						case 't': return '\t';
						default: return match.slice(1);
					}
				}) : value;
				break;
			}
			if (++index === lines.length || lines[index]!.includes('\0')) return { invalidLine: start + 1 };
			value += part + '\n';
			part = lines[index]!;
		}
	}
	return { variables };
}
