import { createDocumentNode, createDocumentRoot, createTextNode, type DocumentAttributeValue, type DocumentAttributes, type DocumentMark, type DocumentNode, type DocumentNodeId } from "./document.js";

/** Structural layers available to Stanza schemas. */
export type DocumentNodeKind = "root" | "group" | "block" | "line" | "inline" | "text";

export interface DocumentMarkSpec {
	readonly validateAttributes?: (attrs: DocumentAttributes) => void;
}

/** Font families that Stanza stores as semantic document text styles. */
export type DocumentTextStyleFontFamily = "sans" | "serif" | "monospace";

/** Persistent typography attributes applied by Stanza's document-formatting controls. */
export interface DocumentTextStyleAttributes {
	readonly fontFamily?: DocumentTextStyleFontFamily;
	readonly fontSize?: number;
}

export interface DocumentNodeSpec {
	readonly kind: DocumentNodeKind;
	readonly content?: readonly DocumentContentTerm[];
	readonly allowedChildren?: readonly string[];
	readonly allowedChildGroups?: readonly string[];
	readonly groups?: readonly string[];
	readonly minChildren?: number;
	readonly maxChildren?: number;
	readonly defaultAttrs?: DocumentAttributes;
	readonly validateAttributes?: (attrs: DocumentAttributes) => void;
}

export interface DocumentContentTerm {
	readonly type?: string;
	readonly group?: string;
	readonly min?: number;
	readonly max?: number;
}

export interface DocumentSchemaOptions {
	readonly topNodeType?: string;
	readonly nodes?: Readonly<Record<string, DocumentNodeSpec>>;
	readonly marks?: Readonly<Record<string, DocumentMarkSpec>>;
}

export interface DocumentValidationOptions {
	/** Allows a node fragment to be assembled across multiple steps before final document validation. */
	readonly allowIncompleteContent?: boolean;
}

export interface CreateNodeOptions {
	readonly id?: DocumentNodeId;
	readonly attrs?: DocumentAttributes;
	readonly content?: readonly DocumentNode[];
	readonly marks?: readonly DocumentMark[];
	readonly text?: string;
}

const DEFAULT_TOP_NODE_TYPE = "doc";

/** Schema and content validator for Stanza's structured document tree. */
export class DocumentSchema {
	readonly topNodeType: string;
	private readonly nodeSpecs: ReadonlyMap<string, DocumentNodeSpec>;
	private readonly markSpecs: ReadonlyMap<string, DocumentMarkSpec>;
	private readonly allocatedNodeIds = new Set<DocumentNodeId>();
	private nextGeneratedId = 1;

	constructor(options: DocumentSchemaOptions = {}) {
		this.topNodeType = options.topNodeType ?? DEFAULT_TOP_NODE_TYPE;
		const nodes = options.nodes ?? defaultNodeSpecs();
		const marks = options.marks ?? defaultMarkSpecs();
		this.nodeSpecs = new Map(Object.entries(nodes));
		this.markSpecs = new Map(Object.entries(marks));
		this.validateSchemaDefinition();
	}

	getNodeSpec(type: string): DocumentNodeSpec | undefined {
		return this.nodeSpecs.get(type);
	}

	/** Returns a read-only snapshot of node specs for domain-owned schema profiles. */
	getNodeSpecs(): ReadonlyMap<string, DocumentNodeSpec> {
		return new Map(this.nodeSpecs);
	}

	/** Returns a read-only snapshot of mark specs for domain-owned schema profiles. */
	getMarkSpecs(): ReadonlyMap<string, DocumentMarkSpec> {
		return new Map(this.markSpecs);
	}

	/** Returns whether a node type is a leaf according to the schema content contract. */
	isLeafNode(node: DocumentNode): boolean {
		const spec = this.requireNodeSpec(node.type);
		return spec.kind === "text" || ((spec.content?.length ?? 0) === 0 && (spec.allowedChildren?.length ?? 0) === 0 && (spec.allowedChildGroups?.length ?? 0) === 0);
	}

