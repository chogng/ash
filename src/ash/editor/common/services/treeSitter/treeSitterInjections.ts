import type { Node, Parser, Query, Range as SyntaxRange, Tree } from '@vscode/tree-sitter-wasm';
import { Range } from '../../core/range.js';
import type { TreeSitterTextSource, TreeSitterTokenizationRuntime } from './treeSitterTree.js';

export interface InjectedTree {
	readonly parser: Parser;
	readonly tree: Tree;
	readonly query: Query;
	readonly symbols?: Query;
	readonly folds?: Query;
	readonly depth: number;
	readonly languageId: string;
	readonly ranges: readonly SyntaxRange[];
}

/** Embedded trees use included ranges, retaining the parent's UTF-16 coordinates. */
export async function prepareInjectedTrees(
	root: Node,
	runtime: TreeSitterTokenizationRuntime,
	model: TreeSitterTextSource,
	current: () => boolean,
	result: InjectedTree[],
	depth = 1,
): Promise<void> {
	if (!runtime.injections || !runtime.loadEmbeddedLanguage || depth > 4) return;
	for (const match of runtime.injections.matches(root).slice(0, 256)) {
		if (!current() || result.length >= 256) return;
		const captured = (name: string) => match.captures.find(capture => capture.name === name)?.node;
		const text = (node: Node) =>
			model.getValueInRange(
				new Range(
					node.startPosition.row + 1,
					node.startPosition.column + 1,
					node.endPosition.row + 1,
					node.endPosition.column + 1,
				),
			);
		const language = captured('injection.language');
		const filename = captured('injection.filename');
		let name = language
			? text(language).trim().split(/\s/)[0]
			: (match.setProperties?.['injection.language'] ??
				(filename ? text(filename).split('.').at(-1) : undefined));
		if (!name) continue;
		const ranges: SyntaxRange[] = [];
		for (const capture of match.captures.filter(capture => capture.name === 'injection.content')) {
			const node = capture.node;
			let startIndex = node.startIndex;
			let endIndex = node.endIndex;
			let startPosition = node.startPosition;
			let endPosition = node.endPosition;
			if (filename) {
				startIndex++;
				startPosition = { row: startPosition.row, column: startPosition.column + 1 };
				if (
					endIndex < model.length &&
					model.getValueInRange(
						Range.fromPositions(model.getPositionAt(endIndex), model.getPositionAt(endIndex + 1)),
					) === '\n'
				) {
					endIndex++;
					endPosition = { row: endPosition.row + 1, column: 0 };
				}
			}
			if (node.parent?.type === 'script_element' || node.parent?.type === 'style_element') {
				const tag = node.parent.firstChild;
				const attributes = tag ? text(tag).toLowerCase() : '';
				if (attributes.includes('application/json') || attributes.includes('application/ld+json'))
					name = 'json';
				if (attributes.includes('typescript') || attributes.includes('lang="ts"')) name = 'typescript';
				if (attributes.includes('lang="scss"')) name = 'scss';
				if (attributes.includes('lang="less"')) name = 'less';
			}
			if (startIndex < endIndex) ranges.push({ startIndex, endIndex, startPosition, endPosition });
		}
		ranges.sort((a, b) => a.startIndex - b.startIndex);
		for (let index = 0; index + 1 < ranges.length; index++) {
			const previous = ranges[index]!,
				next = ranges[index + 1]!;
			if (previous.endIndex > next.startIndex) continue;
			const gap = model.getValueInRange(
				Range.fromPositions(model.getPositionAt(previous.endIndex), model.getPositionAt(next.startIndex)),
			);
			if (/^[\t\r\n ]*$/.test(gap))
				ranges[index] = { ...previous, endIndex: next.startIndex, endPosition: next.startPosition };
		}
		if (!ranges.length) continue;
		const embedded = await runtime.loadEmbeddedLanguage(name);
		if (!embedded || !current()) continue;
		const parser = new embedded.Parser();
		parser.setLanguage(embedded.language);
		let tree: Tree | null;
		try {
			tree = parser.parse(
				offset =>
					offset >= model.length
						? ''
						: model.getValueInRange(
								Range.fromPositions(model.getPositionAt(offset), model.getPositionAt(offset + 4096)),
							),
				null,
				{ includedRanges: ranges.sort((a, b) => a.startIndex - b.startIndex) },
			);
		} catch (error) {
			parser.delete();
			throw error;
		}
		if (!tree) {
			parser.delete();
			throw new Error('Embedded syntax parsing failed');
		}
		if (!current()) {
			tree.delete();
			parser.delete();
			return;
		}
		result.push({
			parser,
			tree,
			query: embedded.query,
			symbols: embedded.symbols,
			folds: embedded.folds,
			depth,
			languageId: embedded.languageId ?? name,
			ranges,
		});
		await prepareInjectedTrees(tree.rootNode, embedded, model, current, result, depth + 1);
	}
}

export function disposeInjectedTrees(trees: readonly InjectedTree[]): void {
	for (const { tree, parser } of trees) {
		tree.delete();
		parser.delete();
	}
}
