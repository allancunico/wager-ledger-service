# ARCHITECTURE.md

## Objetivo e invariantes

Serviço backend contínuo, sem front end, que recebe operações financeiras de provedores por HTTP e SQS. Deve permanecer correto com mensagens duplicadas ou fora de ordem, concorrência entre instâncias e falhas temporárias.

As invariantes centrais são:

- o saldo materializado da wallet é igual ao saldo reconstruído pelo ledger;
- o saldo nunca fica negativo;
- uma operação repetida não duplica débito ou crédito;
- o ledger é append-only;
- saldo, transação, ledger, inbox (quando a origem é SQS) e eventos de outbox são persistidos atomicamente.

PostgreSQL é a fonte de verdade. SQS FIFO contribui com ordenação e deduplicação, mas não substitui as garantias do banco.

## Componentes e stack

O código é dividido em domain, application, infrastructure e interfaces. O domínio não depende de NestJS, MikroORM ou SQS e encapsula estado por factories e transições explícitas. A aplicação coordena os casos de uso; infraestrutura implementa persistência e mensageria; interfaces expõem HTTP e mensagens. MikroORM foi escolhido por oferecer unidades de trabalho, transações explícitas e suporte aos locks PostgreSQL usados pelo serviço.

Stack: Bun 1.x, TypeScript estrito, NestJS, MikroORM, PostgreSQL 16, AWS SQS via LocalStack e Docker Compose.

Um mesmo processo pode habilitar três papéis pela variável ROLES:

| Papel | Responsabilidade |
|---|---|
| api | API HTTP, health e métricas |
| consumer | consumo da fila wager-transactions.fifo |
| workers | publicação da outbox e reprocessamento de referências |

O padrão habilita todos. Múltiplas instâncias compartilham o PostgreSQL e as mesmas filas.

## Dinheiro, persistência e idempotência

MikroORM usa registros de persistência e mappers para converter entre PostgreSQL e as entidades do domínio. Cada operação abre uma unidade de trabalho separada.

Valores monetários são strings decimais na API e no domínio são representados por Money/decimal.js. O banco usa NUMERIC(19,2) e coluna separada para moeda. Valores financeiros não são convertidos para number.

A idempotência persiste no banco:

- HTTP exige Idempotency-Key, única por provedor;
- SQS deduplica pelo messageId do envelope, persistido em inbox_messages por consumidor;
- externalTransactionId também é único por provedor;
- o payloadHash v1 usa SHA-256 em hexadecimal minúsculo sobre JSON canônico dos campos de negócio.

O hash inclui providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money normalizado para duas casas e referenceExternalTransactionId (null quando ausente). Exclui Idempotency-Key e metadados de transporte como messageId, occurredAt e correlationId. Assim, a mesma operação enviada por HTTP e SQS pode ser reconhecida como replay. Reutilizar uma chave com outro payload é conflito.

## Concorrência e transação financeira

O processamento usa PostgreSQL READ COMMITTED e SELECT FOR UPDATE na linha da wallet. Isso serializa alterações da mesma wallet sem bloquear wallets diferentes. lock_timeout limita a espera; timeout e deadlock são falhas transitórias.

Dentro de uma operação, a aplicação registra o inbox quando aplicável, consulta caminhos de replay/conflito, bloqueia a wallet, grava a transação e aplica as regras do domínio. Quando há efeito financeiro, atualiza saldo e versão e insere o lançamento do ledger. Os eventos correspondentes são gravados na outbox antes do commit.

O lock da wallet é obtido antes da inserção da transação para evitar disputa entre o lock da chave estrangeira e o lock exclusivo da wallet. Constraints de unicidade continuam protegendo as corridas. Nenhuma chamada de rede é feita dentro da transação financeira.

Uma wallet muito disputada é serializada pelo lock; essa é a principal limitação de vazão. Operações em wallets diferentes podem avançar em paralelo.

## Regras financeiras

| Tipo | Efeito no saldo | Referência |
|---|---|---|
| BET | débito; rejeita saldo insuficiente | não aceita |
| WIN | crédito | opcional; quando informada, deve apontar para BET processada |
| LOSS | registra o resultado sem alterar saldo nem ledger | não aceita |
| REFUND | crédito | exige BET processada |
| ROLLBACK | inverte o efeito da referência | exige BET, WIN ou REFUND processada |

As referências devem pertencer ao mesmo provedor, player, wallet, moeda e rodada. REFUND e ROLLBACK devem ter o mesmo valor da operação referenciada. Cada referência aceita até uma reversão processada de cada tipo; REFUND e ROLLBACK podem coexistir, mas uma segunda reversão do mesmo tipo é rejeitada. Uma reversão rejeitada não consome essa possibilidade.

Referência ainda ausente deixa a operação em PENDING_REFERENCE. O worker reavalia os itens vencidos com FOR UPDATE SKIP LOCKED, backoff exponencial e TTL configurável. Quando o TTL expira, o resultado é REJECTED com REFERENCE_NOT_FOUND; se a referência existe, mas não foi processada, é REFERENCE_NOT_PROCESSED.

REJECTED é uma decisão de negócio persistida e terminal. FAILED é reservado para esgotamento operacional das tentativas SQS e sua gravação é best effort. Uma falha operacional durante o processamento reverte a transação; não deve ser convertida em rejeição de negócio.

A wallet guarda um snapshot do saldo retornado por replay. Isso também preserva o saldo observado por LOSS, que não produz lançamento no ledger.

## Schema e migrations

Migrations versionadas e reversíveis criam wallets, wager_transactions, wallet_ledger_entries, inbox_messages e outbox_messages.

Constraints e triggers no PostgreSQL protegem as invariantes, entre elas:

