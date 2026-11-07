import { renderAsPlaintext } from '../../../../../base/browser/markdownRenderer.js';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../../base/common/cancellation.js';
import { canceled } from '../../../../../base/common/errors.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISpeechService, HasSpeechProvider, TextToSpeechInProgress } from '../../../speech/common/speechService.js';
import { ChatResponseActionContext, IChatWidgetService } from '../../browser/chat.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

export class StartVoiceChatAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.startVoiceChat',
			title: localize2('chat.voice.startCommand', 'Start Voice Mode'),
			f1: true,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	public override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const widgets = accessor.get(IChatWidgetService);
		const explicit = context && typeof context === 'object' && 'widget' in context ? context.widget : undefined;
		const widget = explicit === undefined ? widgets.lastFocusedWidget : widgets.getAllWidgets().find(widget => widget === explicit);
		if (!widget?.visible || widget.isTranscriptProgressActive) return;
		// The existing widget owns the real-time model, source identity and Core task dispatcher.
		await widget.startVoiceConversation();
	}
}

// This is command admission per window, not media state. The provider still owns synthesis.
const readingWindows = new WeakMap<ISpeechService, CancellationTokenSource>();
const nativeReadAvailable = ContextKeyExpr.and(
	ChatContextKeys.responseUsesNativeSpeech.isEqualTo(true),
	ChatContextKeys.responseIsReadingAloud.isEqualTo(false),
);

export class ReadChatResponseAloud extends Action2 {
	static readonly ID = 'workbench.action.chat.readChatResponseAloud';

	constructor() {
		super({
			id: ReadChatResponseAloud.ID,
			title: localize2('chat.message.readAloud', 'Read aloud'),
			icon: Lxicon.unmute,
			precondition: ContextKeyExpr.and(HasSpeechProvider.isEqualTo(true), ChatContextKeys.responseCanRead.isEqualTo(true), ContextKeyExpr.not(TextToSpeechInProgress.key)),
			menu: {
				id: MenuId.ChatMessageFooter, group: 'navigation', order: 2,
				when: ContextKeyExpr.and(nativeReadAvailable, HasSpeechProvider.isEqualTo(true)),
			},
		});
	}

	public override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
		if (context instanceof ChatResponseActionContext) {
			const speech = accessor.get(ISpeechService);
			const { text } = context.item;
			await context.read(async signal => {
				using source = new CancellationTokenSource();
				using cancelled = addDisposableListener(signal, 'abort', () => source.cancel());
				if (signal.aborted) source.cancel();
				await this.read(speech, text, source.token);
			});
			return;
		}
		if (!isResponse(context)) return;
		await this.read(accessor.get(ISpeechService), context.text, context.source.token);
	}

	private async read(speech: ISpeechService, markdown: string, token: CancellationToken): Promise<void> {
		if (readingWindows.has(speech) || speech.hasActiveTextToSpeechSession) {
			throw new Error(localize('speech.synthesisBusy', 'Speech synthesis is already in progress.'));
		}
		const source = new CancellationTokenSource(token);
		readingWindows.set(speech, source);
		using cancelled = source.token.onCancellationRequested(() => {
			if (readingWindows.get(speech) === source) readingWindows.delete(speech);
		});
		try {
			if (source.token.isCancellationRequested) throw canceled();
			const text = renderAsPlaintext(markdown);
			if (!text) return;
			const session = await speech.createTextToSpeechSession(source.token, 'chat');
			for (let offset = 0; offset < text.length;) {
				if (source.token.isCancellationRequested) throw canceled();
				let end = Math.min(offset + 16384, text.length);
				// The Host bounds UTF-16 text. Preserve a supplementary character at the chunk edge.
				if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
				await session.synthesize(text.slice(offset, end));
				if (source.token.isCancellationRequested) throw canceled();
				offset = end;
			}
		} finally {
			source.dispose(true);
			if (readingWindows.get(speech) === source) readingWindows.delete(speech);
		}
	}
}

export class StopReadAloud extends Action2 {
	public static readonly ID = 'workbench.action.speech.stopReadAloud';
	constructor() {
		super({
			id: StopReadAloud.ID,
			title: localize2('chat.message.stopReadAloud', 'Stop reading aloud'),
			f1: true,
			precondition: TextToSpeechInProgress.isEqualTo(true),
		});
	}
	public override run(accessor: ServicesAccessor): void { readingWindows.get(accessor.get(ISpeechService))?.cancel(); }
}

export class StopReadChatItemAloud extends Action2 {
	public static readonly ID = 'workbench.action.chat.stopReadChatItemAloud';
	constructor() {
		super({
			id: StopReadChatItemAloud.ID,
			title: localize2('chat.message.stopReadAloud', 'Stop reading aloud'),
			icon: Lxicon.mute,
			menu: {
				id: MenuId.ChatMessageFooter, group: 'navigation', order: 2,
				when: ContextKeyExpr.and(ChatContextKeys.responseUsesNativeSpeech.isEqualTo(true), ChatContextKeys.responseIsReadingAloud.isEqualTo(true)),
			},
		});
	}
	public override run(_accessor: ServicesAccessor, context: unknown): void {
		if (context instanceof ChatResponseActionContext) context.stop();
		else if (context && typeof context === 'object' && 'source' in context && context.source instanceof CancellationTokenSource) context.source.cancel();
	}
}

function isResponse(value: unknown): value is { readonly type: 'agentMessage'; readonly text: string; readonly source: CancellationTokenSource; } {
	return !!value && typeof value === 'object' && 'type' in value && value.type === 'agentMessage'
		&& 'text' in value && typeof value.text === 'string'
		&& 'source' in value && value.source instanceof CancellationTokenSource;
}

registerAction2(ReadChatResponseAloud);
MenusRegistry.appendMenuItem(MenuId.ChatMessageFooter, {
	command: {
		id: ReadChatResponseAloud.ID,
		title: localize2('chat.message.readAloud', 'Read aloud'),
		tooltip: localize2('chat.message.readAloudUnavailable', 'Read aloud requires a speech provider'),
		icon: Lxicon.unmute,
		precondition: HasSpeechProvider.isEqualTo(true),
	},
	group: 'navigation',
	order: 2,
	when: ContextKeyExpr.and(nativeReadAvailable, ChatContextKeys.responseHasConversationLink.isEqualTo(true), ContextKeyExpr.not(HasSpeechProvider.key)),
});
registerAction2(StartVoiceChatAction);
registerAction2(StopReadAloud);
registerAction2(StopReadChatItemAloud);
