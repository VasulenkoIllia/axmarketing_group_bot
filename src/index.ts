import { bot } from './bot';
import { config } from './config';

// Fail fast if the container timezone is not set to Kyiv — all scheduling depends on it.
// Accept both 'Europe/Kyiv' (current IANA name) and 'Europe/Kiev' (legacy alias on some systems).
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (tz !== 'Europe/Kyiv' && tz !== 'Europe/Kiev') {
  throw new Error(
    `[Bot] Timezone must be Europe/Kyiv, got "${tz}". Set TZ=Europe/Kyiv in your environment.`,
  );
}

async function checkGroupAccess(): Promise<void> {
  const botId = (await bot.api.getMe()).id;
  const member = await bot.api.getChatMember(config.groupChatId, botId);

  if (member.status === 'left' || member.status === 'kicked') {
    console.error(`[Bot] ERROR: bot is not a member of group ${config.groupChatId}. Add the bot to the group first.`);
    process.exit(1);
  }

  if (member.status === 'restricted') {
    console.error(`[Bot] ERROR: bot is restricted in group ${config.groupChatId} and cannot send messages.`);
    process.exit(1);
  }

  // creator can always post; administrator needs can_post_messages; member can post in regular groups
  if (member.status === 'administrator') {
    const canPost = (member as { can_post_messages?: boolean }).can_post_messages !== false;
    if (!canPost) {
      console.error(`[Bot] ERROR: bot is an administrator in group ${config.groupChatId} but "Post Messages" permission is disabled.`);
      process.exit(1);
    }
  }

  console.log(`[Bot] Group access OK (status: ${member.status})`);

  await bot.api.sendMessage(
    config.adminChatId,
    `✅ Бот запущено і готовий до роботи.\nГрупа: <code>${config.groupChatId}</code>`,
    { parse_mode: 'HTML' },
  ).catch(() => {});
}

async function setCommands(): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'broadcast', description: 'Надіслати повідомлення в групу' },
    { command: 'scheduled', description: 'Заплановані розсилки' },
    { command: 'checkgroup', description: 'Перевірити доступ бота до групи' },
    { command: 'cancel', description: 'Скасувати поточну дію' },
    { command: 'help', description: 'Інструкція' },
  ]);
}

bot.start({
  allowed_updates: ['message', 'callback_query'],
  onStart: async (info) => {
    console.log(`[Bot] @${info.username} started`);
    await checkGroupAccess();
    await setCommands();
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
