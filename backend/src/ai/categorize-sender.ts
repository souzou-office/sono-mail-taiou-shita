import type { SenderCategoryType } from "@prisma/client";
import { callFast, parseJsonResponse } from "./client.js";
import type { ParsedMessage } from "../rules/types.js";

interface CategorizationResult {
  category: SenderCategoryType;
  confidence: number;
  reason: string;
}

const SYSTEM_PROMPT = `あなたはメール分類の専門家です。
送信者のメールアドレス、名前、過去のメール内容をもとに、送信者のカテゴリを正確に判定してください。

カテゴリ:
- HUMAN: 実際の人間からの個人的なメール（同僚、取引先、友人など）
- NEWSLETTER: メルマガ、ニュースレター、定期配信
- NOTIFICATION: サービスの自動通知（GitHub、Slack、Jira等）
- MARKETING: マーケティング、プロモーション、セール告知
- RECEIPT: 領収書、注文確認、配送通知
- CALENDAR: カレンダー招待、予定変更
- COLD_EMAIL: 営業メール、コールドメール、初回アプローチ
- UNKNOWN: 判断がつかない場合`;

/**
 * 送信者を分類する（Inbox Zero の categorize-sender に相当）
 * メールアドレスのパターンとメール内容から高精度に判別
 */
export async function categorizeSender(
  senderEmail: string,
  senderName: string,
  recentMessages: Pick<ParsedMessage, "subject" | "snippet">[],
): Promise<CategorizationResult> {
  // ---- ヒューリスティック（高速パス）----
  const heuristic = heuristicCategorize(senderEmail);
  if (heuristic) return heuristic;

  // ---- AI分類 ----
  const emailSamples = recentMessages
    .slice(0, 5)
    .map((m, i) => `${i + 1}. 件名: ${m.subject}\n   内容: ${m.snippet}`)
    .join("\n");

  const prompt = `以下の送信者を分類してください。

送信者: ${senderName} <${senderEmail}>

最近のメール:
${emailSamples || "(サンプルなし)"}

判定のヒント:
- List-Unsubscribe ヘッダーがある → NEWSLETTER or MARKETING の可能性が高い
- noreply@, no-reply@, notifications@ → NOTIFICATION
- 個人名 + 会社ドメイン → HUMAN の可能性が高い
- 内容が個人宛で質問や依頼を含む → HUMAN

JSON形式で回答:
{"category": "カテゴリ名", "confidence": 0.0-1.0, "reason": "判定理由"}`;

  const result = await callFast(prompt, SYSTEM_PROMPT);
  const parsed = parseJsonResponse<CategorizationResult>(result);

  return parsed || { category: "UNKNOWN", confidence: 0.3, reason: "パース失敗" };
}

/** メールアドレスのパターンだけで高速判定（AIコール不要） */
function heuristicCategorize(email: string): CategorizationResult | null {
  const lower = email.toLowerCase();

  // 自動通知系
  const notificationPatterns = [
    "noreply@", "no-reply@", "notifications@", "notify@",
    "mailer-daemon@", "postmaster@",
    "@github.com", "@slack.com", "@jira.", "@figma.com",
    "@linear.app", "@notion.so", "@asana.com",
  ];
  if (notificationPatterns.some((p) => lower.includes(p))) {
    return { category: "NOTIFICATION", confidence: 0.9, reason: "通知系アドレスパターン" };
  }

  // カレンダー
  if (lower.includes("calendar-notification@google.com") || lower.includes("calendar@")) {
    return { category: "CALENDAR", confidence: 0.95, reason: "カレンダー通知アドレス" };
  }

  // 領収書
  const receiptPatterns = ["receipt@", "order@", "shipping@", "delivery@"];
  if (receiptPatterns.some((p) => lower.includes(p))) {
    return { category: "RECEIPT", confidence: 0.85, reason: "注文・配送系アドレス" };
  }

  // マーケティング
  const marketingPatterns = ["marketing@", "promo@", "deals@", "offers@", "news@"];
  if (marketingPatterns.some((p) => lower.includes(p))) {
    return { category: "MARKETING", confidence: 0.8, reason: "マーケティング系アドレス" };
  }

  return null;
}