	/** Returns whether a parent type accepts a child type directly or through a declared group. */
	canContainChild(parentType: string, childType: string): boolean {
		const parent = this.requireNodeSpec(parentType);
		const child = this.requireNodeSpec(childType);
		if (parent.content) return parent.content.some(term => contentTermMatches(term, childType, child.groups));
		return (parent.allowedChildren?.includes(childType) ?? false) || (parent.allowedChildGroups?.some(group => child.groups?.includes(group) ?? false) ?? false);
	}

	/** Creates a node using schema defaults and a generated id when omitted. */
	createNode(type: string, options: CreateNodeOptions = {}): DocumentNode {
		const spec = this.requireNodeSpec(type);
		const node = createDocumentNode({
			id: options.id ?? this.allocateNodeId(type),
			type,
			attrs: { ...spec.defaultAttrs, ...options.attrs },
			content: options.content,
			marks: options.marks,
			...(options.text === undefined ? {} : { text: options.text }),
		});
		this.validateNode(node, new Set(), false, true);
		return node;
	}

	createText(
		text: string,
		options: Omit<CreateNodeOptions, "text"> = {},
	): DocumentNode {
		if (typeof text !== "string" || text.length === 0) {
			throw new TypeError("Text nodes must contain non-empty text");
		}
		return this.createNode("text", { ...options, text });
	}

	createDocument(
		content: readonly DocumentNode[] = [],
		id?: DocumentNodeId,
	): DocumentNode {
		const document = createDocumentRoot(id ?? this.allocateNodeId(this.topNodeType), content, this.topNodeType);
		this.validate(document);
		return document;
	}

	/** Validates a complete document, including the root node contract. */
	validate(document: DocumentNode): void {
		if (document.type !== this.topNodeType) {
			throw new TypeError(`Document root must be '${this.topNodeType}'`);
		}
		this.validateNode(document, new Set(), true, false);
	}

	/** Validates a node fragment without requiring it to be the document root. */
	validateFragment(node: DocumentNode, options: DocumentValidationOptions = {}): void {
		this.validateNode(node, new Set(), false, options.allowIncompleteContent ?? false);
	}

	private validateNode(
		node: DocumentNode,
		ids: Set<DocumentNodeId>,
		isRoot: boolean,
		allowIncompleteContent: boolean,
	): void {
		if (!node || typeof node !== "object") throw new TypeError("Document node is required");
		if (ids.has(node.id)) throw new Error(`Duplicate document node id '${node.id}'`);
		ids.add(node.id);
		this.allocatedNodeIds.add(node.id);
		const spec = this.requireNodeSpec(node.type);
		if (isRoot && spec.kind !== "root") throw new TypeError("Document root must use a root node spec");
		if (!isRoot && spec.kind === "root") throw new TypeError("Root node cannot be nested");
		validateAttributes(node.attrs, node.type);
		spec.validateAttributes?.(node.attrs);
		if (spec.kind === "text") {
			if (node.text === undefined || node.text.length === 0) throw new TypeError("Text nodes must contain non-empty text");
			if (node.content.length > 0) throw new TypeError("Text nodes cannot contain child nodes");
			this.validateMarks(node.marks);
		} else {
			if (node.text !== undefined) throw new TypeError(`Node '${node.type}' cannot contain text`);
			if (node.marks.length > 0) throw new TypeError(`Node '${node.type}' cannot contain marks`);
		}
		const minChildren = spec.minChildren ?? 0;
		const maxChildren = spec.maxChildren;
		if (!allowIncompleteContent && node.content.length < minChildren) throw new RangeError(`Node '${node.type}' requires at least ${minChildren} child${minChildren === 1 ? "" : "ren"}`);
		if (maxChildren !== undefined && node.content.length > maxChildren) throw new RangeError(`Node '${node.type}' allows at most ${maxChildren} child${maxChildren === 1 ? "" : "ren"}`);
		for (const child of node.content) {
			if (!this.canContainChild(node.type, child.type)) {
				throw new TypeError(`Node '${node.type}' cannot contain '${child.type}'`);
			}
			this.validateNode(child, ids, false, allowIncompleteContent);
		}
		if (spec.content && !matchesContentExpression(spec.content, node.content, this.nodeSpecs, allowIncompleteContent)) throw new TypeError(`Node '${node.type}' content does not match its schema`);
	}

