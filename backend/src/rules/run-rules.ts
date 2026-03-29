import { PrismaClient } from "@prisma/client";
import type { GmailClient } from "../gmail/client.js";
import type { ParsedMessage, PendingItem, NeedsReplyResult } from "./types.js";
import { categorizeSender } from "../ai/categorize-sender.js";
import { judgeNeedsReply } from "../ai/judge-reply.js";

const prisma = new PrismaClient();

const LEARNED_PATTERN_THRESHOLD = 3;

// 返信不要と判断できる送信者カテゴリ
const SKIP_CATEGORIES = new Set([
  "NEWSLETTER", "NOTIFICATION", "MARKETING", "RECEIPT", "CALENDAR", "COLD_EMAIL",
]);

/**
 * メール1通に対して「返信が必要か？」を判定する
 *
 * ① 送信者カテゴリ（キャッシュ） → メルマガ/通知なら即スキップ
 * ② 学習パターン（DB） → 過去3回「返信不要」なら即スキップ
 * ③ AI判定 → ①②で決まらない時だけ呼ぶ（コスト最小化）
 */
export async function judgeMessage(
  userId: string,
  message: ParsedMessage,
): Promise<NeedsReplyResult> {

  // ---- 送信者の過去メール履歴を更新 ----
  const senderHistory = await updateSenderHistory(userId, message);

  // ---- ① 送信者カテゴリで即判定 ----
  const senderCategory = await getOrAnalyzeSenderCategory(userId, message, senderHistory);

  if (senderCategory && SKIP_CATEGORIES.has(senderCategory.category) && senderCategory.confidence >= 0.7) {
    await recordResult(userId, message, false, "SENDER_CATEGORY", `送信者カテゴリ: ${senderCategory.category}`);
    return { needsReply: false, reason: `送信者カテゴリ: ${senderCategory.category}`, skippedBy: "SENDER_CATEGORY" };
  }

  // ---- ② 学習パターンで即判定 ----
  const learnedPattern = await prisma.learnedPattern.findUnique({
    where: { userId_senderEmail: { userId, senderEmail: message.fromAddress } },
  });

  if (learnedPattern?.confirmed) {
    const needsReply = learnedPattern.ruleId === "NEEDS_REPLY";
    await recordResult(userId, message, needsReply, "LEARNED_PATTERN", `学習パターン確定`);
    return { needsReply, reason: "学習パターン確定", skippedBy: "LEARNED_PATTERN" };
  }

  // ---- ③ AI判定（フィードバック+過去メール文脈付き） ----
  const feedbacks = await prisma.classificationFeedback.findMany({
    where: { userId, senderEmail: message.fromAddress },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  let feedbackHint = "";
  if (feedbacks.length > 0) {
    const replyCount = feedbacks.filter((f) => f.correctedRuleId === "NEEDS_REPLY").length;
    const noReplyCount = feedbacks.length - replyCount;
    feedbackHint = `この送信者のメールについて、ユーザーは過去に${replyCount}回「返信必要」、${noReplyCount}回「返信不要」と修正しています。`;
  }

  const aiResult = await judgeNeedsReply(message, {
    senderHistory: { subjects: senderHistory.subjects },
    feedbackHint,
  });

  await recordResult(userId, message, aiResult.needsReply, "AI", aiResult.reason);

  // ---- 学習パターン更新 ----
  await updateLearnedPattern(userId, message.fromAddress, aiResult.needsReply);

  return { needsReply: aiResult.needsReply, reason: aiResult.reason, skippedBy: "AI" };
}

/**
 * 受信箱をスキャンして、返信が必要なメールだけ返す
 */
export async function scanAndJudge(
  gmail: GmailClient,
  userId: string,
  hours: number,
): Promise<{
  pending: PendingItem[];
  stats: { total: number; needsReply: number; skipped: number; errors: number };
}> {
  const messages = await gmail.fetchUnrepliedMessages(hours);
  const pending: PendingItem[] = [];
  let skipped = 0;
  let errors = 0;

  for (const message of messages) {
    try {
      // 既に判定済みか確認
      const existing = await prisma.judgment.findFirst({
        where: { userId, messageId: message.id },
      });

      let needsReply: boolean;

      if (existing) {
        needsReply = existing.status === "NEEDS_REPLY";
      } else {
        const result = await judgeMessage(userId, message);
        needsReply = result.needsReply;
      }

      if (needsReply) {
        // 返信済みチェック（スレッド内の最新が自分なら対応済み）
        const thread = await gmail.fetchThread(message.threadId);
        const latest = thread[thread.length - 1];
        const myEmail = await gmail.getMyEmail();
        if (latest && latest.fromAddress.includes(myEmail)) {
          skipped++;
          continue;
        }

        pending.push({
          threadId: message.threadId,
          messageId: message.id,
          subject: message.subject,
          from: message.from,
          fromAddress: message.fromAddress,
          date: message.date.toISOString(),
          snippet: message.snippet,
        });
      } else {
        skipped++;
      }
    } catch (error) {
      console.error(`Error processing message ${message.id}:`, error);
      errors++;
    }
  }

  return {
    pending,
    stats: { total: messages.length, needsReply: pending.length, skipped, errors },
  };
}

// ============================================
// Feedback（ユーザー修正）
// ============================================

export async function submitFeedback(
  userId: string,
  messageId: string,
  threadId: string,
  senderEmail: string,
  needsReply: boolean,
) {
  await prisma.classificationFeedback.create({
    data: {
      userId,
      senderEmail,
      messageId,
      threadId,
      previousRuleId: null,
      correctedRuleId: needsReply ? "NEEDS_REPLY" : "NO_REPLY",
    },
  });

  // 学習パターンをリセット（間違ったパターンが確定するのを防ぐ）
  await prisma.learnedPattern.upsert({
    where: { userId_senderEmail: { userId, senderEmail } },
    update: {
      ruleId: needsReply ? "NEEDS_REPLY" : "NO_REPLY",
      hitCount: 1,
      confirmed: false,
    },
    create: {
      userId,
      senderEmail,
      ruleId: needsReply ? "NEEDS_REPLY" : "NO_REPLY",
      hitCount: 1,
      confirmed: false,
    },
  });

  // 判定結果も更新
  await prisma.judgment.updateMany({
    where: { userId, messageId },
    data: { status: needsReply ? "NEEDS_REPLY" : "SKIP", reason: "ユーザー修正" },
  });

  // 送信者カテゴリのconfidenceを下げて再分析を促す
  await prisma.senderCategory.updateMany({
    where: { userId, email: senderEmail },
    data: { confidence: 0.3 },
  });
}

// ============================================
// 内部ヘルパー
// ============================================

async function recordResult(
  userId: string,
  message: ParsedMessage,
  needsReply: boolean,
  matchType: string,
  reason: string,
) {
  await prisma.judgment.create({
    data: {
      userId,
      threadId: message.threadId,
      messageId: message.id,
      status: needsReply ? "NEEDS_REPLY" : "SKIP",
      reason,
      matchType: matchType as any,
    },
  });
}

async function updateLearnedPattern(userId: string, senderEmail: string, needsReply: boolean) {
  const ruleId = needsReply ? "NEEDS_REPLY" : "NO_REPLY";
  const existing = await prisma.learnedPattern.findUnique({
    where: { userId_senderEmail: { userId, senderEmail } },
  });

  if (!existing) {
    await prisma.learnedPattern.create({ data: { userId, senderEmail, ruleId, hitCount: 1 } });
    return;
  }

  if (existing.ruleId === ruleId) {
    const newCount = existing.hitCount + 1;
    await prisma.learnedPattern.update({
      where: { id: existing.id },
      data: { hitCount: newCount, confirmed: newCount >= LEARNED_PATTERN_THRESHOLD },
    });
    if (newCount === LEARNED_PATTERN_THRESHOLD) {
      console.log(`[learned] パターン確定: ${senderEmail} → ${ruleId}`);
    }
  } else {
    await prisma.learnedPattern.update({
      where: { id: existing.id },
      data: { ruleId, hitCount: 1, confirmed: false },
    });
  }
}

async function updateSenderHistory(userId: string, message: ParsedMessage) {
  const existing = await prisma.senderHistory.findUnique({
    where: { userId_senderEmail: { userId, senderEmail: message.fromAddress } },
  });

  let subjects: string[];
  let snippets: string[];
  let messageCount: number;

  if (existing) {
    subjects = JSON.parse(existing.subjects) as string[];
    snippets = JSON.parse(existing.snippets) as string[];
    messageCount = existing.messageCount;
    subjects = [message.subject, ...subjects].slice(0, 5);
    snippets = [message.snippet, ...snippets].slice(0, 5);
    messageCount++;
    await prisma.senderHistory.update({
      where: { id: existing.id },
      data: { subjects: JSON.stringify(subjects), snippets: JSON.stringify(snippets), messageCount },
    });
  } else {
    subjects = [message.subject];
    snippets = [message.snippet];
    messageCount = 1;
    await prisma.senderHistory.create({
      data: {
        userId,
        senderEmail: message.fromAddress,
        subjects: JSON.stringify(subjects),
        snippets: JSON.stringify(snippets),
        messageCount,
      },
    });
  }

  return { subjects, snippets, messageCount };
}

async function getOrAnalyzeSenderCategory(
  userId: string,
  message: ParsedMessage,
  senderHistory: { subjects: string[]; snippets: string[]; messageCount: number },
) {
  const cached = await prisma.senderCategory.findUnique({
    where: { userId_email: { userId, email: message.fromAddress } },
  });

  if (cached && cached.confidence >= 0.7) {
    return { category: cached.category, confidence: cached.confidence };
  }

  const recentMessages = senderHistory.subjects.map((subj, i) => ({
    subject: subj,
    snippet: senderHistory.snippets[i] || "",
  }));

  const result = await categorizeSender(message.fromAddress, message.from, recentMessages);

  await prisma.senderCategory.upsert({
    where: { userId_email: { userId, email: message.fromAddress } },
    update: { category: result.category, confidence: result.confidence },
    create: { userId, email: message.fromAddress, category: result.category, confidence: result.confidence },
  });

  return { category: result.category, confidence: result.confidence };
}
