import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, type Node } from 'yaml';

export interface YamlScalarNode {
	readonly type: 'scalar';
	readonly value: string;
	readonly rawValue: string;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly format: 'single' | 'double' | 'none' | 'literal' | 'folded';
}

export interface YamlMapNode {
	readonly type: 'map';
	readonly properties: { key: YamlScalarNode; value: YamlNode }[];
	readonly style: 'block' | 'flow';
	readonly startOffset: number;
	readonly endOffset: number;
}

export interface YamlSequenceNode {
	readonly type: 'sequence';
	readonly items: YamlNode[];
	readonly style: 'block' | 'flow';
	readonly startOffset: number;
	readonly endOffset: number;
}

export type YamlNode = YamlScalarNode | YamlMapNode | YamlSequenceNode;

export interface YamlParseError {
	readonly message: string;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly code: string;
}

export interface ParseOptions {
	readonly allowDuplicateKeys?: boolean;
}

/**
 * Parses a string-valued YAML tree with half-open UTF-16 source offsets.
 * Aliases, anchors and tags cannot be represented by this value tree. They
 * produce YAML_ALIAS/YAML_ANCHOR/YAML_TAG errors and empty scalar placeholders,
 * without resolving references or visiting the unsupported node's children.
 */
export function parse(input: string, errors: YamlParseError[] = [], options: ParseOptions = {}): YamlNode | undefined {
	const document = parseDocument(input, {
		schema: 'failsafe',
		prettyErrors: false,
		stringKeys: true,
		uniqueKeys: !options.allowDuplicateKeys,
	});
	for (const error of [...document.errors, ...document.warnings]) {
		errors.push({ code: error.code, message: error.message, startOffset: error.pos[0], endOffset: error.pos[1] });
	}
	if (!document.contents) return undefined;

	let root: YamlNode | undefined;
	const pending: (() => void)[] = [];
	const convert = (node: Node | null | undefined, accept: (value: YamlNode) => void): void => {
		const startOffset = node?.range?.[0] ?? 0;
		const endOffset = node?.range?.[1] ?? startOffset;
		const code = isAlias(node) ? 'YAML_ALIAS' : node?.tag ? 'YAML_TAG' : node && 'anchor' in node && node.anchor ? 'YAML_ANCHOR' : undefined;
		if (code) {
			errors.push({ code, message: 'YAML aliases, anchors and tags are not supported.', startOffset, endOffset });
			accept({
				type: 'scalar',
				value: '',
				rawValue: input.slice(startOffset, endOffset),
				format: 'none',
				startOffset,
				endOffset,
			});
			return;
		}
		if (isMap(node)) {
			const properties: YamlMapNode['properties'] = [];
			accept({ type: 'map', properties, style: node.flow ? 'flow' : 'block', startOffset, endOffset });
			for (let index = node.items.length - 1; index >= 0; index--) {
				const pair = node.items[index]!;
				pending.push(() =>
					convert(isNode(pair.key) ? pair.key : undefined, key => {
						if (key.type !== 'scalar') return;
						pending.push(() => convert(isNode(pair.value) ? pair.value : undefined, value => properties.push({ key, value })));
					}),
				);
			}
			return;
		}
		if (isSeq(node)) {
			const items: YamlNode[] = [];
			accept({ type: 'sequence', items, style: node.flow ? 'flow' : 'block', startOffset, endOffset });
			for (let index = node.items.length - 1; index >= 0; index--) {
				const item = node.items[index];
				pending.push(() =>
					convert(isNode(item) ? item : undefined, value => {
						items[index] = value;
					}),
				);
			}
			return;
		}
		const format = isScalar(node)
			? (
					{
						QUOTE_SINGLE: 'single',
						QUOTE_DOUBLE: 'double',
						BLOCK_LITERAL: 'literal',
						BLOCK_FOLDED: 'folded',
						PLAIN: 'none',
					} as const
				)[node.type ?? 'PLAIN']
			: 'none';
		accept({
			type: 'scalar',
			value: isScalar(node) ? String(node.value ?? '') : '',
			rawValue: input.slice(startOffset, endOffset),
			format,
			startOffset,
			endOffset,
		});
	};
	// The syntax layer has no product-specific depth limit and does not recurse
	// through an arbitrarily deep library tree on the JavaScript call stack.
	pending.push(() =>
		convert(document.contents, value => {
			root = value;
		}),
	);
	while (pending.length) pending.pop()!();
	return root;
}