	/** Validates marks before a command or input adapter stores them as insertion state. */
	validateMarks(marks: readonly DocumentMark[]): void {
		for (const mark of marks) {
			const spec = this.markSpecs.get(mark.type);
			if (!spec) throw new TypeError(`Unknown document mark '${mark.type}'`);
			validateAttributes(mark.attrs, `mark:${mark.type}`);
			spec.validateAttributes?.(mark.attrs);
		}
	}

	private requireNodeSpec(type: string): DocumentNodeSpec {
		const spec = this.nodeSpecs.get(type);
		if (!spec) throw new TypeError(`Unknown document node '${type}'`);
		return spec;
	}

	private allocateNodeId(type: string): DocumentNodeId {
		let id: DocumentNodeId;
		do {
			id = `${type}-${this.nextGeneratedId++}`;
		} while (this.allocatedNodeIds.has(id));
		this.allocatedNodeIds.add(id);
		return id;
	}

	private validateSchemaDefinition(): void {
		const root = this.nodeSpecs.get(this.topNodeType);
		if (!root || root.kind !== "root") throw new TypeError(`Schema top node '${this.topNodeType}' must be a root node`);
		const declaredGroups = new Set<string>();
		for (const [type, spec] of this.nodeSpecs) {
			if (!/^[a-z][a-zA-Z0-9_-]*$/.test(type)) throw new TypeError(`Invalid document node type '${type}'`);
			if (!spec || !spec.kind) throw new TypeError(`Document node '${type}' requires a kind`);
			validateCardinality(type, spec);
			validateContentTerms(type, spec, this.nodeSpecs);
			for (const group of spec.groups ?? []) {
				validateGroupName(group, `Node '${type}' group`);
				if (declaredGroups.has(group)) continue;
				declaredGroups.add(group);
			}
			for (const group of spec.allowedChildGroups ?? []) validateGroupName(group, `Node '${type}' allowed child group`);
			if (spec.kind === "text" && ((spec.allowedChildren?.length ?? 0) > 0 || (spec.allowedChildGroups?.length ?? 0) > 0)) throw new TypeError(`Text node '${type}' cannot declare child content`);
			if (spec.content && ((spec.allowedChildren?.length ?? 0) > 0 || (spec.allowedChildGroups?.length ?? 0) > 0)) throw new TypeError(`Node '${type}' cannot combine content terms with allowed child lists`);
			for (const childType of spec.allowedChildren ?? []) {
				if (!this.nodeSpecs.has(childType)) throw new TypeError(`Node '${type}' references unknown child '${childType}'`);
			}
		}
		for (const [type, spec] of this.nodeSpecs) {
			for (const group of spec.allowedChildGroups ?? []) {
				if (!declaredGroups.has(group)) throw new TypeError(`Node '${type}' references unknown child group '${group}'`);
			}
		}
		for (const [type, spec] of this.markSpecs) {
			if (!/^[a-z][a-zA-Z0-9_-]*$/.test(type)) throw new TypeError(`Invalid document mark type '${type}'`);
		}
	}
}

export function createDefaultDocumentSchema(): DocumentSchema {
	return new DocumentSchema();
}

