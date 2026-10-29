import { renderAsPlaintext } from '../../../../../base/browser/markdownRenderer.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { canceled } from '../../../../../base/common/errors.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISpeechService, HasSpeechProvider, TextToSpeechInProgress } from '../../../speech/common/speechService.js';
import { IChatWidgetService } from '../../browser/chat.js';
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

export class ReadChatResponseAloud extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.readChatResponseAloud',
			title: localize2('chat.message.readAloud', 'Read aloud'),
			precondition: HasSpeechProvider.isEqualTo(true),
		});
	}

	public override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
		if (!isResponse(context)) return;
		const speech = accessor.get(ISpeechService);
		if (readingWindows.has(speech) || speech.hasActiveTextToSpeechSession) {
			throw new Error(localize('speech.synthesisBusy', 'Speech synthesis is already in progress.'));
		}
		const source = new CancellationTokenSource(context.source.token);
		readingWindows.set(speech, source);
		using cancelled = source.token.onCancellationRequested(() => {
			if (readingWindows.get(speech) === source) readingWindows.delete(speech);
		});
		try {
			if (source.token.isCancellationRequested) throw canceled();
			const text = renderAsPlaintext(context.text);
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
	constructor() { super({ id: StopReadChatItemAloud.ID, title: localize2('chat.message.stopReadAloud', 'Stop reading aloud') }); }
	public override run(_accessor: ServicesAccessor, context: unknown): void {
		if (context && typeof context === 'object' && 'source' in context && context.source instanceof CancellationTokenSource) context.source.cancel();
	}
}

function isResponse(value: unknown): value is { readonly type: 'agentMessage'; readonly text: string; readonly source: CancellationTokenSource; } {
	return !!value && typeof value === 'object' && 'type' in value && value.type === 'agentMessage'
		&& 'text' in value && typeof value.text === 'string'
		&& 'source' in value && value.source instanceof CancellationTokenSource;
}

registerAction2(ReadChatResponseAloud);
registerAction2(StartVoiceChatAction);
registerAction2(StopReadAloud);
registerAction2(StopReadChatItemAloud);
