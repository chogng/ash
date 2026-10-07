export interface OffsetTextEdit {
	readonly startOffset: number;
	readonly endOffset: number;
	readonly text: string;
}

export function canCoalesceHistoryEdits(
	previousUndoEdits: readonly OffsetTextEdit[],
	nextForwardEdits: readonly OffsetTextEdit[],
): boolean {
	if (
		previousUndoEdits.length === 0 ||
		previousUndoEdits.length !== nextForwardEdits.length
	) {
		return false;
	}
	const typingIsAdjacent = previousUndoEdits.every((previous, index) => {
		const next = nextForwardEdits[index];
		return next.text.length > 0 &&
			next.startOffset === previous.endOffset;
	});
	if (typingIsAdjacent) {
		return typingUndoEditsStayDisjoint(
			previousUndoEdits,
			nextForwardEdits,
		);
	}

	const previousAreInsertions = previousUndoEdits.every(
		edit => edit.startOffset === edit.endOffset &&
			edit.text.length > 0,
	);
	const nextAreDeletions = nextForwardEdits.every(
		edit => edit.endOffset > edit.startOffset &&
			edit.text.length === 0,
	);
	if (
		!previousAreInsertions ||
		!nextAreDeletions ||
		inverseInsertionsWouldConverge(nextForwardEdits)
	) {
		return false;
	}
	const backspacesAreAdjacent = previousUndoEdits.every(
		(previous, index) =>
			nextForwardEdits[index].endOffset === previous.startOffset,
	);
	const deletesAreAdjacent = previousUndoEdits.every(
		(previous, index) =>
			nextForwardEdits[index].startOffset === previous.startOffset,
	);
	return backspacesAreAdjacent || deletesAreAdjacent;
}

export function coalesceHistoryUndoEdits(
	previousUndoEdits: readonly OffsetTextEdit[],
	nextForwardEdits: readonly OffsetTextEdit[],
	nextUndoEdits: readonly OffsetTextEdit[],
): OffsetTextEdit[] {
	if (nextForwardEdits[0].text.length > 0) {
		let precedingDelta = 0;
		return previousUndoEdits.map((previous, index) => {
			const next = nextForwardEdits[index];
			const nextUndo = nextUndoEdits[index];
			const combined = {
				startOffset: previous.startOffset + precedingDelta,
				endOffset: nextUndo.endOffset,
				text: previous.text + nextUndo.text,
			};
			precedingDelta += next.text.length -
				(next.endOffset - next.startOffset);
			return combined;
		});
	}

	if (previousUndoEdits[0].text.length > 0) {
		const backspace =
			nextForwardEdits[0].endOffset ===
			previousUndoEdits[0].startOffset;
		return previousUndoEdits.map((previous, index) => {
			const nextUndo = nextUndoEdits[index];
			return {
				startOffset: nextUndo.startOffset,
				endOffset: nextUndo.endOffset,
				text: backspace
					? nextUndo.text + previous.text
					: previous.text + nextUndo.text,
			};
		});
	}

	throw new Error("Unsupported history coalescing shape");
}

export function canReplaceHistoryEdits(
	previousUndoEdits: readonly OffsetTextEdit[],
	nextForwardEdits: readonly OffsetTextEdit[],
): boolean {
	if (
		previousUndoEdits.length === 0 ||
		previousUndoEdits.length !== nextForwardEdits.length
	) {
		return false;
	}
	const replacesCurrentRevision = previousUndoEdits.every(
		(previous, index) => {
			const next = nextForwardEdits[index];
			return next.startOffset === previous.startOffset &&
				next.endOffset === previous.endOffset;
		},
	);
	return replacesCurrentRevision &&
		!inverseInsertionsWouldConverge(nextForwardEdits);
}

export function replaceHistoryUndoEdits(
	previousUndoEdits: readonly OffsetTextEdit[],
	nextUndoEdits: readonly OffsetTextEdit[],
): OffsetTextEdit[] {
	return previousUndoEdits.map((previous, index) => ({
		startOffset: nextUndoEdits[index].startOffset,
		endOffset: nextUndoEdits[index].endOffset,
		text: previous.text,
	}));
}

export function normalizeInverseEdits(
	edits: readonly OffsetTextEdit[],
): OffsetTextEdit[] {
	const normalized: OffsetTextEdit[] = [];
	for (const edit of edits) {
		const previous = normalized[normalized.length - 1];
		if (
			previous &&
			previous.startOffset === previous.endOffset &&
			edit.startOffset === edit.endOffset &&
			previous.startOffset === edit.startOffset
		) {
			normalized[normalized.length - 1] = {
				startOffset: previous.startOffset,
				endOffset: previous.endOffset,
				text: previous.text + edit.text,
			};
		} else {
			normalized.push(edit);
		}
	}
	return normalized;
}

function inverseInsertionsWouldConverge(
	forwardEdits: readonly OffsetTextEdit[],
): boolean {
	let cumulativeDelta = 0;
	let previousStartOffset = -1;
	for (const edit of forwardEdits) {
		const inverseStartOffset = edit.startOffset + cumulativeDelta;
		if (inverseStartOffset <= previousStartOffset) return true;
		previousStartOffset = inverseStartOffset;
		cumulativeDelta -= edit.endOffset - edit.startOffset;
	}
	return false;
}

function typingUndoEditsStayDisjoint(
	previousUndoEdits: readonly OffsetTextEdit[],
	nextForwardEdits: readonly OffsetTextEdit[],
): boolean {
	let cumulativeDelta = 0;
	let previousEndOffset = -1;
	for (let index = 0; index < previousUndoEdits.length; index += 1) {
		const previous = previousUndoEdits[index];
		const next = nextForwardEdits[index];
		const startOffset = previous.startOffset + cumulativeDelta;
		const endOffset = next.startOffset + cumulativeDelta + next.text.length;
		if (startOffset < previousEndOffset || endOffset <= startOffset) {
			return false;
		}
		previousEndOffset = endOffset;
		cumulativeDelta += next.text.length -
			(next.endOffset - next.startOffset);
	}
	return true;
}
