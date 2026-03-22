import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config';
import { PendingMessage, ScheduledBroadcast } from './types';
import { formatKyivTime, nextOccurrenceKyiv, isTomorrow, token } from './utils';

export const bot = new Bot(config.botToken);

// ─── In-memory state ──────────────────────────────────────────────────────────

/** Admin has triggered /broadcast and we wait for their message. */
const waitingForContent = new Set<number>();

/** Admin typed "Свій час" and we wait for a HH:MM reply. */
const waitingForCustomTime = new Set<number>();

/** Message staged for sending, keyed by admin chat id. */
const pendingMessages = new Map<number, PendingMessage>();

/** Scheduled broadcasts keyed by token. */
const scheduledBroadcasts = new Map<string, ScheduledBroadcast>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAdmin(chatId: number): boolean {
  return chatId === config.adminChatId;
}

function buildConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Надіслати зараз', 'send_now')
    .row()
    .text('⏰ +30 хв', 'sched_30')
    .text('⏰ +1 год', 'sched_60')
    .text('⏰ +2 год', 'sched_120')
    .text('🕐 Свій час', 'sched_custom')
    .row()
    .text('❌ Скасувати', 'cancel_broadcast');
}

async function sendToGroup(pending: PendingMessage): Promise<void> {
  await bot.api.copyMessage(config.groupChatId, pending.sourceChatId, pending.messageId);
}

