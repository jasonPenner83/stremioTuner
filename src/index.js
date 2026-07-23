import { bootstrap } from './bootstrap.js';

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
