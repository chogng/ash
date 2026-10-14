import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IAutomationService } from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import { IAutomationRunner } from '../../../../workbench/contrib/chat/common/automations/automationRunner.js';
import { IAutomationDialogService } from '../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { ProviderAutomationService } from './providerAutomationService.js';
import { AutomationRunner } from './automationRunner.js';
import { AutomationDialogService } from './automationDialogService.js';

registerSingleton(IAutomationService, ProviderAutomationService, InstantiationType.Delayed);

registerSingleton(IAutomationRunner, AutomationRunner, InstantiationType.Delayed);

registerSingleton(IAutomationDialogService, AutomationDialogService, InstantiationType.Delayed);
