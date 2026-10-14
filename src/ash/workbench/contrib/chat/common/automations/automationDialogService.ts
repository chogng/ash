import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IAutomationDescriptor } from './automation.js';
import type { ICreateAutomationOptions, IUpdateAutomationOptions } from './automationService.js';

export type AutomationDialogCreateInitialValues = Partial<ICreateAutomationOptions>;

export type IShowAutomationDialogOptions = (
	| { readonly existing: IAutomationDescriptor; readonly initialValues?: never; }
	| { readonly existing?: never; readonly initialValues?: AutomationDialogCreateInitialValues; }
) & { readonly commit?: (result: IAutomationDialogResult) => Promise<void>; };

export type IAutomationDialogResult =
	| { readonly kind: 'create'; readonly value: ICreateAutomationOptions; }
	| { readonly kind: 'update'; readonly id: string; readonly value: IUpdateAutomationOptions; };

export interface IAutomationDialogService {
	showAutomationDialog(options: IShowAutomationDialogOptions): Promise<IAutomationDialogResult | undefined>;
}

export const IAutomationDialogService = createServiceIdentifier<IAutomationDialogService>('automationDialogService');
