import express from "express";
import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";
import { router } from "./api/routes.js";
import { createGmailClient } from "./gmail/client.js";
import { scanAndJudge } from "./rules/run-rules.js";

const prisma = new PrismaClient();
const app = express();

app.use(express.json());

// CORS
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", config.frontendUrl);
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

app.use("/api", router);

app.get("/health", (_req, res) => res.json({ ok: true }));

// ============================================
// 3時間おきスキャン
// ============================================

cron.schedule("0 */3 * * *", async () => {
  console.log("[cron] スキャン開始");
  const users = await prisma.user.findMany({
    where: { accessToken: { not: null } },
  });

  for (const user of users) {
    try {
      const gmail = createGmailClient(user.accessToken!, user.refreshToken);
      const result = await scanAndJudge(gmail, user.id, config.scanHours);
      console.log(`[cron] ${user.email}: ${result.stats.needsReply}件が要返信 / ${result.stats.total}件中`);
    } catch (error) {
      console.error(`[cron] ${user.email}: エラー`, error);
    }
  }
});

app.listen(config.port, () => {
  console.log(`sono-mail-backend running on port ${config.port}`);
});
