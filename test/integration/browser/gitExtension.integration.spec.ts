import { expect, test } from '@playwright/test';

for (const language of ['en', 'zh-CN']) test(`distributed Git Worker registers SCM, commands and history in ${language}`, async ({ page }) => {
 const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
 await page.goto('/gitExtension.html');
 try {
  const activation = await page.evaluate(language => window.gitExtensionIntegration.activate(language), language);
  expect(activation).toEqual([{ lifecycle: 'ready', failure: undefined, registrations: expect.arrayContaining(['sourceControl', 'command']) }]);
  await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
  const before = await page.evaluate(() => window.gitExtensionIntegration.state());
  expect(before.repositories[0].groups).toContain(language === 'zh-CN' ? '更改' : 'Changes');
  const history = await page.evaluate(() => window.gitExtensionIntegration.history());
  expect(history).toMatchObject([{ id: 'a'.repeat(40), subject: 'First commit' }]);
  await page.evaluate(() => window.gitExtensionIntegration.stage());
  await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().calls.some(call => call.method === 'git/stage'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.groups)).toContain(language === 'zh-CN' ? '暂存的更改' : 'Staged Changes');
  await page.evaluate(async () => {
   window.gitExtensionIntegration.answer(['feature']); await window.gitExtensionIntegration.invoke('git.branch', ['root']);
   window.gitExtensionIntegration.answer(['https://example.com/repo']); await window.gitExtensionIntegration.invoke('git.clone');
   window.gitExtensionIntegration.answer(['main']); await window.gitExtensionIntegration.invoke('git.init');
  });
  expect((await page.evaluate(() => window.gitExtensionIntegration.state())).calls.map(call => call.method)).toEqual(expect.arrayContaining(['git/branch/create', 'git/clone', 'git/init']));
  await page.evaluate(() => window.gitExtensionIntegration.disable());
  expect((await page.evaluate(() => window.gitExtensionIntegration.state())).repositories).toEqual([]);
  expect(errors).toEqual([]); expect((await page.evaluate(() => window.gitExtensionIntegration.state())).errors).toEqual([]);
 } finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});
