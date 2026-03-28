import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { google } from "googleapis";
import { config } from "../config.js";
import { createGmailClient, getAuthUrl } from "../gmail/client.js";
import { scanAndProcess, processMessage, submitFeedback } from "../rules/run-rules.js";

const prisma = new PrismaClient();
export const router = Router();

// ============================================
// 認証
// ============================================

router.get("/auth/google", (_req, res) => {
  res.json({ url: getAuthUrl() });
});

router.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).json({ error: "code required" });

  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress!;

  const user = await prisma.user.upsert({
    where: { email },
    create: { email, accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
    update: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || undefined },
  });

  res.redirect(`${config.frontendUrl}?userId=${user.id}`);
});

// ============================================
// ルール管理
// ============================================

router.get("/rules", async (req, res) => {
  const userId = req.query.userId as string;
  const rules = await prisma.rule.findMany({
    where: { userId },
    include: { actions: { orderBy: { order: "asc" } } },
    orderBy: { order: "asc" },
  });
  res.json(rules);
});

router.post("/rules", async (req, res) => {
  const { userId, name, instructions, fromPattern, toPattern, subjectPattern, bodyPattern, conditionalOperator, actions } = req.body;

  const maxOrder = await prisma.rule.aggregate({
    where: { userId },
    _max: { order: true },
  });

  const rule = await prisma.rule.create({
    data: {
      userId,
      name,
      instructions,
      fromPattern,
      toPattern,
      subjectPattern,
      bodyPattern,
      conditionalOperator: conditionalOperator || "OR",
      order: (maxOrder._max.order || 0) + 1,
      actions: {
        create: (actions || []).map((a: any, i: number) => ({
          type: a.type,
          label: a.label,
          to: a.to,
          content: a.content,
          webhookUrl: a.webhookUrl,
          order: i,
        })),
      },
    },
    include: { actions: true },
  });
  res.json(rule);
});

router.put("/rules/:id", async (req, res) => {
  const { name, instructions, fromPattern, toPattern, subjectPattern, bodyPattern, conditionalOperator, enabled, order, actions } = req.body;

  // アクション更新: 全削除→再作成
  if (actions) {
    await prisma.ruleAction.deleteMany({ where: { ruleId: req.params.id } });
  }

  const rule = await prisma.rule.update({
    where: { id: req.params.id },
    data: {
      name,
      instructions,
      fromPattern,
      toPattern,
      subjectPattern,
      bodyPattern,
      conditionalOperator,
      enabled,
      order,
      actions: actions
        ? {
            create: actions.map((a: any, i: number) => ({
              type: a.type,
              label: a.label,
              to: a.to,
              content: a.content,
              webhookUrl: a.webhookUrl,
              order: i,
            })),
          }
        : undefined,
    },
    include: { actions: true },
  });
  res.json(rule);
});

router.delete("/rules/:id", async (req, res) => {
  await prisma.rule.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ============================================
// メールスキャン・処理
// ============================================

router.post("/scan", async (req, res) => {
  const { userId } = req.body;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.accessToken) return res.status(401).json({ error: "認証が必要です" });

  const gmail = createGmailClient(user.accessToken, user.refreshToken);
  const result = await scanAndProcess(gmail, userId, config.scanHours);
  res.json(result);
});

/** 特定メールにルールをテスト実行（dry-run） */
router.post("/test-rules", async (req, res) => {
  const { userId, messageId } = req.body;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.accessToken) return res.status(401).json({ error: "認証が必要です" });

  const gmail = createGmailClient(user.accessToken, user.refreshToken);
  const messages = await gmail.fetchThread(messageId);
  const target = messages.find((m) => m.id === messageId) || messages[messages.length - 1];

  if (!target) return res.status(404).json({ error: "メッセージが見つかりません" });

  // ルールマッチのみ実行（アクションは実行しない）
  const { findMatchingRules } = await import("../rules/match.js");
  const rules = await prisma.rule.findMany({
    where: { userId, enabled: true },
    include: { actions: { orderBy: { order: "asc" } } },
    orderBy: { order: "asc" },
  });

  const matches = await findMatchingRules({
    rules: rules as any,
    message: target,
  });

  res.json({
    message: {
      id: target.id,
      from: target.from,
      subject: target.subject,
      snippet: target.snippet,
    },
    matches: matches.map((m) => ({
      ruleName: m.rule.name,
      matchType: m.matchType,
      reason: m.reason,
      actions: m.rule.actions.map((a) => a.type),
    })),
  });
});

