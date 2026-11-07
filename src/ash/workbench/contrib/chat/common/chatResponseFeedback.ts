import { localize } from '../../../../nls.js';
import type { IConfigurationKeyDefinition } from '../../../../platform/configuration/common/configurationRegistry.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';

/** A personal Ash annotation, independent of model-provider feedback or training. */
export interface ChatResponseFeedbackTarget {
	readonly sessionId: string;
	readonly threadId: string;
	readonly turnId: string;
	readonly itemId: string;
}

export const ChatResponseFeedbackStoragePrefix = 'chat.responseFeedback.';
export const ChatUpvoteAnimationSettingId = 'chat.upvoteAnimation';
export const chatUpvoteAnimations = ['off', 'confetti', 'floatingThumbs', 'pulseWave', 'radiantLines'] as const;
export type ChatUpvoteAnimation = typeof chatUpvoteAnimations[number];

export const chatUpvoteAnimationConfiguration: IConfigurationKeyDefinition<ChatUpvoteAnimation> = {
	key: ChatUpvoteAnimationSettingId,
	defaultValue: 'floatingThumbs',
	schema: { type: 'string', enum: [...chatUpvoteAnimations] },
	parse(value: unknown): ChatUpvoteAnimation {
		if (typeof value === 'string' && chatUpvoteAnimations.includes(value as ChatUpvoteAnimation)) return value as ChatUpvoteAnimation;
		throw new TypeError(localize('chat.upvoteAnimation.invalid', 'Choose a supported helpful-response animation.'));
	},
	setting: {
		valueType: 'select',
		get title() { return localize('chat.upvoteAnimation.title', 'Helpful response animation'); },
		get description() { return localize('chat.upvoteAnimation.description', 'Animation shown after marking an IDE Chat response helpful in Ash.'); },
		get options() {
			return [
				{ value: 'off', label: localize('chat.upvoteAnimation.off', 'Off') },
				{ value: 'confetti', label: localize('chat.upvoteAnimation.confetti', 'Confetti') },
				{ value: 'floatingThumbs', label: localize('chat.upvoteAnimation.floatingThumbs', 'Floating thumbs') },
				{ value: 'pulseWave', label: localize('chat.upvoteAnimation.pulseWave', 'Pulse wave') },
				{ value: 'radiantLines', label: localize('chat.upvoteAnimation.radiantLines', 'Radiant lines') },
			] as const;
		},
	},
};

/** Command arguments cross an untyped boundary; transcript callers already own normalized identities. */
export function isChatResponseFeedbackTarget(value: unknown): value is ChatResponseFeedbackTarget {
	if (!value || typeof value !== 'object') return false;
	const target = value as Record<string, unknown>;
	return ['sessionId', 'threadId', 'turnId', 'itemId'].every(key => typeof target[key] === 'string' && target[key].length > 0);
}

function feedbackKey(target: ChatResponseFeedbackTarget): string {
	return ChatResponseFeedbackStoragePrefix + JSON.stringify([target.sessionId, target.threadId, target.turnId, target.itemId]);
}

export function isResponseHelpful(storage: IStorageService, target: ChatResponseFeedbackTarget): boolean {
	return getResponseVote(storage, target) === 'up';
}

export function markResponseHelpful(storage: IStorageService, target: ChatResponseFeedbackTarget): boolean {
	return setResponseVote(storage, target, 'up');
}

export type ChatResponseVote = 'up' | 'down';

export function getResponseVote(storage: IStorageService, target: ChatResponseFeedbackTarget): ChatResponseVote | undefined {
	const value = storage.get(feedbackKey(target), StorageScope.PROFILE);
	return value === 'true' ? 'up' : value === 'down' ? 'down' : undefined;
}

/** Keep the original helpful marker readable, and store at most one vote per response. */
export function setResponseVote(storage: IStorageService, target: ChatResponseFeedbackTarget, vote: ChatResponseVote): boolean {
	if (getResponseVote(storage, target) === vote) return false;
	storage.store(feedbackKey(target), vote === 'up' ? true : 'down', StorageScope.PROFILE, StorageTarget.MACHINE);
	return true;
}
