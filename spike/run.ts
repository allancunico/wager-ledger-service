/**
 * Spike da etapa 1: valida no Bun os pontos marcados como [a validar] no ARCHITECTURE.md.
 *
 *  A. Nest com Express e DI via @Inject explícito (sem emitDecoratorMetadata)
 *  B. MikroORM: NUMERIC(19,2) hidratado como string, sem perda de precisão
 *  C. Lock pessimista (FOR UPDATE): duas apostas de 80 sobre 100, e 50 em paralelo
 *  D. Identity Map: comportamento do findOne com lock sobre entidade já carregada
 *  E. SKIP LOCKED: pelo MikroORM (PESSIMISTIC_PARTIAL_WRITE) e por SQL direto
 *  F. lock_timeout: classe e código do erro, para o classificador transitório
 *
 * Uso: SPIKE_DATABASE_URL=postgres://... bun run spike/run.ts
 */
import 'reflect-metadata';
import * as core from '@mikro-orm/core';
import { EntitySchema, LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import Decimal from 'decimal.js';
import { v7 as uuidv7 } from 'uuid';

const DATABASE_URL = process.env.SPIKE_DATABASE_URL ?? 'postgres://wager@127.0.0.1:5432/wager';

type Result = { name: string; critical: boolean; ok: boolean; detail: string };
const results: Result[] = [];

function record(name: string, critical: boolean, ok: boolean, detail: string) {
  results.push({ name, critical, ok, detail });
  const tag = ok ? 'PASS' : critical ? 'FAIL' : 'FAIL (informativo)';
  console.log(`${tag}  ${name}: ${detail}`);
}

// ---------------------------------------------------------------------------
// A. Nest + Express + @Inject explícito
// ---------------------------------------------------------------------------
const GREETING = Symbol('GREETING');

@Injectable()
class Dep {
  value() {
    return 'dep-ok';
  }
}

@Controller('probe')
class ProbeController {
  constructor(
    @Inject(GREETING) private readonly greeting: string,
    @Inject(Dep) private readonly dep: Dep,
  ) {}

  @Get()
  get() {
    return { greeting: this.greeting, dep: this.dep.value() };
  }
}

@Module({
  controllers: [ProbeController],
  providers: [{ provide: GREETING, useValue: 'hello' }, Dep],
})
class ProbeModule {}

// Injeção implícita (sem @Inject): depende de design:paramtypes, que o Bun não emite.
@Injectable()
class ImplicitService {
  constructor(private readonly dep: Dep) {}
  ok() {
    return this.dep.value();
  }
}

@Controller('implicit')
class ImplicitController {
  constructor(private readonly service: ImplicitService) {}

  @Get()
  get() {
    return { v: this.service.ok() };
  }
}

@Module({ controllers: [ImplicitController], providers: [Dep, ImplicitService] })
class ImplicitModule {}

async function httpGet(app: Awaited<ReturnType<typeof NestFactory.create>>, path: string) {
  const address = app.getHttpServer().address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  return { status: response.status, body: await response.text() };
}

async function spikeNest() {
  const app = await NestFactory.create(ProbeModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const { status, body } = await httpGet(app, '/probe');
    const parsed = JSON.parse(body) as { greeting?: string; dep?: string };
    record(
      'A1 Nest + Express + @Inject explícito no Bun',
      true,
      status === 200 && parsed.greeting === 'hello' && parsed.dep === 'dep-ok',
      `status=${status} body=${body}`,
    );
  } finally {
    await app.close();
  }

  const implicit = await NestFactory.create(ImplicitModule, { logger: false });
  await implicit.listen(0, '127.0.0.1');
  try {
    const { status } = await httpGet(implicit, '/implicit');
    // Informativo: documenta a razão de usar @Inject em todo lugar. Não é critério de falha.
    record(
      'A2 Injeção implícita (sem @Inject) no Bun',
      false,
      true,
      status === 200
        ? 'funciona (o @Inject explícito continua sendo a convenção do projeto)'
        : `NÃO funciona (status ${status}): @Inject explícito é obrigatório, como previsto`,
    );
  } finally {
    await implicit.close();
  }
}

// ---------------------------------------------------------------------------
// Registros de persistência (EntitySchema, sem decorators)
// ---------------------------------------------------------------------------
class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
}

const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'spike_wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'string', columnType: 'numeric(19,2)' },
    version: { type: 'integer' },
  },
});

