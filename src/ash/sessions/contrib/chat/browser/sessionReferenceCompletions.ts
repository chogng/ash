import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { LanguageCompletionItemKind } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { CHAT_INPUT_LANGUAGE_ID } from '../../../../workbench/contrib/chat/browser/widget/input/editor/chatInputCompletions.js';
import { computeCompletionRanges, getCompletionRangeWord } from '../../../../workbench/contrib/chat/browser/widget/input/editor/chatInputCompletionUtils.js';
import type { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { createChatReferenceVariableEntry } from '../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { matchedCharacterIndices } from '../../../../workbench/contrib/chat/common/slashCommands.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

const sessionToken = '#session';

interface SessionReferenceSelection {
	readonly sessionId: string;
	readonly threadId: string;
	readonly destinationSessionId: string;
	readonly destinationThreadId: string;
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

function referenceTitle(title: string): string {
	return title.replace(/\s+/gu, ' ').trim() || localize('sessions.list.untitled', 'Untitled Session');
}

/** Offers same-host conversation references in a saved Sessions composer. */
export class SessionReferenceCompletions extends Disposable {
	constructor(
		input: ChatInputPart,
		composer: Pick<ChatWidgetModel, 'session' | 'threadId'>,
		@ILanguageFeaturesService features: ILanguageFeaturesService,
		@ISessionsManagementService sessions: ISessionsManagementService,
	) {
		super();
		const editor = input.inputEditor;
		const model = editor?.getModel();
		if (!editor || !model) return;

		const isCurrentInput = (resource: string | undefined, version: number): boolean => !this.isDisposed && !model.isDisposed()
			&& resource === model.uri.toString() && version === model.getVersionId() && !editor.getOption(EditorOption.readOnly);
		this._register(features.completionProvider.register({
			id: `ash.sessions.sessionReference.${createUuid()}`,
			languageIds: [CHAT_INPUT_LANGUAGE_ID],
			triggerCharacters: ['#'],
			provideCompletions: request => {
				const destination = composer.session;
				const destinationThreadId = composer.threadId;
				if (!destination || !destinationThreadId || !isCurrentInput(request.resource?.toString(), request.snapshot.version)) return undefined;

				const ranges = computeCompletionRanges(model, request.position, /#[^\s#@]*/u, true);
				const token = ranges && getCompletionRangeWord(ranges);
				if (!ranges || !token) return undefined;
				const prefix = token.toLowerCase();
				if (!sessionToken.startsWith(prefix) && !prefix.startsWith(`${sessionToken}:`)) return undefined;
				if (token === '#') return { items: [], isIncomplete: true };

				const titleQuery = token.slice(sessionToken.length + 1);
				const { replace: range } = ranges;
				const start = model.getOffsetAt(range.getStartPosition());
				const end = model.getOffsetAt(range.getEndPosition());
				const text = model.getValueInRange(range);
				const candidates = sessions.sessions.filter(session => session.providerId === destination.providerId)
					.flatMap(session => session.chats.map(thread => {
						const title = referenceTitle(thread.title ?? session.title);
						return { sessionId: session.sessionId, thread, title, matches: matchedCharacterIndices(title, titleQuery) };
					}))
					.filter(candidate => !titleQuery || candidate.matches.length > 0)
					.sort((left, right) => (right.thread.updatedAt?.getTime() ?? 0) - (left.thread.updatedAt?.getTime() ?? 0));

				return {
					items: candidates.slice(0, 100).map(({ sessionId, thread, title, matches }) => {
						const current = sessionId === destination.sessionId && thread.threadId === destinationThreadId;
						const updated = thread.updatedAt?.toLocaleString(getNLSLanguage());
						const detail = current ? [localize('sessions.chat.sessionReferenceCurrent', 'Current conversation'), updated].filter(Boolean).join(' · ') : updated;
						const selection: SessionReferenceSelection = { sessionId, threadId: thread.threadId, destinationSessionId: destination.sessionId, destinationThreadId, start, end, text };
						return {
							id: JSON.stringify([sessionId, thread.threadId]), label: title, labelMatchIndices: matches, detail,
							kind: LanguageCompletionItemKind.Reference, range, insertText: text,
							command: { id: 'sessions.chat.addSessionReference', title: localize('chat.context.add', 'Add context'), arguments: [selection] },
						};
					}),
					isIncomplete: true,
				};
			},
			executeCompletionCommand: async (request, signal) => {
				const selection = request.command.arguments[0] as SessionReferenceSelection;
				const destination = composer.session;
				if (signal.aborted || !isCurrentInput(request.resource?.toString(), request.snapshot.version)
					|| !destination || destination.sessionId !== selection.destinationSessionId || composer.threadId !== selection.destinationThreadId
					|| request.snapshot.getText().slice(selection.start, selection.end) !== selection.text) return;
				const cursor = editor.getSelection();
				if (!cursor?.isEmpty() || model.getOffsetAt(cursor.getPosition()) !== selection.end) return;

				const session = sessions.sessions.find(candidate => candidate.sessionId === selection.sessionId && candidate.providerId === destination.providerId);
				const thread = session?.chats.find(candidate => candidate.threadId === selection.threadId);
				if (!session || !thread) return;
				const title = referenceTitle(thread.title ?? session.title);
				const accepted = await input.acceptContextCompletion(selection, async () => {
					const attachment = createChatReferenceVariableEntry(session.sessionId, thread.threadId, title);
					// Repeated references have independent editor positions.
					return [{ ...attachment, id: `${attachment.id}:${createUuid()}` }];
				}, signal);
				if (!this.isDisposed && !signal.aborted && accepted?.length) status(localize('chat.context.added', 'Added {0}', title));
			},
		}));
	}
}
