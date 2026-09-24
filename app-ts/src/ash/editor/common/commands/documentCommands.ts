import { containsDocumentNode, findDocumentNode, type DocumentAttributes, type DocumentMark, type DocumentNode, type DocumentNodeId } from "../model/document.js";
import { type DocumentFragment } from "../model/documentSerialization.js";
import { nodeSelection, type DocumentPoint, type DocumentSelection, textSelection } from "../core/documentSelection.js";
import { type DocumentSchema, type DocumentTextStyleAttributes } from "../model/documentSchema.js";
import { DocumentTransaction } from "../model/documentTransaction.js";

export type AdjacentBlockDirection = "backward" | "forward";
export type BlockMoveDirection = "up" | "down";
export type ListItemIndentation = "in" | "out";
export type TableCellDirection = "backward" | "forward";

export interface TableCellContext {
	readonly table: DocumentNode;
	readonly row: DocumentNode;
	readonly cell: DocumentNode;
	readonly rowIndex: number;
	readonly columnIndex: number;
}

/** Focus target returned by a browser command after its transaction commits. */
export interface DocumentCommandFocus {
	readonly blockId: DocumentNodeId;
	readonly point?: DocumentPoint;
}

/** A validated model transaction plus the block the browser should focus. */
export interface DocumentCommand {
	readonly transaction: DocumentTransaction;
	readonly focus: DocumentCommandFocus;
}

/** Splits one paragraph or heading at a text offset and inserts its right half after it. */
export function createSplitBlockCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, textNodeId: DocumentNodeId, offset: number): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location?.parent || !isTextBearingBlock(location.node)) return undefined;
	const textIndex = location.node.content.findIndex(child => child.id === textNodeId && child.text !== undefined);
	const text = textIndex >= 0 ? location.node.content[textIndex] : undefined;
	if (!text || !Number.isSafeInteger(offset) || offset < 0 || offset > text.text!.length) return undefined;

	const rightText = text.text!.slice(offset);
	const rightNode = rightText.length > 0 ? schema.createText(rightText, { marks: text.marks }) : undefined;
	const trailing = location.node.content.slice(textIndex + 1);
	const newBlock = schema.createNode(location.node.type, {
		attrs: location.node.attrs,
		content: rightNode ? [rightNode] : [],
	});
	let transaction = new DocumentTransaction();
	if (offset === 0) transaction = transaction.deleteNode(text.id);
	else if (offset < text.text!.length) transaction = transaction.replaceText(text.id, offset, text.text!.length, "");
	for (const child of trailing) transaction = transaction.deleteNode(child.id);
	transaction = transaction.insertNode(location.parent.id, location.index + 1, newBlock);
	for (let index = 0; index < trailing.length; index += 1) transaction = transaction.insertNode(newBlock.id, (rightNode ? 1 : 0) + index, trailing[index]!);
	const focusText = rightNode ?? trailing.find(child => child.text !== undefined);
	const point = focusText ? { nodeId: focusText.id, offset: 0 } : undefined;
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId: newBlock.id, ...(point ? { point } : {}) } };
}

/** Splits a paragraph inside a list item into a new sibling list item. */
export function createSplitListItemCommand(schema: DocumentSchema, document: DocumentNode, listItemId: DocumentNodeId, paragraphId: DocumentNodeId, textNodeId: DocumentNodeId, offset: number): DocumentCommand | undefined {
	const itemLocation = findDocumentNode(document, listItemId);
	if (!itemLocation?.parent || itemLocation.node.type !== "listItem" || !isListType(itemLocation.parent.type)) return undefined;
	const paragraphLocation = findDocumentNode(document, paragraphId);
	if (!paragraphLocation || paragraphLocation.parent?.id !== listItemId || !isTextBearingBlock(paragraphLocation.node)) return undefined;
	const textIndex = paragraphLocation.node.content.findIndex(child => child.id === textNodeId && child.text !== undefined);
	const text = textIndex >= 0 ? paragraphLocation.node.content[textIndex] : undefined;
	if ((!text && (textNodeId.length > 0 || paragraphLocation.node.content.length > 0)) || !Number.isSafeInteger(offset) || offset < 0 || (text && offset > text.text!.length) || (!text && offset !== 0)) return undefined;
	const rightText = text ? text.text!.slice(offset) : "";
	const trailingInline = text ? paragraphLocation.node.content.slice(textIndex + 1) : [];
	const trailingBlocks = itemLocation.node.content.slice(paragraphLocation.index + 1);
	const rightParagraph = schema.createNode(paragraphLocation.node.type, { attrs: paragraphLocation.node.attrs, content: rightText.length > 0 ? [schema.createText(rightText, { marks: text?.marks ?? [] })] : [] });
	const newItem = schema.createNode("listItem", { content: [rightParagraph] });
	let transaction = new DocumentTransaction();
	if (text && offset === 0) transaction = transaction.deleteNode(text.id);
	else if (text && offset < text.text!.length) transaction = transaction.replaceText(text.id, offset, text.text!.length, "");
	for (const child of trailingInline) transaction = transaction.deleteNode(child.id);
	for (const child of trailingBlocks) transaction = transaction.deleteNode(child.id);
	transaction = transaction.insertNode(itemLocation.parent.id, itemLocation.index + 1, newItem);
	for (let index = 0; index < trailingInline.length; index += 1) transaction = transaction.insertNode(rightParagraph.id, (rightText.length > 0 ? 1 : 0) + index, trailingInline[index]!);
	for (let index = 0; index < trailingBlocks.length; index += 1) transaction = transaction.insertNode(newItem.id, index + 1, trailingBlocks[index]!);
	const focusText = rightParagraph.content.find(child => child.text !== undefined) ?? trailingInline.find(child => child.text !== undefined);
	const point = focusText ? { nodeId: focusText.id, offset: 0 } : undefined;
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId: newItem.id, ...(point ? { point } : {}) } };
}

/** Exits an empty list item, removing the item and creating a paragraph when the list ends. */
export function createExitEmptyListItemCommand(schema: DocumentSchema, document: DocumentNode, listItemId: DocumentNodeId, paragraphId: DocumentNodeId): DocumentCommand | undefined {
	const itemLocation = findDocumentNode(document, listItemId);
	if (!itemLocation?.parent || itemLocation.node.type !== "listItem" || !isListType(itemLocation.parent.type)) return undefined;
	const paragraphLocation = findDocumentNode(document, paragraphId);
	if (!paragraphLocation || paragraphLocation.parent?.id !== listItemId || paragraphLocation.node.type !== "paragraph" || paragraphLocation.node.content.length > 0 || itemLocation.node.content.length !== 1) return undefined;
	const list = itemLocation.parent;
	const listLocation = findDocumentNode(document, list.id);
	if (!listLocation?.parent) return undefined;
	const listParent = listLocation.parent;
	if (list.content.length === 1 || itemLocation.index === list.content.length - 1) {
		const paragraph = schema.createNode("paragraph");
		let transaction = new DocumentTransaction().deleteNode(listItemId);
		if (list.content.length === 1) {
			transaction = transaction.deleteNode(list.id).insertNode(listParent.id, listLocation.index, paragraph);
		} else {
			transaction = transaction.insertNode(listParent.id, listLocation.index + 1, paragraph);
		}
		return { transaction, focus: { blockId: paragraph.id } };
	}
	const nextItem = list.content[itemLocation.index + 1];
	const nextBlock = nextItem?.content.find(child => isTextBearingBlock(child));
	const transaction = new DocumentTransaction().deleteNode(listItemId);
	return { transaction, focus: { blockId: nextBlock?.id ?? paragraphId } };
}

