import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import { config } from './config';
import { PendingMessage, ScheduledBroadcast } from './types';
import { formatScheduleLabel, parseDate, token } from './utils';

/** Mutable target group ID — updated automatically on supergroup migration. */
let groupChatId = config.groupChatId;

export function getGroupChatId(): number {
  return groupChatId;
}

export const bot = new Bot(config.botToken);

// ─── In-memory state ──────────────────────────────────────────────────────────

/** Admin triggered /broadcast — waiting for them to send the message content. */
const waitingForContent = new Set<number>();

/** Admin chose a date — waiting for HH:MM input. */
const waitingForTimeInput = new Set<number>();

/** Admin chose "Інша дата" — waiting for DD.MM[.YYYY] input. */
const waitingForDateInput = new Set<number>();

/** Stores the chosen date (midnight) while admin is entering HH:MM. */
const pendingScheduleDate = new Map<number, Date>();

/** Message staged for sending, keyed by admin chat id. */
const pendingMessages = new Map<number, PendingMessage>();

/** Scheduled broadcasts keyed by token. */
const scheduledBroadcasts = new Map<string, ScheduledBroadcast>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAdmin(chatId: number): boolean {
  return chatId === config.adminChatId;
}

function clearSession(chatId: number): void {
  waitingForContent.delete(chatId);
  waitingForTimeInput.delete(chatId);
  waitingForDateInput.delete(chatId);
  pendingScheduleDate.delete(chatId);
  pendingMessages.delete(chatId);
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

function buildDatePickerKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📅 Сьогодні', 'sched_today')
    .text('📅 Завтра', 'sched_tomorrow')
    .row()
    .text('📅 Інша дата (ДД.ММ)', 'sched_date')
    .row()
    .text('❌ Скасувати', 'cancel_broadcast');
}

async function sendToGroup(pending: PendingMessage): Promise<void> {
  try {
    await bot.api.copyMessage(groupChatId, pending.sourceChatId, pending.messageId);
  } catch (err) {
    if (!(err instanceof GrammyError)) throw err;

    // Group was upgraded to a supergroup — Telegram provides the new chat ID
    const newChatId = (err.parameters as { migrate_to_chat_id?: number })?.migrate_to_chat_id;
    if (newChatId) {
      groupChatId = newChatId;
      await bot.api.copyMessage(newChatId, pending.sourceChatId, pending.messageId);
      return;
    }

    throw err;
  }
}

async function executeSend(adminChatId: number, pending: PendingMessage): Promise<void> {
  const prevId = groupChatId;
  try {
    await sendToGroup(pending);
    let text = '✅ Повідомлення надіслано в групу.';
    if (groupChatId !== prevId) {
      text +=
        `\n\n⚠️ Група була конвертована в супергрупу.\n` +
        `Новий ID: <code>${groupChatId}</code>\n` +
        `Оновіть <b>GROUP_CHAT_ID</b> в .env і перезапустіть бота.`;
    }
    await bot.api.sendMessage(adminChatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await bot.api.sendMessage(adminChatId, `❌ Помилка при відправці: ${msg}`);
  }
}

function scheduleAndStore(
  chatId: number,
  pending: PendingMessage,
  fireAt: Date,
  label: string,
  statusMessageId: number,
): void {
  const schedToken = token();
  const delayMs = fireAt.getTime() - Date.now();
  const capturedPending = { ...pending };

  const timerHandle = setTimeout(async () => {
    scheduledBroadcasts.delete(schedToken);
    await executeSend(chatId, capturedPending);
  }, delayMs);

  scheduledBroadcasts.set(schedToken, {
    adminChatId: chatId,
    pending: capturedPending,
    scheduledFor: fireAt,
    label,
    statusMessageId,
    timerHandle,
  });
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;

  // Clear any stuck session state (e.g. admin closed bot mid-flow)
  clearSession(ctx.chat.id);

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
      bot.api.getChat(groupChatId),
      bot.api.getChatMember(groupChatId, botId),
    ]);

    const groupTitle = 'title' in chatInfo ? chatInfo.title : String(groupChatId);

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

    if (member.status === 'creator') {
      await ctx.reply(
        `✅ Бот є власником групи <b>${groupTitle}</b>. Всі права є.`,
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

  clearSession(ctx.chat.id);
  waitingForContent.add(ctx.chat.id);

  await ctx.reply(
    '📨 Надішліть повідомлення для групи.\n\n' +
      'Підтримується: текст, фото, відео, документ, аудіо, голосове, кружок.\n' +
      '/cancel — скасувати',
  );
});

// ─── /cancel ──────────────────────────────────────────────────────────────────

