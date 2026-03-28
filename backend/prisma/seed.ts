import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // デモユーザー
  const user = await prisma.user.upsert({
    where: { email: "demo@example.com" },
    update: {},
    create: { email: "demo@example.com" },
  });

  // ---- サンプルルール ----

  // 1. メルマガ → 自動アーカイブ＋ラベル
  await prisma.rule.create({
    data: {
      userId: user.id,
      name: "メルマガ自動整理",
      instructions: "メルマガやニュースレター。List-Unsubscribeヘッダーがあるメール。定期配信。",
      order: 1,
      actions: {
        create: [
          { type: "LABEL", label: "メルマガ", order: 0 },
          { type: "ARCHIVE", order: 1 },
          { type: "MARK_READ", order: 2 },
        ],
      },
    },
  });

  // 2. GitHub通知 → ラベル付け
  await prisma.rule.create({
    data: {
      userId: user.id,
      name: "GitHub通知",
      fromPattern: "*@github.com",
      instructions: "GitHubからの通知（PR、Issue、Review等）",
      order: 2,
      actions: {
        create: [
          { type: "LABEL", label: "GitHub", order: 0 },
        ],
      },
    },
  });

  // 3. 領収書 → 自動ラベル＋既読
  await prisma.rule.create({
    data: {
      userId: user.id,
      name: "領収書・注文確認",
      instructions: "領収書、注文確認、配送通知、決済完了通知。",
      fromPattern: "receipt@* | order@* | noreply@amazon.*",
      order: 3,
      actions: {
        create: [
          { type: "LABEL", label: "領収書", order: 0 },
          { type: "MARK_READ", order: 1 },
        ],
      },
    },
  });

  // 4. 要返信 → ラベル＋ドラフト生成
  await prisma.rule.create({
    data: {
      userId: user.id,
      name: "要返信メール",
      instructions: "実際の人間からの、返信が必要なメール。質問、依頼、相談、確認事項を含む。自動通知やメルマガは除外。",
      order: 10,
      actions: {
        create: [
          { type: "LABEL", label: "要返信", order: 0 },
          { type: "DRAFT_REPLY", content: "丁寧に、簡潔に返信してください。相手の質問や依頼に的確に答える。", order: 1 },
        ],
      },
    },
  });

  // 5. 営業メール → スパム
  await prisma.rule.create({
    data: {
      userId: user.id,
      name: "営業メールブロック",
      instructions: "営業メール、コールドメール。初めて連絡してくる企業からの売り込み。",
      order: 5,
      actions: {
        create: [
          { type: "LABEL", label: "営業", order: 0 },
          { type: "ARCHIVE", order: 1 },
        ],
      },
    },
  });

  console.log("Seed完了: ユーザー + 5ルール作成");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