/** Joins a list item with its adjacent sibling while preserving nested blocks. */
export function createJoinAdjacentListItemCommand(document: DocumentNode, listItemId: DocumentNodeId, paragraphId: DocumentNodeId, direction: AdjacentBlockDirection): DocumentCommand | undefined {
	const itemLocation = findDocumentNode(document, listItemId);
	if (!itemLocation?.parent || itemLocation.node.type !== "listItem" || !isListType(itemLocation.parent.type)) return undefined;
	const paragraphLocation = findDocumentNode(document, paragraphId);
	if (!paragraphLocation || paragraphLocation.parent?.id !== listItemId || !isTextBearingBlock(paragraphLocation.node)) return undefined;
	const adjacent = itemLocation.parent.content[itemLocation.index + (direction === "backward" ? -1 : 1)];
	if (!adjacent || adjacent.type !== "listItem") return undefined;
	const target = direction === "backward" ? adjacent : itemLocation.node;
	const source = direction === "backward" ? itemLocation.node : adjacent;
	const targetParagraph = target.content.at(-1);
	const sourceParagraph = source.content[0];
	const canMergeParagraphs = targetParagraph !== undefined && sourceParagraph !== undefined && isTextBearingBlock(targetParagraph) && isTextBearingBlock(sourceParagraph) && targetParagraph.type === sourceParagraph.type;
	const movedSourceContent = canMergeParagraphs ? source.content.slice(1) : source.content;
	let transaction = new DocumentTransaction();
	if (canMergeParagraphs) {
		for (let index = 0; index < sourceParagraph.content.length; index += 1) transaction = transaction.moveNode(sourceParagraph.content[index]!.id, targetParagraph.id, targetParagraph.content.length + index);
		transaction = transaction.deleteNode(sourceParagraph.id);
	}
	for (let index = 0; index < movedSourceContent.length; index += 1) transaction = transaction.moveNode(movedSourceContent[index]!.id, target.id, target.content.length + index);
	transaction = transaction.deleteNode(source.id);
	const focusParagraph = canMergeParagraphs ? targetParagraph : [...target.content].reverse().find(child => isTextBearingBlock(child));
	const focusText = focusParagraph ? lastTextNode(focusParagraph.content) : undefined;
	const point = focusText ? { nodeId: focusText.id, offset: focusText.text!.length } : undefined;
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId: focusParagraph?.id ?? paragraphId, ...(point ? { point } : {}) } };
}

/** Indents or outdents a list item without changing its stable identity. */
export function createListItemIndentationCommand(schema: DocumentSchema, document: DocumentNode, listItemId: DocumentNodeId, paragraphId: DocumentNodeId, direction: ListItemIndentation): DocumentCommand | undefined {
	const itemLocation = findDocumentNode(document, listItemId);
	if (!itemLocation?.parent || itemLocation.node.type !== "listItem" || !isListType(itemLocation.parent.type)) return undefined;
	if (!findDocumentNode(document, paragraphId) || !itemLocation.node.content.some(child => child.id === paragraphId)) return undefined;
	if (direction === "in") {
		const previous = itemLocation.parent.content[itemLocation.index - 1];
		if (!previous || previous.type !== "listItem") return undefined;
		const nested = previous.content.at(-1);
		let transaction = new DocumentTransaction();
		let nestedList: DocumentNode;
		if (nested && nested.type === itemLocation.parent.type) {
			nestedList = nested;
		} else {
			nestedList = schema.createNode(itemLocation.parent.type, { attrs: itemLocation.parent.attrs });
			transaction = transaction.insertNode(previous.id, previous.content.length, nestedList);
		}
		transaction = transaction.moveNode(listItemId, nestedList.id, nestedList.content.length);
		return { transaction, focus: { blockId: paragraphId } };
	}
	const nestedListLocation = findDocumentNode(document, itemLocation.parent.id);
	if (!nestedListLocation?.parent || nestedListLocation.parent.type !== "listItem") return undefined;
	const parentItemLocation = findDocumentNode(document, nestedListLocation.parent.id);
	const outerList = parentItemLocation?.parent;
	if (!parentItemLocation || !outerList || !isListType(outerList.type)) return undefined;
	let transaction = new DocumentTransaction().moveNode(listItemId, outerList.id, parentItemLocation.index + 1);
	if (itemLocation.parent.content.length === 1) transaction = transaction.deleteNode(itemLocation.parent.id);
	return { transaction, focus: { blockId: paragraphId } };
}

/** Changes a text-bearing block between paragraph and heading without replacing its identity. */
export function createSetBlockTypeCommand(document: DocumentNode, blockId: DocumentNodeId, type: "paragraph" | "heading"): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location?.parent || !isTextBearingBlock(location.node) || location.node.type === type) return undefined;
	const attrs = type === "heading" ? { ...location.node.attrs, level: typeof location.node.attrs.level === "number" ? location.node.attrs.level : 1 } : location.node.attrs;
	return { transaction: new DocumentTransaction().setNodeType(blockId, type, attrs), focus: { blockId } };
}

/** Wraps a text-bearing block in a blockquote or moves it out of its containing blockquote. */
export function createToggleBlockquoteCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location?.parent || !isTextBearingBlock(location.node)) return undefined;
	if (location.parent.type === "blockquote") {
		const blockquoteLocation = findDocumentNode(document, location.parent.id);
		if (!blockquoteLocation?.parent) return undefined;
		let transaction = new DocumentTransaction().moveNode(blockId, blockquoteLocation.parent.id, blockquoteLocation.index);
		if (location.parent.content.length === 1) transaction = transaction.deleteNode(location.parent.id);
		return { transaction, focus: { blockId } };
	}
	const blockquote = schema.createNode("blockquote", { content: [location.node] });
	const transaction = new DocumentTransaction().deleteNode(blockId).insertNode(location.parent.id, location.index, blockquote);
	return { transaction, focus: { blockId } };
}

/** Inserts a top-level horizontal rule immediately after the active text-bearing block. */
export function createInsertHorizontalRuleCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location?.parent || location.parent.type !== "doc" || !isTextBearingBlock(location.node)) return undefined;
	const rule = schema.createNode("horizontalRule");
	const transaction = new DocumentTransaction().insertNode(location.parent.id, location.index + 1, rule);
	return { transaction, focus: { blockId } };
}

/** Wraps a top-level text-bearing block in a list or changes an existing list's kind. */
export function createToggleListCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, listType: "bulletList" | "orderedList"): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location?.parent || !isTextBearingBlock(location.node)) return undefined;
	if (location.parent.type === "listItem") {
		const listLocation = findDocumentNode(document, location.parent.id);
		if (!listLocation?.parent || !isListType(listLocation.parent.type) || listLocation.parent.type === listType) return undefined;
		return { transaction: new DocumentTransaction().setNodeType(listLocation.parent.id, listType, listAttributes(listType, listLocation.parent.attrs)), focus: { blockId } };
	}
	if (location.parent.type !== "doc") return undefined;
	const item = schema.createNode("listItem", { content: [location.node] });
	const list = schema.createNode(listType, { attrs: listAttributes(listType, {}), content: [item] });
	const transaction = new DocumentTransaction().deleteNode(blockId).insertNode(location.parent.id, location.index, list);
	return { transaction, focus: { blockId } };
}

/** Joins the current text-bearing block with its compatible adjacent sibling. */
export function createJoinAdjacentBlockCommand(document: DocumentNode, blockId: DocumentNodeId, textNodeId: DocumentNodeId, direction: AdjacentBlockDirection): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location?.parent || !isTextBearingBlock(location.node)) return undefined;
	if (textNodeId && !location.node.content.some(child => child.id === textNodeId && child.text !== undefined)) return undefined;
	const adjacentIndex = direction === "backward" ? location.index - 1 : location.index + 1;
	const adjacent = location.parent.content[adjacentIndex];
	if (!adjacent || !isTextBearingBlock(adjacent) || adjacent.type !== location.node.type) return undefined;
	if (direction === "backward") {
		const targetLast = adjacent.content.at(-1);
		const sourceFirst = location.node.content[0];
		const canMerge = targetLast?.text !== undefined && sourceFirst?.text !== undefined && marksEqual(targetLast.marks, sourceFirst.marks);
		const movedContent = canMerge ? location.node.content.slice(1) : location.node.content;
		let transaction = new DocumentTransaction();
		if (canMerge) transaction = transaction.replaceText(targetLast.id, targetLast.text!.length, targetLast.text!.length, sourceFirst.text!).deleteNode(sourceFirst.id);
		for (let index = 0; index < movedContent.length; index += 1) transaction = transaction.moveNode(movedContent[index]!.id, adjacent.id, adjacent.content.length + index);
		transaction = transaction.deleteNode(location.node.id);
		const point = canMerge && movedContent.length === 0
			? { nodeId: targetLast.id, offset: targetLast.text!.length + sourceFirst.text!.length }
			: lastTextPoint([...adjacent.content, ...movedContent]);
		if (point) transaction = transaction.withSelection(textSelection(point));
		return { transaction, focus: { blockId: adjacent.id, ...(point ? { point } : {}) } };
	}
	const targetLast = location.node.content.at(-1);
	const sourceFirst = adjacent.content[0];
	const canMerge = targetLast?.text !== undefined && sourceFirst?.text !== undefined && marksEqual(targetLast.marks, sourceFirst.marks);
	const movedContent = canMerge ? adjacent.content.slice(1) : adjacent.content;
	const point = lastTextPoint(location.node.content);
	let transaction = new DocumentTransaction();
	if (canMerge) transaction = transaction.replaceText(targetLast.id, targetLast.text!.length, targetLast.text!.length, sourceFirst.text!).deleteNode(sourceFirst.id);
	for (let index = 0; index < movedContent.length; index += 1) transaction = transaction.moveNode(movedContent[index]!.id, location.node.id, location.node.content.length + index);
	transaction = transaction.deleteNode(adjacent.id);
	const focus = canMerge && point && targetLast?.text !== undefined
		? point
		: point ?? firstTextPoint(adjacent.content);
	if (focus) transaction = transaction.withSelection(textSelection(focus));
	return { transaction, focus: { blockId: location.node.id, ...(focus ? { point: focus } : {}) } };
}

