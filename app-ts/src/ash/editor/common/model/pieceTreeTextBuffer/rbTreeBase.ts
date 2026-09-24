import type { PieceNode } from "./pieceTreeBase.js";

export const enum NodeColor {
	Black = 0,
	Red = 1,
}

/** Returns the first node in document order. */
export function leftmost(node: PieceNode | undefined): PieceNode | undefined {
	while (node?.left) node = node.left;
	return node;
}

/** Returns the last node in document order. */
export function rightmost(node: PieceNode | undefined): PieceNode | undefined {
	while (node?.right) node = node.right;
	return node;
}

export function nextNode(node: PieceNode): PieceNode | undefined {
	if (node.right) return leftmost(node.right);
	while (node.parent && node === node.parent.right) node = node.parent;
	return node.parent;
}

export function previousNode(node: PieceNode): PieceNode | undefined {
	if (node.left) return rightmost(node.left);
	while (node.parent && node === node.parent.left) node = node.parent;
	return node.parent;
}

/** Inserts a node immediately before a document-order reference; undefined means the end. */
export function insertBefore(root: PieceNode | undefined, reference: PieceNode | undefined, node: PieceNode): PieceNode {
	if (!root) {
		node.color = NodeColor.Black;
		return node;
	}
	if (!reference) return insertChild(root, rightmost(root)!, "right", node);
	if (!reference.left) return insertChild(root, reference, "left", node);
	return insertChild(root, rightmost(reference.left)!, "right", node);
}

/** Inserts a node immediately after a document-order reference. */
export function insertAfter(root: PieceNode, reference: PieceNode, node: PieceNode): PieceNode {
	if (!reference.right) return insertChild(root, reference, "right", node);
	return insertChild(root, leftmost(reference.right)!, "left", node);
}

/** Removes one node while preserving red-black ordering and subtree metadata. */
export function deleteNode(root: PieceNode, node: PieceNode): PieceNode | undefined {
	const state: TreeState = { root };
	let replacementSource = node;
	let removedColor = replacementSource.color;
	let replacement: PieceNode | undefined;
	let replacementParent: PieceNode | undefined;
	let replacementIsLeft = false;

	if (!node.left) {
		replacement = node.right;
		replacementParent = node.parent;
		replacementIsLeft = !!node.parent && node === node.parent.left;
		transplant(state, node, node.right);
		refreshAncestors(replacementParent);
	} else if (!node.right) {
		replacement = node.left;
		replacementParent = node.parent;
		replacementIsLeft = !!node.parent && node === node.parent.left;
		transplant(state, node, node.left);
		refreshAncestors(replacementParent);
	} else {
		replacementSource = leftmost(node.right)!;
		removedColor = replacementSource.color;
		replacement = replacementSource.right;
		if (replacementSource.parent === node) {
			replacementParent = replacementSource;
			replacementIsLeft = false;
			if (replacement) replacement.parent = replacementSource;
		} else {
			const detachedParent = replacementSource.parent!;
			replacementParent = detachedParent;
			replacementIsLeft = true;
			transplant(state, replacementSource, replacementSource.right);
			refreshAncestors(detachedParent);
			replacementSource.right = node.right;
			replacementSource.right.parent = replacementSource;
		}
		transplant(state, node, replacementSource);
		replacementSource.left = node.left;
		replacementSource.left.parent = replacementSource;
		replacementSource.color = node.color;
		replacementSource.recompute();
		refreshAncestors(replacementSource.parent);
	}

	if (removedColor === NodeColor.Black) fixDelete(state, replacement, replacementParent, replacementIsLeft);
	node.parent = undefined;
	node.left = undefined;
	node.right = undefined;
	node.recompute();
	if (state.root) {
		state.root.parent = undefined;
		state.root.color = NodeColor.Black;
	}
	return state.root;
}

interface TreeState {
	root: PieceNode | undefined;
}

function insertChild(root: PieceNode, parent: PieceNode, side: "left" | "right", node: PieceNode): PieceNode {
	node.parent = parent;
	node.left = undefined;
	node.right = undefined;
	node.color = NodeColor.Red;
	node.recompute();
	parent[side] = node;
	refreshAncestors(parent);
	const state: TreeState = { root };
	fixInsert(state, node);
	state.root!.parent = undefined;
	return state.root!;
}

