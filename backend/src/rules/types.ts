/** メールのパース済みデータ */
export interface ParsedMessage {
  id: string;
  threadId: string;
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  body: string;
  snippet: string;
  date: Date;
  headers: {
    listUnsubscribe?: string;
    replyTo?: string;
  };
  labelIds: string[];
}

/** 要返信判定の結果 */
export interface NeedsReplyResult {
  needsReply: boolean;
  reason: string;
  skippedBy?: "SENDER_CATEGORY" | "LEARNED_PATTERN" | "AI";
}

/** 未対応メール（フロント向け） */
export interface PendingItem {
  threadId: string;
  messageId: string;
  subject: string;
  from: string;
  fromAddress: string;
  date: string;
  snippet: string;
}
