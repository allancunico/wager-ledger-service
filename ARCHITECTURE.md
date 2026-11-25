# ARCHITECTURE.md

## 1. Objetivo e invariantes

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, com entrega at-least-once.

Invariantes que tudo preserva:

- `wallet.balance == saldo reconstruído pelo ledger`;
- saldo nunca negativo;
- nenhum débito ou crédito duplicado;
- nenhum evento confirmado é perdido.

O banco é a garantia final dessas invariantes. Recursos do broker (FIFO, dedup) são otimização.

## 2. Topologia de execução

Serviço de backend contínuo, sem front end. Um mesmo código sobe até três papéis, escolhidos pela variável `ROLES`:

| Papel | Função |
|---|---|
| `api` | API HTTP (wallets, submissão, consultas, reconciliação, health, `/metrics`) |
| `consumer` | consumidor da fila `wager-transactions.fifo` |
| `workers` | publisher da outbox e reprocessador de `PENDING_REFERENCE` |

Padrão: todos os papéis. No Compose rodam 3 ou mais instâncias, todas contra o mesmo PostgreSQL e as mesmas filas.

## 3. Stack e decisões

### 3.1 ORM: MikroORM + registros de persistência com mappers

- MikroORM é o ORM preferencial do desafio. `em.transactional()` e `LockMode` casam com a estratégia de lock por wallet.
- O domínio é puro (sem ORM, sem decorators do Nest). O ORM trabalha com registros de persistência simples (`WalletRecord` etc.), e mappers convertem de e para `Wallet.rehydrate(...)`.
- O dinheiro nunca passa por `number`: o registro guarda `amount` como string e `currency` em coluna separada, e o mapper monta o `Money`.
- Identity Map: cada requisição HTTP, mensagem SQS e tick de worker usa um `em.fork()` próprio, e a wallet só é carregada depois do lock.
- Validado no spike (seção 11): DI do Nest no Bun com `@Inject(TOKEN)` explícito, hidratação de `NUMERIC` como string e `SKIP LOCKED` pelo MikroORM.

### 3.2 Dinheiro: `NUMERIC(19,2)` + `currency CHAR(3)`

- Uma coluna de valor exata (`NUMERIC(19,2)`) e outra de moeda, em wallet, transação e ledger.
- Conversão zero com a string da API (`"25.00"`).
- `Money` no domínio com `decimal.js`, escala fixa de 2 casas, imutável.
- Proibidos no código e no banco: `number`, `float`, `double`, `REAL`, `DOUBLE PRECISION`.

### 3.3 Concorrência: lock pessimista por wallet

`SELECT ... FOR UPDATE` na linha da wallet, `READ COMMITTED`, `CHECK (balance >= 0)` como defesa em profundidade.

Sequência dentro de uma transação SQL:

1. Registrar no inbox (somente entrada SQS).
2. Consultar a chave de idempotência e o id externo para o caminho rápido de replay/conflito.
3. Travar a wallet (`FOR UPDATE`) antes de inserir a transação. A FK da transação adquire `KEY SHARE`; inserir primeiro e depois converter para `FOR UPDATE` pode provocar deadlock entre requisições da mesma wallet.
4. Inserir a transação com `ON CONFLICT DO NOTHING`. Se uma corrida venceu a unicidade: mesmo `payloadHash` é replay, diferente é conflito.
5. Carregar a referência (se houver) e validar as regras no domínio.
6. Atualizar saldo e `version`, inserir ledger, atualizar o status da transação e inserir na outbox.
7. Commit. Ack e publicação só depois.

Pontos:

- A referência precisa pertencer à mesma wallet, então há um único lock por operação e nenhuma ordem de aquisição a errar.
- `lock_timeout` na transação. Timeout e deadlock (`40P01`) são erros transitórios (503 na API, retry no SQS).
- Nenhum I/O externo dentro do lock. A outbox existe para isso.
- Métrica: tempo de espera do `FOR UPDATE`, mais contagem de timeouts e deadlocks.
- Um `CHECK` violado em produção é bug de domínio: rollback e alerta, não rejeição de negócio.
- Limitação assumida: uma hot wallet é serializada (vazão ≈ 1 / duração da transação). Wallets diferentes seguem em paralelo.