/** Joins adjacent text runs in one block when their marks are compatible. */
export function createJoinAdjacentTextRunCommand(document: DocumentNode, blockId: DocumentNodeId, textNodeId: DocumentNodeId, direction: AdjacentBlockDirection): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location || !isTextBearingBlock(location.node)) return undefined;
	const index = location.node.content.findIndex(child => child.id === textNodeId && child.text !== undefined);
	if (index < 0) return undefined;
	const adjacent = location.node.content[index + (direction === "backward" ? -1 : 1)];
	const current = location.node.content[index];
	if (!adjacent || !current || adjacent.text === undefined || current.text === undefined || !marksEqual(adjacent.marks, current.marks)) return undefined;
	if (direction === "backward") {
		const offset = adjacent.text.length;
		const transaction = new DocumentTransaction()
			.replaceText(adjacent.id, offset, offset, current.text)
			.deleteNode(current.id)
			.withSelection(textSelection({ nodeId: adjacent.id, offset: offset + current.text.length }));
		return { transaction, focus: { blockId, point: { nodeId: adjacent.id, offset: offset + current.text.length } } };
	}
	const offset = current.text.length;
	const transaction = new DocumentTransaction()
		.replaceText(current.id, offset, offset, adjacent.text)
		.deleteNode(adjacent.id)
		.withSelection(textSelection({ nodeId: current.id, offset }));
	return { transaction, focus: { blockId, point: { nodeId: current.id, offset } } };
}

/** Moves a block within its current parent while preserving its identity. */
export function createMoveBlockCommand(document: DocumentNode, blockId: DocumentNodeId, direction: BlockMoveDirection): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location?.parent || location.node.type === "doc") return undefined;
	const nextIndex = direction === "up" ? location.index - 1 : location.index + 1;
	if (nextIndex < 0 || nextIndex >= location.parent.content.length) return undefined;
	return {
		transaction: new DocumentTransaction().moveNode(blockId, location.parent.id, nextIndex),
		focus: { blockId },
	};
}

/** Inserts an empty paragraph after a block and makes it the next focus target. */
export function createInsertParagraphAfterCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location?.parent) return undefined;
	const paragraph = schema.createNode("paragraph");
	return {
		transaction: new DocumentTransaction().insertNode(location.parent.id, location.index + 1, paragraph),
		focus: { blockId: paragraph.id },
	};
}

/** Inserts a rectangular table after the active block and focuses its first cell. */
export function createInsertTableCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, rows = 2, columns = 2): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location?.parent || !isTextBearingBlock(location.node) || !Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || rows > 20 || columns < 1 || columns > 20) return undefined;
	const tableRows: DocumentNode[] = [];
	let firstParagraph: DocumentNode | undefined;
	for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
		const cells: DocumentNode[] = [];
		for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
			const paragraph = schema.createNode("paragraph");
			firstParagraph ??= paragraph;
			cells.push(schema.createNode("tableCell", { content: [paragraph] }));
		}
		tableRows.push(schema.createNode("tableRow", { content: cells }));
	}
	const table = schema.createNode("table", { content: tableRows });
	const transaction = new DocumentTransaction().insertNode(location.parent.id, location.index + 1, table);
	return { transaction, focus: { blockId: firstParagraph!.id } };
}

/** Returns the table, row, and cell containing a descendant node. */
export function findTableCellContext(document: DocumentNode, descendantId: DocumentNodeId): TableCellContext | undefined {
	return findTableCellContextInNode(document, descendantId);
}

/** Returns the next or previous cell in document order without changing the document. */
export function findAdjacentTableCell(document: DocumentNode, cellId: DocumentNodeId, direction: TableCellDirection): DocumentNodeId | undefined {
	const context = findTableCellContext(document, cellId);
	if (!context) return undefined;
	const cells = context.table.content.flatMap(row => row.type === "tableRow" ? row.content.filter(cell => cell.type === "tableCell") : []);
	const index = cells.findIndex(cell => cell.id === context.cell.id);
	if (index < 0) return undefined;
	return cells[index + (direction === "backward" ? -1 : 1)]?.id;
}

/** Inserts an empty row into a table and focuses its first cell. */
export function createInsertTableRowCommand(schema: DocumentSchema, document: DocumentNode, tableId: DocumentNodeId, index?: number): DocumentCommand | undefined {
	const table = findTableNode(document, tableId);
	if (!table) return undefined;
	const rows = table.content.filter(child => child.type === "tableRow");
	if (rows.length === 0) return undefined;
	const columns = Math.max(...rows.map(row => row.content.filter(child => child.type === "tableCell").length));
	if (columns < 1 || columns > 100) return undefined;
	const insertIndex = index ?? table.content.length;
	if (!Number.isSafeInteger(insertIndex) || insertIndex < 0 || insertIndex > table.content.length) return undefined;
	const created = createTableRow(schema, columns);
	return {
		transaction: new DocumentTransaction().insertNode(table.id, insertIndex, created.row),
		focus: { blockId: created.firstBlockId },
	};
}

/** Inserts an empty cell into every row at the given column position. */
export function createInsertTableColumnCommand(schema: DocumentSchema, document: DocumentNode, tableId: DocumentNodeId, columnIndex: number): DocumentCommand | undefined {
	const table = findTableNode(document, tableId);
	if (!table || !Number.isSafeInteger(columnIndex) || columnIndex < 0) return undefined;
	const rows = table.content.filter(child => child.type === "tableRow");
	if (rows.length === 0 || columnIndex > Math.max(...rows.map(row => row.content.length))) return undefined;
	let transaction = new DocumentTransaction();
	let firstBlockId: DocumentNodeId | undefined;
	for (const row of rows) {
		const cell = createTableCell(schema);
		firstBlockId ??= cell.firstBlockId;
		transaction = transaction.insertNode(row.id, Math.min(columnIndex, row.content.length), cell.node);
	}
	return firstBlockId ? { transaction, focus: { blockId: firstBlockId } } : undefined;
}

/** Deletes a row while keeping at least one row and focuses the nearest surviving row. */
export function createDeleteTableRowCommand(document: DocumentNode, tableId: DocumentNodeId, rowId: DocumentNodeId): DocumentCommand | undefined {
	const table = findTableNode(document, tableId);
	if (!table || table.content.length <= 1) return undefined;
	const rowIndex = table.content.findIndex(child => child.id === rowId && child.type === "tableRow");
	if (rowIndex < 0) return undefined;
	const targetRow = table.content[rowIndex + 1] ?? table.content[rowIndex - 1];
	if (!targetRow) return undefined;
	return {
		transaction: new DocumentTransaction().deleteNode(rowId),
		focus: { blockId: firstTableFocusId(targetRow) },
	};
}

/** Deletes a column from every row while keeping at least one column. */
export function createDeleteTableColumnCommand(document: DocumentNode, tableId: DocumentNodeId, columnIndex: number): DocumentCommand | undefined {
	const table = findTableNode(document, tableId);
	if (!table || !Number.isSafeInteger(columnIndex) || columnIndex < 0) return undefined;
	const rows = table.content.filter(child => child.type === "tableRow");
	if (rows.length === 0 || rows.some(row => row.content.length <= 1) || columnIndex >= rows[0]!.content.length) return undefined;
	let transaction = new DocumentTransaction();
	for (const row of rows) transaction = transaction.deleteNode(row.content[columnIndex]!.id);
	const targetCell = rows[0]!.content[columnIndex + 1] ?? rows[0]!.content[columnIndex - 1];
	if (!targetCell) return undefined;
	return {
		transaction,
		focus: { blockId: firstTableFocusId(targetCell) },
	};
}

/** Inserts an inline image into a paragraph or heading. */
export function createInsertImageCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, src: string, alt = ""): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location || !isTextBearingBlock(location.node) || typeof src !== "string" || src.length === 0) return undefined;
	const image = createImageNode(schema, src, alt);
	const transaction = new DocumentTransaction().insertNode(blockId, location.node.content.length, image);
	return { transaction, focus: { blockId } };
}

/** Inserts any schema-declared inline atomic node at a text selection. */
export function createInsertInlineNodeAtSelectionCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, selection: DocumentSelection, node: DocumentNode): DocumentCommand | undefined {
	if (selection.kind !== "text" || node.text !== undefined || schema.getNodeSpec(node.type)?.kind !== "inline") return undefined;
	schema.validateFragment(node, { allowIncompleteContent: true });
	return createReplaceInlineSelectionCommand(schema, document, blockId, selection, [node]);
}

