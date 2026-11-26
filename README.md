# Wager Ledger Service

Serviço backend para transações financeiras de apostas (**BET**, **WIN**, **LOSS**, **REFUND**, **ROLLBACK**). Mantém saldo e ledger consistentes com idempotência persistente, PostgreSQL e processamento assíncrono por SQS. Não possui front end.

Stack: Bun 1.x, TypeScript estrito, NestJS, MikroORM, PostgreSQL 16, SQS via LocalStack e Docker Compose. As decisões e limitações estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Executar localmente

Requisitos: Bun 1.x, Docker e Docker Compose. No PowerShell:

    bun install
    cp .env.example .env
    bun run infra:up
    bun run migrate:up
    bun run start

Ajuste as variáveis em .env conforme seu ambiente; substitua LOCALSTACK_AUTH_TOKEN=seu_token_aqui por um token válido para sua instalação do LocalStack. O Compose publica PostgreSQL em localhost:5433 e LocalStack em localhost:4566; o script de inicialização cria as filas SQS.

As migrations precisam ser aplicadas antes de iniciar a API. O serviço usa por padrão os papéis api, consumer e workers. Para interromper a infraestrutura, bun run infra:down remove também o volume do PostgreSQL e apaga os dados locais.

## Comandos

| Comando | Uso |
|---|---|
| bun run start / bun run dev | Inicia a aplicação / inicia com reinício automático |
| bun run migrate:up | Aplica migrations pendentes |
| bun run migrate:down | Reverte a migration mais recente |
| bun run migrate:down -- --all | Reverte todas as migrations |
| bun run test:unit | Testes de domínio e mappers; não precisa de serviços externos |
| bun run test:integration | Testes com PostgreSQL e LocalStack |
| bun run test:concurrency | Concorrência com PostgreSQL e instâncias independentes |
| bun run typecheck / bun run lint | TypeScript / Biome |
| bun run infra:up / bun run infra:down | Sobe / remove a infraestrutura local |

Os testes de integração e concorrência criam bancos temporários e os removem ao terminar. A conexão indicada por TEST_DATABASE_ADMIN_URL ou, na ausência dela, DATABASE_URL precisa permitir criar e remover bancos. Integração também precisa do LocalStack acessível pelas variáveis AWS em .env.

## API

A API escuta em http://localhost:3000. Valores monetários são enviados como strings decimais.

Criar uma wallet:

    POST /wallets
    Content-Type: application/json

    {"playerId":"<uuid>","initialBalance":{"amount":"100.00","currency":"BRL"}}

Submeter uma transação; Idempotency-Key é obrigatório:

    POST /transactions
    Content-Type: application/json
    Idempotency-Key: provedor-a:ext-123

    {"providerId":"provedor-a","externalTransactionId":"ext-123","playerId":"<uuid>","walletId":"<uuid>","roundId":"rodada-1","gameId":"jogo-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}

Rotas disponíveis (a submissão também está exposta em /wagering/transactions):

- GET /wallets/:walletId
- GET /wallets/:walletId/ledger?limit=50&cursor=...
- POST /wallets/:walletId/reconciliation
- GET /transactions/:transactionId
- GET /transactions/by-external/:providerId/:externalTransactionId
- GET /providers/:providerId/wagering/transactions/:externalTransactionId

A submissão retorna 201 quando processada, 200 em replay processado, 202 quando aguarda referência e 422 para rejeição de negócio. Payload inválido retorna 400, conflitos de idempotência 409, recurso ausente 404 e falhas transitórias 503. Erros usam application/problem+json.

## Mensageria e operação

A fila de entrada wager-transactions.fifo recebe este envelope. O messageId dentro do corpo é a chave persistente do inbox; o identificador atribuído pelo SQS é metadado de transporte.

    {
      "messageId": "msg-123",
      "type": "WagerTransactionRequested",
      "occurredAt": "2026-07-29T15:00:00.000Z",
      "data": {
        "providerId": "provedor-a",
        "externalTransactionId": "ext-123",
        "idempotencyKey": "provedor-a:ext-123",
        "playerId": "<uuid>",
        "walletId": "<uuid>",
        "roundId": "rodada-1",
        "gameId": "jogo-1",
        "kind": "BET",
        "money": {"amount":"25.00","currency":"BRL"}
      }
    }

GET /health/live indica que o processo está ativo. GET /health/ready verifica PostgreSQL, fila de entrada e DLQ/redrive, e fila de eventos da outbox. GET /metrics expõe métricas Prometheus.

A autenticação está desligada pelo adaptador no-op. Para executar três instâncias no Compose, aplique as migrations primeiro e rode docker compose --profile app up --build --scale app=3.
