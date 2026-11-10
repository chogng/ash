import './media/markdown.css';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { MarkdownImageDropOrPaste } from './markdownImageDropOrPaste.js';

registerWorkbenchContribution('workbench.markdown.imageDropOrPaste', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(MarkdownImageDropOrPaste));
