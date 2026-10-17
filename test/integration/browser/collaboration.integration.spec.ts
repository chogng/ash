import { expect, test, type Page } from '@playwright/test';

function channel(page: Page, id: string) { return page.getByRole('treeitem').filter({ has: page.locator(`[data-channel-id="${id}"]`) }); }

for (const locale of ['en', 'zh-CN']) {
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`Collaboration panel ${locale} ${theme}: channels, call controls and narrow layout`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.setViewportSize({ width: 360, height: 820 });
			await page.goto(`/collaboration.html?locale=${locale}&theme=${theme}`);
			await expect(channel(page, 'desktop')).toBeVisible();
			expect(await page.evaluate(() => window.ashCollaboration.operations())).toEqual([]);
			const search = page.getByRole('searchbox');
			await search.fill('desktop');
			await expect(channel(page, 'projects')).toBeVisible();
			await expect(channel(page, 'ash')).toBeVisible();
			await expect(channel(page, 'general')).toHaveCount(0);
			await search.press('Escape');
			await expect(channel(page, 'general')).toBeVisible();
			await page.getByRole('button', { name: locale === 'en' ? 'Create call' : '创建通话', exact: true }).click();
			await expect(page.getByRole('list', { name: locale === 'en' ? 'People in this call' : '通话参与者' })).toContainText(locale === 'en' ? 'Participant 2' : '参与者 2');
			expect(await page.evaluate(() => window.ashCollaboration.operations())).toEqual(['local']);
			await page.getByRole('button', { name: locale === 'en' ? 'Leave call' : '离开通话', exact: true }).click();
			await search.focus();
			await page.locator('#app').screenshot({ path: test.info().outputPath('collaboration.png') });
			await page.setViewportSize({ width: 260, height: 650 });
			await expect(search).toBeVisible();
			expect(await page.locator('#app').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await search.focus();
			const outline = await search.evaluate(element => getComputedStyle(element).outlineStyle);
			expect(outline).toBe('solid');
			expect(await page.evaluate(() => window.ashCollaboration.accessible('view'))).toContain('# projects / ash / desktop');
			expect(await page.evaluate(() => window.ashCollaboration.accessible('help'))).toContain('F2');
			await page.evaluate(() => window.ashCollaboration.verbosity(false));
			await expect(page.getByRole('tree')).not.toHaveAttribute('aria-label', /Alt\+F1/);
			expect(errors).toEqual([]);
			expect(await page.evaluate(() => window.ashCollaboration.notifications())).toEqual([]);
		});
	}
}

test('Channel tree preserves collapse through search and supports keyboard create, rename and removal', async ({ page }) => {
	await page.setViewportSize({ width: 600, height: 900 });
	await page.goto('/collaboration.html');
	await channel(page, 'rooms').click();
	await page.keyboard.press('ArrowLeft');
	await expect(channel(page, 'rooms')).toHaveAttribute('aria-expanded', 'false');
	const search = page.getByRole('searchbox');
	await search.fill('design');
	await expect(channel(page, 'design')).toBeVisible();
	await search.press('Escape');
	await expect(channel(page, 'rooms')).toHaveAttribute('aria-expanded', 'false');
	await channel(page, 'rooms').click();
	await page.keyboard.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'New Subchannel', exact: true }).click();
	const input = page.getByRole('textbox', { name: /^(New Subchannel|Rename Channel|New Channel)$/ });
	await input.fill('design');
	await input.press('Enter');
	await expect(input).toBeVisible();
	await expect(page.getByText('A channel with this name already exists here.')).toBeVisible();
	await input.fill('meeting'); await input.press('Enter');
	const meeting = page.getByRole('treeitem').filter({ hasText: 'meeting' });
	await expect(meeting).toHaveAttribute('aria-level', '2');
	await expect(channel(page, 'rooms')).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('.collaboration-selection-label')).toHaveText('# rooms / meeting');
	await expect(page.getByRole('tree')).toBeFocused();
	await expect(page.getByRole('tree')).toHaveAttribute('aria-activedescendant', (await meeting.getAttribute('id'))!);
	await page.keyboard.press('F2');
	await input.fill('planning'); await input.press('Enter');
	await expect(page.getByRole('treeitem').filter({ hasText: 'planning' })).toBeVisible();
	await expect(page.locator('.collaboration-selection-label')).toHaveText('# rooms / planning');
	await page.keyboard.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Remove Channel and Subchannels', exact: true }).click();
	await page.getByRole('option', { name: /Remove .* and all subchannels/ }).click();
	await expect(page.getByRole('treeitem').filter({ hasText: 'planning' })).toHaveCount(0);
	await page.keyboard.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Remove Channel and Subchannels', exact: true }).click();
	await page.getByRole('option', { name: /Remove .* and all subchannels/ }).click();
	await expect(channel(page, 'rooms')).toHaveCount(0);
	await expect(channel(page, 'design')).toHaveCount(0);
	await expect(channel(page, 'engineering')).toHaveCount(0);
	await page.getByRole('button', { name: 'New Channel', exact: true }).click();
	await input.fill('A very long channel name that must truncate inside a narrow collaboration sidebar'); await input.press('Enter');
	await expect(page.getByText('Use 1–80 characters without slashes or control characters.')).toBeVisible();
	await input.fill('A very long channel name that truncates inside a narrow collaboration sidebar'); await input.press('Enter');
	await page.setViewportSize({ width: 260, height: 650 });
	const label = page.locator('.collaboration-channel-name').filter({ hasText: 'A very long' });
	await expect(label).toBeVisible();
	expect(await label.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
	await search.fill('missing channel');
	await expect(page.getByText('No matching channels. Try another search.')).toBeVisible();
	await search.press('Escape');
	expect(await page.evaluate(() => window.ashCollaboration.notifications())).toEqual([]);
	await page.reload();
	await expect(page.locator('.collaboration-channel-name').filter({ hasText: 'A very long' })).toBeVisible();
	expect(await page.evaluate(() => window.ashCollaboration.operations())).toEqual([]);
});