### 3.4 Interpretação da regra 4 (reversões)

Cada transação só pode ser revertida **uma vez no total**, por qualquer tipo de reversão. Índice único parcial sobre reversões `PROCESSED`. Uma reversão rejeitada não bloqueia uma tentativa válida depois. Uma `BET` reembolsada não aceita `ROLLBACK`, mas o próprio `REFUND` pode ser revertido por `ROLLBACK`.

Outras interpretações:

- `REFUND` referencia só `BET`. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`. `LOSS`, `OPENING` e `ROLLBACK` não são reversíveis.
- `WIN` pode referenciar uma `BET` `PROCESSED` do mesmo contexto. O valor do `WIN` não precisa igualar o da `BET`, e ele não conta como reversão. Se a referência não existir ainda, fica pendente como as demais.
- Moeda ou dono da wallet divergentes viram `REJECTED` persistido (422). Wallet inexistente é 404.
- Uma referência em `PENDING_REFERENCE` ainda não é `PROCESSED`, então a dependente também espera (cadeia pendente).
- Replay devolve o saldo da época: a transação guarda um `balance_snapshot`, porque `LOSS` não gera ledger e o saldo não pode ser derivado dele.
- `REJECTED` também é idempotente: reenviar devolve a mesma rejeição, sem reavaliar.

### 3.5 Contrato HTTP

O status descreve o estado da transação. `idempotentReplay` no corpo diz se foi replay.

| Situação | Status |
|---|---|
| Nova, `PROCESSED` | 201 (`idempotentReplay: false`) |
| Replay de `PROCESSED` | 200 (`idempotentReplay: true`) |
| `PENDING_REFERENCE` (nova ou replay) | 202, com `transactionId` |
| `REJECTED` (nova ou replay) | 422, com `failureCode` e saldo da época |
| Payload inválido | 400, nada persistido |
| Mesma key com payload diferente | 409 `IDEMPOTENCY_KEY_CONFLICT` |
| Mesmo `externalTransactionId` com outra key | 409 |
| Wallet inexistente | 404 |
| Falha transitória (lock timeout, deadlock, banco fora) | 503 + `Retry-After` |
| Replay de `FAILED` | 500 `TRANSACTION_FAILED`, `retryable: false` |
| Bug inesperado | 500 (vira alerta) |

Outros endpoints:

- `POST /wallets`: 201, 409 `WALLET_ALREADY_EXISTS`, 400.
- `GET` de wallet, ledger e transações: 200 ou 404. Uma transação `REJECTED` consultada é 200.
- Ledger com cursor inválido: 400. Cursor opaco e estável.
- `POST /wallets/:id/reconciliation`: 200 mesmo com divergência (`consistent: false`, log e métrica). Divergência não é corrigida silenciosamente.
- `GET /health/ready`: 200 ou 503. `GET /health/live`: 200.

Corpo de erro único, no estilo `application/problem+json`: `code` estável, `message` e `retryable`. O mesmo classificador de erros serve HTTP e SQS.

Idempotência:

- Header `Idempotency-Key` obrigatório e fonte da verdade (padrão recomendado: `{providerId}:{externalTransactionId}`).
- `payloadHash` = SHA-256 do JSON canônico (chaves ordenadas) dos campos de negócio. Header e metadados de transporte ficam fora. **Algoritmo exato a documentar na implementação.**

### 3.6 Taxonomia de `failureCode`

Todos viram 422 no HTTP. Um 422 nunca é retentável com a mesma key.

| `failureCode` | Quando | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` com saldo menor que o valor | reenviar como nova transação após recarga |
| `REVERSAL_WOULD_OVERDRAW` | `ROLLBACK` de `WIN` ou `REFUND` cujo débito deixaria saldo negativo | não reenviar, tratamento operacional |
| `REFERENCE_NOT_FOUND` | TTL esgotado sem a referência chegar | conferir e reenviar como nova |
| `REFERENCE_NOT_PROCESSED` | referência existe, mas está `REJECTED` ou `FAILED` | desistir |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo de referência inválido para a operação | corrigir o payload |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | desistir, já resolvido |
| `REFERENCE_MISMATCH` | outro player, wallet ou rodada | corrigir o payload |
| `AMOUNT_MISMATCH` | valor da reversão diferente do da referência | corrigir o payload |
| `CURRENCY_MISMATCH` | moeda diferente da wallet ou da referência | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | `playerId` não é o dono da wallet | corrigir o payload |

