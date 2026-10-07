import { CharCode } from "../../../../base/common/charCode.js";
import { NodeColor } from "./rbTreeBase.js";

export enum PieceBuffer {
	Original,
	Add,
}

export interface BufferPiece {
	readonly buffer: PieceBuffer;
	readonly startOffset: number;
	readonly length: number;
	readonly lineFeedOffsets: readonly number[];
}

export class PieceNode {
	parent: PieceNode | undefined;
	left: PieceNode | undefined;
	right: PieceNode | undefined;
	color = NodeColor.Red;
	totalLength: number;
	totalLineFeeds: number;
	totalPieces: number;

	constructor(public piece: BufferPiece) {
		this.totalLength = piece.length;
		this.totalLineFeeds = piece.lineFeedOffsets.length;
		this.totalPieces = 1;
	}

	recompute(): void {
		this.totalLength = nodeLength(this.left) + this.piece.length + nodeLength(this.right);
		this.totalLineFeeds = nodeLineFeeds(this.left) + this.piece.lineFeedOffsets.length + nodeLineFeeds(this.right);
		this.totalPieces = nodePieces(this.left) + 1 + nodePieces(this.right);
	}
}

export function createPiece(buffer: PieceBuffer, startOffset: number, text: string): BufferPiece {
	const lineFeedOffsets: number[] = [];
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === CharCode.LineFeed) lineFeedOffsets.push(index);
	}
	return { buffer, startOffset, length: text.length, lineFeedOffsets };
}

export function slicePiece(piece: BufferPiece, startOffset: number, endOffset: number): BufferPiece {
	const firstLineFeed = lowerBound(piece.lineFeedOffsets, startOffset);
	const lastLineFeed = lowerBound(piece.lineFeedOffsets, endOffset);
	return {
		buffer: piece.buffer,
		startOffset: piece.startOffset + startOffset,
		length: endOffset - startOffset,
		lineFeedOffsets: piece.lineFeedOffsets.slice(firstLineFeed, lastLineFeed).map(offset => offset - startOffset),
	};
}

export function canCoalesce(left: BufferPiece, right: BufferPiece): boolean {
	return left.buffer === right.buffer && left.startOffset + left.length === right.startOffset;
}

export function coalescePieces(left: BufferPiece, right: BufferPiece): BufferPiece {
	return {
		buffer: left.buffer,
		startOffset: left.startOffset,
		length: left.length + right.length,
		lineFeedOffsets: [...left.lineFeedOffsets, ...right.lineFeedOffsets.map(offset => left.length + offset)],
	};
}

export function updateNodeAndAncestors(node: PieceNode): void {
	let current: PieceNode | undefined = node;
	while (current) {
		current.recompute();
		current = current.parent;
	}
}

export function nodeLength(node: PieceNode | undefined): number {
	return node?.totalLength ?? 0;
}

export function nodeLineFeeds(node: PieceNode | undefined): number {
	return node?.totalLineFeeds ?? 0;
}

export function nodePieces(node: PieceNode | undefined): number {
	return node?.totalPieces ?? 0;
}

export function lowerBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (values[middle] < target) low = middle + 1;
		else high = middle;
	}
	return low;
}
