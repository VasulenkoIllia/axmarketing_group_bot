import { bot } from './bot';
import { config } from './config';

async function checkGroupAccess(): Promise<void> {
  const botId = (await bot.api.getMe()).id;
  const member = await bot.api.getChatMember(config.groupChatId, botId);

  const canPost =
    member.status === 'administrator'
      ? (member as { can_post_messages?: boolean }).can_post_messages !== false
      : member.status === 'member';

  if (member.status === 'left' || member.status === 'kicked') {
    console.error(`[Bot] ERROR: bot is not a member of group ${config.groupChatId}. Add the bot to the group first.`);
    process.exit(1);
  }

  if (member.status === 'restricted') {
    console.error(`[Bot] ERROR: bot is restricted in group ${config.groupChatId} and cannot send messages.`);
    process.exit(1);
  }

  if (!canPost) {
    console.error(`[Bot] ERROR: bot is an administrator in group ${config.groupChatId} but "Post Messages" permission is disabled.`);
    process.exit(1);
  }

  console.log(`[Bot] Group access OK (status: ${member.status})`);

  await bot.api.sendMessage(
    config.adminChatId,
    `✅ Бот запущено і готовий до роботи.\nГрупа: <code>${config.groupChatId}</code>`,
    { parse_mode: 'HTML' },
  ).catch(() => {});
}

bot.start({
  allowed_updates: ['message', 'callback_query'],
  onStart: async (info) => {
    console.log(`[Bot] @${info.username} started`);
    await checkGroupAccess();
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
