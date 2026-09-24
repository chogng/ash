import { type HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { type URI } from '../../../../base/common/uri.js';
import { type Range } from '../../../common/core/range.js';
import { type DocumentDropEdit, type DocumentPasteEdit, type DropYieldTo, type WorkspaceEdit } from '../../../common/languages.js';
import { parseSnippet } from '../../snippet/common/snippetParser.js';

/** Collects the primary insertions and the provider's other resource edits in one transaction. */
export function createCombinedWorkspaceEdit(uri: URI, ranges: readonly Range[], edit: DocumentPasteEdit | DocumentDropEdit): WorkspaceEdit {
	const text = typeof edit.insertText === 'string'
		? edit.insertText
		: parseSnippet(edit.insertText.snippet, { allowUnresolvedVariables: true }).text;
	return {
		edits: [
			...ranges.filter(() => text.length > 0).map(range => ({
				resource: uri,
				textEdit: { range, text },
			})),
			...(edit.additionalEdit?.edits ?? []),
		],
	};
}

/** Preserves provider order except where one edit explicitly yields to another. */
export function sortEditsByYieldTo<T extends {
	readonly kind: HierarchicalKind | undefined;
	readonly handledMimeType?: string;
	readonly yieldTo?: readonly DropYieldTo[];
}>(edits: readonly T[]): T[] {
	const dependencies = edits.map(edit => edits.flatMap((other, index) =>
		other !== edit && edit.yieldTo?.some(target => matchesYieldTarget(target, other)) ? [index] : []));
	const indices = new Int32Array(edits.length).fill(-1);
	const lowLinks = new Int32Array(edits.length);
	const onStack = new Set<number>();
	const stack: number[] = [];
	const components: number[][] = [];
	const componentOf = new Int32Array(edits.length);
	let nextIndex = 0;
	const collect = (index: number): void => {
		indices[index] = nextIndex;
		lowLinks[index] = nextIndex++;
		stack.push(index);
		onStack.add(index);
		for (const dependency of dependencies[index]!) {
			if (indices[dependency] === -1) {
				collect(dependency);
				lowLinks[index] = Math.min(lowLinks[index]!, lowLinks[dependency]!);
			} else if (onStack.has(dependency)) {
				lowLinks[index] = Math.min(lowLinks[index]!, indices[dependency]!);
			}
		}
		if (lowLinks[index] !== indices[index]) return;
		const component: number[] = [];
		for (;;) {
			const member = stack.pop()!;
			onStack.delete(member);
			componentOf[member] = components.length;
			component.push(member);
			if (member === index) break;
		}
		components.push(component.sort((a, b) => a - b));
	};
	for (let index = 0; index < edits.length; index++) {
		if (indices[index] === -1) collect(index);
	}
	const result: T[] = [];
	const visited = new Set<number>();
	const visit = (componentIndex: number): void => {
		if (visited.has(componentIndex)) return;
		visited.add(componentIndex);
		for (const member of components[componentIndex]!) {
			for (const dependency of dependencies[member]!) {
				const dependencyComponent = componentOf[dependency]!;
				if (dependencyComponent !== componentIndex) visit(dependencyComponent);
			}
		}
		for (const member of components[componentIndex]!) result.push(edits[member]!);
	};
	for (let index = 0; index < edits.length; index++) visit(componentOf[index]!);
	return result;
}

function matchesYieldTarget(target: DropYieldTo, edit: { readonly kind: HierarchicalKind | undefined; readonly handledMimeType?: string }): boolean {
	return 'mimeType' in target
		? target.mimeType === edit.handledMimeType
		: edit.kind !== undefined && target.kind.contains(edit.kind);
}