function defaultNodeSpecs(): Readonly<Record<string, DocumentNodeSpec>> {
	const blocks = ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "codeBlock", "table", "horizontalRule"] as const;
	const listBlocks = ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "codeBlock", "table"] as const;
	const tableCellBlocks = ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "codeBlock", "table"] as const;
	return {
		doc: { kind: "root", allowedChildren: blocks },
		paragraph: { kind: "block", allowedChildren: ["text", "hardBreak", "image"] },
		heading: { kind: "block", allowedChildren: ["text", "hardBreak", "image"], defaultAttrs: { level: 1 }, validateAttributes: attrs => validateIntegerAttribute(attrs, "level", 1, 6) },
		blockquote: { kind: "block", allowedChildren: listBlocks, minChildren: 1 },
		bulletList: { kind: "block", allowedChildren: ["listItem"], minChildren: 1 },
		orderedList: { kind: "block", allowedChildren: ["listItem"], minChildren: 1, defaultAttrs: { order: 1 }, validateAttributes: attrs => validateIntegerAttribute(attrs, "order", 1, Number.MAX_SAFE_INTEGER) },
		listItem: { kind: "block", allowedChildren: listBlocks, minChildren: 1 },
		codeBlock: { kind: "block", content: [{ type: "text", min: 0, max: 1 }], defaultAttrs: { language: "text" }, validateAttributes: attrs => validateStringAttribute(attrs, "language", false) },
		table: { kind: "block", allowedChildren: ["tableRow"], minChildren: 1 },
		tableRow: { kind: "block", allowedChildren: ["tableCell"], minChildren: 1 },
		tableCell: { kind: "block", allowedChildren: tableCellBlocks, minChildren: 1 },
		horizontalRule: { kind: "block" },
		hardBreak: { kind: "inline" },
		image: { kind: "inline", validateAttributes: attrs => validateStringAttribute(attrs, "src", true) },
		text: { kind: "text" },
	};
}

function defaultMarkSpecs(): Readonly<Record<string, DocumentMarkSpec>> {
	return {
		strong: {},
		em: {},
		code: {},
		link: { validateAttributes: attrs => validateStringAttribute(attrs, "href", true) },
		textStyle: { validateAttributes: validateTextStyleMarkAttributes },
	};
}

function validateAttributes(attrs: DocumentAttributes, owner: string): void {
	if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) throw new TypeError(`Attributes for '${owner}' must be an object`);
	for (const [key, value] of Object.entries(attrs)) {
		if (!/^[a-z][a-zA-Z0-9_-]*$/.test(key)) throw new TypeError(`Invalid attribute '${key}' on '${owner}'`);
		if (!isDocumentAttributeValue(value)) throw new TypeError(`Attribute '${key}' on '${owner}' has an invalid value`);
	}
}