Códigos de erro da API (sem persistência): `INVALID_PAYLOAD`, `OPENING_NOT_ALLOWED`, `MISSING_REFERENCE`, `IDEMPOTENCY_KEY_CONFLICT`, `WALLET_ALREADY_EXISTS`, entre outros. No SQS, mensagem inválida é erro permanente e vai para a DLQ.

`FAILED`: a API nunca o grava (falha transitória dá rollback e 503). Só o consumidor SQS grava, em melhor esforço, quando uma mensagem esgota as tentativas, com `PROCESSING_ATTEMPTS_EXHAUSTED`. Se o banco estiver fora, a DLQ continua sendo a trilha.

### 3.7 Máquina de estados de `WagerTransaction`

```
PENDING --> PROCESSED          (terminal)
PENDING --> REJECTED           (terminal)
PENDING --> PENDING_REFERENCE
PENDING --> FAILED             (terminal)
PENDING_REFERENCE --> PROCESSED | REJECTED | FAILED
```

`PENDING` nunca é visível fora da transação SQL: a transação nasce e é decidida no mesmo commit. Transicionar a partir de um estado terminal é erro de programação (`InvalidTransactionStateError`), não caminho de negócio.

### 3.8 `PENDING_REFERENCE`

| Parâmetro | Valor |
|---|---|
| Limite | TTL de 1 hora a partir de `createdAt` (configurável) |
| Backoff | 5 s × 2ⁿ, teto de 5 min, jitter ±20% |
| Lote do worker | 50 por tick, `FOR UPDATE SKIP LOCKED` |
| Ao expirar | `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected` |
| `attempts` | gravado e exposto como métrica, não é o limite |

- O TTL é usado em vez de número de tentativas porque o que importa ao provedor é por quanto tempo esperamos.
- `WagerTransactionPendingReference` sai uma vez, na entrada no estado.
- Todos os valores são configuráveis. Os testes usam TTL de segundos com `Clock` injetável.
- A corrida referência × dependente não perde nada: ambas disputam o lock da mesma wallet, e o worker é a rede de segurança.
- Fora do escopo: reprocessar as dependentes imediatamente ao processar a referência (otimização de latência).

### 3.9 Autenticação

Fora da pontuação. Implementação mínima:

- `AuthGuard` global que delega a uma `ProviderIdentityPort` (`authenticate(request) → ProviderIdentity`).
- Adaptador padrão no-op (aceita tudo, identidade anônima).
- Log de aviso no boot informando que a autenticação está desligada.
- O canal SQS não passa pelo guard (canal interno confiável), mas o use case valida a identidade do provedor da mensagem com as mesmas regras de domínio.

Desenho que seria adotado (somente documentado):

- Keycloak ou Zitadel como IdP, OIDC client credentials (o chamador é máquina).
- Validação do JWT pelo JWKS do IdP.
- Um `client_id` por provedor, mapeado para `providerId`.
- Escopos: provedores submetem e consultam só as próprias transações. Criação de wallets é escopo administrativo.
- Regra central: o `providerId` do corpo deve ser igual ao da identidade autenticada. A checagem mora no adaptador e no guard, o domínio não conhece autenticação.

Limitação: sem autenticação, qualquer cliente que alcance a API pode submeter transações em nome de qualquer provedor. O guard global delega a um `ProviderIdentityPort`, com adaptador no-op enquanto a autenticação estiver desligada.

### 3.10 Eventos da outbox

Destino: fila SQS FIFO `wager-events.fifo`.

