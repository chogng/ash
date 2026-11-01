export interface ILink {
	readonly label: string;
	readonly href: string;
	readonly title?: string;
}

export type LinkedTextNode = string | ILink;

/** Plain text and explicit links, without interpreting the rest of Markdown. */
export class LinkedText {
	constructor(readonly nodes: LinkedTextNode[]) { }
	toString(): string { return this.nodes.map(node => typeof node === 'string' ? node : node.label).join(''); }
}

export function parseLinkedText(text: string): LinkedText {
	const nodes: LinkedTextNode[] = [];
	const links = /\[([^\]\n]+)\]\(((?:https?:|command:)[^\s)]+)(?:\s+(["'])(.*?)\3)?\)/gu;
	let cursor = 0;
	for (const match of text.matchAll(links)) {
		if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
		const link: ILink = match[3] ? { label: match[1], href: match[2], title: match[4] } : { label: match[1], href: match[2] };
		nodes.push(link);
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) nodes.push(text.slice(cursor));
	return new LinkedText(nodes);
}