class OutboxRecord {
  id!: string;
  groupKey!: string;
  n!: number;
  publishedAt: Date | null = null;
}

const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: 'spike_outbox',
  properties: {
    id: { type: 'uuid', primary: true },
    groupKey: { type: 'string', fieldName: 'group_key' },
    n: { type: 'integer' },
    publishedAt: { type: 'Date', fieldName: 'published_at', nullable: true },
  },
});

type Orm = Awaited<ReturnType<typeof initOrm>>;

const capturedQueries: string[] = [];

async function initOrm() {
  return MikroORM.init({
    entities: [WalletSchema, OutboxSchema],
    clientUrl: DATABASE_URL,
    pool: { min: 2, max: 80 },
    debug: ['query'],
    logger: (message: string) => {
      capturedQueries.push(message);
    },
  });
}

async function createTables(orm: Orm) {
  const em = orm.em.fork();
  await em.execute('drop table if exists spike_wallets');
  await em.execute('drop table if exists spike_outbox');
  await em.execute(`create table spike_wallets (
    id uuid primary key,
    player_id uuid not null,
    currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
    balance numeric(19,2) not null check (balance >= 0),
    version integer not null default 1
  )`);
  await em.execute(`create table spike_outbox (
    id uuid primary key,
    group_key text not null,
    n integer not null,
    published_at timestamptz null
  )`);
}

async function openWallet(orm: Orm, balance: string): Promise<string> {
  const id = uuidv7();
  await orm.em.fork().insert(WalletRecord, {
    id,
    playerId: uuidv7(),
    currency: 'BRL',
    balance,
    version: 1,
  });
  return id;
}

// ---------------------------------------------------------------------------
// B. NUMERIC como string, sem perda de precisão
// ---------------------------------------------------------------------------
async function spikeNumeric(orm: Orm) {
  const big = '12345678901234567.89'; // 17 dígitos inteiros: um float de 64 bits corromperia
  const id = await openWallet(orm, big);

  const em = orm.em.fork();
  const wallet = await em.findOneOrFail(WalletRecord, { id });
  record(
    'B1 NUMERIC(19,2) hidratado como string pelo MikroORM',
    true,
    typeof wallet.balance === 'string' && wallet.balance === big,
    `typeof=${typeof wallet.balance} valor=${String(wallet.balance)}`,
  );

  const raw = await orm.em
    .fork()
    .execute<{ balance: unknown }[]>('select balance from spike_wallets where id = ?', [id]);
  const rawValue = raw[0]?.balance;
  record(
    'B2 SQL direto também devolve NUMERIC como string',
    true,
    typeof rawValue === 'string' && rawValue === big,
    `typeof=${typeof rawValue} valor=${String(rawValue)}`,
  );

  const sum = new Decimal(wallet.balance).plus('0.10').toFixed(2);
  const carry = new Decimal(wallet.balance).plus('0.11').toFixed(2); // 67.89 + 0.11 = 68.00
  record(
    'B3 decimal.js e uuid v7 funcionam no Bun',
    true,
    sum === '12345678901234567.99' &&
      carry === '12345678901234568.00' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(id),
    `soma=${sum} com vai-um=${carry} precisão padrão do Decimal=${Decimal.precision} id=${id}`,
  );
}