function fixInsert(state: TreeState, inserted: PieceNode): void {
	let node = inserted;
	while (node.parent?.color === NodeColor.Red) {
		const parent = node.parent;
		const grandparent = parent.parent!;
		if (parent === grandparent.left) {
			const uncle = grandparent.right;
			if (colorOf(uncle) === NodeColor.Red) {
				parent.color = NodeColor.Black;
				uncle!.color = NodeColor.Black;
				grandparent.color = NodeColor.Red;
				node = grandparent;
				continue;
			}
			if (node === parent.right) {
				node = parent;
				rotateLeft(state, node);
			}
			node.parent!.color = NodeColor.Black;
			node.parent!.parent!.color = NodeColor.Red;
			rotateRight(state, node.parent!.parent!);
		} else {
			const uncle = grandparent.left;
			if (colorOf(uncle) === NodeColor.Red) {
				parent.color = NodeColor.Black;
				uncle!.color = NodeColor.Black;
				grandparent.color = NodeColor.Red;
				node = grandparent;
				continue;
			}
			if (node === parent.left) {
				node = parent;
				rotateRight(state, node);
			}
			node.parent!.color = NodeColor.Black;
			node.parent!.parent!.color = NodeColor.Red;
			rotateLeft(state, node.parent!.parent!);
		}
	}
	state.root!.color = NodeColor.Black;
}

function fixDelete(state: TreeState, replacement: PieceNode | undefined, initialParent: PieceNode | undefined, initialIsLeft: boolean): void {
	let node = replacement;
	let parent = node?.parent ?? initialParent;
	let isLeft = node ? !!parent && node === parent.left : initialIsLeft;
	while (node !== state.root && colorOf(node) === NodeColor.Black) {
		if (!parent) break;
		if (isLeft) {
			let sibling = parent.right;
			if (colorOf(sibling) === NodeColor.Red) {
				sibling!.color = NodeColor.Black;
				parent.color = NodeColor.Red;
				rotateLeft(state, parent);
				sibling = parent.right;
			}
			if (colorOf(sibling?.left) === NodeColor.Black && colorOf(sibling?.right) === NodeColor.Black) {
				if (sibling) sibling.color = NodeColor.Red;
				node = parent;
				parent = node.parent;
				isLeft = !!parent && node === parent.left;
				continue;
			}
			if (colorOf(sibling?.right) === NodeColor.Black) {
				if (sibling?.left) sibling.left.color = NodeColor.Black;
				if (sibling) {
					sibling.color = NodeColor.Red;
					rotateRight(state, sibling);
				}
				sibling = parent.right;
			}
			if (sibling) sibling.color = parent.color;
			parent.color = NodeColor.Black;
			if (sibling?.right) sibling.right.color = NodeColor.Black;
			rotateLeft(state, parent);
			node = state.root;
			parent = undefined;
		} else {
			let sibling = parent.left;
			if (colorOf(sibling) === NodeColor.Red) {
				sibling!.color = NodeColor.Black;
				parent.color = NodeColor.Red;
				rotateRight(state, parent);
				sibling = parent.left;
			}
			if (colorOf(sibling?.left) === NodeColor.Black && colorOf(sibling?.right) === NodeColor.Black) {
				if (sibling) sibling.color = NodeColor.Red;
				node = parent;
				parent = node.parent;
				isLeft = !!parent && node === parent.left;
				continue;
			}
			if (colorOf(sibling?.left) === NodeColor.Black) {
				if (sibling?.right) sibling.right.color = NodeColor.Black;
				if (sibling) {
					sibling.color = NodeColor.Red;
					rotateLeft(state, sibling);
				}
				sibling = parent.left;
			}
			if (sibling) sibling.color = parent.color;
			parent.color = NodeColor.Black;
			if (sibling?.left) sibling.left.color = NodeColor.Black;
			rotateRight(state, parent);
			node = state.root;
			parent = undefined;
		}
	}
	if (node) node.color = NodeColor.Black;
}

function rotateLeft(state: TreeState, node: PieceNode): void {
	const right = node.right!;
	node.right = right.left;
	if (right.left) right.left.parent = node;
	right.parent = node.parent;
	if (!node.parent) state.root = right;
	else if (node === node.parent.left) node.parent.left = right;
	else node.parent.right = right;
	right.left = node;
	node.parent = right;
	node.recompute();
	right.recompute();
}

function rotateRight(state: TreeState, node: PieceNode): void {
	const left = node.left!;
	node.left = left.right;
	if (left.right) left.right.parent = node;
	left.parent = node.parent;
	if (!node.parent) state.root = left;
	else if (node === node.parent.right) node.parent.right = left;
	else node.parent.left = left;
	left.right = node;
	node.parent = left;
	node.recompute();
	left.recompute();
}

function transplant(state: TreeState, source: PieceNode, replacement: PieceNode | undefined): void {
	if (!source.parent) state.root = replacement;
	else if (source === source.parent.left) source.parent.left = replacement;
	else source.parent.right = replacement;
	if (replacement) replacement.parent = source.parent;
}

function refreshAncestors(node: PieceNode | undefined): void {
	while (node) {
		node.recompute();
		node = node.parent;
	}
}

function colorOf(node: PieceNode | undefined): NodeColor {
	return node?.color ?? NodeColor.Black;
}
