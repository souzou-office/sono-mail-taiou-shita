import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { google } from "googleapis";
import { config } from "../config.js";
import { createGmailClient, getAuthUrl } from "../gmail/client.js";
import { scanAndJudge, submitFeedback } from "../rules/run-rules.js";

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
// 未対応メール一覧（メイン機能）
// ============================================

router.get("/pending", async (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.accessToken) return res.status(401).json({ error: "認証が必要です" });

  const gmail = createGmailClient(user.accessToken, user.refreshToken);
  const result = await scanAndJudge(gmail, userId, config.scanHours);

  res.json(result);
});

// ============================================
// フィードバック（AIの判定を修正）
// ============================================

router.post("/feedback", async (req, res) => {
  const { userId, messageId, threadId, senderEmail, needsReply } = req.body;

  if (!userId || !messageId || !senderEmail || needsReply === undefined) {
    return res.status(400).json({ error: "userId, messageId, senderEmail, needsReply は必須です" });
  }

  await submitFeedback(userId, messageId, threadId, senderEmail, needsReply);

  res.json({
    ok: true,
    message: needsReply
      ? "「返信必要」として記録しました"
      : "「返信不要」として記録しました。次回から同じ送信者に反映されます。",
  });
});

// ============================================
// 学習状況
// ============================================

router.get("/learning-stats", async (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const [patterns, categories, feedbackCount] = await Promise.all([
    prisma.learnedPattern.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } }),
    prisma.senderCategory.findMany({ where: { userId }, orderBy: { analyzedAt: "desc" } }),
    prisma.classificationFeedback.count({ where: { userId } }),
  ]);

  res.json({
    learnedPatterns: {
      total: patterns.length,
      confirmed: patterns.filter((p) => p.confirmed).length,
      items: patterns.map((p) => ({
        senderEmail: p.senderEmail,
        result: p.ruleId === "NEEDS_REPLY" ? "返信必要" : "返信不要",
        hitCount: p.hitCount,
        confirmed: p.confirmed,
      })),
    },
    senderCategories: {
      total: categories.length,
      breakdown: Object.fromEntries(
        Object.entries(
          categories.reduce((acc, c) => {
            acc[c.category] = (acc[c.category] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
        ),
      ),
    },
    feedbackCount,
  });
});
