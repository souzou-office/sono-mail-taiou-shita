import { PrismaClient } from "@prisma/client";
import type { GmailClient } from "../gmail/client.js";
import type { ParsedMessage, RuleWithActions, RuleMatch } from "./types.js";
import { findMatchingRules } from "./match.js";
import { executeActions } from "./execute.js";
import { categorizeSender } from "../ai/categorize-sender.js";

const prisma = new PrismaClient();

const LEARNED_PATTERN_THRESHOLD = 3; // この回数連続で同じルール → 確定

/**
 * メール1通に対してルールを適用する完全パイプライン
 *
 * 1. 送信者の過去メール履歴を取得・更新（精度改善 #3）
 * 2. 送信者を分類（過去メール文脈付き）
 * 3. Learned Pattern チェック（精度改善 #2）
 * 4. Classification Feedback 取得（精度改善 #1）
 * 5. 4層マッチングでルール選択
 * 6. アクション実行
 * 7. Learned Pattern 更新
 * 8. 実行履歴をDB保存
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

  // ---- 精度改善 #3: 送信者の過去メール履歴を更新 ----
  const senderHistory = await updateSenderHistory(userId, message);

  // ---- 送信者カテゴリ取得（過去メール文脈付き） ----
  const senderCategory = await getOrAnalyzeSenderCategory(
    userId,
    message,
    senderHistory,
  );

  // ---- 精度改善 #2: Learned Pattern 確認 ----
  const learnedPattern = await prisma.learnedPattern.findUnique({
    where: { userId_senderEmail: { userId, senderEmail: message.fromAddress } },
  });

  // ---- 精度改善 #1: Classification Feedback 取得 ----
  const feedbacks = await prisma.classificationFeedback.findMany({
    where: { userId, senderEmail: message.fromAddress },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  // ---- 4層マッチング ----
  const matches = await findMatchingRules({
    rules: rules as RuleWithActions[],
    message,
    senderCategory,
    learnedPattern,
    feedbacks: feedbacks.map((f) => ({
      senderEmail: f.senderEmail,
      correctedRuleId: f.correctedRuleId,
    })),
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

    // ---- 精度改善 #2: Learned Pattern を更新 ----
    if (match.matchType === "AI") {
      await updateLearnedPattern(userId, message.fromAddress, match.rule.id);
    }
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
  learnedPatternsCreated: number;
}> {
  const messages = await gmail.fetchUnrepliedMessages(hours);
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  let learnedPatternsCreated = 0;

  for (const message of messages) {
    try {
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
        // 新しくconfirmedになったパターンをカウント
        const pattern = await prisma.learnedPattern.findUnique({
          where: { userId_senderEmail: { userId, senderEmail: message.fromAddress } },
        });
        if (pattern?.confirmed && pattern.hitCount === LEARNED_PATTERN_THRESHOLD) {
          learnedPatternsCreated++;
        }
      } else {
        skipped++;
      }
    } catch (error) {
      console.error(`Error processing message ${message.id}:`, error);
      errors++;
    }
  }

  return { total: messages.length, processed, skipped, errors, learnedPatternsCreated };
}

// ============================================
// 精度改善 #1: Classification Feedback
// ============================================

/**
 * ユーザーがAIの判定を修正した時に呼ぶ
 * → 同じ送信者の次回判定で修正結果がプロンプトに含まれる
 * → Learned Pattern もリセットされる
 */
export async function submitFeedback(
  userId: string,
  messageId: string,
  threadId: string,
  senderEmail: string,
  previousRuleId: string | null,
  correctedRuleId: string,
) {
  // フィードバック保存
  await prisma.classificationFeedback.create({
    data: {
      userId,
      senderEmail,
      messageId,
      threadId,
      previousRuleId,
      correctedRuleId,
    },
  });

  // Learned Pattern をリセット（間違ったパターンが確定するのを防ぐ）
  await prisma.learnedPattern.upsert({
    where: { userId_senderEmail: { userId, senderEmail } },
    update: {
      ruleId: correctedRuleId,
      hitCount: 1, // リセットして修正後のルールから再カウント
      confirmed: false,
    },
    create: {
      userId,
      senderEmail,
      ruleId: correctedRuleId,
      hitCount: 1,
      confirmed: false,
    },
  });

  // 送信者カテゴリも再分析をトリガー（confidence下げる）
  await prisma.senderCategory.updateMany({
    where: { userId, email: senderEmail },
    data: { confidence: 0.3 },
  });
}

// ============================================
// 精度改善 #2: Learned Patterns
// ============================================

/**
 * AI判定が成功した時にパターンを記録
 * 同じ送信者 × 同じルールが LEARNED_PATTERN_THRESHOLD 回続いたら confirmed
 */
async function updateLearnedPattern(
  userId: string,
  senderEmail: string,
  ruleId: string,
) {
  const existing = await prisma.learnedPattern.findUnique({
    where: { userId_senderEmail: { userId, senderEmail } },
  });

  if (!existing) {
    // 初回
    await prisma.learnedPattern.create({
      data: { userId, senderEmail, ruleId, hitCount: 1 },
    });
    return;
  }

  if (existing.ruleId === ruleId) {
    // 同じルールに連続マッチ → カウントアップ
    const newCount = existing.hitCount + 1;
    await prisma.learnedPattern.update({
      where: { id: existing.id },
      data: {
        hitCount: newCount,
        confirmed: newCount >= LEARNED_PATTERN_THRESHOLD,
      },
    });

    if (newCount === LEARNED_PATTERN_THRESHOLD) {
      console.log(`[learned] パターン確定: ${senderEmail} → rule ${ruleId}`);
    }
  } else {
    // 別のルールにマッチ → リセット
    await prisma.learnedPattern.update({
      where: { id: existing.id },
      data: {
        ruleId,
        hitCount: 1,
        confirmed: false,
      },
    });
  }
}

// ============================================
// 精度改善 #3: 送信者の過去メール履歴
// ============================================

/**
 * 送信者の過去メール（件名・スニペット）をDBにキャッシュ
 * 送信者カテゴリ分析に過去5通のコンテキストを提供
 */
async function updateSenderHistory(
  userId: string,
  message: ParsedMessage,
): Promise<{ subjects: string[]; snippets: string[]; messageCount: number }> {
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

    // 最新を先頭に追加、最大5件保持
    subjects = [message.subject, ...subjects].slice(0, 5);
    snippets = [message.snippet, ...snippets].slice(0, 5);
    messageCount++;

    await prisma.senderHistory.update({
      where: { id: existing.id },
      data: {
        subjects: JSON.stringify(subjects),
        snippets: JSON.stringify(snippets),
        messageCount,
      },
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

// ============================================
// 送信者カテゴリ管理（過去メール文脈付き）
// ============================================

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

  // 過去メール文脈を使って分析（精度改善 #3 の核心）
  const recentMessages = senderHistory.subjects.map((subj, i) => ({
    subject: subj,
    snippet: senderHistory.snippets[i] || "",
  }));

  const result = await categorizeSender(
    message.fromAddress,
    message.from,
    recentMessages,
  );

  // DB保存（upsertでconfidence低いキャッシュを上書き）
  await prisma.senderCategory.upsert({
    where: { userId_email: { userId, email: message.fromAddress } },
    update: {
      category: result.category,
      confidence: result.confidence,
    },
    create: {
      userId,
      email: message.fromAddress,
      category: result.category,
      confidence: result.confidence,
    },
  });

  return { category: result.category, confidence: result.confidence };
}
