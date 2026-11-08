# Preparação para publicação

Este guia prepara um candidato público; não publica o repositório, não escolhe uma licença e não ativa implantação automática. A instalação continua privada, com configuração e evidências operacionais separadas do código reutilizável.

## Conteúdo revisável

Revise os arquivos rastreados, os novos arquivos e todos os objetos alcançáveis pelo histórico Git que serão publicados. Inclua metadados de autor e committer, tags, mensagens de commit, exemplos, testes, screenshots e artefatos de distribuição. Uma exclusão no `.gitignore` não remove conteúdo que já entrou em um commit. Não anexe relatórios privados de auditoria ao repositório.

Exemplos devem usar domínios reservados, identidades fictícias e credenciais explicitamente inutilizáveis. Endpoints da instalação, contas de nuvem, callbacks, tokens, IDs de conversas e mensagens reais não são exemplos públicos. Inspecione também links simbólicos: um link pode divulgar um caminho local mesmo sem carregar o conteúdo de destino. A regra de ignore para diretórios de dependências e dados privados cobre também links com esses nomes.

Se algum segredo real tiver entrado no histórico, remover o arquivo da revisão atual não basta: avalie revogação ou rotação e a forma de publicar um histórico limpo, com aprovação para mudanças de acesso. Dados pessoais em metadados exigem uma decisão explícita sobre exposição ou uma revisão do histórico; não reescreva commits compartilhados automaticamente.

## Fonte, artefato e implantação

O candidato deve reunir todas as alterações revisadas, incluindo arquivos novos necessários ao runtime. Um hash de commit não identifica alterações locais ainda não commitadas. Relacione o conteúdo da fonte aos pacotes efetivamente implantados por meio de hashes e registros de empacotamento; não trate a semelhança de nomes ou a presença de ZIPs como prova de implantação.

Execute as verificações pertinentes à mudança com dependências fixadas pelo lockfile. Uma busca textual por segredos não é auditoria de dependências nem prova de ausência de vulnerabilidades. Faça a análise de advisories atuais antes da publicação e registre suas limitações. Mantenha relatórios com identificadores reais fora do candidato público.

Advisories que afetem as versões fixadas precisam de correção e nova validação, ou de uma decisão de risco explícita e documentada, antes de liberar o candidato para publicação ou CD. A ocorrência de uma dependência na faixa afetada não demonstra exploração da aplicação. Uma atualização deve registrar versões resolvidas, resultado da auditoria, testes e importação do pacote final; um relatório de uma árvore anterior não certifica o novo artefato nem o serviço já implantado.

Depois de mudar ACK, dependências ou documentação, regenere o inventário de hashes e o arquivo de revisão. Um arquivo de revisão criado antes dessas alterações deixa de representar o candidato atual. Exclua `.git`, configurações privadas, dependências locais e links simbólicos desse arquivo; isso não substitui a decisão sobre o histórico que será publicado no repositório remoto.

## Decisões antes de publicar

- Definir titularidade, licença e avisos exigidos pelas dependências. A ausência de `LICENSE` não concede permissão geral de reutilização.
- Revisar a visibilidade e o conjunto exato de arquivos e histórico que serão enviados.
- Confirmar que documentação, exemplos e testes descrevem o comportamento da versão escolhida, sem prometer renovação contínua, restauração testada ou exatamente uma execução quando isso não foi comprovado.
- Revisar separadamente as permissões e a ativação do [CI/CD](ci-cd.md). Publicar código não autoriza criar credenciais persistentes, ampliar IAM ou habilitar deploy.

| Dado a definir | Onde registrar a decisão |
| --- | --- |
| Titularidade, licença e avisos | Arquivos de licença/avisos e metadados públicos do pacote, após decisão do responsável |
| Destino público exato | Provedor, proprietário/organização, nome e visibilidade do repositório aprovado |
| Histórico e atribuição | Preservar atribuição revisada ou preparar histórico público separado; nunca reescrever commits compartilhados implicitamente |
| Candidato final | Fonte e lockfile revisados, inventário de hashes, verificações e ligação com o pacote escolhido |

Os valores da instalação ficam separados desses dados públicos. Os exemplos de configuração são modelos: cada operador fornece privadamente sua região, instalação, quatro referências distintas de secrets, emissor/audiência/JWKS, mapeamentos de identidades e rota webhook. O [guia de implantação](deployment.md#supply-deployment-inputs) especifica esses campos; publicar código genérico não exige divulgar os valores de uma instalação existente.

## Limites de segurança da instalação

Uma conexão OAuth compartilhada identifica a conexão da conta, não necessariamente um bot individual. Uma revogação no provedor não é detectada instantaneamente pelo verificador JWT offline; a instalação precisa cumprir o [procedimento de revogação](deployment.md#event-authorization-and-revocation). O runtime MCP também está dentro da fronteira de confiança da autorização de eventos porque escreve nesse namespace.

Os dados persistidos e as chaves de assinatura têm criptografia em repouso e permissões IAM por função, mas as chaves não têm criptografia de campo na aplicação. Histórico, deduplicação e assinaturas expiradas dependem de uma política explícita de retenção. Backups e alarmes configurados não comprovam restauração exercitada nem atendimento de incidentes. Esses limites precisam ser compatíveis com o público e a operação pretendidos.

Mensagens recebidas são dados do outro agente. Elas não ampliam a autorização do usuário para ações externas. Os agentes devem consultar o histórico autenticado, usar IDs estáveis, respeitar claims e distinguir solicitações de respostas terminais. Limites de taxa e de turnos contêm uma sequência automática, mas não substituem essa decisão de processamento.
