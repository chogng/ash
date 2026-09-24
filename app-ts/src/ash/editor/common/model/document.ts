/** Stable identity for one node in a structured document tree. */
export type DocumentNodeId = string;

export type DocumentAttributeValue = string | number | boolean | null;

export type DocumentAttributes = Readonly<Record<string, DocumentAttributeValue>>;

export interface DocumentMark {
	readonly type: string;
	readonly attrs: DocumentAttributes;
}

/** Immutable structure metadata used by a Stanza TextModel and its serializers. */
export interface DocumentNode {
	readonly id: DocumentNodeId;
	readonly type: string;
	readonly attrs: DocumentAttributes;
	readonly content: readonly DocumentNode[];
	readonly marks: readonly DocumentMark[];
	readonly text?: string;
}

export interface DocumentNodeOptions {
	readonly id: DocumentNodeId;
	readonly type: string;
	readonly attrs?: DocumentAttributes;
	readonly content?: readonly DocumentNode[];
	readonly marks?: readonly DocumentMark[];
	readonly text?: string;
}

export interface DocumentNodeLocation {
	readonly node: DocumentNode;
	readonly parent: DocumentNode | undefined;
	readonly index: number;
}

/** Creates an immutable node whose child nodes are structurally shared. */
export function createDocumentNode(options: DocumentNodeOptions): DocumentNode {
	assertNodeIdentity(options.id);
	if (typeof options.type !== "string" || options.type.length === 0) {
		throw new TypeError("Document node type must be a non-empty string");
	}
	const content = Object.freeze([...(options.content ?? [])]);
	const marks = Object.freeze(
		(options.marks ?? []).map(mark => Object.freeze({
			type: mark.type,
			attrs: Object.freeze({ ...(mark.attrs ?? {}) }),
		})),
	);
	const node: DocumentNode = {
		id: options.id,
		type: options.type,
		attrs: Object.freeze({ ...(options.attrs ?? {}) }),
		content,
		marks,
		...(options.text === undefined ? {} : { text: options.text }),
	};
	return Object.freeze(node);
}

/** Recursively freezes an externally supplied tree before it becomes a model snapshot. */
export function freezeDocumentNode(node: DocumentNode): DocumentNode {
	return createDocumentNode({
		id: node.id,
		type: node.type,
		attrs: node.attrs,
		content: node.content.map(child => freezeDocumentNode(child)),
		marks: node.marks,
		...(node.text === undefined ? {} : { text: node.text }),
	});
}

/** Creates a text leaf. Schema validation decides whether empty text is allowed. */
export function createTextNode(
	id: DocumentNodeId,
	text: string,
	marks: readonly DocumentMark[] = [],
): DocumentNode {
	return createDocumentNode({ id, type: "text", text, marks });
}

/** Creates the root node for one structured document. */
export function createDocumentRoot(
	id: DocumentNodeId,
	content: readonly DocumentNode[] = [],
	type = "doc",
): DocumentNode {
	return createDocumentNode({ id, type, content });
}

/** Finds a node and its direct parent without mutating the tree. */
export function findDocumentNode(
	root: DocumentNode,
	id: DocumentNodeId,
): DocumentNodeLocation | undefined {
	if (root.id === id) return { node: root, parent: undefined, index: -1 };
	for (let index = 0; index < root.content.length; index += 1) {
		const child = root.content[index];
		if (child.id === id) return { node: child, parent: root, index };
		const nested = findDocumentNode(child, id);
		if (nested) return nested;
	}
	return undefined;
}

/** Returns true when `candidateId` is the node itself or a descendant. */
export function containsDocumentNode(
	root: DocumentNode,
	candidateId: DocumentNodeId,
): boolean {
	if (root.id === candidateId) return true;
	return root.content.some(child => containsDocumentNode(child, candidateId));
}

