import type { IWebWorkerClient } from '../../../../base/common/worker/webWorker.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { posix } from '../../../../base/common/path.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { SyntaxProvider } from '../../../../editor/common/languages.js';
import type { LanguageToken, LanguageTokenResult } from '../../../../editor/common/tokens/languageTokens.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { WebWorkerDescriptor } from '../../../../platform/webWorker/browser/webWorkerDescriptor.js';
import { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import { chatHighlightChannel, chatHighlightTokenTypes, maximumChatHighlightLength } from './chatHighlightProtocol.js';

const editorLanguageAliases = new Map([
	['dockercompose', 'yaml'], ['dtd', 'xml'], ['gitignore', 'ignore'], ['gitignore_global', 'ignore'],
	['git-blame-ignore-revs', 'ignore'], ['javascriptreact', 'jsx'], ['jsx-tags', 'jsx'],
	['snippets', 'jsonc'], ['starlark', 'python'], ['typescriptreact', 'tsx'],
]);

export const ICodeHighlightingService = createDecorator<ICodeHighlightingService>('codeHighlightingService');

export interface ICodeHighlightingService {
	readonly _serviceBrand: undefined;
	highlight(language: string, text: string, signal: AbortSignal): Promise<LanguageTokenResult>;
}

/** Uses the filename for files whose language is not registered in this window. */
export function createCodeHighlightingProvider(highlighter: ICodeHighlightingService): SyntaxProvider {
	return {
		id: 'ash.codeHighlighting',
		languageIds: ['*'],
		tokenPriority: 1,
		provideTokens: (request, signal) => {
			const path = request.model?.uri.path;
			const language = request.languageId === 'plaintext' && path
				? (posix.extname(path) || posix.basename(path).match(/^\.[^.]+$/u)?.[0] || '').slice(1)
				: request.languageId;
			if (request.model && request.model.length > maximumChatHighlightLength) return undefined;
			return highlighter.highlight(language, request.snapshot.getText(), signal);
		},
	};
}

/** A window shares one lazy highlighter across its text editors and code blocks. */
export class CodeHighlightingService extends Disposable implements ICodeHighlightingService {
	declare readonly _serviceBrand: undefined;
	private readonly worker = this._register(new MutableDisposable<IWebWorkerClient<object>>());
	private readonly failure = this._register(new MutableDisposable());
	private requestId = 0;

	constructor(@IWebWorkerService private readonly workers: IWebWorkerService, @IThemeService private readonly themes: IThemeService) { super(); }

	async highlight(language: string, text: string, signal: AbortSignal): Promise<LanguageTokenResult> {
		const id = language.trim().split(/\s+/u, 1)[0]!.toLowerCase();
		if (!id || id === 'plaintext' || !text.length || text.length > maximumChatHighlightLength) return { tokens: [] };
		const worker = this.worker.value ?? this.createWorker();
		const result = await worker.request(++this.requestId, { language: editorLanguageAliases.get(id) ?? id, text }, signal);
		const theme = this.themes.getColorTheme();
		if (!Array.isArray(result)) throw new TypeError('Invalid chat highlight result');
		const tokens: LanguageToken[] = [];
		for (const value of result) {
			if (!Array.isArray(value) || value.length !== 4) throw new TypeError('Invalid chat highlight token');
			const [line, start, end, tokenType] = value;
			if (![line, start, end].every(value => Number.isSafeInteger(value) && value >= 1) || end <= start || !chatHighlightTokenTypes.has(tokenType)) {
				throw new TypeError('Invalid chat highlight range or token type');
			}
			const style = theme.getTokenStyleMetadata(tokenType, [], id);
			const fontStyle = style && (['italic', 'bold', 'underline', 'strikethrough'] as const).filter(key => style[key]);
			tokens.push({
				range: new Range(line, start, line, end), tokenType, modifiers: [],
				presentation: { foreground: style?.foreground === undefined ? undefined : theme.tokenColorMap[style.foreground], fontStyle },
			});
		}
		return { tokens };
	}

	private createWorker(): IWebWorkerClient<object> {
		const worker = this.workers.createWorkerClient(new WebWorkerDescriptor({
			label: 'ash-chat-highlighting',
			channel: chatHighlightChannel,
			createWorker: () => new Worker(new URL('./chatHighlightWorker.ts', import.meta.url), { type: 'module', name: 'ash-chat-highlighting' }),
		}));
		this.worker.value = worker;
		this.failure.value = worker.onDidFail(() => { this.failure.clear(); this.worker.clear(); });
		return worker;
	}
}
