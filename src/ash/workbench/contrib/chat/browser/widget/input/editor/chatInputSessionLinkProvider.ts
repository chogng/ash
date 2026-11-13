import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import type { LanguageLink, LanguageLinkProvider, LanguageLinkRequest } from '../../../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../../../editor/common/services/languageFeatures.js';
import { localize, localize2 } from '../../../../../../../nls.js';
import { MenuId, MenusRegistry } from '../../../../../../../platform/actions/common/actions.js';
import { OPEN_SESSION_LINK_SCHEME, parseOpenSessionLinkUri } from '../../../../../../../platform/agentHost/common/openSessionLink.js';
import { isArtifactLink, parseArtifactLink } from '../../../../../../../platform/artifactIntegrations/common/artifactLink.js';
import { ChatContextKeys } from '../../../../common/actions/chatContextKeys.js';
import { CHAT_INPUT_LANGUAGE_ID } from './chatInputCompletions.js';

const chatLinkPattern = new RegExp(`(?:${OPEN_SESSION_LINK_SCHEME}://|ash://artifact/|ash-artifact://open/)[^\\s<>"'\x60]+`, 'gu');
const closingBrackets = new Map([['(', ')'], ['[', ']'], ['{', '}']]);

/** Detects internal conversation and artifact links in the composer. */
export class ChatInputSessionLinkProvider extends Disposable implements LanguageLinkProvider {
	constructor(@ILanguageFeaturesService features: ILanguageFeaturesService) {
		super();
		this._register(features.linkProvider.register({ language: CHAT_INPUT_LANGUAGE_ID }, this));
		this._register(MenusRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: { id: 'editor.action.openLink', title: localize2({ bundle: 'ash', key: 'editor.openLink' }, 'Open Link') },
			when: ChatContextKeys.enabled.isEqualTo(true),
		}));
	}

	public provideLinks(request: LanguageLinkRequest, signal: AbortSignal): readonly LanguageLink[] {
		const links: LanguageLink[] = [];
		const lines = request.snapshot.getText().split('\n');
		for (const [index, line] of lines.entries()) {
			if (signal.aborted) return [];
			for (const match of line.matchAll(chatLinkPattern)) {
				const preceding = line[match.index - 1];
				// A nested URL or identifier owns its entire token; do not turn its suffix into navigation.
				if (preceding && !/[\s([{<"'\x60]/u.test(preceding)) continue;
				let target = match[0];
				const closing = preceding ? closingBrackets.get(preceding) : undefined;
				if (closing && target.endsWith(closing)) target = target.slice(0, -1);
				let artifact: boolean;
				try {
					const resource = URI.parse(target);
					artifact = isArtifactLink(resource);
					if (artifact) {
						if (!parseArtifactLink(resource)) continue;
					} else {
						parseOpenSessionLinkUri(resource);
					}
				} catch {
					continue;
				}
				links.push({
					range: new Range(index + 1, match.index + 1, index + 1, match.index + target.length + 1),
					target,
					tooltip: artifact ? localize('chat.artifactLink.open', 'Open artifact') : localize('chat.sessionLink.open', 'Open conversation'),
				});
			}
		}
		return links;
	}
}
