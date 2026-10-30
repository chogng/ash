/** Synthetic, parseable Codex credentials for tests that keep the real Rust auth owner. */
export function chatGPTAuthDocument(): string {
	const jwt = (value: unknown): string => `e30.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`;
	return JSON.stringify({
		auth_mode: 'chatgpt', last_refresh: new Date().toISOString(),
		tokens: {
			id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'synthetic-user', chatgpt_account_id: 'synthetic-account', chatgpt_plan_type: 'plus' } }),
			access_token: jwt({ exp: 4_000_000_000, jti: 'synthetic-test-login' }),
			refresh_token: 'synthetic-refresh-must-not-be-used', account_id: 'synthetic-account',
		},
	});
}
