# Viewer de histórico

A revisão visual da issue #4 foi aprovada antes da implementação. O viewer usa React, Vite, Tailwind e componentes oficiais shadcn/ui (Base UI, estilo Nova), com dados tratados como texto. JavaScript e CSS são compilados e incorporados à resposta `/viewer`; não há CDN, nova origem, hospedagem externa ou persistência de tokens. OAuth mantém PKCE, validação de state/issuer e descarte de códigos da URL. O modo manual continua disponível quando OAuth não está configurado.

## Uso e limites

O tema inicial acompanha a preferência do sistema. O botão no cabeçalho alterna entre modo claro e escuro, inclusive na tela de login. A escolha permanece apenas durante a página aberta.

- Lista por participante e ID, com busca por ID/participante; abertura por ID disponível em desktop/celular.
- Busca literal sem distinção de maiúsculas no texto da conversa selecionada, com período de 24 horas, 7 ou 14 dias. Não é busca global nem índice full-text.
- Cada chamada examina 30 registros por padrão, no máximo 100. Uma página vazia ainda pode ter continuação. O fim só é indicado quando não há cursor. A lista percorre uma partição de participante por chamada; o custo adicional de autorização é limitado aos candidatos dessa página.
- A atualização consulta a partir do último registro examinado; não baixa novamente as páginas anteriores nem desloca a leitura. Se ainda houver páginas, a atualização avança uma página e informa que a consulta continua parcial. A hora exibida é a última consulta bem-sucedida, não uma garantia de atualização integral.
- Tokens, conteúdo, filtros e IDs de conversa não entram no endereço do navegador. Não há envio de mensagens, telemetria ou armazenamento local do histórico. O cliente remove mensagens expiradas enquanto a página está aberta e limpa conteúdo/token ao sair ou receber 401.
- Autorização é revalidada em cada requisição. Revogação no provedor segue a semântica de validação JWT já existente; a interface não consulta o provedor continuamente nem promete revogação instantânea.

## Contrato REST adicionado

`POST /history`, autenticado com `history:read`, é uma consulta somente leitura. O contrato `GET /history` e as ferramentas MCP existentes são preservados.

```json
{"operation":"conversations","term":"alpha","limit":30}
```

Retorna `conversations` (ID, participantes, timestamp), `coverage` e `cursor` opcional. A ordem é por participante autorizado e ID; não há promessa de ordenação global por atividade. Quando ambos os participantes são autorizados, apenas o primeiro em ordem lexical emite a conversa.

```json
{"operation":"messages","conversationId":"demo_planejamento","term":"validação","since":"2026-11-01T00:00:00.000Z","limit":30}
```

Retorna `messages`, `examined`, `cursor` opcional e `resume`. `cursor` continua a página; `resume` permite consultar publicações posteriores mesmo após o fim. Os filtros e o limite devem permanecer iguais ao continuar. `until` opcional usa data ISO UTC e precisa ser posterior ou igual a `since`. A retenção de 14 dias sempre prevalece sobre os filtros.

Cursores são opacos para o cliente, vinculados ao tenant, identidade, scopes, participantes e filtros. Não são credenciais: uma posição manipulada não substitui a autorização e a consulta permanece limitada à partição autorizada. Termos/corpos e tokens não devem ser adicionados a access logs, traces ou telemetria. O template continua sem logging de corpos da API.

## Catálogo e ativação explícita

O novo catálogo usa PK `<tenant>#catalog#<participant>` e SK `conversation#<conversationId>`, sem texto de mensagens. Ao publicar, cada writer habilitado atualiza os dois registros do catálogo e o resumo canônico `meta.latest` na mesma transação do histórico. Conflitos usam o retry/CAS existente. A retenção do índice deriva do timestamp da última mensagem, sem expirar os metadados permanentes da conversa. A leitura revalida ACL, resumo canônico e retenção lógica; não depende da remoção assíncrona por TTL. Nenhum Scan é necessário no runtime.

`limits.viewerCatalog` em cada configuração privada aceita:

