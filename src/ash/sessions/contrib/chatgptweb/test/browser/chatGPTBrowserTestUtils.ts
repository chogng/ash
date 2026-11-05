import type { Page } from '@playwright/test';
import { simpleChatGPTModelCatalog } from '../../../../../../../test/fixtures/chatGPTModels.js';

/** Exercise the actual page and client with synthetic HTTP boundaries, without a real account. */
export async function mockChatGPTRequests(page: Page, answer = 'Synthetic answer'): Promise<void> {
	await page.route('**/service/**', async route => {
		const path = new URL(route.request().url()).pathname;
		const message = (id: string, role: string, text: string): object => ({ id, author: { role }, content: { content_type: 'text', parts: [text] } });
		if (path.endsWith('/models')) {
			await route.fulfill({ json: simpleChatGPTModelCatalog([{ slug: 'fixture', title: 'Fixture model' }]) });
		} else if (path.endsWith('/pins')) {
			await route.fulfill({ json: [] });
		} else if (path.endsWith('/gizmos/snorlax/sidebar')) {
			await route.fulfill({ json: { items: [], cursor: null } });
		} else if (path.includes('/gizmos/') && path.endsWith('/conversations')) {
			await route.fulfill({ json: { items: [], cursor: null } });
		} else if (path.endsWith('/conversations')) {
			await route.fulfill({ json: { items: [{ id: 'fixture-chat', title: 'Synthetic conversation' }], total: 1 } });
		} else if (path.endsWith('/conversation/fixture-chat')) {
			await route.fulfill({
				json: {
					title: 'Synthetic conversation', current_node: 'previous-reply', mapping: {
						question: { parent: null, message: message('question', 'user', 'Synthetic question') },
						empty: { parent: 'question', message: message('empty', 'assistant', '') },
						recap: { parent: 'empty', message: { id: 'recap', author: { role: 'assistant' }, content: { content_type: 'reasoning_recap', content: 'Thought for a few seconds' } } },
						whitespace: { parent: 'recap', message: message('whitespace', 'assistant', ' \n\t ') },
						'previous-reply': { parent: 'whitespace', message: message('previous-reply', 'assistant', answer) },
					}
				}
			});
		} else if (path.endsWith('/prepare')) {
			await route.fulfill({ json: { conduit_token: 'fixture-conduit' } });
		} else if (path.includes('/.headers/')) {
			await route.fulfill({ json: { 'OpenAI-Sentinel-Chat-Requirements-Token': 'fixture-verification' } });
		} else {
			await route.fulfill({ status: 500, json: {} });
		}
	});
}
