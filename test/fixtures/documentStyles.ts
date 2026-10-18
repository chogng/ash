/** Self-contained so Playwright can also run it in a document's own realm. */
export function captureDocumentStyles(root: Element) {
	const document = root.ownerDocument;
	const nodes = [...document.querySelectorAll('style, link[rel~="stylesheet"]')];
	const sheets = [...document.styleSheets];
	const adopted = [...(document.adoptedStyleSheets ?? [])];
	const readRules = (sheet: CSSStyleSheet): string[] => [...sheet.cssRules].flatMap(rule => {
		const imported = 'styleSheet' in rule ? (rule as CSSImportRule).styleSheet : null;
		return [rule.cssText, ...(imported ? readRules(imported) : [])];
	});
	return {
		document,
		nodes,
		markup: nodes.map(node => node.outerHTML),
		sheets,
		adopted,
		// Reading cssRules deliberately propagates SecurityError for cross-origin sheets.
		rules: [...sheets, ...adopted].map(readRules),
		rootStyle: document.documentElement.getAttribute('style'),
		bodyStyle: document.body.getAttribute('style'),
	};
}

/** Compare identities as well as content: replacing a sheet is also a side effect. */
export function compareDocumentStyles(before: ReturnType<typeof captureDocumentStyles>, after: ReturnType<typeof captureDocumentStyles>): string[] {
	const changes: string[] = [];
	const sameItems = (left: readonly unknown[], right: readonly unknown[]): boolean => left.length === right.length && left.every((item, index) => item === right[index]);
	if (before.document !== after.document) changes.push('document replaced');
	if (!sameItems(before.nodes, after.nodes)) changes.push('stylesheet nodes changed');
	if (!sameItems(before.markup, after.markup)) changes.push('stylesheet markup changed');
	if (!sameItems(before.sheets, after.sheets)) changes.push('stylesheet identities changed');
	if (!sameItems(before.adopted, after.adopted)) changes.push('adopted stylesheets changed');
	if (JSON.stringify(before.rules) !== JSON.stringify(after.rules)) changes.push('stylesheet rules changed');
	if (before.rootStyle !== after.rootStyle) changes.push('root inline style changed');
	if (before.bodyStyle !== after.bodyStyle) changes.push('body inline style changed');
	return changes;
}
