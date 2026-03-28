import type { SenderCategoryType } from "@prisma/client";
import type { ParsedMessage, RuleWithActions, RuleMatch } from "./types.js";
import { aiChooseRule } from "../ai/classify-email.js";

/**
 * 3層マッチングエンジン（Inbox Zero のアーキテクチャに準拠）
 *
 * Layer 1: 静的パターンマッチ（高速・確実）
 *   - from/to/subject/body のワイルドカード・正規表現
 *
 * Layer 2: 送信者カテゴリマッチ（学習パターン）
 *   - 過去に分類済みの送信者情報を活用
 *   - ルールの instructions に "NEWSLETTER" 等のカテゴリが含まれていればマッチ
 *
 * Layer 3: AI判定（高精度・低速）
 *   - Claude で自然言語の instructions を評価
 *   - Layer 1/2 で確定しなかったルールのみAIに送る
 */
export async function findMatchingRules({
  rules,
  message,
  senderCategory,
}: {
  rules: RuleWithActions[];
  message: ParsedMessage;
  senderCategory?: { category: SenderCategoryType; confidence: number } | null;
}): Promise<RuleMatch[]> {
  const enabledRules = rules.filter((r) => r.enabled).sort((a, b) => a.order - b.order);
  if (enabledRules.length === 0) return [];

  const matches: RuleMatch[] = [];
  const needsAiEvaluation: RuleWithActions[] = [];

  for (const rule of enabledRules) {
    // ---- Layer 1: 静的パターンマッチ ----
    const staticResult = matchStaticConditions(rule, message);

    if (staticResult.matched) {
      matches.push({ rule, matchType: "STATIC", reason: staticResult.reason });
      continue;
    }

    // ---- Layer 2: 送信者カテゴリマッチ ----
    if (senderCategory && senderCategory.confidence >= 0.7) {
      const categoryResult = matchSenderCategory(rule, senderCategory.category);
      if (categoryResult.matched) {
        matches.push({ rule, matchType: "LEARNED", reason: categoryResult.reason });
        continue;
      }
    }

    // Layer 1/2 で明確に除外されなかった && instructions がある → AI判定候補
    if (rule.instructions && !staticResult.excluded) {
      needsAiEvaluation.push(rule);
    }
  }

  // 静的/カテゴリで十分なマッチがあればAIスキップ（コスト最適化）
  if (matches.length > 0 && needsAiEvaluation.length === 0) {
    return matches;
  }

  // ---- Layer 3: AI判定 ----
  if (needsAiEvaluation.length > 0) {
    const aiSelections = await aiChooseRule(message, needsAiEvaluation);

    for (const sel of aiSelections) {
      const rule = needsAiEvaluation.find((r) => r.id === sel.ruleId);
      if (rule) {
        matches.push({ rule, matchType: "AI", reason: sel.reason });
      }
    }
  }

  return matches;
}

// ============================================
// Layer 1: 静的パターンマッチ
// ============================================

interface StaticMatchResult {
  matched: boolean;
  excluded: boolean; // 明確に条件外
  reason: string;
}

function matchStaticConditions(
  rule: RuleWithActions,
  message: ParsedMessage,
): StaticMatchResult {
  const conditions: { field: string; pattern: string; value: string }[] = [];

  if (rule.fromPattern) conditions.push({ field: "from", pattern: rule.fromPattern, value: message.fromAddress });
  if (rule.toPattern) conditions.push({ field: "to", pattern: rule.toPattern, value: message.to });
  if (rule.subjectPattern) conditions.push({ field: "subject", pattern: rule.subjectPattern, value: message.subject });
  if (rule.bodyPattern) conditions.push({ field: "body", pattern: rule.bodyPattern, value: message.body.substring(0, 5000) });

  if (conditions.length === 0) {
    return { matched: false, excluded: false, reason: "" };
  }

  const results = conditions.map((c) => ({
    ...c,
    matches: matchPattern(c.pattern, c.value),
  }));

  const isAnd = rule.conditionalOperator === "AND";

  if (isAnd) {
    const allMatch = results.every((r) => r.matches);
    if (allMatch) {
      const reason = results.map((r) => `${r.field}="${r.pattern}"`).join(" AND ");
      return { matched: true, excluded: false, reason: `静的マッチ: ${reason}` };
    }
    return { matched: false, excluded: true, reason: "" };
  }

  // OR
  const anyMatch = results.find((r) => r.matches);
  if (anyMatch) {
    return { matched: true, excluded: false, reason: `静的マッチ: ${anyMatch.field}="${anyMatch.pattern}"` };
  }

  // OR条件があって1つもマッチしない → 除外ではない（AI判定の余地あり）
  return { matched: false, excluded: false, reason: "" };
}

/**
 * ワイルドカード＋パイプ区切りパターンマッチ
 * 例: "*.example.com | tanaka@*" → OR条件
 * 例: "/正規表現/" → 正規表現
 */
function matchPattern(pattern: string, value: string): boolean {
  const patterns = pattern.split(/\s*\|\s*/);
  return patterns.some((p) => matchSinglePattern(p.trim(), value));
}

function matchSinglePattern(pattern: string, value: string): boolean {
  // 正規表現: /pattern/flags
  const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      const regex = new RegExp(regexMatch[1], regexMatch[2] || "i");
      return regex.test(value);
    } catch {
      return false;
    }
  }

  // ワイルドカード: * を .* に変換
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

// ============================================
// Layer 2: 送信者カテゴリマッチ
// ============================================

function matchSenderCategory(
  rule: RuleWithActions,
  category: SenderCategoryType,
): { matched: boolean; reason: string } {
  if (!rule.instructions) return { matched: false, reason: "" };

  // instructions 内にカテゴリキーワードがあればマッチ
  const categoryKeywords: Record<SenderCategoryType, string[]> = {
    HUMAN: ["人間", "個人", "human", "conversation", "会話"],
    NEWSLETTER: ["メルマガ", "ニュースレター", "newsletter"],
    NOTIFICATION: ["通知", "notification", "自動通知"],
    MARKETING: ["マーケティング", "marketing", "プロモーション", "広告"],
    RECEIPT: ["領収書", "receipt", "注文", "配送"],
    CALENDAR: ["カレンダー", "calendar", "予定", "招待"],
    COLD_EMAIL: ["営業", "cold email", "コールド", "セールス"],
    UNKNOWN: [],
  };

  const keywords = categoryKeywords[category] || [];
  const instructionsLower = rule.instructions.toLowerCase();

  for (const kw of keywords) {
    if (instructionsLower.includes(kw.toLowerCase())) {
      return { matched: true, reason: `送信者カテゴリ: ${category} → "${kw}"` };
    }
  }

  return { matched: false, reason: "" };
}
