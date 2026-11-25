import { createOrm } from './orm';

async function main(): Promise<void> {
  const [command, option] = process.argv.slice(2);
  if (!['up', 'down', 'status'].includes(command ?? '')) {
    throw new Error('Uso: bun run src/infrastructure/database/migrate.ts <up|down [--all]|status>');
  }
  const orm = await createOrm();
  try {
    const migrator = orm.migrator;
    if (command === 'up') {
      const result = await migrator.up();
      for (const file of result) console.log(`UP ${file.name}`);
    } else if (command === 'down') {
      if (option && option !== '--all') throw new Error('Opção de down aceita: --all');
      const result = option === '--all' ? await migrator.down({ to: 0 }) : await migrator.down();
      for (const file of result) console.log(`DOWN ${file.name}`);
    } else {
      const pending = await migrator.getPending();
      const executed = await migrator.getStorage().executed();
      console.log(JSON.stringify({ executed, pending: pending.map((item) => item.name) }, null, 2));
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
