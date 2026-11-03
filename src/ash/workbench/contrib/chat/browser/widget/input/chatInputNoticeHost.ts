import { addDisposableListener, getActiveWindow } from '../../../../../../base/browser/dom.js';
import { onUnexpectedError } from '../../../../../../base/common/errors.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';

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

/** A notification takes precedence over an introduction, which takes precedence over a tip. */
export const enum ChatInputNoticeLane {
	Notification = 0,
	Onboarding = 1,
	Tip = 2,
}
export interface IChatInputSurface {
	readonly focusRoot: HTMLElement;
	lastFocused: number;
}

let focusSequence = 0;

/** Use an ordering counter so two inputs focused in the same millisecond remain distinguishable. */
export function trackChatInputRecency(surface: IChatInputSurface): IDisposable {
	if (surface.focusRoot.contains(surface.focusRoot.ownerDocument.activeElement)) surface.lastFocused = ++focusSequence;
	return addDisposableListener(surface.focusRoot, 'focusin', () => surface.lastFocused = ++focusSequence);
}

export function pickActiveChatInput<T extends IChatInputSurface>(surfaces: Iterable<T>, isEligible?: (surface: T) => boolean): T | undefined {
	const document = getActiveWindow().document;
	let selected: T | undefined;
	for (const surface of surfaces) {
		const root = surface.focusRoot;
		if (root.ownerDocument !== document || !root.isConnected || root.closest('[hidden]')
			|| root.getClientRects().length === 0 || (isEligible && !isEligible(surface))) {
			continue;
		}
		if (root.contains(document.activeElement)) return surface;
		if (!selected || surface.lastFocused > selected.lastFocused) selected = surface;
	}
	return selected;
}

interface NoticeClaim {
	readonly lane: ChatInputNoticeLane;
	readonly options: IChatInputNoticeClaimOptions;
}

/** Owns arbitration for one input. Producers keep their claims while a higher-priority notice leads. */
export class ChatInputNoticeHost extends Disposable {
	private readonly claims = new Set<NoticeClaim>();
	private leading: NoticeClaim | undefined;
	private updating = false;

	constructor(private readonly focusInput: () => void) {
		super();
	}

	occupy(lane: ChatInputNoticeLane, options: IChatInputNoticeClaimOptions = {}): IDisposable {
		if (this.isDisposed) return toDisposable(() => { });
		const claim = { lane, options };
		this.claims.add(claim);
		this.update();
		return toDisposable(() => {
			this.claims.delete(claim);
			this.update();
		});
	}

	hasFocusableNotice(): boolean {
		const target = this.leading?.options.focusTarget;
		return !!target && (target.canFocus?.() ?? true);
	}

	toggleFocus(): boolean {
		if (!this.hasFocusableNotice()) return false;
		const target = this.leading!.options.focusTarget!;
		if (target.hasFocus()) this.focusInput();
		else target.focus();
		return true;
	}

	private update(): void {
		if (this.updating) return;
		this.updating = true;
		let restoreFocus = false;
		try {
			while (true) {
				let next: NoticeClaim | undefined;
				if (!this.isDisposed) {
					for (const claim of this.claims) {
						if (!next || claim.lane <= next.lane) next = claim;
					}
				}
				if (this.leading === next) break;
				if (this.leading) {
					const previous = this.leading;
					restoreFocus ||= previous.options.focusTarget?.hasFocus() ?? false;
					this.leading = undefined;
					this.notify(previous, false);
					// A stand-down callback may release or replace another claim.
					continue;
				}
				this.leading = next;
				if (next) this.notify(next, true);
			}
		} finally {
			this.updating = false;
		}
		if (restoreFocus && !this.isDisposed) {
			if (this.hasFocusableNotice()) this.leading!.options.focusTarget!.focus();
			else this.focusInput();
		}
	}

	private notify(claim: NoticeClaim, leading: boolean): void {
		try {
			claim.options.onDidChangeLeading?.(leading);
		} catch (error) {
			onUnexpectedError(error);
		}
	}

	protected override disposeCore(): void {
		this.claims.clear();
		this.update();
		super.disposeCore();
	}
}