// ---------------------------------------------------------------------------
// C. Lock pessimista por wallet
// ---------------------------------------------------------------------------
async function bet(orm: Orm, walletId: string, amount: string): Promise<'PROCESSED' | 'REJECTED'> {
  return orm.em.fork().transactional(async (tx) => {
    await tx.execute("set local lock_timeout = '10000ms'");
    const wallet = await tx.findOneOrFail(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    const balance = new Decimal(wallet.balance);
    const value = new Decimal(amount);
    if (balance.lessThan(value)) {
      return 'REJECTED';
    }
    wallet.balance = balance.minus(value).toFixed(2);
    wallet.version += 1;
    return 'PROCESSED';
  });
}

async function readWallet(orm: Orm, id: string) {
  return orm.em.fork().findOneOrFail(WalletRecord, { id });
}

async function spikeLock(orm: Orm) {
  const hot = await openWallet(orm, '100.00');
  const outcome = await Promise.all([bet(orm, hot, '80.00'), bet(orm, hot, '80.00')]);
  const afterTwo = await readWallet(orm, hot);
  const processed = outcome.filter((o) => o === 'PROCESSED').length;
  record(
    'C1 Duas apostas de 80 sobre 100: uma PROCESSED, outra REJECTED, saldo 20.00',
    true,
    processed === 1 && afterTwo.balance === '20.00' && afterTwo.version === 2,
    `resultados=${outcome.join(',')} saldo=${afterTwo.balance} version=${afterTwo.version}`,
  );

  const many = await openWallet(orm, '30.00');
  const burst = await Promise.all(Array.from({ length: 50 }, () => bet(orm, many, '1.00')));
  const afterBurst = await readWallet(orm, many);
  const ok = burst.filter((o) => o === 'PROCESSED').length;
  record(
    'C2 50 apostas de 1.00 em paralelo sobre 30.00: 30 PROCESSED, 20 REJECTED, saldo 0.00',
    true,
    ok === 30 && afterBurst.balance === '0.00' && afterBurst.version === 31,
    `processed=${ok} rejected=${burst.length - ok} saldo=${afterBurst.balance} version=${afterBurst.version}`,
  );
}

// ---------------------------------------------------------------------------
// D. Identity Map x lock
// ---------------------------------------------------------------------------
async function spikeIdentityMap(orm: Orm) {
  const id = await openWallet(orm, '20.00');
  const detail = await orm.em.fork().transactional(async (tx) => {
    const first = await tx.findOneOrFail(WalletRecord, { id });
    const firstValue = first.balance;
    await orm.em.fork().nativeUpdate(WalletRecord, { id }, { balance: '5.00' });
    const locked = await tx.findOneOrFail(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    const lockedValue = locked.balance;
    const refreshed = await tx.findOneOrFail(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return { firstValue, lockedValue, refreshedValue: refreshed.balance };
  });
  const staleWithoutRefresh = detail.lockedValue !== '5.00';
  record(
    'D1 Identity Map: findOne com lock sobre entidade já carregada',
    false,
    detail.refreshedValue === '5.00',
    `inicial=${detail.firstValue} com lock=${detail.lockedValue} com lock+refresh=${detail.refreshedValue}; ` +
      (staleWithoutRefresh
        ? 'o lock NÃO atualiza a entidade em cache: carregar a wallet só depois do lock, em fork próprio'
        : 'o lock atualizou a entidade em cache'),
  );
}

// ---------------------------------------------------------------------------
// E. SKIP LOCKED
// ---------------------------------------------------------------------------
async function seedOutbox(orm: Orm) {
  const em = orm.em.fork();
  await em.execute('truncate spike_outbox');
  for (let n = 1; n <= 10; n++) {
    await em.insert(OutboxRecord, { id: uuidv7(), groupKey: 'w1', n, publishedAt: null });
  }
}

async function claimWhileOtherHolds(
  orm: Orm,
  claim: (tx: ReturnType<Orm['em']['fork']>) => Promise<number[]>,
): Promise<{ a: number[]; b: number[] }> {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announceA!: (ids: number[]) => void;
  const aReady = new Promise<number[]>((resolve) => {
    announceA = resolve;
  });

  const txA = orm.em.fork().transactional(async (tx) => {
    const ids = await claim(tx);
    announceA(ids);
    await hold;
  });
  const a = await aReady;
  try {
    const b = await orm.em.fork().transactional(async (tx) => {
      await tx.execute("set local lock_timeout = '1500ms'");
      return claim(tx);
    });
    return { a, b };
  } finally {
    release();
    await txA;
  }
}

async function spikeSkipLocked(orm: Orm) {
  await seedOutbox(orm);
  capturedQueries.length = 0;
  try {
    const { a, b } = await claimWhileOtherHolds(orm, async (tx) => {
      const rows = await tx.find(
        OutboxRecord,
        { publishedAt: null },
        { orderBy: { n: 'asc' }, limit: 5, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
      );
      return rows.map((r) => r.n);
    });
    const sql = capturedQueries.find((q) => /for update/i.test(q)) ?? '(sem SQL capturado)';
    const disjoint = a.length === 5 && b.length === 5 && a.every((n) => !b.includes(n));
    record(
      'E1 SKIP LOCKED pelo MikroORM (PESSIMISTIC_PARTIAL_WRITE): lotes disjuntos',
      false,
      disjoint && /skip locked/i.test(sql),
      `A=[${a.join(',')}] B=[${b.join(',')}] sql=${sql.replace(/\s+/g, ' ').slice(0, 160)}`,
    );
  } catch (error) {
    record(
      'E1 SKIP LOCKED pelo MikroORM (PESSIMISTIC_PARTIAL_WRITE): lotes disjuntos',
      false,
      false,
      `erro: ${(error as Error).message.slice(0, 160)} (usar o fallback de SQL direto)`,
    );
  }

  await seedOutbox(orm);
  const { a, b } = await claimWhileOtherHolds(orm, async (tx) => {
    const rows = await tx.execute<{ n: number }[]>(
      `select n from spike_outbox
       where published_at is null
       order by n asc limit 5
       for update skip locked`,
    );
    return rows.map((r) => r.n);
  });
  record(
    'E2 SKIP LOCKED por SQL direto dentro da transação do MikroORM: lotes disjuntos',
    true,
    a.length === 5 && b.length === 5 && a.every((n) => !b.includes(n)),
    `A=[${a.join(',')}] B=[${b.join(',')}]`,
  );
}

// ---------------------------------------------------------------------------
// F. lock_timeout: como o erro chega ao código
// ---------------------------------------------------------------------------
async function spikeLockTimeout(orm: Orm) {
  const id = await openWallet(orm, '10.00');
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const lockedPromise = new Promise<void>((resolve) => {
    locked = resolve;
  });

  const holder = orm.em.fork().transactional(async (tx) => {
    await tx.findOneOrFail(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    locked();
    await hold;
  });
  await lockedPromise;

  let caught: unknown;
  try {
    await orm.em.fork().transactional(async (tx) => {
      await tx.execute("set local lock_timeout = '200ms'");
      await tx.findOneOrFail(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    });
  } catch (error) {
    caught = error;
  } finally {
    release();
    await holder;
  }

  const err = caught as { name?: string; code?: string; message?: string } | undefined;
  const LockWait = (core as unknown as Record<string, unknown>).LockWaitTimeoutException as
    | (new (
        ...args: never[]
      ) => Error)
    | undefined;
  record(
    'F1 lock_timeout vira erro identificável (código 55P03)',
    true,
    caught !== undefined && err?.code === '55P03',
    `classe=${err?.name} code=${err?.code} instanceof LockWaitTimeoutException=${
      LockWait ? caught instanceof LockWait : 'n/d'
    }`,
  );
}

// ---------------------------------------------------------------------------
// G. Deadlock: código do erro (40P01) preservado até o código da aplicação
// ---------------------------------------------------------------------------
async function spikeDeadlock(orm: Orm) {
  const first = await openWallet(orm, '10.00');
  const second = await openWallet(orm, '10.00');

  let aHasFirst!: () => void;
  const aFirst = new Promise<void>((resolve) => {
    aHasFirst = resolve;
  });
  let bHasFirst!: () => void;
  const bFirst = new Promise<void>((resolve) => {
    bHasFirst = resolve;
  });

  const run = (
    mine: string,
    other: string,
    announce: () => void,
    waitFor: Promise<void>,
  ): Promise<void> =>
    orm.em.fork().transactional(async (tx) => {
      await tx.findOneOrFail(WalletRecord, { id: mine }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      announce();
      await waitFor;
      await tx.findOneOrFail(WalletRecord, { id: other }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    });

  const settled = await Promise.allSettled([
    run(first, second, aHasFirst, bFirst),
    run(second, first, bHasFirst, aFirst),
  ]);
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  const code = (rejected[0]?.reason as { code?: string } | undefined)?.code;
  record(
    'G1 Deadlock vira erro identificável (código 40P01) e a outra transação conclui',
    true,
    rejected.length === 1 && code === '40P01',
    `rejeitadas=${rejected.length} code=${code}`,
  );
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`Bun ${Bun.version} | banco: ${DATABASE_URL.replace(/\/\/.*@/, '//***@')}\n`);

  await spikeNest();

  const orm = await initOrm();
  try {
    await createTables(orm);
    await spikeNumeric(orm);
    await spikeLock(orm);
    await spikeIdentityMap(orm);
    await spikeSkipLocked(orm);
    await spikeLockTimeout(orm);
    await spikeDeadlock(orm);
  } finally {
    const em = orm.em.fork();
    await em.execute('drop table if exists spike_wallets');
    await em.execute('drop table if exists spike_outbox');
    await orm.close(true);
  }

  const failedCritical = results.filter((r) => r.critical && !r.ok);
  console.log(
    `\n${results.filter((r) => r.ok).length}/${results.length} verificações ok; ` +
      `${failedCritical.length} falha(s) crítica(s)`,
  );
  process.exit(failedCritical.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Spike abortou:', error);
  process.exit(2);
});