- `MessageGroupId` = `walletId` (ordem por wallet, wallets em paralelo).
- `MessageDeduplicationId` = `eventId` (id da linha da outbox, estável entre republicações).
- Contrato: entrega at-least-once. O consumidor deduplica por `eventId`. FIFO e dedup do broker são só otimização.
- A outbox tem coluna `group_key` (a `walletId`), porque `aggregateId` nos eventos de transação é o `transactionId`.
- Sem estado terminal: o publisher repete com backoff exponencial e teto, sem descartar. `attempts` e outbox lag são métricas, e um limiar de tentativas é alerta.
- Janela de duplicação conhecida: o processo morre depois do envio e antes de marcar como publicado. O `eventId` estável torna isso seguro.
- Publisher com `FOR UPDATE SKIP LOCKED` em lotes. O detalhe do claim (transação aberta durante o envio ou concessão com prazo) é decidido na etapa 6.
- Sem consumidor downstream e sem DLQ para esta fila. Nos testes, um helper lê a `wager-events.fifo`. SNS fica como evolução documentada.
- Eventos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda), `WagerTransactionPendingReference`.

## 4. Schema (garantias no banco)

Tabelas: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`.

| Garantia | Mecanismo |
|---|---|
| Uma wallet por `(player_id, currency)` | `UNIQUE (player_id, currency)` |
| Saldo não negativo | `CHECK (balance >= 0)` |
| Valor positivo | `CHECK (amount > 0)` em transação e ledger |
| Moeda válida | `CHECK (currency ~ '^[A-Z]{3}$')` |
| Idempotência por provedor | `UNIQUE (provider_id, idempotency_key)` |
| Mesma transação do provedor sob outra key | `UNIQUE (provider_id, external_transaction_id)` |
| Reversão única por referência | índice único parcial em `reference_transaction_id` para reversões `PROCESSED` |
| Reversão exige referência | `CHECK` por `kind` |
| Um lançamento por transação e wallet | `UNIQUE (wallet_id, transaction_id)` |
| Ledger imutável | trigger que bloqueia `UPDATE`, `DELETE` e `TRUNCATE` |
| Ledger aritmeticamente consistente | `CHECK ((direction='CREDIT' AND balance_after = balance_before + amount) OR (direction='DEBIT' AND balance_after = balance_before - amount))` |
| Dedup do inbox | `PRIMARY KEY (consumer_name, message_id)` |
| Outbox pendente eficiente | índice parcial `WHERE published_at IS NULL` |

Migrations versionadas e reversíveis (Migrator do MikroORM), com SQL escrito à mão em `up` e `down` para constraints e triggers.

`OPENING` é interno: não pode ser submetido pela API nem pela fila. Saldo inicial maior que zero gera a transação `OPENING` e o lançamento `CREDIT` na mesma transação SQL da criação da wallet.

## 5. Consumidor SQS

- Mesmo use case da entrada HTTP.
- Dedup por inbox persistente `(consumerName, messageId)`, na mesma transação financeira. O inbox deduplica a mensagem, a idempotency key deduplica a operação de negócio.
- `ack` somente após o commit.
- Erro de negócio: terminal, ack. Transitório: retry com backoff. Permanente: DLQ, após limite de tentativas.
- `SIGTERM`: concluir as mensagens em andamento ou devolver a visibilidade.

## 6. Observabilidade

- Logs JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Sem payloads financeiros completos.
- Métricas (`prom-client`, `/metrics`): transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag, latência de processamento, divergências de reconciliação.
- Health: `live` e `ready` (PostgreSQL e SQS).

## 7. Escolhas de ferramentas

| Item | Escolha |
|---|---|
| HTTP adapter | Express (validado no Bun, seção 11) |
| Validação na borda | zod (DTOs sem decorators, parse de `Money` nosso) |
| Config | variáveis de ambiente validadas com zod no boot |
| Lint e formatação | Biome |
| IDs | UUIDv7 gerados na aplicação |
| Estrutura | `src/domain`, `application`, `infrastructure`, `interfaces`; módulos `wallet` e `wagering` |
| Idioma | identificadores e commits em inglês, documentação em português |
| Scripts | `test:unit`, `test:integration`, `test:concurrency`, `test:load`, `migrate:up`, `migrate:down`, `infra:up` |

## 8. Estratégia de testes

- PostgreSQL e LocalStack reais via **Docker Compose** (`bun run infra:up`), a mesma infra do desenvolvimento. Testcontainers foi descartado pela compatibilidade incerta com o Bun.
- Isolamento: cada suíte cria um banco próprio (`CREATE DATABASE` a partir de um template já migrado) e filas com nome único.
- Multi-instância: processos filhos reais (`Bun.spawn`), cada um com porta e `ROLES` próprios, contra o mesmo Postgres e as mesmas filas.
- Crash entre commit e ack: gancho de falha ativado só por variável de ambiente (ex.: `FAULT=crash_after_commit`, `SIGKILL` nesse ponto). Mecanismo de teste, desligado por padrão.
- `Clock` injetável para TTL e backoff determinísticos.
- Invariante final de todos os testes: `wallet.balance == saldo reconstruído pelo ledger`.
- Infra das filas: script de inicialização do LocalStack no Compose, e não criação na aplicação.

## 9. Plano (3 dias)

| Dia | Etapas | Entrega |
|---|---|---|
| 1 | 1 a 4 | scaffold e spike, domínio com testes unitários, schema e use case com API HTTP |
| 2 | 5 a 8 | concorrência no banco, outbox, consumidor SQS, worker de `PENDING_REFERENCE` |
| 3 | 9 e 10 | observabilidade, testes multi-instância e de crash, docs finais |

Cortado: `test:load` (só se sobrar tempo). Enxuto: métricas no mínimo exigido, sem Swagger e sem OpenTelemetry. Documentação escrita conforme o avanço.

Estado do clone: as etapas 1 a 4 estão implementadas; as etapas 5 a 10 permanecem no plano.

## 10. Limitações conhecidas

- Hot wallet serializada pelo lock pessimista.
- Autenticação desligada por decisão (ver 3.9).
- Fila de eventos sem DLQ e sem consumidor downstream.
- Reversão parcial fora de escopo (valor da reversão deve igualar o da referência).
- Janela de duplicação na publicação da outbox, coberta por `eventId` estável e dedup no consumidor.

## 11. Resultados do spike (etapa 1)

Código em `spike/run.ts` (`bun run spike`). Executado duas vezes seguidas, com o mesmo resultado: 12 de 12 verificações ok.

Ambiente: Bun 1.4.4, Nest 12, MikroORM 7.2, TypeScript 7, PostgreSQL 16.15 local. O Docker daemon não estava disponível no ambiente de desenvolvimento deste passo, então o spike rodou contra um PostgreSQL 16 local, não contra o container do Compose (mesma versão major, `postgres:16-alpine`).

| # | Verificação | Resultado |
|---|---|---|
| A1 | Nest + Express + `@Inject(TOKEN)` explícito no Bun | funciona |
| A2 | Injeção implícita, sem `@Inject` | **não funciona** no Bun (a rota responde 500). `@Inject` explícito é obrigatório em todo o projeto |
| B1 | `NUMERIC(19,2)` pelo MikroORM | hidratado como `string`, sem perda (`12345678901234567.89`, 17 dígitos inteiros) |
| B2 | `NUMERIC` por SQL direto | também `string` |
| B3 | `decimal.js` e UUIDv7 no Bun | funcionam |
| C1 | Duas apostas de 80 sobre 100 | uma `PROCESSED`, uma `REJECTED`, saldo `20.00`, `version = 2` |
| C2 | 50 apostas de 1.00 em paralelo sobre 30.00 | 30 `PROCESSED`, 20 `REJECTED`, saldo `0.00`, `version = 31` |
| D1 | `findOne` com lock sobre entidade já carregada | ver correção abaixo |
| E1 | `SKIP LOCKED` pelo MikroORM | `LockMode.PESSIMISTIC_PARTIAL_WRITE` gera `for update skip locked`; dois lotes concorrentes saíram disjuntos |
| E2 | `SKIP LOCKED` por SQL direto dentro da transação do MikroORM | funciona (fica como alternativa) |
| F1 | `lock_timeout` | erro `DriverException` com `code = '55P03'` |
| G1 | Deadlock | erro com `code = '40P01'`; a outra transação conclui |

### Consequências para o projeto

1. **Classificador de erros pelo SQLSTATE.** O MikroORM 7 entrega o timeout de lock como `DriverException` genérica (não como `LockWaitTimeoutException`). O classificador de erros transitórios deve olhar `error.code`: `55P03` (lock timeout) e `40P01` (deadlock) são transitórios (503 na API, retry no SQS). Não usar `instanceof`.
2. **Sem fallback de SQL para o publisher.** `PESSIMISTIC_PARTIAL_WRITE` basta para o claim da outbox e do worker de `PENDING_REFERENCE`. O SQL direto fica como alternativa caso o detalhe do claim (etapa 6) peça algo que o ORM não expresse.
3. **Precisão do `Decimal`.** O padrão do `decimal.js` é 20 dígitos significativos. `NUMERIC(19,2)` cabe nisso, mas o `Money` deve configurar a precisão explicitamente (por exemplo 40) em vez de depender do padrão.

### Correção a uma afirmação anterior (seção 3.1)

Eu havia afirmado que um `findOne` com lock sobre uma entidade já carregada devolveria o objeto antigo do Identity Map. Neste ambiente, dentro de uma transação, o `findOne` com `PESSIMISTIC_WRITE` **atualizou** a entidade em cache (D1: `20.00` antes, `5.00` com lock). A regra do projeto não muda, porque é mais segura e não depende desse detalhe: um `em.fork()` por unidade de trabalho e a wallet carregada só depois do lock. Mas o risco que eu descrevi era menor do que eu disse, e a afirmação devia ter sido testada antes de ser feita.

### O que o spike não cobriu

- **Docker Compose e LocalStack não foram executados.** O `docker-compose.yml` foi validado só por sintaxe (`docker compose config`) e o script `docker/localstack-init/01-create-queues.sh` só por `bash -n`. A criação das filas, a redrive policy da DLQ e o healthcheck do LocalStack ainda não foram exercitados de verdade. Isso entra no primeiro `bun run infra:up` na sua máquina.
- **SQS não foi tocado.** O `@aws-sdk/client-sqs` está instalado, mas nenhuma chamada foi feita.
- **Migrations da etapa 3.** O spike inicial criou tabelas por SQL direto; depois foram adicionadas migrations versionadas do MikroORM. A seção 13 registra o schema atual e o que ainda precisa de validação PostgreSQL neste clone.
- **Dockerfile.** Escrito, não construído.

## 12. Domínio (etapa 2): decisões de implementação

Código em `src/domain`, sem importar ORM, Nest, SQS ou nada de infraestrutura (as únicas dependências externas são `decimal.js` e `node:crypto`). O domínio nunca lê o relógio: recebe o instante como parâmetro (`Clock` e `FixedClock` ficam para a aplicação e os testes). Os testes ficam em `test/unit` (incluindo testes dos mappers).

### 12.1 Interpretações adicionais

1. **`Money.from` aceita 0, 1 ou 2 casas e normaliza para 2** (`"25"` vira `"25.00"`). Rejeita mais de 2 casas, sinal, espaços, vírgula, notação científica, `NaN`, `Infinity` e mais de 17 dígitos inteiros (o limite de `NUMERIC(19,2)`, para o erro surgir no domínio como 400 e não como falha do banco). Só `from` rejeita negativos; resultados de `subtract` e `negate` podem ser negativos para cálculo.
2. **`WIN` pode referenciar uma `BET`** (referência opcional). O código também permite que `LOSS` referencie uma `BET`, como extensão provisória ainda não confirmada; se essa referência for informada e ainda não existir, a transação espera como as demais. `BET` não aceita referência.
3. **Uma transação não pode referenciar a si mesma**, e todo identificador do provedor tem no máximo 255 caracteres (limite das colunas `varchar(255)`).
4. **`OPENING`** usa `providerId = 'system'` e `idempotencyKey = externalTransactionId = 'opening:{walletId}'`. Nasce `PROCESSED`.

### 12.2 Ajustes às assinaturas do README (permitidos pela seção 6)

- `Wallet.open` devolve `{ wallet, openingEntry }` e exige os ids de abertura quando o saldo inicial é positivo. Assim um saldo não existe sem lançamento, nem na criação. `version` começa em 1 e só sobe quando o saldo muda.
- `Wallet.debit` e `credit` devolvem o `WalletLedgerEntry` da movimentação. A wallet só muda de estado depois de o lançamento ter sido validado.
- `WagerTransaction.markProcessed(referenceTransactionId, at, balance)` e `reject(code, at, balance?)` guardam o **saldo observado** (`balanceSnapshot`), que é o que o replay idempotente devolve. `LOSS` não gera lançamento, então esse saldo não pode ser derivado do ledger.
- A transação ganhou `resolvedAt` (instante da decisão terminal, para os três estados), `referenceAttempts` e `nextReferenceAttemptAt` (controle do `PENDING_REFERENCE`). No lugar de `processedAt`, `resolvedAt` cobre também rejeição e falha.
- `OutboxMessage` ganhou `groupKey` (a wallet, para o `MessageGroupId`). `IntegrationEvent` ganhou `groupKey()`.

### 12.3 Avaliador de regras (`evaluate` e `processTransaction`)

`evaluate` não tem efeito colateral e devolve uma decisão (`APPLY`, `REJECT` com `failureCode`, ou `PENDING_REFERENCE`). `processTransaction` avalia e aplica o resultado na transação e na wallet. A camada de aplicação resolve a referência por `(providerId, referenceExternalTransactionId)`, calcula "já revertida" e persiste tudo numa transação SQL, sob o lock da wallet.

**A ordem das verificações decide qual `failureCode` o provedor recebe**, então ela é fixa e testada:

1. `WALLET_PLAYER_MISMATCH`
2. `CURRENCY_MISMATCH` (transação × wallet)
3. Se há referência:
   1. ausente → espera (`REFERENCE_MISSING`)
   2. `REFERENCE_KIND_NOT_ALLOWED`
   3. `REFERENCE_MISMATCH` (outro provider, player, wallet ou rodada)
   4. `CURRENCY_MISMATCH` (referência)
   5. referência pendente → espera (`REFERENCE_PENDING`); rejeitada ou falha → `REFERENCE_NOT_PROCESSED`
   6. só reversões: `AMOUNT_MISMATCH`, depois `REFERENCE_ALREADY_REVERSED`
4. Efeito no saldo: `INSUFFICIENT_FUNDS` (`BET`) ou `REVERSAL_WOULD_OVERDRAW` (`ROLLBACK` que debita).

As verificações 3.2 a 3.4 só usam campos imutáveis, então valem mesmo com a referência ainda pendente: uma referência incompatível é rejeitada na hora, sem esperar o TTL.

**Fim do TTL.** Se a referência nunca apareceu, `REFERENCE_NOT_FOUND`. Se ela existe mas ainda está pendente (cadeia, como um `ROLLBACK` de um `REFUND` que ainda espera), `REFERENCE_NOT_PROCESSED`. A fronteira é inclusiva: no instante `createdAt + TTL` a transação já expira.

**Backoff.** `min(base × 2ⁿ, teto) × (1 ± jitter)`. O `PENDING_REFERENCE` usa 5 s, teto de 300 s, ±20%, e a primeira reavaliação sai 5 s depois da entrada. A outbox usa 1 s, teto de 300 s, ±20%, sem estado terminal (testado com 1000 falhas seguidas).

### 12.4 Hash do payload (idempotência)

`payloadHash` (v1) = SHA-256 em hexadecimal minúsculo do **JSON canônico** (chaves ordenadas recursivamente, sem espaços) de: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId` (`null` quando ausente). Ficam fora o header `Idempotency-Key`, `messageId`, `occurredAt` e `correlationId`, então a mesma operação por HTTP ou SQS gera o mesmo hash. O `money` entra normalizado, então `"25"` e `"25.00"` são o mesmo payload. Um teste com vetor fixo protege o formato: mudá-lo sem querer invalidaria o conflito de idempotência de transações já gravadas.

