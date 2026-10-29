import './snippets.service.contribution.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { SnippetCompletionProvider } from './snippetCompletionProvider.js';

registerWorkbenchContribution('workbench.contrib.snippets', WorkbenchPhase.BlockStartup, accessor =>
	accessor.get(IInstantiationService).createInstance(SnippetCompletionProvider),
);
