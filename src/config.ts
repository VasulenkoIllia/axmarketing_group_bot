import 'dotenv/config';

const botToken = process.env.BOT_TOKEN;
const adminChatId = process.env.ADMIN_CHAT_ID;
const groupChatId = process.env.GROUP_CHAT_ID;

if (!botToken) throw new Error('BOT_TOKEN is required in .env');
if (!adminChatId) throw new Error('ADMIN_CHAT_ID is required in .env');
if (!groupChatId) throw new Error('GROUP_CHAT_ID is required in .env');

const adminChatIdNum = Number(adminChatId);
const groupChatIdNum = Number(groupChatId);

if (Number.isNaN(adminChatIdNum) || adminChatIdNum === 0)
  throw new Error(`ADMIN_CHAT_ID must be a valid integer, got: "${adminChatId}"`);
if (Number.isNaN(groupChatIdNum) || groupChatIdNum === 0)
  throw new Error(`GROUP_CHAT_ID must be a valid integer, got: "${groupChatId}"`);

export const config = {
  botToken,
  adminChatId: adminChatIdNum,
  groupChatId: groupChatIdNum,
};