### 12.5 Como os testes foram validados

Além de passarem, os testes foram confrontados com 9 mutações deliberadas no código (saldo nunca checado, `version` sem incremento, reversão dupla permitida, valor da reversão não conferido, mesmo código para saldo insuficiente e overdraw, fronteira do TTL, hash sem moeda, limite de magnitude, ledger desbalanceado aceito). Todas foram detectadas por pelo menos um teste. Isso mostra que os testes cobrem essas regras, e não que cobrem todo o domínio.

### 12.6 Limites da etapa 2

- O domínio só foi exercitado em memória. A atomicidade, os locks e as constraints do schema entram nas etapas 3 a 5.
- Os mappers entre o domínio e os registros de persistência foram adicionados na etapa 3; os testes unitários cobrem round-trip, não persistência real.
- O resultado de uma transação já decidida em replay (200, 422, 202) é montado pela camada de aplicação, ainda por escrever.

## 13. Persistência (etapa 3): implementação no clone atual

O clone contém seis migrations SQL reversíveis, inicializadas pelo Migrator do MikroORM em `src/infrastructure/database/migrate.ts`. A configuração está centralizada em `orm.ts`; os registros usam `EntitySchema` sem decorators ou relações ORM, e `mappers.ts` converte os registros para as factories `rehydrate` do domínio.

