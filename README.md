# Wager Ledger Service

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, com entrega at-least-once, idempotência persistente e consistência entre saldo e ledger.

Stack: Bun 1.x, TypeScript estrito, NestJS, MikroORM, PostgreSQL, AWS SQS (LocalStack).

As decisões de arquitetura, o schema e as limitações estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

> Status: etapas 1 (fundações) e 2 (domínio puro, 243 testes unitários) concluídas. Schema, use case, API e mensageria ainda não foram implementados.

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker e Docker Compose

## Setup

```bash
bun install
cp .env.example .env
bun run infra:up        # sobe PostgreSQL e LocalStack (cria as 3 filas SQS)
```

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
| `bun run test:unit` | testes de unidade do domínio (não precisam de banco nem de Docker) |
| `bun run test:integration` | testes de integração (etapa 3 em diante) |
| `bun run test:concurrency` | testes de concorrência (etapa 5 em diante) |
| `bun run migrate:up` / `migrate:down` | migrations (etapa 3) |

Os scripts de teste, de migration e `test:load` ainda apontam para arquivos que serão criados nas próximas etapas.

## Papéis do processo

Um mesmo código sobe até três papéis, escolhidos por `ROLES` (separados por vírgula, padrão: todos):

- `api`: API HTTP
- `consumer`: consumidor da fila `wager-transactions.fifo`
- `workers`: publisher da outbox e reprocessador de `PENDING_REFERENCE`

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
