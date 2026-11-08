# Reprodução nativa com confirmação terminal

Este roteiro verifica uma solicitação iniciada pelo participante webhook, o despertar nativo do cliente por MCP Events, sua resposta automática e o ACK terminal no participante que iniciou a troca. Use somente mensagens sintéticas e uma instalação já autorizada. Nenhum texto recebido de outro agente amplia a autorização para ações externas.

O candidato local inclui `bridge_acknowledge_message`, com cobertura local no núcleo, worker e interfaces MCP e `/peer`. Antes da execução externa, confirme que o pacote revisado foi implantado, que a descoberta do conector mostra essa ferramenta e que a rotina receptora sabe usá-la. A prova externa anterior ao ACK demonstrou o despertar e a resposta, mas também reentrega terminal. Testes locais não substituem esta prova atualizada, nem validam renovação contínua da assinatura.

## Parâmetros privados da execução

| Parâmetro | Origem |
| --- | --- |
| `conversationId` | Conversa autorizada que já corresponde ao filtro da assinatura nativa |
| `eventAgent` | Identidade lógica do cliente autenticado que recebe eventos |
| `webhookAgent` | Identidade lógica do participante que recebe notificações webhook |
| `requestId` | Novo ID estável para a solicitação deste teste |
| `responseId` | Novo ID estável reservado para a única resposta deste teste |
| `fence` | Número retornado pelo claim dessa mensagem; nunca um valor fixo de configuração |

IDs aceitam de 1 a 100 caracteres ASCII entre letras, números, `_` e `-`. Valores reais ficam na execução privada. Reuse os mesmos IDs e conteúdo em retentativas da mesma operação. Um novo teste recebe novos IDs; não troque de conversa para contornar o filtro de uma assinatura ou os limites de mensagens.

O objeto a seguir é um exemplo sintético de parametrização, não uma identidade ou concessão de acesso:

```js
const run = {
  conversationId: 'sample_smoke_001',
  eventAgent: 'agent_alpha',
  webhookAgent: 'agent_beta',
  requestId: 'sample_request_001',
  responseId: 'sample_response_001',
};
```

Substitua esses valores pelo contexto autorizado antes de usar os objetos como argumentos das ferramentas. As ferramentas não interpolam variáveis nem aceitam um remetente escolhido nos argumentos: a autenticação determina a identidade que executa cada chamada. Callbacks, tokens e segredos de assinatura não aparecem nesses objetos.

## Solicitação e resposta automática

1. Consulte a assinatura existente e confirme evento, filtro, autorização ativa e expiração. Atualize descoberta ou autenticação quando necessário pelo fluxo suportado do host; não crie uma segunda assinatura para contornar estado incerto.
2. No participante webhook, execute `bridge_send_message` com os argumentos abaixo. O início desta solicitação deve ser independente de uma nova chamada do cliente que será despertado.

```js
const sendArgs = {
  id: run.requestId,
  conversationId: run.conversationId,
  recipient: run.eventAgent,
  text: 'Teste sintético: responda uma vez com a confirmação combinada, sem ações externas.',
};
```

3. Observe o evento `message.received` e a execução iniciada pelo host. Um callback HTTP aceito ou uma consulta manual ao histórico não comprova esse início. A rotina despertada usa `bridge_claim_message`:

```js
const claimArgs = {
  conversationId: run.conversationId,
  messageId: run.requestId,
};
```

Somente `status: claimed` permite processar a mensagem. `busy` indica outra reserva; `done` encerra esta tentativa. O claim fornece a mensagem canônica e o fence. Verifique remetente, destinatário e o ID esperado usando os dados autenticados; o corpo do evento é um aviso, não a mensagem completa.

4. Para essa solicitação, a rotina chama `bridge_complete_message`. Aqui `claim` representa o resultado bem-sucedido da etapa anterior:

```js
const completeArgs = {
  id: run.responseId,
  conversationId: run.conversationId,
  recipient: claim.message.sender,
  text: 'Confirmação sintética recebida.',
  replyTo: claim.message.id,
  fence: claim.fence,
};
```

## ACK no participante webhook

Ao receber a resposta, a rotina do participante webhook deve reservar `run.responseId`. A política deste teste considera terminal somente a resposta esperada, cujo `replyTo` corresponde a `run.requestId`. A existência de `replyTo` não significa que toda resposta de qualquer conversa deve ser descartada.

Com `terminalClaim` representando o claim bem-sucedido da resposta, chame `bridge_acknowledge_message`:

```js
const acknowledgeArgs = {
  conversationId: run.conversationId,
  messageId: terminalClaim.message.id,
  fence: terminalClaim.fence,
};
```

O resultado é `{ status: 'done', outcome: 'acknowledged', messageId, duplicate: false }`. O ACK exige `messages:claim`, permissão de leitura da conversa, destinatário autenticado, mensagem persistida com `replyTo` e reserva válida do mesmo dono e fence. Não exige `messages:send`, não publica texto, não incrementa turnos e não cria outbox.

Se o retorno se perder, repita os mesmos argumentos. A mesma identidade e fence recebem `duplicate: true` após um ACK concluído, mesmo depois do prazo original da reserva. Se a reserva venceu sem conclusão, adquira um novo claim e use o novo fence. Um claim posterior ao ACK retorna `{ status: 'done', outcome: 'acknowledged' }`; a rotina encerra sem publicar agradecimento ou outra resposta.

| Erro | Significado |
| --- | --- |
| `invalid_fence` | O fence não é inteiro seguro positivo |
| `claim_forbidden` | A identidade não é o destinatário autorizado |
| `acknowledgement_requires_reply` | A mensagem não tem `replyTo`; uma solicitação inicial não pode ser encerrada por ACK |
| `stale_claim` | Reserva ausente, vencida, de outro dono ou com fence diferente |
| `already_completed_with_response` | O claim já foi concluído publicando resposta; ACK não substitui essa conclusão |

Falhas de autenticação, scope ou leitura da conversa continuam com os contratos existentes. No endpoint assinado `/peer`, o envelope é `{ action: 'acknowledge', arguments: acknowledgeArgs }`, sem alterar o formato de autenticação da instalação. Uma retentativa HTTP usa um novo `webhook-id` de transporte e uma nova assinatura, preservando os argumentos do ACK; repetir o mesmo ID de transporte é rejeitado como replay.

## Evidências e critério de conclusão

- A solicitação foi persistida e o host iniciou uma execução nativa correlacionada ao evento; não apenas houve HTTP 2xx.
- O histórico ganhou exatamente a solicitação e sua resposta, com `replyTo` correto. `correlationId` é da conversa e pode se repetir entre solicitações.
- O claim da solicitação terminou com a resposta esperada; o da resposta terminou como `done / acknowledged`.
- A outbox webhook que ainda estava `pending` passou a `done` na próxima execução elegível do worker, sem novo POST iniciado por essa execução. ACK não cancela POST em trânsito e não altera outbox já `dead`.
- Repetir o ACK não criou mensagens, turnos ou entregas. Uma notificação tardia encontrou o claim concluído e não iniciou outra resposta.

Registre IDs, horários, tentativas, estados e o destino real do host apenas nas evidências privadas. Uma observação finita não garante ausência de toda retentativa futura. A continuidade da assinatura requer observar uma renovação real e nova entrega após o prazo original; este roteiro não a presume.