### 13.1 Garantias definidas no schema

- `wallets`: unicidade de player/moeda, saldo não negativo, moeda em formato de três letras maiúsculas, versão positiva e trigger que só permite incrementar a versão quando o saldo muda.
- `wager_transactions`: chaves únicas por provedor, valores positivos, tipos e estados enumerados, exigência de referência para `REFUND`/`ROLLBACK`, reversão única quando processada, tentativas não negativas e trigger que bloqueia atualização após estado terminal.
- `wallet_ledger_entries`: sequência de identidade para paginação, unicidade por wallet/transação, aritmética e saldos não negativos, cadeia serializada pelo lock da wallet e trigger de imutabilidade para `UPDATE`, `DELETE` e `TRUNCATE`.
- `inbox_messages`: chave primária composta por consumidor e mensagem.
- `outbox_messages`: payload JSONB vinculado ao `eventId`, índice parcial para mensagens pendentes, tentativas não negativas e bloqueio de exclusão enquanto pendente.
- Triggers de constraint adiados até o commit verificam que o saldo da wallet coincide com a última linha do ledger e que transações processadas com efeito de saldo têm exatamente um lançamento compatível.

Valores monetários são `NUMERIC(19,2)` hidratados pelo driver como strings. Os registros e mappers não convertem dinheiro para `number`; a coluna interna `seq` do ledger não faz parte do domínio nem do mapper.