/** Inserts an inline image at a text selection, replacing selected text atomically. */
export function createInsertImageAtSelectionCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, selection: DocumentSelection, src: string, alt = ""): DocumentCommand | undefined {
	if (typeof src !== "string" || src.length === 0) return undefined;
	return createReplaceInlineSelectionCommand(schema, document, blockId, selection, [createImageNode(schema, src, alt)]);
}

/** Inserts a hard break at a text selection, replacing selected inline content atomically. */
export function createInsertHardBreakCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, selection?: DocumentSelection): DocumentCommand | undefined {
	const location = findDocumentNode(document, blockId);
	if (!location || !isTextBearingBlock(location.node)) return undefined;
	const hardBreak = schema.createNode("hardBreak");
	if (!selection) return { transaction: new DocumentTransaction().insertNode(blockId, location.node.content.length, hardBreak), focus: { blockId } };
	return createReplaceInlineSelectionCommand(schema, document, blockId, selection, [hardBreak]);
}

/** Deletes a non-collapsed inline selection, including image and hard-break nodes. */
export function createDeleteInlineSelectionCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, selection: DocumentSelection): DocumentCommand | undefined {
	if (selection.kind === "all") return createReplaceDocumentTextCommand(schema, document, "");
	if (selection.kind !== "text" || (selection.anchor.nodeId === selection.head.nodeId && selection.anchor.offset === selection.head.offset)) return undefined;
	return createReplaceInlineSelectionCommand(schema, document, blockId, selection, []) ?? createReplaceTextCommand(schema, document, blockId, selection, "");
}

/** Deletes an adjacent non-text inline node while keeping the caret in its text run. */
export function createDeleteAdjacentInlineNodeCommand(document: DocumentNode, blockId: DocumentNodeId, textNodeId: DocumentNodeId, direction: AdjacentBlockDirection): DocumentCommand | undefined {
	const blockLocation = findDocumentNode(document, blockId);
	if (!blockLocation || !isTextBearingBlock(blockLocation.node)) return undefined;
	const textIndex = blockLocation.node.content.findIndex(child => child.id === textNodeId && child.text !== undefined);
	const textNode = textIndex >= 0 ? blockLocation.node.content[textIndex] : undefined;
	const adjacent = blockLocation.node.content[textIndex + (direction === "backward" ? -1 : 1)];
	if (!textNode || textNode.text === undefined || !adjacent || adjacent.text !== undefined) return undefined;
	const point = { nodeId: textNode.id, offset: direction === "backward" ? 0 : textNode.text.length };
	const transaction = new DocumentTransaction().deleteNode(adjacent.id).withSelection(textSelection(point));
	return { transaction, focus: { blockId, point } };
}

/** Deletes a selected image or hard break and restores the nearest text caret. */
export function createDeleteNodeSelectionCommand(document: DocumentNode, selection: DocumentSelection): DocumentCommand | undefined {
	if (selection.kind !== "node") return undefined;
	const location = findDocumentNode(document, selection.nodeId);
	if (!location?.parent || location.node.text !== undefined || !isTextBearingBlock(location.parent)) return undefined;
	const nextText = location.parent.content.slice(location.index + 1).find(child => child.text !== undefined);
	const previousText = [...location.parent.content.slice(0, location.index)].reverse().find(child => child.text !== undefined);
	const point = nextText ? { nodeId: nextText.id, offset: 0 } : previousText ? { nodeId: previousText.id, offset: previousText.text!.length } : undefined;
	let transaction = new DocumentTransaction().deleteNode(location.node.id);
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId: location.parent.id, ...(point ? { point } : {}) } };
}

/** Replaces a text selection inside one block while preserving unaffected inline runs. */
export function createReplaceTextCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, selection: DocumentSelection, replacement: string, marks?: readonly DocumentMark[]): DocumentCommand | undefined {
	if (selection.kind === "all") return createReplaceDocumentTextCommand(schema, document, replacement, marks);
	if (selection.kind !== "text") return undefined;
	const crossBlockCommand = createReplaceCrossBlockTextCommand(schema, document, selection, replacement, marks);
	if (crossBlockCommand) return crossBlockCommand;
	const blockLocation = findDocumentNode(document, blockId);
	if (!blockLocation || !isTextBearingBlock(blockLocation.node)) return undefined;
	const range = resolveInlineRange(blockLocation.node, selection);
	if (!range) return undefined;
	const normalizedReplacement = normalizeInlineText(replacement);
	if (range.startIndex === range.endIndex && range.start.offset === range.end.offset) {
		const textNode = blockLocation.node.content[range.startIndex]!;
		if (textNode.text === undefined || normalizedReplacement.length === 0) return undefined;
		const offset = range.start.offset;
		const transaction = new DocumentTransaction()
			.replaceText(textNode.id, offset, offset, normalizedReplacement, marks)
			.withSelection(textSelection({ nodeId: textNode.id, offset: offset + normalizedReplacement.length }));
		return { transaction, focus: { blockId, point: { nodeId: textNode.id, offset: offset + normalizedReplacement.length } } };
	}
	if (range.selected.length === 0) return undefined;
	const startNode = blockLocation.node.content[range.startIndex]!;
	const endNode = blockLocation.node.content[range.endIndex]!;
	const insertionMarks = marks ? [...marks] : startNode.marks;
	const replacementNodes: DocumentNode[] = [];
	let prefixNode: DocumentNode | undefined;
	let insertedNode: DocumentNode | undefined;
	let suffixNode: DocumentNode | undefined;
	let startIdUsed = false;
	const createReplacementNode = (text: string, nodeMarks: DocumentNode["marks"], id?: DocumentNodeId): DocumentNode | undefined => {
		if (text.length === 0) return undefined;
		const node = schema.createText(text, { ...(id ? { id } : {}), marks: nodeMarks });
		return node;
	};
	if (range.start.offset > 0) {
		const prefix = createReplacementNode(startNode.text!.slice(0, range.start.offset), startNode.marks, startNode.id);
		if (prefix) {
			prefixNode = prefix;
			replacementNodes.push(prefix);
		}
		startIdUsed = true;
	}
	if (normalizedReplacement.length > 0) {
		const inserted = createReplacementNode(normalizedReplacement, insertionMarks, startIdUsed ? undefined : startNode.id);
		if (inserted) {
			insertedNode = inserted;
			replacementNodes.push(inserted);
		}
		startIdUsed = true;
	}
	if (range.end.offset < endNode.text!.length) {
		const suffix = createReplacementNode(endNode.text!.slice(range.end.offset), endNode.marks, range.startIndex === range.endIndex ? undefined : endNode.id);
		if (suffix) {
			suffixNode = suffix;
			replacementNodes.push(suffix);
		}
	}
	let transaction = new DocumentTransaction();
	for (let index = range.endIndex; index >= range.startIndex; index -= 1) transaction = transaction.deleteNode(blockLocation.node.content[index]!.id);
	for (let index = 0; index < replacementNodes.length; index += 1) transaction = transaction.insertNode(blockId, range.startIndex + index, replacementNodes[index]!);
	const caret = insertedNode ?? suffixNode ?? prefixNode;
	const point = caret ? { nodeId: caret.id, offset: insertedNode ? insertedNode.text!.length : suffixNode ? 0 : prefixNode!.text!.length } : undefined;
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId, ...(point ? { point } : {}) } };
}

function createReplaceCrossBlockTextCommand(schema: DocumentSchema, document: DocumentNode, selection: Extract<DocumentSelection, { kind: "text" }>, replacement: string, marks?: readonly DocumentMark[]): DocumentCommand | undefined {
	const range = resolveCrossBlockTextRange(document, selection);
	if (!range) return undefined;
	const normalizedReplacement = normalizeInlineText(replacement);
	if (normalizedReplacement.includes("\n")) return undefined;
	const startContent = range.start.block.content;
	const endContent = range.end.block.content;
	const startNode = startContent[range.start.index]!;
	const endNode = endContent[range.end.index]!;
	const replacementNodes: DocumentNode[] = [...startContent.slice(0, range.start.index)];
	let prefixNode: DocumentNode | undefined;
	let insertedNode: DocumentNode | undefined;
	let suffixNode: DocumentNode | undefined;
	if (range.start.offset > 0) {
		prefixNode = schema.createText(startNode.text!.slice(0, range.start.offset), { id: startNode.id, marks: startNode.marks });
		replacementNodes.push(prefixNode);
	}
	if (normalizedReplacement.length > 0) {
		insertedNode = schema.createText(normalizedReplacement, { ...(prefixNode ? {} : { id: startNode.id }), marks: marks ? [...marks] : startNode.marks });
		replacementNodes.push(insertedNode);
	}
	if (range.end.offset < endNode.text!.length) {
		suffixNode = schema.createText(endNode.text!.slice(range.end.offset), { id: endNode.id, marks: endNode.marks });
		replacementNodes.push(suffixNode);
	}
	replacementNodes.push(...endContent.slice(range.end.index + 1));
	let transaction = new DocumentTransaction();
	for (const child of startContent) transaction = transaction.deleteNode(child.id);
	for (let index = range.start.parentIndex + 1; index < range.end.parentIndex; index += 1) transaction = transaction.deleteNode(range.start.parent.content[index]!.id);
	transaction = transaction.deleteNode(range.end.block.id);
	for (let index = 0; index < replacementNodes.length; index += 1) transaction = transaction.insertNode(range.start.block.id, index, replacementNodes[index]!);
	const point = insertedNode
		? { nodeId: insertedNode.id, offset: insertedNode.text!.length }
		: suffixNode
			? { nodeId: suffixNode.id, offset: 0 }
			: prefixNode
				? { nodeId: prefixNode.id, offset: prefixNode.text!.length }
				: lastTextPoint(replacementNodes);
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId: range.start.block.id, ...(point ? { point } : {}) } };
}

