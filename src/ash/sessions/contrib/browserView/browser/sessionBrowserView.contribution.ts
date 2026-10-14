import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { SessionBrowserViewController } from './sessionBrowserView.js';

// Install policy before browser discovery can open tabs; page restoration still runs after Sessions restoration.
registerWorkbenchContribution(SessionBrowserViewController.ID, WorkbenchPhase.BlockRestore,
	services => services.get(IInstantiationService).createInstance(SessionBrowserViewController));
