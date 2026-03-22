export interface PendingMessage {
  sourceChatId: number;
  messageId: number;
}

export interface ScheduledBroadcast {
  adminChatId: number;
  pending: PendingMessage;
  scheduledFor: Date;
  label: string;
  statusMessageId: number;
  timerHandle: ReturnType<typeof setTimeout>;
}
