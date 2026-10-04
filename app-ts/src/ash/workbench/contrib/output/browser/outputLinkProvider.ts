import { Disposable } from '../../../../base/common/lifecycle.js';
import { withSelection } from '../../../../platform/opener/common/opener.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { LanguageLink, LanguageLinkRequest } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { detectOutputLinks } from '../common/outputLinkComputer.js';

/** Supplies workspace locations to the editor's existing link activation and cancellation lifecycle. */
export class OutputLinkProvider extends Disposable {
	constructor(
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this._register(languageFeatures.linkProvider.register({ scheme: 'output' }, {
			provideLinks: (request, signal) => signal.aborted ? [] : this.provideLinks(request),
		}));
	}

	private provideLinks(request: LanguageLinkRequest): readonly LanguageLink[] {
		const links: LanguageLink[] = [];
		const lines = request.snapshot.getText().split('\n');
		const folders = this.workspace.getWorkspace().folders;
		for (let index = 0; index < lines.length; index++) {
			for (const link of detectOutputLinks(lines[index]!, folders)) {
				const position = link.selection.getStartPosition();
				const target = withSelection(link.resource, { startLineNumber: position.lineNumber, startColumn: position.column });
				links.push({ range: new Range(index + 1, link.startIndex + 1, index + 1, link.endIndex + 1), target: target.toString() });
			}
		}
		return links;
	}
}
