export interface DiffApiRequest {
	readonly original: string;
	readonly modified: string;
}

export type DiffApiRowKind = "context" | "added" | "removed" | "modified";

export interface DiffApiRange {
	readonly startColumn: number;
	readonly endColumn: number;
}

export interface DiffApiRow {
	readonly kind: DiffApiRowKind;
	readonly originalLineIndex: number | null;
	readonly modifiedLineIndex: number | null;
	readonly originalChanges: readonly DiffApiRange[];
	readonly modifiedChanges: readonly DiffApiRange[];
}

export interface DiffApiHunk {
	readonly rowStart: number;
	readonly rowEnd: number;
	readonly originalStartLineIndex: number;
	readonly originalLineCount: number;
	readonly modifiedStartLineIndex: number;
	readonly modifiedLineCount: number;
}

export interface DiffApiResult {
	readonly rows: readonly DiffApiRow[];
	readonly hunks: readonly DiffApiHunk[];
	readonly originalLineCount: number;
	readonly modifiedLineCount: number;
}

/** Backend business diff API. Interactive editor comparisons use the frontend computation service. */
export interface IDiffApi {
	compute(request: DiffApiRequest): Promise<DiffApiResult>;
}