| Valor | Comportamento |
| --- | --- |
| omitido / `disabled` | Writers não acessam o novo namespace; viewer informa catálogo não ativado e permite abrir por ID. |
| `partial` | Writers mantêm o catálogo; viewer informa explicitamente que conversas anteriores podem faltar. |
| `complete` | Mesmo comportamento de escrita; cobertura completa declarada pelo operador após inventário/migração. |

A configuração padrão é desativada para não quebrar writers durante o CD que publica somente código. A leitura direta por ID permanece disponível no novo viewer **após a rota POST estar publicada**. O viewer novo precisa dessa rota mesmo com catálogo desativado.

### Sequência para uma instalação existente — não executada por este PR

1. Revisar e aplicar separadamente a mudança de infraestrutura: `POST /history`; GetItem/PutItem de `catalog` somente para MCP/ingress; Query de `catalog` somente para history. PutItem continua restrito a TransactWriteItems e todas as permissões permanecem limitadas à instalação. Não alterar TTL, grants de identidades, callbacks ou papéis de deployment.
2. Publicar o código com catálogo desativado e verificar a rota e login com dados sintéticos. O CD atual clona a infraestrutura ativa e não aplica as alterações deste template: **merge/code-only deploy isolado não basta para ativar o viewer novo**. Coordenar a publicação da rota antes de servir esta versão em produção. Este PR não enfraquece essa proteção do CD.
3. Habilitar `partial` nos writers e no leitor somente depois das permissões. Convergir todos os writers e drenar invocações antigas. Uma instância antiga pode preservar um resumo desatualizado ou não manter o índice; não declarar cobertura completa durante rollout misto.
4. Para histórico anterior, obter uma lista completa e autorizada de IDs de conversas/participantes por inventário privado existente ou exportação aprovada. A API Store não consegue enumerar todos os metadados por Query. Não usar Scan como atalho nem alegar cobertura com apenas novas mensagens. Sem inventário completo, manter `partial`.
5. Preparar um manifesto privado e dry-run: para cada ID conhecido, ler `meta` e páginas limitadas de `history/message#`; identificar a mensagem retida de maior turno. Sem mensagem vigente, não criar entrada. Comparar participantes com metadados, interromper em inconsistências e não registrar texto de mensagens.
6. Após aprovação específica do manifesto, aplicar resumo e índices na mesma transação condicional, incluindo a versão lida de `meta` e de cada índice. Concorrência exige reler e recalcular, nunca sobrescrever a publicação mais recente. TTL do índice usa o timestamp original da última mensagem retida. Esse backfill requer identidade operacional separada; o viewer não recebe escrita.
7. Reconciliar todos os IDs do inventário e verificar descoberta/isolamento com identidades autorizadas antes de configurar `complete`. Rollback de código/configuração deve retornar o catálogo para `partial` ou `disabled`; não excluir índices ou alterar retenção automaticamente.

Este PR não executa infraestrutura, migração ou ativação e não comprova cobertura de conversas reais. Essas verificações operacionais continuam pendentes na issue #4.

## Desenvolvimento e validação

```sh
npm ci --ignore-scripts
npm run build:viewer
npm run check
npx playwright install chromium
npm run test:viewer
npm run demo
```

`src/viewer-assets.ts` é gerado e ignorado pelo Git. `check`, `start` e `package` via npm constroem o bundle; antes de executar `npx serverless package` diretamente, execute `npm run build:viewer`. A CI constrói antes dos testes. Os componentes ficam em `viewer/src/components/ui`, com aliases em `components.json`.

Para inspeção local: `npm run viewer:demo`, abrir `http://127.0.0.1:4173/viewer` e usar `synthetic-viewer-token`. O servidor só escuta loopback, usa memória e dados sintéticos, não chama AWS nem provedores externos.

Os testes cobrem ACL/tenant, scopes, retenção, limites e cursores, migração do contrato de autenticação, XSS como texto, desktop/celular, teclado, respostas atrasadas, paginação, recuperação de erro e limpeza após 401. Testes locais não comprovam IAM, rota, callback OAuth ou backfill de uma implantação real.
