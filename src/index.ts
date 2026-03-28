import { startDiscordBot } from './discord/bot';

startDiscordBot().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