/** Inserts multiline plain text as sibling blocks while preserving inline runs around the selection. */
export function createPasteTextCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, selection: DocumentSelection, pastedText: string, marks?: readonly DocumentMark[]): DocumentCommand | undefined {
	if (selection.kind === "all") return createReplaceDocumentTextCommand(schema, document, pastedText, marks);
	if (selection.kind !== "text") return undefined;
	const normalizedText = normalizeInlineText(pastedText);
	if (!normalizedText.includes("\n")) return createReplaceTextCommand(schema, document, blockId, selection, normalizedText, marks);
	const crossBlockCommand = createPasteCrossBlockTextCommand(schema, document, selection, normalizedText, marks);
	if (crossBlockCommand) return crossBlockCommand;
	const blockLocation = findDocumentNode(document, blockId);
	if (!blockLocation?.parent || !isTextBearingBlock(blockLocation.node)) return undefined;
	const range = resolveInlineRange(blockLocation.node, selection);
	if (!range) return undefined;
	const startNode = blockLocation.node.content[range.startIndex]!;
	const endNode = blockLocation.node.content[range.endIndex]!;
	const before = [...blockLocation.node.content.slice(0, range.startIndex)];
	const after = [...blockLocation.node.content.slice(range.endIndex + 1)];
	const prefix = range.start.offset > 0 ? schema.createText(startNode.text!.slice(0, range.start.offset), { id: startNode.id, marks: startNode.marks }) : undefined;
	const suffix = range.end.offset < endNode.text!.length ? schema.createText(endNode.text!.slice(range.end.offset), { id: range.startIndex === range.endIndex ? undefined : endNode.id, marks: endNode.marks }) : undefined;
	if (prefix) before.push(prefix);
	if (suffix) after.unshift(suffix);
	const insertionMarks = marks ? [...marks] : startNode.marks;
	const lines = normalizedText.split("\n");
	const lineContents: DocumentNode[][] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const content: DocumentNode[] = [];
		if (index === 0) content.push(...before);
		if (lines[index]!.length > 0) content.push(schema.createText(lines[index]!, { marks: insertionMarks }));
		if (index === lines.length - 1) content.push(...after);
		lineContents.push(content);
	}
	let transaction = new DocumentTransaction();
	for (const child of blockLocation.node.content) transaction = transaction.deleteNode(child.id);
	for (let index = 0; index < lineContents[0]!.length; index += 1) transaction = transaction.insertNode(blockId, index, lineContents[0]![index]!);
	const blocks = lineContents.slice(1).map(content => schema.createNode(blockLocation.node.type, { attrs: blockLocation.node.attrs, content }));
	for (let index = 0; index < blocks.length; index += 1) transaction = transaction.insertNode(blockLocation.parent.id, blockLocation.index + index + 1, blocks[index]!);
	const lastBlock = blocks.at(-1);
	const focusNode = lastTextNode(lastBlock?.content ?? []) ?? lastTextNode(lineContents[0]!);
	const focusBlockId = lastBlock?.id ?? blockId;
	const point = focusNode ? { nodeId: focusNode.id, offset: focusNode.text!.length } : undefined;
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId: focusBlockId, ...(point ? { point } : {}) } };
}

function createPasteCrossBlockTextCommand(schema: DocumentSchema, document: DocumentNode, selection: Extract<DocumentSelection, { kind: "text" }>, normalizedText: string, marks?: readonly DocumentMark[]): DocumentCommand | undefined {
	const range = resolveCrossBlockTextRange(document, selection);
	if (!range) return undefined;
	const startContent = range.start.block.content;
	const endContent = range.end.block.content;
	const startNode = startContent[range.start.index]!;
	const endNode = endContent[range.end.index]!;
	const before: DocumentNode[] = [...startContent.slice(0, range.start.index)];
	const after: DocumentNode[] = [];
	if (range.start.offset > 0) before.push(schema.createText(startNode.text!.slice(0, range.start.offset), { id: startNode.id, marks: startNode.marks }));
	if (range.end.offset < endNode.text!.length) after.push(schema.createText(endNode.text!.slice(range.end.offset), { id: endNode.id, marks: endNode.marks }));
	after.push(...endContent.slice(range.end.index + 1));
	const insertionMarks = marks ? [...marks] : startNode.marks;
	const lines = normalizedText.split("\n");
	const lineContents: DocumentNode[][] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const content: DocumentNode[] = [];
		if (index === 0) content.push(...before);
		if (lines[index]!.length > 0) content.push(schema.createText(lines[index]!, { marks: insertionMarks }));
		if (index === lines.length - 1) content.push(...after);
		lineContents.push(content);
	}
	let transaction = new DocumentTransaction();
	for (const child of startContent) transaction = transaction.deleteNode(child.id);
	for (let index = range.start.parentIndex + 1; index < range.end.parentIndex; index += 1) transaction = transaction.deleteNode(range.start.parent.content[index]!.id);
	transaction = transaction.deleteNode(range.end.block.id);
	for (let index = 0; index < lineContents[0]!.length; index += 1) transaction = transaction.insertNode(range.start.block.id, index, lineContents[0]![index]!);
	const blocks = lineContents.slice(1).map(content => schema.createNode(range.start.block.type, { attrs: range.start.block.attrs, content }));
	for (let index = 0; index < blocks.length; index += 1) transaction = transaction.insertNode(range.start.parent.id, range.start.parentIndex + index + 1, blocks[index]!);
	const lastBlock = blocks.at(-1);
	const focusNode = lastTextNode(lastBlock?.content ?? []) ?? lastTextNode(lineContents[0]!);
	const focusBlockId = lastBlock?.id ?? range.start.block.id;
	const point = focusNode ? { nodeId: focusNode.id, offset: focusNode.text!.length } : undefined;
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId: focusBlockId, ...(point ? { point } : {}) } };
}