// ============================================
// Classification Feedback（精度改善 #1）
// ============================================

/** ユーザーがAIの判定を修正する */
router.post("/feedback", async (req, res) => {
  const { userId, messageId, threadId, senderEmail, previousRuleId, correctedRuleId } = req.body;

  if (!userId || !messageId || !correctedRuleId || !senderEmail) {
    return res.status(400).json({ error: "userId, messageId, senderEmail, correctedRuleId は必須です" });
  }

  await submitFeedback(userId, messageId, threadId, senderEmail, previousRuleId, correctedRuleId);
  res.json({ ok: true, message: "フィードバック保存完了。次回から同じ送信者に反映されます。" });
});

/** フィードバック一覧 */
router.get("/feedback", async (req, res) => {
  const userId = req.query.userId as string;
  const feedbacks = await prisma.classificationFeedback.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(feedbacks);
});

// ============================================
// Learned Patterns（精度改善 #2）
// ============================================

router.get("/learned-patterns", async (req, res) => {
  const userId = req.query.userId as string;
  const patterns = await prisma.learnedPattern.findMany({
    where: { userId },
    orderBy: [{ confirmed: "desc" }, { hitCount: "desc" }],
  });

  // ルール名もJOIN
  const ruleIds = [...new Set(patterns.map((p) => p.ruleId))];
  const rules = await prisma.rule.findMany({
    where: { id: { in: ruleIds } },
    select: { id: true, name: true },
  });
  const ruleMap = Object.fromEntries(rules.map((r) => [r.id, r.name]));

  res.json(patterns.map((p) => ({
    ...p,
    ruleName: ruleMap[p.ruleId] || "(不明)",
  })));
});

/** パターンを手動で削除（再学習させたい時） */
router.delete("/learned-patterns/:id", async (req, res) => {
  await prisma.learnedPattern.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ============================================
// Sender History（精度改善 #3）
// ============================================

router.get("/sender-history", async (req, res) => {
  const userId = req.query.userId as string;
  const histories = await prisma.senderHistory.findMany({
    where: { userId },
    orderBy: { messageCount: "desc" },
    take: 50,
  });
  res.json(histories.map((h) => ({
    ...h,
    subjects: JSON.parse(h.subjects),
    snippets: JSON.parse(h.snippets),
  })));
});

// ============================================
// 実行履歴
// ============================================

router.get("/history", async (req, res) => {
  const userId = req.query.userId as string;
  const limit = parseInt(req.query.limit as string) || 50;

  const history = await prisma.executedRule.findMany({
    where: { userId },
    include: { rule: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  res.json(history);
});

// ============================================
// 送信者カテゴリ
// ============================================

router.get("/sender-categories", async (req, res) => {
  const userId = req.query.userId as string;
  const categories = await prisma.senderCategory.findMany({
    where: { userId },
    orderBy: { analyzedAt: "desc" },
  });
  res.json(categories);
});

router.put("/sender-categories/:id", async (req, res) => {
  const { category } = req.body;
  const updated = await prisma.senderCategory.update({
    where: { id: req.params.id },
    data: { category, confidence: 1.0 },
  });
  res.json(updated);
});

// ============================================
// 未対応メール一覧（既存フロント互換）
// ============================================

router.get("/pending", async (req, res) => {
  const userId = req.query.userId as string;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.accessToken) return res.status(401).json({ error: "認証が必要です" });

  const gmail = createGmailClient(user.accessToken, user.refreshToken);
  const messages = await gmail.fetchUnrepliedMessages(config.scanHours);

  // 実行履歴でARCHIVE済みのものを除外
  const archived = await prisma.executedRule.findMany({
    where: {
      userId,
      status: "APPLIED",
      rule: { actions: { some: { type: "ARCHIVE" } } },
    },
    select: { messageId: true },
  });
  const archivedIds = new Set(archived.map((a) => a.messageId));

  const pending = messages
    .filter((m) => !archivedIds.has(m.id))
    .map((m) => ({
      threadId: m.threadId,
      subject: m.subject,
      from: m.from,
      date: m.date.toISOString(),
    }));

  res.json(pending);
});
