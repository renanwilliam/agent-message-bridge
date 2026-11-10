import { test, expect, type Page } from '@playwright/test';
async function login(page: Page) {
  await page.goto('/viewer');
  await page.getByLabel('Token de acesso').fill('synthetic-viewer-token');
  await page.getByRole('button', { name: 'Consultar histórico' }).click();
}
async function select(page: Page, mobile: boolean, id = 'demo_planejamento') {
  if (mobile)
    await page.getByRole('button', { name: 'Conversas', exact: true }).click();
  await page.getByRole('button').filter({ hasText: id }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
test('descoberta, paginação, busca, conteúdo seguro e limpeza da sessão', async ({
  page,
  isMobile,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const reads: { url: string; token?: string; body: string }[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/history'))
      reads.push({
        url: request.url(),
        token: request.headers().authorization,
        body: request.postData() ?? '',
      });
  });
  await login(page);
  await select(page, isMobile);
  await expect(page.getByRole('article')).toHaveCount(30);
  await expect(page.getByText('Mais recentes primeiro', { exact: false })).toBeVisible();
  await expect(page.getByRole('article').first()).toContainText('Mensagem sintética 35.');
  await expect(page.getByRole('article').last()).toContainText('Mensagem sintética 6.');
  await page.screenshot({ path: testInfo.outputPath('viewer.png') });
  await page.getByRole('button', { name: 'Carregar mensagens anteriores' }).click();
  await expect(page.getByRole('article')).toHaveCount(35);
  await expect(
    page.getByText('<script>window.syntheticXss = true</script>', {
      exact: false,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => 'syntheticXss' in window)).toBe(false);
  await expect(
    page.getByText('Fim do histórico disponível', { exact: true }),
  ).toBeVisible();
  await page.getByRole('article').nth(10).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Atualizar histórico' }).click();
  await expect(page.getByRole('article')).toHaveCount(30);
  await expect(page.getByRole('article').first()).toContainText('Mensagem sintética 35.');
  await expect(page.getByRole('article').last()).toContainText('Mensagem sintética 6.');
  const messageReads = reads.map(r => JSON.parse(r.body)).filter(r => r.operation === 'messages');
  expect(messageReads.every(r => r.order === 'desc')).toBe(true);
  expect(messageReads[1].cursor).toBeTruthy();
  expect(messageReads[2].cursor).toBeUndefined();
  await page.getByLabel('Buscar nesta conversa').fill('Resultado final');
  await page
    .getByRole('button', { name: 'Buscar mensagens', exact: true })
    .click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Carregar mensagens anteriores' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Carregar mensagens anteriores' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  expect(
    reads.every(
      (r) =>
        !r.url.includes('?') && r.token === 'Bearer synthetic-viewer-token',
    ),
  ).toBe(true);
  expect(reads.some((r) => r.body.includes('Resultado final'))).toBe(true);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  await page.getByRole('button', { name: 'Sair e limpar' }).click();
  await expect(page.getByLabel('Token de acesso')).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('teclado, abrir por ID, metadados e largura responsiva', async ({
  page,
  isMobile,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Abrir por ID' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('ID da conversa').fill('demo_validacao');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Metadados técnicos' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('other_1', { exact: true }).first(),
  ).toBeVisible();
  if (isMobile) {
    await page.getByRole('button', { name: 'Conversas', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'Conversas', exact: true }),
    ).toBeFocused();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('resposta atrasada não mistura conversas e chamadas repetidas não duplicam páginas', async ({
  page,
  isMobile,
}) => {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayed = false;
  await page.route('**/history', async (route) => {
    const body = route.request().postDataJSON();
    if (
      body.operation === 'messages' &&
      body.conversationId === 'demo_planejamento' &&
      !delayed
    ) {
      delayed = true;
      await wait;
    }
    await route.continue().catch(() => {});
  });
  await login(page);
  await select(page, isMobile);
  await expect.poll(() => delayed).toBe(true);
  await select(page, isMobile, 'demo_validacao');
  await expect(page.getByRole('article')).toHaveCount(1);
  release!();
  await expect(page.getByRole('article')).toContainText(
    'Outra conversa sintética.',
  );
  await select(page, isMobile);
  await expect(page.getByRole('article')).toHaveCount(30);
  await page
    .getByRole('button', { name: 'Carregar mensagens anteriores' })
    .dblclick();
  await expect(page.getByRole('article')).toHaveCount(35);
});
test('erro recuperável e expiração removem o conteúdo privado', async ({
  page,
  isMobile,
}) => {
  await login(page);
  await select(page, isMobile);
  await expect(page.getByRole('article')).toHaveCount(30);
  await page.route('**/history', (route) =>
    route.fulfill({ status: 503, body: '{}' }),
  );
  await page.getByRole('button', { name: 'Atualizar histórico' }).click();
  await expect(page.getByText('Consulta não concluída')).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(30);
  await page.unroute('**/history');
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('article')).toHaveCount(30);
  await page.route('**/history', (route) =>
    route.fulfill({ status: 401, body: '{}' }),
  );
  await page.getByRole('button', { name: 'Atualizar histórico' }).click();
  await expect(page.getByLabel('Token de acesso')).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
});
test('falha ao carregar anteriores repete a mesma página e atualizar mantém os filtros', async ({ page, isMobile }) => {
  const reads: Record<string, any>[] = [];
  let fail = true;
  await page.route('**/history', async route => {
    const body = route.request().postDataJSON();
    if (body.operation === 'messages') {
      reads.push(body);
      if (body.cursor && fail) {
        fail = false;
        await route.fulfill({ status: 503, body: '{}' });
        return;
      }
    }
    await route.continue();
  });
  await login(page);await select(page, isMobile);
  await page.getByRole('button', { name: 'Carregar mensagens anteriores' }).click();
  await expect(page.getByText('Consulta não concluída')).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(30);
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('article')).toHaveCount(35);
  expect(reads[1]!.cursor).toBe(reads[2]!.cursor);
  await page.getByLabel('Buscar nesta conversa').fill('Resultado final');
  await page.getByRole('button', { name: 'Buscar mensagens', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Atualizar histórico' }).click();
  await expect(page.getByRole('button', { name: 'Atualizar histórico' })).toBeEnabled();
  expect(reads.at(-1)).toEqual({ ...reads.at(-2), cursor: undefined });
  expect(reads.at(-1)!.term).toBe('Resultado final');
  expect(reads.at(-1)!.since).toBeTruthy();
  expect(reads.at(-1)!.cursor).toBeUndefined();
});

test('modo escuro acompanha o sistema e alterna por teclado sem perder a conversa', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await login(page);
  await expect(page.locator('html')).toHaveClass('dark');
  await select(page, isMobile);
  await expect(page.getByRole('article')).toHaveCount(30);
  await page.getByRole('button', { name: 'Atualizar histórico' }).waitFor();
  await expect(
    page.getByRole('button', { name: 'Atualizar histórico' }),
  ).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('viewer-dark.png') });
  await page.getByRole('button', { name: 'Ativar modo claro' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).not.toHaveClass('dark');
  await expect(page.getByRole('article')).toHaveCount(30);
  await page.getByRole('button', { name: 'Ativar modo escuro' }).click();
  await expect(page.locator('html')).toHaveClass('dark');
  await page.getByRole('button', { name: 'Abrir por ID' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(
    await page
      .getByRole('dialog')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe('rgb(32, 32, 32)');
  await page.keyboard.press('Escape');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