bot.command('cancel', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;
  const chatId = ctx.chat.id;

  const hadState =
    waitingForContent.has(chatId) ||
    waitingForTimeInput.has(chatId) ||
    waitingForDateInput.has(chatId) ||
    pendingMessages.has(chatId);

  clearSession(chatId);

  if (hadState) {
    await ctx.reply('❌ Скасовано.');
  } else {
    const count = [...scheduledBroadcasts.values()].filter(
      (s) => s.adminChatId === chatId,
    ).length;
    await ctx.reply(
      count > 0
        ? 'Немає активної операції.\n\nДля керування запланованими розсилками — /scheduled'
        : 'Немає активної операції.',
    );
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
  const text = ('text' in ctx.message ? ctx.message.text?.trim() : '') ?? '';

  // ── Date input (DD.MM or DD.MM.YYYY) ─────────────────────────────────────────
  if (waitingForDateInput.has(chatId)) {
    const parsed = parseDate(text);

    if (!parsed) {
      await ctx.reply(
        'Невірний формат. Введіть дату як <b>ДД.ММ</b> або <b>ДД.ММ.РРРР</b>\nНаприклад: <code>25.04</code> або <code>25.04.2026</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (parsed.getTime() < today.getTime()) {
      await ctx.reply('Дата в минулому. Введіть сьогоднішню або майбутню дату.');
      return;
    }

    waitingForDateInput.delete(chatId);
    pendingScheduleDate.set(chatId, parsed);
    waitingForTimeInput.add(chatId);

    await ctx.reply(
      'Введіть час відправки (київський час) у форматі <b>ГГ:ХХ</b>\nНаприклад: <code>18:30</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  // ── Time input (HH:MM) ────────────────────────────────────────────────────────
  if (waitingForTimeInput.has(chatId)) {
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
      await ctx.reply('Невірний час. Година: 0–23, хвилини: 0–59.');
      return;
    }

    const pending = pendingMessages.get(chatId);
    if (!pending) {
      clearSession(chatId);
      await ctx.reply('Сесія закінчилась. Почніть /broadcast заново.');
      return;
    }

    const chosenDate = pendingScheduleDate.get(chatId) ?? new Date();
    const fireAt = new Date(chosenDate);
    fireAt.setHours(hour, minute, 0, 0);

    if (fireAt.getTime() <= Date.now()) {
      await ctx.reply('Цей час вже минув. Введіть майбутній час або виберіть іншу дату.');
      return;
    }

    const label = formatScheduleLabel(fireAt);
    clearSession(chatId);

    const statusMsg = await ctx.reply(
      `⏰ Заплановано на <b>${label}</b>.\n/scheduled — керувати розсилками`,
      { parse_mode: 'HTML' },
    );

    scheduleAndStore(chatId, pending, fireAt, label, statusMsg.message_id);
    return;
  }

  // ── Capture broadcast content ─────────────────────────────────────────────────
  if (!waitingForContent.has(chatId)) return;

  waitingForContent.delete(chatId);

  const pending: PendingMessage = {
    sourceChatId: ctx.message.chat.id,
    messageId: ctx.message.message_id,
  };
  pendingMessages.set(chatId, pending);

  await ctx.reply('Надіслати це повідомлення в групу?', {
    reply_markup: buildConfirmKeyboard(),
  });
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
    clearSession(chatId);
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
    const label = formatScheduleLabel(fireAt);

    const edited = await ctx.editMessageText(
      `⏰ Заплановано на <b>${label}</b>.\n/scheduled — керувати розсилками`,
      { parse_mode: 'HTML' },
    );
    await ctx.answerCallbackQuery(`Заплановано на ${label}`);

    const schedMsgId = typeof edited === 'object' ? edited.message_id : (ctx.callbackQuery.message?.message_id ?? 0);
    scheduleAndStore(chatId, pending, fireAt, label, schedMsgId);
    return;
  }

  // ── Schedule custom — show date picker ────────────────────────────────────────
  if (data === 'sched_custom') {
    const pending = pendingMessages.get(chatId);
    if (!pending) {
      await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.');
      return;
    }
    await ctx.editMessageText('Оберіть дату відправки (київський час):', {
      reply_markup: buildDatePickerKeyboard(),
    });
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Date picker: Today ────────────────────────────────────────────────────────
  if (data === 'sched_today') {
    const pending = pendingMessages.get(chatId);
    if (!pending) {
      await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.');
      return;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    pendingScheduleDate.set(chatId, today);
    waitingForTimeInput.add(chatId);

    await ctx.editMessageText(
      'Введіть час відправки (київський час) у форматі <b>ГГ:ХХ</b>\nНаприклад: <code>18:30</code>',
      { parse_mode: 'HTML' },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Date picker: Tomorrow ─────────────────────────────────────────────────────
  if (data === 'sched_tomorrow') {
    const pending = pendingMessages.get(chatId);
    if (!pending) {
      await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.');
      return;
    }
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    pendingScheduleDate.set(chatId, tomorrow);
    waitingForTimeInput.add(chatId);

    await ctx.editMessageText(
      'Введіть час відправки (київський час) у форматі <b>ГГ:ХХ</b>\nНаприклад: <code>18:30</code>',
      { parse_mode: 'HTML' },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Date picker: Custom date ──────────────────────────────────────────────────
  if (data === 'sched_date') {
    const pending = pendingMessages.get(chatId);
    if (!pending) {
      await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.');
      return;
    }
    waitingForDateInput.add(chatId);

    await ctx.editMessageText(
      'Введіть дату у форматі <b>ДД.ММ</b> або <b>ДД.ММ.РРРР</b>\nНаприклад: <code>25.04</code> або <code>25.04.2027</code>',
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

bot.catch((err) => {
  console.error('[Bot] Uncaught error:', err);
});