test('Channels remain available when this host has no calls capability', async ({ page }) => {
	await page.goto('/collaboration.html?noCalls=1');
	await expect(channel(page, 'general')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Create call', exact: true })).toHaveCount(0);
});


test('Members support invitations, role changes, revocation and read-only channel controls', async ({ page }) => {
	await page.goto('/collaboration.html');
	await page.getByRole('searchbox').focus();
	const members = page.getByRole('button', { name: 'Members and Permissions', exact: true });
	await members.click();
	await page.getByRole('option', { name: /Invite Member/ }).click();
	const input = page.getByRole('textbox', { name: 'Member Display Name' });
	await input.fill('Bob'); await input.press('Enter');
	await page.getByRole('option', { name: 'Editor', exact: true }).click();
	await page.getByRole('option', { name: 'Copy Invitation', exact: true }).click();
	expect(JSON.parse(await page.evaluate(() => window.ashCollaboration.clipboard())).credential).toHaveLength(64);
	await members.click(); await page.getByRole('option', { name: /Bob/ }).click();
	await page.getByRole('option', { name: 'Change Role', exact: true }).click();
	await page.getByRole('option', { name: 'Viewer', exact: true }).click();
	await members.click(); await expect(page.getByRole('option', { name: /Bob/ })).toContainText('Viewer');
	await page.getByRole('option', { name: /Bob/ }).click();
	await page.getByRole('option', { name: 'Remove Member', exact: true }).click();
	await page.getByRole('option', { name: 'Revoke access for Bob', exact: true }).click();
	await members.click(); await expect(page.getByRole('option', { name: /Bob/ })).toHaveCount(0); await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashCollaboration.setRole('viewer'));
	await expect(page.getByRole('button', { name: 'New Channel', exact: true })).toBeDisabled();
	await channel(page, 'general').click(); await page.keyboard.press('F2');
	await expect(page.getByRole('textbox', { name: 'Rename Channel' })).toHaveCount(0);
	await members.click(); await expect(page.getByRole('option', { name: /Invite Member/ })).toHaveCount(0); await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashCollaboration.revoke());
	await expect(page.getByText('Access denied. Your invitation may have been revoked.')).toBeVisible();
	await expect(page.getByRole('treeitem')).toHaveCount(0);
});

test('A host without channels capability offers no fake shared channels', async ({ page }) => {
	await page.goto('/collaboration.html?noChannels=1');
	await expect(page.getByRole('button', { name: 'Connect Channels', exact: true })).toBeDisabled();
	await expect(page.getByText('Channels require a connected Ash backend.')).toBeVisible();
});


test('channel actions are keyboard accessible and start a call using channel access', async ({ page }) => {
	await page.goto('/collaboration.html');
	await channel(page, 'general').click();
	await expect(page.getByRole('button', { name: 'Open channel notes', exact: true })).toBeEnabled();
	await page.keyboard.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Join or start channel call', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashCollaboration.operations())).toEqual(['invitation']);
	await expect(page.locator('.ash-call').getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Join or start channel call', exact: true }).click();
	await expect(page.locator('.collaboration-connection')).toContainText('Leave the current call');
	await expect.poll(() => page.evaluate(() => window.ashCollaboration.operations())).toEqual(['invitation']);
});
