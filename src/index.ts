import { bot } from './bot';

bot.start({
  allowed_updates: ['message', 'callback_query'],
  onStart: (info) => {
    console.log(`[Bot] @${info.username} started`);
  },
});

process.once('SIGINT', () => {
  console.log('[Bot] SIGINT received, stopping...');
  bot.stop();
});
process.once('SIGTERM', () => {
  console.log('[Bot] SIGTERM received, stopping...');
  bot.stop();
});