/** Inserts a Stanza fragment at a text selection while remapping pasted node identities. */
export function createInsertFragmentCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, selection: DocumentSelection, fragment: DocumentFragment): DocumentCommand | undefined {
	if (fragment.content.length === 0) return undefined;
	if (selection.kind === "all") return createReplaceDocumentFragmentCommand(schema, document, fragment);
	if (selection.kind !== "text") return undefined;
	try {
		for (const node of fragment.content) schema.validateFragment(node);
	} catch {
		return undefined;
	}
	const location = findDocumentNode(document, blockId);
	if (!location?.parent || !isTextBearingBlock(location.node)) return undefined;
	const parent = location.parent;
	const range = resolveInlineRange(location.node, selection);
	if (!range) return undefined;
	const pastedBlocks = fragment.content.map(node => cloneNodeWithFreshIds(schema, node));
	if (pastedBlocks.length === 1 && isTextBearingBlock(pastedBlocks[0]!)) return createReplaceInlineSelectionCommand(schema, document, blockId, selection, pastedBlocks[0]!.content);
	if (!schema.canContainChild(parent.type, location.node.type) || pastedBlocks.some(node => !schema.canContainChild(parent.type, node.type))) return undefined;
	const startNode = location.node.content[range.startIndex]!;
	const endNode = location.node.content[range.endIndex]!;
	const before = [...location.node.content.slice(0, range.startIndex)];
	const after = [...location.node.content.slice(range.endIndex + 1)];
	if (range.start.offset > 0) before.push(schema.createText(startNode.text!.slice(0, range.start.offset), { id: startNode.id, marks: startNode.marks }));
	if (range.end.offset < endNode.text!.length) after.unshift(schema.createText(endNode.text!.slice(range.end.offset), { id: range.startIndex === range.endIndex ? undefined : endNode.id, marks: endNode.marks }));
	if (pastedBlocks.every(isTextBearingBlock)) {
		const first = schema.createNode(location.node.type, { attrs: location.node.attrs, content: [...before, ...pastedBlocks[0]!.content] });
		const lastIndex = pastedBlocks.length - 1;
		const blocks = [first, ...pastedBlocks.slice(1, lastIndex), schema.createNode(pastedBlocks[lastIndex]!.type, { attrs: pastedBlocks[lastIndex]!.attrs, content: [...pastedBlocks[lastIndex]!.content, ...after] })];
		let transaction = new DocumentTransaction();
		for (const child of location.node.content) transaction = transaction.deleteNode(child.id);
		for (let index = 0; index < first.content.length; index += 1) transaction = transaction.insertNode(blockId, index, first.content[index]!);
		for (let index = 1; index < blocks.length; index += 1) transaction = transaction.insertNode(parent.id, location.index + index, blocks[index]!);
		const focusBlock = blocks.at(-1)!;
		const focusNode = lastTextNode(focusBlock.content) ?? firstTextNode(focusBlock.content);
		const point = focusNode ? { nodeId: focusNode.id, offset: focusNode.text!.length } : undefined;
		if (point) transaction = transaction.withSelection(textSelection(point));
		return { transaction, focus: { blockId: focusBlock.id, ...(point ? { point } : {}) } };
	}
	const prefix = before.length > 0 ? schema.createNode(location.node.type, { attrs: location.node.attrs, content: before }) : undefined;
	const suffix = after.length > 0 ? schema.createNode(location.node.type, { attrs: location.node.attrs, content: after }) : undefined;
	const blocks = [...(prefix ? [prefix] : []), ...pastedBlocks, ...(suffix ? [suffix] : [])];
	if (blocks.length === 0) return undefined;
	let transaction = new DocumentTransaction();
	transaction = transaction.deleteNode(location.node.id);
	for (let index = 0; index < blocks.length; index += 1) transaction = transaction.insertNode(parent.id, location.index + index, blocks[index]!);
	const focusBlock = blocks.at(-1)!;
	const focusNode = lastTextNodeDeep(focusBlock) ?? firstTextNodeDeep(focusBlock);
	const point = focusNode ? { nodeId: focusNode.id, offset: focusNode.text!.length } : undefined;
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId: focusBlock.id, ...(point ? { point } : {}) } };
}

function cloneNodeWithFreshIds(schema: DocumentSchema, node: DocumentNode): DocumentNode {
	if (node.text !== undefined) return schema.createText(node.text, { marks: node.marks });
	return schema.createNode(node.type, { attrs: node.attrs, content: node.content.map(child => cloneNodeWithFreshIds(schema, child)) });
}

function createReplaceDocumentTextCommand(schema: DocumentSchema, document: DocumentNode, replacement: string, marks?: readonly DocumentMark[]): DocumentCommand | undefined {
	if (!schema.canContainChild(schema.topNodeType, "paragraph")) return undefined;
	const content = normalizeInlineText(replacement).split("\n").map(line => schema.createNode("paragraph", { content: line.length > 0 ? [schema.createText(line, { marks: marks ?? [] })] : [] }));
	return createReplaceDocumentContentCommand(schema, document, content);
}

function createReplaceDocumentFragmentCommand(schema: DocumentSchema, document: DocumentNode, fragment: DocumentFragment): DocumentCommand | undefined {
	let content: readonly DocumentNode[];
	try {
		content = fragment.content.map(node => cloneNodeWithFreshIds(schema, node));
		let rootId = "__ash_document_replace_root__";
		while (content.some(node => node.id === rootId)) rootId += "_";
		schema.createDocument(content, rootId);
	} catch {
		return undefined;
	}
	return createReplaceDocumentContentCommand(schema, document, content);
}

function createReplaceDocumentContentCommand(schema: DocumentSchema, document: DocumentNode, content: readonly DocumentNode[]): DocumentCommand | undefined {
	if (document.type !== schema.topNodeType) return undefined;
	if (content.some(node => !schema.canContainChild(schema.topNodeType, node.type))) return undefined;
	let transaction = new DocumentTransaction();
	for (const child of document.content) transaction = transaction.deleteNode(child.id);
	for (let index = 0; index < content.length; index += 1) transaction = transaction.insertNode(document.id, index, content[index]!);
	const focusBlock = lastEditableBlock(content);
	const point = focusBlock ? lastTextPointInNode(focusBlock) : undefined;
	transaction = point ? transaction.withSelection(textSelection(point)) : transaction.withSelection(undefined);
	const blockId = focusBlock?.id ?? document.id;
	return { transaction, focus: { blockId, ...(point ? { point } : {}) } };
}

function lastEditableBlock(content: readonly DocumentNode[]): DocumentNode | undefined {
	for (let index = content.length - 1; index >= 0; index -= 1) {
		const block = lastEditableBlockInNode(content[index]!);
		if (block) return block;
	}
	return undefined;
}

function lastEditableBlockInNode(node: DocumentNode): DocumentNode | undefined {
	if (node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock") return node;
	for (let index = node.content.length - 1; index >= 0; index -= 1) {
		const block = lastEditableBlockInNode(node.content[index]!);
		if (block) return block;
	}
	return undefined;
}

function lastTextPointInNode(node: DocumentNode): DocumentPoint | undefined {
	if (node.text !== undefined) return { nodeId: node.id, offset: node.text.length };
	for (let index = node.content.length - 1; index >= 0; index -= 1) {
		const point = lastTextPointInNode(node.content[index]!);
		if (point) return point;
	}
	return undefined;
}

/** Toggles a mark across a selection in one text-bearing block, splitting inline runs when necessary. */
export function createToggleMarkCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, textNodeId: DocumentNodeId, selection: DocumentSelection, markType: string, attrs: DocumentAttributes = {}, storedMarks?: readonly DocumentMark[]): DocumentCommand | undefined {
	return createMarkCommand(schema, document, blockId, textNodeId, selection, markType, attrs, "toggle", storedMarks);
}

/** Applies a mark across a text selection, updating attributes on existing marks. */
export function createSetMarkCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, textNodeId: DocumentNodeId, selection: DocumentSelection, markType: string, attrs: DocumentAttributes = {}, storedMarks?: readonly DocumentMark[]): DocumentCommand | undefined {
	return createMarkCommand(schema, document, blockId, textNodeId, selection, markType, attrs, "set", storedMarks);
}

/** Updates one persistent typography attribute without discarding the other text-style attribute. */
export function createSetTextStyleCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, textNodeId: DocumentNodeId, selection: DocumentSelection, attrs: DocumentTextStyleAttributes, storedMarks?: readonly DocumentMark[]): DocumentCommand | undefined {
	return createMarkCommand(schema, document, blockId, textNodeId, selection, "textStyle", { ...attrs }, "merge", storedMarks);
}

/** Removes a mark across a text selection. */
export function createRemoveMarkCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, textNodeId: DocumentNodeId, selection: DocumentSelection, markType: string, storedMarks?: readonly DocumentMark[]): DocumentCommand | undefined {
	return createMarkCommand(schema, document, blockId, textNodeId, selection, markType, {}, "remove", storedMarks);
}

/** Sets a validated link mark across a text selection. */
export function createSetLinkMarkCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, textNodeId: DocumentNodeId, selection: DocumentSelection, href: string, storedMarks?: readonly DocumentMark[]): DocumentCommand | undefined {
	const normalizedHref = typeof href === "string" ? href.trim() : "";
	if (normalizedHref.length === 0) return undefined;
	return createSetMarkCommand(schema, document, blockId, textNodeId, selection, "link", { href: normalizedHref }, storedMarks);
}

function createMarkCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, textNodeId: DocumentNodeId, selection: DocumentSelection, markType: string, attrs: DocumentAttributes, mode: "remove" | "set" | "toggle" | "merge", storedMarks?: readonly DocumentMark[]): DocumentCommand | undefined {
	if (selection.kind !== "text" || (selection.anchor.nodeId !== textNodeId && selection.head.nodeId !== textNodeId)) return undefined;
	const blockLocation = findDocumentNode(document, blockId);
	if (!blockLocation || !isTextBearingBlock(blockLocation.node)) return undefined;
	const range = resolveInlineRange(blockLocation.node, selection);
	if (!range) return undefined;
	if (typeof markType !== "string" || markType.length === 0) return undefined;
	if (range.selected.length === 0 || (range.startIndex === range.endIndex && range.start.offset === range.end.offset)) {
		const point = selection.anchor;
		const currentMarks = storedMarks ?? marksAtPoint(blockLocation.node, point);
		const nextMarks = updateStoredMarks(schema, currentMarks, markType, attrs, mode);
		return { transaction: new DocumentTransaction().withSelection(selection).withStoredMarks(nextMarks), focus: { blockId, point } };
	}
	const removeMark = mode === "remove" || (mode === "toggle" && range.selected.every(part => part.node.marks.some(mark => mark.type === markType)));
	const replacements = new Map<number, readonly TextSegment[]>();
	for (let index = range.startIndex; index <= range.endIndex; index += 1) {
		const node = blockLocation.node.content[index]!;
		const from = index === range.startIndex ? range.start.offset : 0;
		const to = index === range.endIndex ? range.end.offset : node.text!.length;
		replacements.set(index, createMarkedTextSegments(schema, node, from, to, markType, attrs, removeMark, mode === "set" || mode === "merge", mode === "merge"));
	}
	let transaction = new DocumentTransaction();
	for (let index = range.endIndex; index >= range.startIndex; index -= 1) {
		const node = blockLocation.node.content[index]!;
		const replacement = replacements.get(index)!;
		transaction = transaction.deleteNode(node.id);
		for (let offset = 0; offset < replacement.length; offset += 1) transaction = transaction.insertNode(blockId, index + offset, replacement[offset]!.node);
	}
	const mappedStart = mapInlineBoundary(range.start, replacements.get(range.startIndex)!, true);
	const mappedEnd = mapInlineBoundary(range.end, replacements.get(range.endIndex)!, false);
	const mappedAnchor = range.forward ? mappedStart : mappedEnd;
	const mappedHead = range.forward ? mappedEnd : mappedStart;
	transaction = transaction.withSelection(textSelection(mappedAnchor, mappedHead));
	return { transaction, focus: { blockId, point: mappedAnchor } };
}

function marksAtPoint(block: DocumentNode, point: DocumentPoint): readonly DocumentMark[] {
	const node = block.content.find(child => child.id === point.nodeId && child.text !== undefined);
	return node?.marks ?? [];
}

function updateStoredMarks(schema: DocumentSchema, current: readonly DocumentMark[], markType: string, attrs: DocumentAttributes, mode: "remove" | "set" | "toggle" | "merge"): readonly DocumentMark[] {
	const hasMark = current.some(mark => mark.type === markType);
	const remove = mode === "remove" || (mode === "toggle" && hasMark);
	const existing = current.find(mark => mark.type === markType);
	const nextAttrs = mode === "merge" && existing ? { ...existing.attrs, ...attrs } : attrs;
	const next = remove
		? current.filter(mark => mark.type !== markType)
		: [...current.filter(mark => mark.type !== markType), { type: markType, attrs: nextAttrs }];
	schema.validateMarks(next);
	return Object.freeze(next.map(mark => Object.freeze({ type: mark.type, attrs: Object.freeze({ ...(mark.attrs ?? {}) }) })));
}

function isTextBearingBlock(node: DocumentNode): boolean {
	return node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock";
}

function findTableNode(document: DocumentNode, tableId: DocumentNodeId): DocumentNode | undefined {
	const location = findDocumentNode(document, tableId);
	return location?.node.type === "table" ? location.node : undefined;
}

function createImageNode(schema: DocumentSchema, src: string, alt: string): DocumentNode {
	return schema.createNode("image", { attrs: { src, ...(alt.length > 0 ? { alt } : {}) } });
}

function findTableCellContextInNode(node: DocumentNode, descendantId: DocumentNodeId, table?: DocumentNode, row?: DocumentNode, rowIndex = -1, columnIndex = -1): TableCellContext | undefined {
	if (node.type === "table") {
		for (let index = 0; index < node.content.length; index += 1) {
			const child = node.content[index]!;
			const nested = findTableCellContextInNode(child, descendantId, node, row, index, columnIndex);
			if (nested) return nested;
		}
		return undefined;
	}
	if (node.type === "tableRow") {
		for (let index = 0; index < node.content.length; index += 1) {
			const child = node.content[index]!;
			const nested = findTableCellContextInNode(child, descendantId, table, node, rowIndex, index);
			if (nested) return nested;
		}
		return undefined;
	}
	if (node.type === "tableCell") {
		if (table && row && containsDocumentNode(node, descendantId)) return { table, row, cell: node, rowIndex, columnIndex };
		for (const child of node.content) {
			const nested = findTableCellContextInNode(child, descendantId, table, row, rowIndex, columnIndex);
			if (nested) return nested;
		}
		return undefined;
	}
	for (const child of node.content) {
		const nested = findTableCellContextInNode(child, descendantId, table, row, rowIndex, columnIndex);
		if (nested) return nested;
	}
	return undefined;
}

function createTableRow(schema: DocumentSchema, columns: number): { readonly row: DocumentNode; readonly firstBlockId: DocumentNodeId } {
	const cells: DocumentNode[] = [];
	let firstBlockId: DocumentNodeId | undefined;
	for (let index = 0; index < columns; index += 1) {
		const cell = createTableCell(schema);
		firstBlockId ??= cell.firstBlockId;
		cells.push(cell.node);
	}
	return { row: schema.createNode("tableRow", { content: cells }), firstBlockId: firstBlockId! };
}

function createTableCell(schema: DocumentSchema): { readonly node: DocumentNode; readonly firstBlockId: DocumentNodeId } {
	const paragraph = schema.createNode("paragraph");
	return { node: schema.createNode("tableCell", { content: [paragraph] }), firstBlockId: paragraph.id };
}

