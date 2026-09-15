/** Fixed model-size limits used to keep expensive editor features bounded. */
export const TEXT_MODEL_LARGE_FILE_LIMITS = Object.freeze({
	tokenizationTextUnits: 20 * 1_024 * 1_024,
	tokenizationLineCount: 300_000,
	synchronizationTextUnits: 50 * 1_024 * 1_024,
	heapOperationTextUnits: 256 * 1_024 * 1_024,
});

export interface TextModelLargeFilePolicy {
	readonly tooLargeForTokenization: boolean;
	readonly tooLargeForSynchronization: boolean;
	readonly tooLargeForHeapOperation: boolean;
}

/** Classifies the initial model snapshot. The result deliberately remains stable for the model lifetime. */
export function classifyTextModelSize(textUnits: number, lineCount: number, largeFileOptimizations = true): TextModelLargeFilePolicy {
	if (!Number.isSafeInteger(textUnits) || textUnits < 0) throw new RangeError("Text model size must be a non-negative safe integer");
	if (!Number.isSafeInteger(lineCount) || lineCount < 1) throw new RangeError("Text model line count must be a positive safe integer");
	return Object.freeze({
		tooLargeForTokenization: largeFileOptimizations && (
			textUnits > TEXT_MODEL_LARGE_FILE_LIMITS.tokenizationTextUnits
			|| lineCount > TEXT_MODEL_LARGE_FILE_LIMITS.tokenizationLineCount
		),
		tooLargeForSynchronization: textUnits > TEXT_MODEL_LARGE_FILE_LIMITS.synchronizationTextUnits,
		tooLargeForHeapOperation: largeFileOptimizations && textUnits > TEXT_MODEL_LARGE_FILE_LIMITS.heapOperationTextUnits,
	});
}
