let messages: Readonly<Record<string, string>> = {};
export function setMessages(value: Readonly<Record<string, string>>): void {
	messages = value;
}
export function localize(key: string, english: string, ...args: (string | number)[]): string {
	return (messages[english] ?? messages[key] ?? english).replace(/\{(\d+)\}/g, (match, index) =>
		index < args.length ? String(args[index]) : match,
	);
}