function isDocumentAttributeValue(value: unknown): value is DocumentAttributeValue {
	return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function validateStringAttribute(attrs: DocumentAttributes, name: string, required: boolean): void {
	const value = attrs[name];
	if (value === undefined && !required) return;
	if (typeof value !== "string" || (required && value.length === 0)) throw new TypeError(`Attribute '${name}' must be a ${required ? "non-empty " : ""}string`);
}

function validateIntegerAttribute(attrs: DocumentAttributes, name: string, min: number, max: number): void {
	const value = attrs[name];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Attribute '${name}' must be an integer between ${min} and ${max}`);
}

function validateTextStyleMarkAttributes(attrs: DocumentAttributes): void {
	const fontFamily = attrs.fontFamily;
	const fontSize = attrs.fontSize;
	if (fontFamily === undefined && fontSize === undefined) throw new TypeError("Text style marks require a font family or font size");
	if (fontFamily !== undefined && fontFamily !== "sans" && fontFamily !== "serif" && fontFamily !== "monospace") {
		throw new TypeError("Text style font family must be sans, serif, or monospace");
	}
	if (fontSize !== undefined) validateIntegerAttribute(attrs, "fontSize", 8, 72);
	for (const key of Object.keys(attrs)) {
		if (key !== "fontFamily" && key !== "fontSize") throw new TypeError(`Unknown text style attribute '${key}'`);
	}
}

function validateCardinality(type: string, spec: DocumentNodeSpec): void {
	const min = spec.minChildren;
	const max = spec.maxChildren;
	if (min !== undefined && (!Number.isSafeInteger(min) || min < 0)) throw new RangeError(`Node '${type}' minChildren must be a non-negative safe integer`);
	if (max !== undefined && (!Number.isSafeInteger(max) || max < 0)) throw new RangeError(`Node '${type}' maxChildren must be a non-negative safe integer`);
	if (min !== undefined && max !== undefined && min > max) throw new RangeError(`Node '${type}' minChildren cannot exceed maxChildren`);
}

function validateGroupName(group: string, owner: string): void {
	if (typeof group !== "string" || !/^[a-z][a-zA-Z0-9_-]*$/.test(group)) throw new TypeError(`${owner} must use a valid group name`);
}

function contentTermMatches(term: DocumentContentTerm, childType: string, childGroups: readonly string[] | undefined): boolean {
	return term.type === childType || (term.group !== undefined && (childGroups?.includes(term.group) ?? false));
}

function validateContentTerms(owner: string, spec: DocumentNodeSpec, nodeSpecs: ReadonlyMap<string, DocumentNodeSpec>): void {
	if (!spec.content) return;
	if (spec.kind === "text") throw new TypeError(`Text node '${owner}' cannot declare content terms`);
	const declaredGroups = new Set<string>();
	for (const candidate of nodeSpecs.values()) for (const group of candidate.groups ?? []) declaredGroups.add(group);
	for (const term of spec.content) {
		const hasType = term.type !== undefined;
		const hasGroup = term.group !== undefined;
		if (hasType === hasGroup) throw new TypeError(`Node '${owner}' content terms must declare exactly one type or group`);
		if (hasType && !nodeSpecs.has(term.type!)) throw new TypeError(`Node '${owner}' content references unknown child '${term.type}'`);
		if (hasGroup) {
			validateGroupName(term.group!, `Node '${owner}' content group`);
			if (!declaredGroups.has(term.group!)) throw new TypeError(`Node '${owner}' content references unknown child group '${term.group}'`);
		}
		validateContentTermCardinality(owner, term);
	}
}

function validateContentTermCardinality(owner: string, term: DocumentContentTerm): void {
	if (term.min !== undefined && (!Number.isSafeInteger(term.min) || term.min < 0)) throw new RangeError(`Node '${owner}' content min must be a non-negative safe integer`);
	if (term.max !== undefined && (!Number.isSafeInteger(term.max) || term.max < 0)) throw new RangeError(`Node '${owner}' content max must be a non-negative safe integer`);
	if (term.min !== undefined && term.max !== undefined && term.min > term.max) throw new RangeError(`Node '${owner}' content min cannot exceed max`);
}

function matchesContentExpression(terms: readonly DocumentContentTerm[], children: readonly DocumentNode[], nodeSpecs: ReadonlyMap<string, DocumentNodeSpec>, allowIncompleteContent: boolean): boolean {
	const memo = new Map<string, boolean>();
	const matches = (termIndex: number, childIndex: number): boolean => {
		const key = `${termIndex}:${childIndex}`;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;
		if (termIndex === terms.length) return childIndex === children.length;
		const term = terms[termIndex]!;
		const min = allowIncompleteContent ? 0 : term.min ?? 0;
		const max = Math.min(term.max ?? children.length - childIndex, children.length - childIndex);
		for (let count = min; count <= max; count += 1) {
			let matchesChildren = true;
			for (let index = 0; index < count; index += 1) {
				const child = children[childIndex + index]!;
				const childSpec = nodeSpecs.get(child.type);
				if (!childSpec || !contentTermMatches(term, child.type, childSpec.groups)) {
					matchesChildren = false;
					break;
				}
			}
			if (matchesChildren && matches(termIndex + 1, childIndex + count)) {
				memo.set(key, true);
				return true;
			}
		}
		memo.set(key, false);
		return false;
	};
	return matches(0, 0);
}