async function executeSend(adminChatId: number, pending: PendingMessage): Promise<void> {
  try {
    await sendToGroup(pending);
    await bot.api.sendMessage(adminChatId, '✅ Повідомлення надіслано в групу.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await bot.api.sendMessage(adminChatId, `❌ Помилка при відправці: ${msg}`);
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;

  const scheduled = [...scheduledBroadcasts.values()].filter(
    (s) => s.adminChatId === ctx.chat.id,
  );

  let text = '<b>AX Marketing Group Bot</b>\n\n';
  if (scheduled.length > 0) {
    text += `⏰ Запланованих розсилок: <b>${scheduled.length}</b> — /scheduled\n\n`;
  }
  text +=
    '<b>Команди:</b>\n' +
    '/broadcast — надіслати повідомлення в групу\n' +
    '/scheduled — заплановані розсилки\n' +
    '/checkgroup — перевірити доступ бота до групи\n' +
    '/cancel — скасувати поточну дію';

  await ctx.reply(text, { parse_mode: 'HTML' });
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.command('help', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;
  await ctx.reply(
    '<b>Інструкція:</b>\n\n' +
      '1. /broadcast → надішліть повідомлення → виберіть: зараз або відкласти\n' +
      '2. Бот покаже превью і запитає коли відправити\n' +
      '3. Підтримується: текст, фото, відео, документ, аудіо, голосове, кружок\n\n' +
      '<b>Команди:</b>\n' +
      '/broadcast — запустити розсилку\n' +
      '/scheduled — переглянути та скасувати заплановані розсилки\n' +
      '/checkgroup — перевірити доступ бота до групи\n' +
      '/cancel — скасувати поточну дію\n\n' +
      '⚠️ Час відправки — київський. Заплановані розсилки скасовуються при перезапуску бота.',
    { parse_mode: 'HTML' },
  );
});

// ─── /checkgroup ──────────────────────────────────────────────────────────────

bot.command('checkgroup', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;

  try {
    const botId = ctx.me.id;
    const [chatInfo, member] = await Promise.all([
      bot.api.getChat(config.groupChatId),
      bot.api.getChatMember(config.groupChatId, botId),
    ]);

    const groupTitle = 'title' in chatInfo ? chatInfo.title : String(config.groupChatId);

    if (member.status === 'left' || member.status === 'kicked') {
      await ctx.reply(
        `❌ Бот не є учасником групи <b>${groupTitle}</b>.\nДодайте бота в групу.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (member.status === 'restricted') {
      await ctx.reply(
        `⚠️ Бот обмежений в групі <b>${groupTitle}</b> і не може надсилати повідомлення.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (member.status === 'administrator') {
      const canPost = (member as { can_post_messages?: boolean }).can_post_messages !== false;
      if (!canPost) {
        await ctx.reply(
          `⚠️ Бот є адміністратором в <b>${groupTitle}</b>, але право "Надсилати повідомлення" вимкнено.`,
          { parse_mode: 'HTML' },
        );
        return;
      }
      await ctx.reply(
        `✅ Бот — адміністратор в <b>${groupTitle}</b>. Все ок.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // member
    await ctx.reply(
      `✅ Бот є учасником групи <b>${groupTitle}</b> і може надсилати повідомлення.`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ Не вдалося перевірити групу: ${msg}`);
  }
});

// ─── /broadcast ───────────────────────────────────────────────────────────────

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;

  waitingForContent.add(ctx.chat.id);
  waitingForCustomTime.delete(ctx.chat.id);
  pendingMessages.delete(ctx.chat.id);

  await ctx.reply(
    '📨 Надішліть повідомлення для групи.\n\n' +
      'Підтримується: текст, фото, відео, документ, аудіо, голосове, кружок.\n' +
      '/cancel — скасувати',
    { parse_mode: 'HTML' },
  );
});

// ─── /cancel ──────────────────────────────────────────────────────────────────

bot.command('cancel', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;
  const chatId = ctx.chat.id;

  const hadState =
    waitingForContent.has(chatId) ||
    waitingForCustomTime.has(chatId) ||
    pendingMessages.has(chatId);

  waitingForContent.delete(chatId);
  waitingForCustomTime.delete(chatId);
  pendingMessages.delete(chatId);

  if (hadState) {
    await ctx.reply('❌ Скасовано.');
  } else {
    const count = [...scheduledBroadcasts.values()].filter(
      (s) => s.adminChatId === chatId,
    ).length;
    if (count > 0) {
      await ctx.reply(`Немає активної операції.\n\nДля керування запланованими розсилками — /scheduled`);
    } else {
      await ctx.reply('Немає активної операції.');
    }
  }
});

// ─── /scheduled ───────────────────────────────────────────────────────────────

bot.command('scheduled', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;

  const entries = [...scheduledBroadcasts.entries()].filter(
    ([, s]) => s.adminChatId === ctx.chat.id,
  );

  if (entries.length === 0) {
    await ctx.reply('Немає запланованих розсилок.');
    return;
  }

  const kb = new InlineKeyboard();
  const lines: string[] = [];

  entries.forEach(([tok, s], i) => {
    lines.push(`${i + 1}. ⏰ <b>${s.label}</b>`);
    kb.text(`❌ Скасувати ${s.label}`, `cancel_sched_${tok}`).row();
  });

  await ctx.reply(
    `<b>Заплановані розсилки (${entries.length}):</b>\n\n${lines.join('\n')}`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
});

// ─── Message handler ──────────────────────────────────────────────────────────

bot.on('message', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;
  if ('text' in ctx.message && ctx.message.text?.startsWith('/')) return;

  const chatId = ctx.chat.id;

  // ── Custom time input ────────────────────────────────────────────────────────
  if (waitingForCustomTime.has(chatId)) {
    const text = ('text' in ctx.message ? ctx.message.text?.trim() : '') ?? '';
    const match = text.match(/^(\d{1,2}):(\d{2})$/);

    if (!match) {
      await ctx.reply(
        'Невірний формат. Введіть час як <b>ГГ:ХХ</b>, наприклад: <code>18:30</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);

    if (hour > 23 || minute > 59) {
      await ctx.reply('Невірний час. Година: 0–23, хвилини: 0–59');
      return;
    }

    const pending = pendingMessages.get(chatId);
    if (!pending) {
      waitingForCustomTime.delete(chatId);
      await ctx.reply('Сесія закінчилась. Почніть /broadcast заново.');
      return;
    }

    waitingForCustomTime.delete(chatId);
    pendingMessages.delete(chatId);

    const fireAt = nextOccurrenceKyiv(hour, minute);
    const delayMs = fireAt.getTime() - Date.now();
    const fireLabel =
      formatKyivTime(fireAt) + (isTomorrow(fireAt) ? ' (завтра)' : ' (сьогодні)');

    const capturedPending = { ...pending };
    const schedToken = token();

    const timerHandle = setTimeout(async () => {
      scheduledBroadcasts.delete(schedToken);
      await executeSend(chatId, capturedPending);
    }, delayMs);

    const statusMsg = await ctx.reply(
      `⏰ Заплановано на <b>${fireLabel}</b>.\n/scheduled — керувати розсилками`,
      { parse_mode: 'HTML' },
    );

    scheduledBroadcasts.set(schedToken, {
      adminChatId: chatId,
      pending: capturedPending,
      scheduledFor: fireAt,
      label: fireLabel,
      statusMessageId: statusMsg.message_id,
      timerHandle,
    });
    return;
  }

  // ── Capture broadcast content ────────────────────────────────────────────────
  if (!waitingForContent.has(chatId)) return;

  waitingForContent.delete(chatId);

  const pending: PendingMessage = {
    sourceChatId: ctx.message.chat.id,
    messageId: ctx.message.message_id,
  };
  pendingMessages.set(chatId, pending);

  await ctx.reply(
    'Надіслати це повідомлення в групу?',
    { reply_markup: buildConfirmKeyboard() },
  );
});

// ─── Inline callbacks ─────────────────────────────────────────────────────────

bot.on('callback_query:data', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId || !isAdmin(chatId)) {
    await ctx.answerCallbackQuery();
    return;
  }

  const data = ctx.callbackQuery.data;

  // ── Cancel broadcast session ──────────────────────────────────────────────────
  if (data === 'cancel_broadcast') {
    pendingMessages.delete(chatId);
    await ctx.editMessageText('❌ Розсилку скасовано.');
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Send now ──────────────────────────────────────────────────────────────────
  if (data === 'send_now') {
    const pending = pendingMessages.get(chatId);
    if (!pending) {
      await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.');
      return;
    }
    pendingMessages.delete(chatId);
    await ctx.editMessageText('⏳ Надсилаю...');
    await ctx.answerCallbackQuery();
    await executeSend(chatId, pending);
    return;
  }

  // ── Schedule +N minutes ───────────────────────────────────────────────────────
  if (data === 'sched_30' || data === 'sched_60' || data === 'sched_120') {
    const pending = pendingMessages.get(chatId);
    if (!pending) {
      await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.');
      return;
    }
    pendingMessages.delete(chatId);

    const minutes = data === 'sched_30' ? 30 : data === 'sched_60' ? 60 : 120;
    const fireAt = new Date(Date.now() + minutes * 60_000);
    const fireLabel =
      formatKyivTime(fireAt) + (isTomorrow(fireAt) ? ' (завтра)' : ' (сьогодні)');
    const capturedPending = { ...pending };
    const schedToken = token();

    const timerHandle = setTimeout(async () => {
      scheduledBroadcasts.delete(schedToken);
      await executeSend(chatId, capturedPending);
    }, minutes * 60_000);

    const schedMsgId = ctx.callbackQuery.message?.message_id ?? 0;
    await ctx.editMessageText(
      `⏰ Заплановано на <b>${fireLabel}</b>.\n/scheduled — керувати розсилками`,
      { parse_mode: 'HTML' },
    );
    await ctx.answerCallbackQuery(`Заплановано на ${fireLabel}`);

    scheduledBroadcasts.set(schedToken, {
      adminChatId: chatId,
      pending: capturedPending,
      scheduledFor: fireAt,
      label: fireLabel,
      statusMessageId: schedMsgId,
      timerHandle,
    });
    return;
  }

  // ── Schedule custom time ──────────────────────────────────────────────────────
  if (data === 'sched_custom') {
    const pending = pendingMessages.get(chatId);
    if (!pending) {
      await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.');
      return;
    }
    // Keep pending, just switch to waiting for custom time
    waitingForCustomTime.add(chatId);
    await ctx.editMessageText(
      'Введіть час відправки (київський час) у форматі <b>ГГ:ХХ</b>\nНаприклад: <code>18:30</code>',
      { parse_mode: 'HTML' },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Cancel a scheduled broadcast ─────────────────────────────────────────────
  if (data.startsWith('cancel_sched_')) {
    const schedToken = data.slice('cancel_sched_'.length);
    const sched = scheduledBroadcasts.get(schedToken);
    if (sched) {
      clearTimeout(sched.timerHandle);
      scheduledBroadcasts.delete(schedToken);
      await bot.api
        .editMessageText(chatId, sched.statusMessageId, `❌ Розсилку ${sched.label} скасовано.`)
        .catch(() => {});
    }

    const remaining = [...scheduledBroadcasts.entries()].filter(
      ([, s]) => s.adminChatId === chatId,
    );

    if (remaining.length === 0) {
      await ctx.editMessageText('✅ Скасовано. Немає більше запланованих розсилок.');
    } else {
      const kb = new InlineKeyboard();
      const lines: string[] = [];
      remaining.forEach(([tok, s], i) => {
        lines.push(`${i + 1}. ⏰ <b>${s.label}</b>`);
        kb.text(`❌ Скасувати ${s.label}`, `cancel_sched_${tok}`).row();
      });
      await ctx.editMessageText(
        `<b>Заплановані розсилки (${remaining.length}):</b>\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML', reply_markup: kb },
      );
    }
    await ctx.answerCallbackQuery('✅ Скасовано');
    return;
  }

  await ctx.answerCallbackQuery();
});