function firstTableFocusId(node: DocumentNode): DocumentNodeId {
	if (node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock") return node.id;
	return node.content.length > 0 ? firstTableFocusId(node.content[0]!) : node.id;
}

function isListType(type: string): boolean {
	return type === "bulletList" || type === "orderedList";
}

function listAttributes(type: "bulletList" | "orderedList", attrs: DocumentAttributes): DocumentAttributes {
	return type === "orderedList" ? { order: typeof attrs.order === "number" ? attrs.order : 1 } : {};
}

function firstTextPoint(content: readonly DocumentNode[]): DocumentPoint | undefined {
	const text = content.find(child => child.text !== undefined);
	return text ? { nodeId: text.id, offset: 0 } : undefined;
}

function lastTextPoint(content: readonly DocumentNode[]): DocumentPoint | undefined {
	const text = lastTextNode(content);
	return text ? { nodeId: text.id, offset: text.text!.length } : undefined;
}

function firstTextNode(content: readonly DocumentNode[]): DocumentNode | undefined {
	return content.find(child => child.text !== undefined);
}

function lastTextNode(content: readonly DocumentNode[]): DocumentNode | undefined {
	return [...content].reverse().find(child => child.text !== undefined);
}

function firstTextNodeDeep(node: DocumentNode): DocumentNode | undefined {
	if (node.text !== undefined) return node;
	for (const child of node.content) {
		const text = firstTextNodeDeep(child);
		if (text) return text;
	}
	return undefined;
}

function lastTextNodeDeep(node: DocumentNode): DocumentNode | undefined {
	if (node.text !== undefined) return node;
	for (let index = node.content.length - 1; index >= 0; index -= 1) {
		const text = lastTextNodeDeep(node.content[index]!);
		if (text) return text;
	}
	return undefined;
}

function marksEqual(left: DocumentNode["marks"], right: DocumentNode["marks"]): boolean {
	if (left.length !== right.length) return false;
	return left.every((mark, index) => {
		const other = right[index];
		return mark.type === other?.type && JSON.stringify(mark.attrs) === JSON.stringify(other.attrs);
	});
}

function normalizeInlineText(text: string): string {
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

interface InlineRange {
	readonly startIndex: number;
	readonly endIndex: number;
	readonly start: DocumentPoint;
	readonly end: DocumentPoint;
	readonly forward: boolean;
	readonly selected: readonly { node: DocumentNode; from: number; to: number }[];
}

interface TextBearingBlockLocation {
	readonly block: DocumentNode;
	readonly parent: DocumentNode;
	readonly parentIndex: number;
}

interface CrossBlockTextRange {
	readonly start: TextBearingBlockLocation & { readonly index: number; readonly offset: number };
	readonly end: TextBearingBlockLocation & { readonly index: number; readonly offset: number };
}

interface TextSegment {
	readonly from: number;
	readonly to: number;
	readonly node: DocumentNode;
}

interface InlineNodeRange {
	readonly startIndex: number;
	readonly endIndex: number;
	readonly start: DocumentPoint;
	readonly end: DocumentPoint;
	readonly forward: boolean;
}

function createReplaceInlineSelectionCommand(schema: DocumentSchema, document: DocumentNode, blockId: DocumentNodeId, selection: DocumentSelection, replacementNodes: readonly DocumentNode[]): DocumentCommand | undefined {
	if (selection.kind !== "text") return undefined;
	const location = findDocumentNode(document, blockId);
	if (!location || !isTextBearingBlock(location.node)) return undefined;
	const range = resolveInlineNodeRange(location.node, selection);
	if (!range) return undefined;
	const startNode = location.node.content[range.startIndex]!;
	const endNode = location.node.content[range.endIndex]!;
	const nodes: DocumentNode[] = [];
	let prefixNode: DocumentNode | undefined;
	let suffixNode: DocumentNode | undefined;
	if (range.start.offset > 0) {
		prefixNode = schema.createText(startNode.text!.slice(0, range.start.offset), { id: startNode.id, marks: startNode.marks });
		nodes.push(prefixNode);
	}
	nodes.push(...replacementNodes);
	if (range.end.offset < endNode.text!.length) {
		suffixNode = schema.createText(endNode.text!.slice(range.end.offset), { ...(range.startIndex === range.endIndex ? {} : { id: endNode.id }), marks: endNode.marks });
		nodes.push(suffixNode);
	}
	let transaction = new DocumentTransaction();
	for (let index = range.endIndex; index >= range.startIndex; index -= 1) transaction = transaction.deleteNode(location.node.content[index]!.id);
	for (let index = 0; index < nodes.length; index += 1) transaction = transaction.insertNode(blockId, range.startIndex + index, nodes[index]!);
	const point = suffixNode ? { nodeId: suffixNode.id, offset: 0 } : prefixNode ? { nodeId: prefixNode.id, offset: prefixNode.text!.length } : findInlineSelectionFallbackPoint(location.node.content, range.startIndex, range.endIndex);
	if (point) transaction = transaction.withSelection(textSelection(point));
	return { transaction, focus: { blockId, ...(point ? { point } : {}) } };
}

function findInlineSelectionFallbackPoint(content: readonly DocumentNode[], startIndex: number, endIndex: number): DocumentPoint | undefined {
	for (let index = endIndex + 1; index < content.length; index += 1) {
		const text = content[index];
		if (text?.text !== undefined) return { nodeId: text.id, offset: 0 };
	}
	for (let index = startIndex - 1; index >= 0; index -= 1) {
		const text = content[index];
		if (text?.text !== undefined) return { nodeId: text.id, offset: text.text.length };
	}
	return undefined;
}

function resolveInlineNodeRange(block: DocumentNode, selection: Extract<DocumentSelection, { kind: "text" }>): InlineNodeRange | undefined {
	const anchorIndex = block.content.findIndex(child => child.id === selection.anchor.nodeId && child.text !== undefined);
	const headIndex = block.content.findIndex(child => child.id === selection.head.nodeId && child.text !== undefined);
	if (anchorIndex < 0 || headIndex < 0) return undefined;
	const anchorNode = block.content[anchorIndex]!;
	const headNode = block.content[headIndex]!;
	if (selection.anchor.offset > anchorNode.text!.length || selection.head.offset > headNode.text!.length) return undefined;
	const forward = anchorIndex < headIndex || (anchorIndex === headIndex && selection.anchor.offset <= selection.head.offset);
	return {
		startIndex: forward ? anchorIndex : headIndex,
		endIndex: forward ? headIndex : anchorIndex,
		start: forward ? selection.anchor : selection.head,
		end: forward ? selection.head : selection.anchor,
		forward,
	};
}

function resolveCrossBlockTextRange(document: DocumentNode, selection: Extract<DocumentSelection, { kind: "text" }>): CrossBlockTextRange | undefined {
	const anchor = findTextBearingBlockLocation(document, selection.anchor.nodeId);
	const head = findTextBearingBlockLocation(document, selection.head.nodeId);
	if (!anchor || !head || anchor.block.id === head.block.id || anchor.parent.id !== head.parent.id) return undefined;
	const forward = anchor.parentIndex < head.parentIndex;
	const start = forward ? { location: anchor, point: selection.anchor } : { location: head, point: selection.head };
	const end = forward ? { location: head, point: selection.head } : { location: anchor, point: selection.anchor };
	const startIndex = start.location.block.content.findIndex(child => child.id === start.point.nodeId && child.text !== undefined);
	const endIndex = end.location.block.content.findIndex(child => child.id === end.point.nodeId && child.text !== undefined);
	const startNode = start.location.block.content[startIndex];
	const endNode = end.location.block.content[endIndex];
	if (startIndex < 0 || endIndex < 0 || !startNode || !endNode || startNode.text === undefined || endNode.text === undefined) return undefined;
	if (start.point.offset > startNode.text.length || end.point.offset > endNode.text.length) return undefined;
	for (let index = start.location.parentIndex; index <= end.location.parentIndex; index += 1) {
		if (!isTextBearingBlock(start.location.parent.content[index]!)) return undefined;
	}
	return {
		start: { ...start.location, index: startIndex, offset: start.point.offset },
		end: { ...end.location, index: endIndex, offset: end.point.offset },
	};
}

function findTextBearingBlockLocation(root: DocumentNode, textNodeId: DocumentNodeId): TextBearingBlockLocation | undefined {
	const textLocation = findDocumentNode(root, textNodeId);
	const block = textLocation?.parent;
	if (!block || !isTextBearingBlock(block)) return undefined;
	const blockLocation = findDocumentNode(root, block.id);
	if (!blockLocation?.parent) return undefined;
	return { block, parent: blockLocation.parent, parentIndex: blockLocation.index };
}

function resolveInlineRange(block: DocumentNode, selection: Extract<DocumentSelection, { kind: "text" }>): InlineRange | undefined {
	const anchorIndex = block.content.findIndex(child => child.id === selection.anchor.nodeId && child.text !== undefined);
	const headIndex = block.content.findIndex(child => child.id === selection.head.nodeId && child.text !== undefined);
	if (anchorIndex < 0 || headIndex < 0) return undefined;
	const anchorNode = block.content[anchorIndex]!;
	const headNode = block.content[headIndex]!;
	if (selection.anchor.offset > anchorNode.text!.length || selection.head.offset > headNode.text!.length) return undefined;
	const forward = anchorIndex < headIndex || (anchorIndex === headIndex && selection.anchor.offset <= selection.head.offset);
	const startIndex = forward ? anchorIndex : headIndex;
	const endIndex = forward ? headIndex : anchorIndex;
	const start = forward ? selection.anchor : selection.head;
	const end = forward ? selection.head : selection.anchor;
	const selected: { node: DocumentNode; from: number; to: number }[] = [];
	for (let index = startIndex; index <= endIndex; index += 1) {
		const node = block.content[index]!;
		if (node.text === undefined) return undefined;
		const from = index === startIndex ? start.offset : 0;
		const to = index === endIndex ? end.offset : node.text.length;
		if (to < from) return undefined;
		if (to > from) selected.push({ node, from, to });
	}
	return { startIndex, endIndex, start, end, forward, selected };
}

function createMarkedTextSegments(schema: DocumentSchema, node: DocumentNode, from: number, to: number, markType: string, attrs: DocumentAttributes, removeMark: boolean, replaceExisting: boolean, mergeExisting = false): readonly TextSegment[] {
	if (from === to) return [{ from: 0, to: node.text!.length, node }];
	const parts: Array<{ from: number; to: number; marks: DocumentNode["marks"] }> = [];
	if (from > 0) parts.push({ from: 0, to: from, marks: node.marks });
	if (to > from) {
		const marks = removeMark
			? node.marks.filter(mark => mark.type !== markType)
			: replaceExisting
				? node.marks.some(mark => mark.type === markType)
					? node.marks.map(mark => mark.type === markType ? { type: markType, attrs: mergeExisting ? { ...mark.attrs, ...attrs } : attrs } : mark)
					: [...node.marks, { type: markType, attrs }]
				: node.marks.some(mark => mark.type === markType) ? node.marks : [...node.marks, { type: markType, attrs }];
		parts.push({ from, to, marks });
	}
	if (to < node.text!.length) parts.push({ from: to, to: node.text!.length, marks: node.marks });
	return parts.map((part, index) => ({ from: part.from, to: part.to, node: schema.createText(node.text!.slice(part.from, part.to), { ...(index === 0 ? { id: node.id } : {}), marks: part.marks }) }));
}

function mapInlineBoundary(point: DocumentPoint, segments: readonly TextSegment[], preferNext: boolean): DocumentPoint {
	const segment = segments.find(candidate => point.offset > candidate.from && point.offset < candidate.to)
		?? (preferNext ? segments.find(candidate => candidate.from === point.offset) : undefined)
		?? [...segments].reverse().find(candidate => candidate.to === point.offset)
		?? segments[0]!;
	return { nodeId: segment.node.id, offset: Math.max(0, Math.min(segment.to - segment.from, point.offset - segment.from)) };
}
