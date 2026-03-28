import express from "express";
import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";
import { router } from "./api/routes.js";
import { createGmailClient } from "./gmail/client.js";
import { scanAndProcess } from "./rules/run-rules.js";

const prisma = new PrismaClient();
const app = express();

app.use(express.json());

// CORS
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", config.frontendUrl);
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  next();
});

app.use("/api", router);

app.get("/health", (_req, res) => res.json({ ok: true }));

// ============================================
// 定期スキャン（cron）
// ============================================

// 毎朝7時: フルスキャン
cron.schedule("0 7 * * *", async () => {
  console.log("[cron] 朝のフルスキャン開始");
  await runForAllUsers();
});

// 3時間おき: 差分チェック
cron.schedule("0 */3 * * *", async () => {
  console.log("[cron] 定期チェック開始");
  await runForAllUsers();
});

async function runForAllUsers() {
  const users = await prisma.user.findMany({
    where: { accessToken: { not: null } },
  });

  for (const user of users) {
    try {
      const gmail = createGmailClient(user.accessToken!, user.refreshToken);
      const result = await scanAndProcess(gmail, user.id, config.scanHours);
      console.log(`[cron] ${user.email}: ${result.processed}件処理, ${result.skipped}件スキップ`);
    } catch (error) {
      console.error(`[cron] ${user.email}: エラー`, error);
    }
  }
}

// ============================================
// 起動
// ============================================

app.listen(config.port, () => {
  console.log(`sono-mail-backend running on port ${config.port}`);
  console.log(`Frontend: ${config.frontendUrl}`);
});
