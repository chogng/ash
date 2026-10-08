import type { Event } from '../../../base/common/event.js';

export type SymphonyStatus = 'pending' | 'starting' | 'running' | 'blocked' | 'retrying' | 'stopping' | 'paused' | 'completed';
export type SymphonyControl = 'run' | 'pause' | 'complete';
export interface SymphonyWorkflow {
	readonly id: string;
	readonly path: string;
	readonly tracker: string;
	readonly enabled: boolean;
	readonly error: string | undefined;
}
export interface SymphonyConversation {
	readonly id: string;
	readonly workflowId: string;
	readonly identifier: string;
	readonly title: string;
	readonly status: SymphonyStatus;
	readonly tokens: number;
	readonly tokensComplete: boolean;
	readonly durationMs: number;
	readonly error: string | undefined;
}
export interface SymphonyMessage { readonly id: string; readonly role: 'user' | 'assistant'; readonly text: string }
export interface SymphonySnapshot { readonly workflows: readonly SymphonyWorkflow[]; readonly conversations: readonly SymphonyConversation[] }

/** Profile-owned scheduling exposed through the window's existing App Server connection. */
export interface ISymphonyBackend {
	readonly onDidChange: Event<void>;
	read(): Promise<SymphonySnapshot>;
	configure(path: string): Promise<SymphonySnapshot>;
	submit(workflowId: string, title: string, prompt: string): Promise<SymphonyConversation>;
	control(id: string, control: SymphonyControl): Promise<void>;
	enable(workflowId: string, enabled: boolean): Promise<void>;
	messages(id: string): Promise<{ readonly conversation: SymphonyConversation; readonly messages: readonly SymphonyMessage[] }>;
}