/** Returns a structurally shared tree with one node replaced. */
export function replaceDocumentNode(
	root: DocumentNode,
	id: DocumentNodeId,
	replacement: DocumentNode,
): DocumentNode {
	if (root.id === id) return replacement;
	for (let index = 0; index < root.content.length; index += 1) {
		const child = root.content[index];
		const replaced = replaceDocumentNodeIfPresent(child, id, replacement);
		if (!replaced) continue;
		const content = root.content.slice();
		content[index] = replaced;
		return recreateNode(root, content);
	}
	throw new RangeError(`Document node '${id}' does not exist`);
}

export interface RemovedDocumentNode {
	readonly document: DocumentNode;
	readonly removed: DocumentNode;
	readonly parentId: DocumentNodeId;
	readonly index: number;
}

/** Removes one non-root node and returns its original parent location. */
export function removeDocumentNode(
	root: DocumentNode,
	id: DocumentNodeId,
): RemovedDocumentNode {
	if (root.id === id) throw new RangeError("The document root cannot be removed");
	const result = removeFromChildren(root, id);
	if (!result) throw new RangeError(`Document node '${id}' does not exist`);
	return result;
}

/** Inserts one node at an index in an existing parent. */
export function insertDocumentNode(
	root: DocumentNode,
	parentId: DocumentNodeId,
	index: number,
	child: DocumentNode,
): DocumentNode {
	const parent = findDocumentNode(root, parentId)?.node;
	if (!parent) throw new RangeError(`Document parent '${parentId}' does not exist`);
	if (!Number.isSafeInteger(index) || index < 0 || index > parent.content.length) {
		throw new RangeError(`Document child index must be between 0 and ${parent.content.length}`);
	}
	const content = parent.content.slice();
	content.splice(index, 0, child);
	return replaceDocumentNode(root, parentId, recreateNode(parent, content));
}

export function collectDocumentNodeIds(root: DocumentNode): ReadonlySet<DocumentNodeId> {
	const ids = new Set<DocumentNodeId>();
	collectIds(root, ids);
	return ids;
}

function collectIds(node: DocumentNode, ids: Set<DocumentNodeId>): void {
	if (ids.has(node.id)) throw new Error(`Duplicate document node id '${node.id}'`);
	ids.add(node.id);
	for (const child of node.content) collectIds(child, ids);
}

function replaceDocumentNodeIfPresent(
	root: DocumentNode,
	id: DocumentNodeId,
	replacement: DocumentNode,
): DocumentNode | undefined {
	if (root.id === id) return replacement;
	for (let index = 0; index < root.content.length; index += 1) {
		const child = root.content[index];
		const replaced = replaceDocumentNodeIfPresent(child, id, replacement);
		if (!replaced) continue;
		const content = root.content.slice();
		content[index] = replaced;
		return recreateNode(root, content);
	}
	return undefined;
}

function removeFromChildren(
	parent: DocumentNode,
	id: DocumentNodeId,
): RemovedDocumentNode | undefined {
	for (let index = 0; index < parent.content.length; index += 1) {
		const child = parent.content[index];
		if (child.id === id) {
			const content = parent.content.slice();
			content.splice(index, 1);
			return {
				document: recreateNode(parent, content),
				removed: child,
				parentId: parent.id,
				index,
			};
		}
		const nested = removeFromChildren(child, id);
		if (!nested) continue;
		const content = parent.content.slice();
		content[index] = nested.document;
		return {
			document: recreateNode(parent, content),
			removed: nested.removed,
			parentId: nested.parentId,
			index: nested.index,
		};
	}
	return undefined;
}

function recreateNode(
	node: DocumentNode,
	content: readonly DocumentNode[],
	attrs: DocumentAttributes = node.attrs,
): DocumentNode {
	return createDocumentNode({
		id: node.id,
		type: node.type,
		attrs,
		content,
		marks: node.marks,
		...(node.text === undefined ? {} : { text: node.text }),
	});
}

function assertNodeIdentity(id: string): void {
	if (typeof id !== "string" || id.trim().length === 0) {
		throw new TypeError("Document node id must be a non-empty string");
	}
}
