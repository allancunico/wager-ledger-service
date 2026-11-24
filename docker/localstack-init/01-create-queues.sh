#!/bin/bash
# Executado pelo LocalStack quando fica pronto (init hook ready.d).
# Cria as filas FIFO: entrada, DLQ da entrada e eventos da outbox.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"

# DLQ primeiro, porque a fila principal referencia o ARN dela na redrive policy.
awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --region "$REGION" \
  --queue-url "http://sqs.${REGION}.localhost.localstack.cloud:4566/000000000000/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

# Fila de entrada. O limite de tentativas antes da DLQ (maxReceiveCount) é 5;
# o consumidor também aplica a própria contagem, e a redrive é a rede de segurança.
awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# Fila de eventos da outbox (sem DLQ, sem consumidor downstream: ver ARCHITECTURE.md 3.10).
awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

touch /tmp/queues-ready
echo "Filas SQS criadas."
