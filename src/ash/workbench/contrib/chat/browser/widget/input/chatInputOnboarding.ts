import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import type { IChatInputNoticeClaimOptions } from './chatInputNoticeHost.js';

export type ChatInputNoticeClaim = (options: IChatInputNoticeClaimOptions) => IDisposable;

/** Registration lifetime follows the host's visibility; disposing releases its banner and recording. */
export interface IChatInputOnboardingHostOptions {
	readonly container: HTMLElement;
	readonly focusRoot: HTMLElement;
	readonly focus?: () => void;
	readonly claimNotice?: ChatInputNoticeClaim;
}
