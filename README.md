# Wager Ledger Service

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, com entrega at-least-once, idempotência persistente e consistência entre saldo e ledger.

Stack: Bun 1.x, TypeScript estrito, NestJS, MikroORM, PostgreSQL, AWS SQS (LocalStack).

As decisões de arquitetura, o schema e as limitações estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker e Docker Compose

## Setup

```bash
bun install
cp .env.example .env
bun run infra:up        # sobe PostgreSQL e LocalStack (cria as 3 filas SQS)
```

O PostgreSQL do Compose é publicado em `localhost:5433` para evitar conflito com instalações locais que já usam a porta `5432`. A URL padrão está em `.env.example`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a aplicação (papéis definidos por `ROLES`) |
| `bun run dev` | idem, com reinício automático |
| `bun run lint` | Biome (lint e formatação) |
| `bun run format` | formata o código |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run spike` | spike da etapa 1 (precisa de um PostgreSQL acessível, ver abaixo) |
| `bun run infra:up` / `infra:down` | sobe / derruba a infra local |
| `bun run test:unit` | testes unitários do domínio e round-trip dos mappers (não precisam de banco nem de Docker) |
| `bun run test:integration` | migrations, constraints, API e publisher com PostgreSQL e LocalStack (banco temporário) |
| `bun run test:concurrency` | concorrência no PostgreSQL entre instâncias independentes do serviço |
| `bun run migrate:up` | aplica as migrations |
| `bun run migrate:down` | reverte a migration mais recente |
| `bun run migrate:down -- --all` | reverte todas as migrations |

Os testes de integração usam `TEST_DATABASE_ADMIN_URL` se definida; caso contrário, usam `DATABASE_URL` como conexão administrativa para criar um banco isolado. A role precisa poder criar e remover bancos. `test:integration` requer PostgreSQL e LocalStack acessíveis; `test:concurrency` requer PostgreSQL.

## API HTTP (etapa 4)

Antes da primeira execução, aplique as migrations:

```bash
bun run migrate:up
bun run start
```

Crie uma wallet com saldo inicial exato (o valor é sempre string decimal):

```http
POST /wallets
Content-Type: application/json

{"playerId":"<uuid>","initialBalance":{"amount":"100.00","currency":"BRL"}}
```

Submeta uma transação com `Idempotency-Key`:

```http
POST /transactions
Content-Type: application/json
Idempotency-Key: provedor-123

{"providerId":"provedor-a","externalTransactionId":"ext-123","playerId":"<uuid>","walletId":"<uuid>","roundId":"rodada-1","gameId":"jogo-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}
```

Consultas disponíveis: `GET /wallets/:id`, `GET /wallets/:id/ledger?limit=50&cursor=...`, `POST /wallets/:id/reconciliation`, `GET /transactions/:id` e `GET /transactions/by-external/:providerId/:externalTransactionId`. Erros usam `application/problem+json`. A autenticação está desligada pelo adaptador no-op.

O publisher de eventos usa o papel `workers` e envia para a fila FIFO configurada. O consumidor da fila de entrada, o worker de `PENDING_REFERENCE` e os testes de concorrência entre processos HTTP pertencem às próximas etapas.

## Papéis do processo

Um mesmo código sobe até três papéis, escolhidos por `ROLES` (separados por vírgula, padrão: todos):

- `api`: API HTTP
- `consumer`: consumidor da fila `wager-transactions.fifo`
- `workers`: publisher da outbox (reprocessador de `PENDING_REFERENCE` entra em etapa posterior)

```bash
ROLES=api PORT=3101 bun run start
curl http://localhost:3101/health/live
```

Para várias instâncias contra a mesma infra: `docker compose --profile app up --scale app=3`.

## Spike

`bun run spike` valida o Nest, o MikroORM e os locks do PostgreSQL no Bun. Por padrão conecta em `postgres://wager@127.0.0.1:5432/wager`; use `SPIKE_DATABASE_URL` para apontar outro banco. Com a infra do Compose no ar, use:

```bash
SPIKE_DATABASE_URL=postgres://wager:wager@localhost:5432/wager bun run spike
```

O spike cria e remove tabelas com prefixo `spike_`. Os resultados estão na seção 11 do `ARCHITECTURE.md`.
