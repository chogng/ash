import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { ChatEntitlementContextKeys } from '../../../../services/chat/common/chatEntitlementService.js';
import type { ChatResponseVote } from '../chatResponseFeedback.js';

export namespace ChatContextKeys {
	export const Setup = ChatEntitlementContextKeys.Setup;
	export const inputHasText = new RawContextKey<boolean>('chatInputHasText', false);
	export const requestInProgress = new RawContextKey<boolean>('chatRequestInProgress', false);
	export const inputBlocked = new RawContextKey<boolean>('chatInputBlocked', false);
	export const transcriptProgressActive = new RawContextKey<boolean>('chatTranscriptProgressActive', false);
	export const speechToTextConfigured = new RawContextKey<boolean>('chatSpeechToTextConfigured', false);
	export enum EditingRequestType { Sent = 's', Queue = 'q', Steer = 'st' }
	export const editingRequestType = new RawContextKey<EditingRequestType | undefined>('chatEditingSentRequest', undefined);
	/** The window's Chat implementation is available and its UI preference permits use. */
	export const enabled = new RawContextKey<boolean>('chatIsEnabled', false);
	export const hasActiveRequest = new RawContextKey<boolean>('chatSessionHasActiveRequest', false);
	export const inChatSession = new RawContextKey<boolean>('inChat', false);
	export const responseHasText = new RawContextKey<boolean>('chatResponseHasText', false);
	export const requestHasText = new RawContextKey<boolean>('chatRequestHasText', false);
	/** The popup presentation uses thumbnails for sent images and opens images in place. */
	export const imagePreviewPresentation = new RawContextKey<'editor' | 'popup'>('chatImagePreviewPresentation', 'editor');
	export const requestCanEdit = new RawContextKey<boolean>('chatRequestCanEdit', false);
	export const requestHasVersions = new RawContextKey<boolean>('chatRequestHasVersions', false);
	export const responseHasFeedbackSurvey = new RawContextKey<boolean>('chatSessionResponseHasFeedbackSurvey', false);
	export const responseVote = new RawContextKey<ChatResponseVote | undefined>('chatResponseVote', undefined);
	export const responseHasLoadedSkills = new RawContextKey<boolean>('chatResponseHasLoadedSkills', false);
	export const responseRequestClientId = new RawContextKey<string>('chatResponseRequestClientId', '');
	export const responseHasConversationLink = new RawContextKey<boolean>('chatResponseHasConversationLink', false);
	export const responseCanFork = new RawContextKey<boolean>('chatResponseCanFork', false);
	export const responseCanCompareResults = new RawContextKey<boolean>('chatResponseCanCompareResults', false);
	export const requestCanRunAnotherVersion = new RawContextKey<boolean>('chatRequestCanRunAnotherVersion', false);
	export const responseUsesNativeSpeech = new RawContextKey<boolean>('chatResponseUsesNativeSpeech', false);
	export const responseCanRead = new RawContextKey<boolean>('chatResponseCanRead', false);
	export const responseIsReadingAloud = new RawContextKey<boolean>('chatResponseIsReadingAloud', false);
	export const inputCursorAtTop = new RawContextKey<boolean>('chatCursorAtTop', false);
	export const inChatInput = new RawContextKey<boolean>('inChatInput', false);
	export const inQuickChat = new RawContextKey<boolean>('quickChatHasFocus', false);
	export const findSupported = new RawContextKey<boolean>('chatFindSupported', false);
	export const findWidgetVisible = new RawContextKey<boolean>('chatFindWidgetVisible', false);
	export const findWidgetFocused = new RawContextKey<boolean>('chatFindWidgetFocused', false);
	export const findInputFocused = new RawContextKey<boolean>('chatFindInputFocused', false);
	/** Projects the Chat view's actual layout, independently of list visibility. */
	export const agentSessionsViewerOrientation = new RawContextKey<number | undefined>('agentSessionsViewerOrientation', undefined);
}
