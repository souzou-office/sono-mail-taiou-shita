import { google, type gmail_v1 } from "googleapis";
import { config } from "../config.js";
import type { ParsedMessage } from "../rules/types.js";

const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri,
);

export function getAuthUrl(): string {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
  });
}

export function createGmailClient(accessToken: string, refreshToken?: string | null) {
  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
  auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const gmail = google.gmail({ version: "v1", auth });

  let _myEmail: string | null = null;

  return {
    auth,

    /** 自分のメールアドレスを取得（キャッシュ） */
    async getMyEmail(): Promise<string> {
      if (_myEmail) return _myEmail;
      const profile = await gmail.users.getProfile({ userId: "me" });
      _myEmail = profile.data.emailAddress || "";
      return _myEmail;
    },

    /** 未読メール一覧を取得 */
    async fetchUnrepliedMessages(hours: number): Promise<ParsedMessage[]> {
      const after = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
      const res = await gmail.users.messages.list({
        userId: "me",
        q: `after:${after} -from:me is:inbox`,
        maxResults: 100,
      });

      const messages: ParsedMessage[] = [];
      for (const msg of res.data.messages || []) {
        const full = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "full",
        });
        const parsed = parseGmailMessage(full.data);
        if (parsed) messages.push(parsed);
      }
      return messages;
    },

    /** スレッドの全メッセージ取得 */
    async fetchThread(threadId: string): Promise<ParsedMessage[]> {
      const res = await gmail.users.threads.get({ userId: "me", id: threadId });
      return (res.data.messages || [])
        .map(parseGmailMessage)
        .filter((m): m is ParsedMessage => m !== null);
    },

    // ============================================
    // アクション実行
    // ============================================

    async archive(messageId: string) {
      await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { removeLabelIds: ["INBOX"] },
      });
    },

    async addLabel(messageId: string, labelName: string) {
      const labelId = await getOrCreateLabel(gmail, labelName);
      await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { addLabelIds: [labelId] },
      });
    },

    async markRead(messageId: string) {
      await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
    },

    async markSpam(messageId: string) {
      await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
      });
    },

    async createDraft(threadId: string, to: string, subject: string, body: string) {
      const raw = createRawEmail(to, subject, body, threadId);
      await gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: { raw, threadId },
        },
      });
    },

    async sendReply(threadId: string, to: string, subject: string, body: string) {
      const raw = createRawEmail(to, subject, body, threadId);
      await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw, threadId },
      });
    },

    async forward(messageId: string, to: string) {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "raw",
      });
      await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: msg.data.raw!, threadId: msg.data.threadId! },
      });
    },
  };
}

// ============================================
// ヘルパー
// ============================================

function parseGmailMessage(msg: gmail_v1.Schema$Message): ParsedMessage | null {
  if (!msg.id || !msg.threadId) return null;

  const headers = msg.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

  const from = getHeader("From");
  const fromMatch = from.match(/<(.+?)>/);
  const fromAddress = fromMatch ? fromMatch[1] : from;

  const body = extractBody(msg.payload) || "";

  return {
    id: msg.id,
    threadId: msg.threadId,
    from,
    fromAddress: fromAddress.toLowerCase(),
    to: getHeader("To"),
    subject: getHeader("Subject"),
    body,
    snippet: msg.snippet || body.substring(0, 300),
    date: new Date(parseInt(msg.internalDate || "0")),
    headers: {
      listUnsubscribe: getHeader("List-Unsubscribe") || undefined,
      replyTo: getHeader("Reply-To") || undefined,
    },
    labelIds: msg.labelIds || [],
  };
}

function extractBody(payload?: gmail_v1.Schema$MessagePart | null): string {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  for (const part of payload.parts || []) {
    const text = extractBody(part);
    if (text) return text;
  }
  return "";
}

async function getOrCreateLabel(gmail: gmail_v1.Gmail, name: string): Promise<string> {
  const res = await gmail.users.labels.list({ userId: "me" });
  const existing = res.data.labels?.find(
    (l) => l.name?.toLowerCase() === name.toLowerCase(),
  );
  if (existing?.id) return existing.id;

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return created.data.id!;
}

function createRawEmail(to: string, subject: string, body: string, threadId?: string): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

export type GmailClient = ReturnType<typeof createGmailClient>;
