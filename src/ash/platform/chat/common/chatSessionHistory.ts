/** A content-loading failure and its recovery, scoped to history or live updates. */
export interface IChatSessionHistoryStatus {
	readonly kind: 'history' | 'live';
	readonly message: string;
	readonly action: { readonly label: string; readonly run: () => Promise<void>; };
}