### 13.2 Verificação disponível

Os testes unitários dos mappers cobrem os cinco registros, precisão decimal, `null`/`undefined`, snapshot/failure code e timestamps. Os testes de integração criam um banco PostgreSQL temporário, aplicam e revertem migrations e exercitam constraints de wallet, transação, ledger, inbox e outbox.

Validação em 25/11/2026: `bun run test:integration` executou migrations, constraints e casos de uso contra PostgreSQL no Docker; a API HTTP também recebeu requisições reais em teste. A suíte cria bancos temporários `wager_test_*` e os remove ao final.

## 14. Aplicação e API HTTP (etapa 4)

- `POST /wallets` cria uma wallet e, quando o saldo inicial é positivo, grava `OPENING`, ledger e eventos de outbox na mesma transação.
- `POST /transactions` exige `Idempotency-Key`, valida DTO com Zod e processa a transação sob lock da wallet. `PROCESSED`, `PENDING_REFERENCE` e `REJECTED` respondem respectivamente 201/200 em replay, 202 e 422.
- Consultas: `GET /wallets/:id`, `GET /wallets/:id/ledger?limit=50&cursor=...`, `POST /wallets/:id/reconciliation`, `GET /transactions/:id` e `GET /transactions/by-external/:providerId/:externalTransactionId`.
- `GET /health/live` não acessa dependências; `GET /health/ready` confirma conexão com PostgreSQL.
- Erros seguem `application/problem+json`, incluem `code`, `message` e `retryable`; lock timeout e deadlock viram 503 com `Retry-After`.
- As migrations são aplicadas explicitamente com `bun run migrate:up` antes de iniciar a API. O guard de identidade está configurado com adaptador no-op.
