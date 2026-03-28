import { PrismaClient } from "@prisma/client";
import type { GmailClient } from "../gmail/client.js";
import type { ParsedMessage, RuleWithActions, RuleMatch } from "./types.js";
import { findMatchingRules } from "./match.js";
import { executeActions } from "./execute.js";
import { categorizeSender } from "../ai/categorize-sender.js";

const prisma = new PrismaClient();

/**
 * メール1通に対してルールを適用する完全パイプライン
 *
 * 1. 送信者を分類（キャッシュあり）
 * 2. 3層マッチングでルール選択
 * 3. アクション実行
 * 4. 実行履歴をDB保存
 */
export async function processMessage(
  gmail: GmailClient,
  message: ParsedMessage,
  userId: string,
): Promise<{ matches: RuleMatch[]; executed: boolean }> {
  // ルール取得
  const rules = await prisma.rule.findMany({
    where: { userId, enabled: true },
    include: { actions: { orderBy: { order: "asc" } } },
    orderBy: { order: "asc" },
  });

  if (rules.length === 0) {
    return { matches: [], executed: false };
  }

  // 送信者カテゴリ取得（キャッシュ or 新規分析）
  const senderCategory = await getOrAnalyzeSenderCategory(
    userId,
    message,
  );

  // 3層マッチング
  const matches = await findMatchingRules({
    rules: rules as RuleWithActions[],
    message,
    senderCategory,
  });

  if (matches.length === 0) {
    await prisma.executedRule.create({
      data: {
        userId,
        threadId: message.threadId,
        messageId: message.id,
        status: "SKIPPED",
        reason: "マッチするルールなし",
      },
    });
    return { matches: [], executed: false };
  }

  // マッチした各ルールのアクションを実行
  for (const match of matches) {
    const results = await executeActions(gmail, message, match);
    const hasError = results.some((r) => !r.success);

    await prisma.executedRule.create({
      data: {
        userId,
        ruleId: match.rule.id,
        threadId: message.threadId,
        messageId: message.id,
        status: hasError ? "ERROR" : "APPLIED",
        reason: match.reason,
        matchType: match.matchType,
      },
    });
  }

  return { matches, executed: true };
}

/**
 * 受信箱全体をスキャンして処理する
 */
export async function scanAndProcess(
  gmail: GmailClient,
  userId: string,
  hours: number,
): Promise<{
  total: number;
  processed: number;
  skipped: number;
  errors: number;
}> {
  const messages = await gmail.fetchUnrepliedMessages(hours);
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const message of messages) {
    try {
      // 既に処理済みか確認
      const existing = await prisma.executedRule.findFirst({
        where: { userId, messageId: message.id },
      });
      if (existing) {
        skipped++;
        continue;
      }

      const result = await processMessage(gmail, message, userId);
      if (result.executed) {
        processed++;
      } else {
        skipped++;
      }
    } catch (error) {
      console.error(`Error processing message ${message.id}:`, error);
      errors++;
    }
  }

  return { total: messages.length, processed, skipped, errors };
}

// ============================================
// 送信者カテゴリ管理
// ============================================

async function getOrAnalyzeSenderCategory(
  userId: string,
  message: ParsedMessage,
) {
  // キャッシュ確認
  const cached = await prisma.senderCategory.findUnique({
    where: { userId_email: { userId, email: message.fromAddress } },
  });

  if (cached) {
    return { category: cached.category, confidence: cached.confidence };
  }

  // 新規分析
  const result = await categorizeSender(
    message.fromAddress,
    message.from,
    [{ subject: message.subject, snippet: message.snippet }],
  );

  // DB保存
  await prisma.senderCategory.create({
    data: {
      userId,
      email: message.fromAddress,
      category: result.category,
      confidence: result.confidence,
    },
  });

  return { category: result.category, confidence: result.confidence };
}