- wallet única por player e moeda, saldo não negativo e versão válida;
- idempotency key e external transaction id únicos por provedor;
- tipos, estados, moeda e valores válidos;
- exigência e unicidade das reversões processadas;
- um lançamento por transação e wallet, direção e aritmética consistentes;
- bloqueio de UPDATE, DELETE e TRUNCATE no ledger;
- saldo da wallet igual ao último saldo do ledger no commit;
- transações processadas com efeito no saldo acompanhadas de lançamento compatível.

A criação de uma wallet com saldo inicial positivo grava uma transação interna OPENING e seu crédito no ledger na mesma transação SQL. Um saldo inicial zero não precisa de lançamento.

## API HTTP

| Rota | Uso |
|---|---|
| POST /wallets | cria wallet |
| POST /transactions | submete operação; exige Idempotency-Key |
| POST /wagering/transactions | alias compatível com o contrato do desafio |
| GET /wallets/:walletId | consulta saldo e versão |
| GET /wallets/:walletId/ledger | consulta ledger paginado |
| POST /wallets/:walletId/reconciliation | compara saldo e ledger |
| GET /transactions/:transactionId | consulta por ID interno |
| GET /transactions/by-external/:providerId/:externalTransactionId | consulta por ID externo |
| GET /providers/:providerId/wagering/transactions/:externalTransactionId | rota de consulta compatível com o desafio |
| GET /health/live e /health/ready | liveness e readiness |
| GET /metrics | métricas Prometheus |

A submissão distingue processamento novo (201), replay processado (200), operação pendente (202), rejeição de negócio (422), payload inválido (400), conflito de idempotência ou de ID externo (409), recurso ausente (404) e falha operacional transitória (503 com Retry-After). Erros usam application/problem+json. Uma divergência de reconciliação é informada, logada e medida; o sistema não altera o saldo para escondê-la.

## Consumidor SQS

A fila de entrada recebe um envelope com messageId, type igual a WagerTransactionRequested, occurredAt e data. data contém os mesmos campos de negócio usados pela API e Idempotency-Key no campo idempotencyKey. O messageId do envelope é a chave do inbox; o MessageId do broker continua sendo metadado de transporte.

O consumer executa o mesmo caso de uso financeiro da API e apaga a mensagem somente depois do commit. Rejeições de negócio são terminais e recebem ACK. Falhas transitórias são repetidas com visibility timeout e backoff; payload inválido permanece sem ACK e segue a redrive policy até a DLQ. A configuração padrão permite cinco entregas. No shutdown, o item em andamento termina e mensagens ainda não processadas têm sua visibilidade devolvida.

## Transactional outbox

A outbox grava os eventos na mesma transação da alteração financeira. Publishers fazem claim por lease com FOR UPDATE SKIP LOCKED, respeitam a ordem de inserção por wallet, enviam para wager-events.fifo fora da transação financeira e só então marcam published_at.

MessageGroupId é walletId; MessageDeduplicationId é o eventId estável da linha da outbox. Se o processo morrer depois do envio e antes de marcar publicação, a lease expira e o evento é enviado de novo com o mesmo eventId. A fila FIFO reduz duplicatas dentro de sua janela de deduplicação; consumidores downstream também precisam deduplicar por eventId para tolerar entrega at-least-once.

Eventos publicados: WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged e WagerTransactionPendingReference. Ainda não há consumidor downstream nem DLQ para a fila de eventos. Eventos pendentes são retentados com backoff, sem estado terminal de descarte.

## Autenticação e observabilidade

A autenticação está intencionalmente desligada por um AuthGuard com ProviderIdentityPort e adaptador no-op. O desenho futuro é OIDC client credentials, validação JWT/JWKS e vínculo de client_id ao providerId; escopos administrativos podem restringir a criação de wallets. Sem autenticação, qualquer cliente que alcance a API pode enviar operações para qualquer provedor.

Logs estruturados incluem identificadores de correlação e da operação quando disponíveis, sem registrar o payload financeiro completo. /metrics expõe contadores de transações, replays, retries, mensagens que atingem o limite SQS, conflitos de lock e divergências de reconciliação, além de latência e idade/quantidade de eventos pendentes da outbox.

/health/live não consulta dependências. /health/ready verifica PostgreSQL, fila de entrada, DLQ e correspondência da redrive policy, e fila da outbox.

## Testes e limites de cobertura

- test:unit cobre Money, invariantes e regras do domínio, hash de idempotência e round-trip dos mappers.
- test:integration usa PostgreSQL e LocalStack reais para migrations, constraints, casos de uso HTTP, inbox/redelivery, retry, DLQ, atomicidade e publicação da outbox.
- test:concurrency cobre disputa de saldo, 50 submissões idênticas em três instâncias de serviço, wallets distintas e três processos HTTP.
- Há teste de crash de consumer depois do commit e antes do ACK, teste de publisher concorrente e teste da janela em que SQS aceita um evento mas o banco não o marca como publicado.
- test:load; teste de carga não implementado.

## Testes e limites de cobertura

- Wallet muito disputada: o lock serializa as operações para proteger o saldo; isso limita a vazão dessa wallet. Wallets diferentes continuam sendo processadas em paralelo.
- Eventos sem consumidor downstream: o serviço publica os eventos na fila, mas ainda não há outro componente que os consuma e execute ações a partir deles.
- Fila de eventos sem DLQ: falhas de publicação mantêm o evento pendente na outbox para novas tentativas. Uma falha prolongada pode acumular eventos pendentes.
- Reversão parcial: não é suportada; REFUND e ROLLBACK precisam ter o mesmo valor da operação referenciada.