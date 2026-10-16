/** A notice owns its focus target while it leads the input's notice area. */
export interface IChatInputNoticeFocusTarget {
	hasFocus(): boolean;
	focus(): void;
	canFocus?(): boolean;
}

/** Claim owners notify a banner when higher priority content takes its space. */
export interface IChatInputNoticeClaimOptions {
	readonly focusTarget?: IChatInputNoticeFocusTarget;
	readonly onDidChangeLeading?: (leading: boolean) => void;
}
