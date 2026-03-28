// ============================================
// 未対応メールチェッカー - GAS Backend
// ============================================
// 設定: スクリプトプロパティに以下を設定
//   ANTHROPIC_API_KEY: Anthropic APIキー
//   BACKEND_URL: バックエンドのURL（例: https://xxx.com/api）
//   BACKEND_USER_ID: バックエンドのユーザーID
//   ALLOWED_ORIGINS: フロント側のURL（CORS用）

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SCAN_HOURS = 48; // 過去何時間をスキャン
const MY_EMAIL = Session.getActiveUser().getEmail();

// ============================================
// Web API（フロント用）
// ============================================
function doGet(e) {
  // アクセス時に返信済みチェック（リアルタイム性向上）
  quickReplyCheck();
  const data = getStoredItems();
  const output = ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}

// 軽量な返信済みチェック（AI判定なし、返信済みだけ消す）
function quickReplyCheck() {
  const items = getStoredItems();
  if (items.length === 0) return;

  const stillNeeded = [];
  for (const item of items) {
    try {
      const thread = GmailApp.getThreadById(item.threadId);
      if (!thread) continue;
      const messages = thread.getMessages();
      const latest = messages[messages.length - 1];
      if (latest.getFrom().includes(MY_EMAIL)) continue; // 返信済み → 消す
      stillNeeded.push(item);
    } catch (e) {
      stillNeeded.push(item); // エラー時は残す
    }
  }

  if (stillNeeded.length !== items.length) {
    saveItems(stillNeeded);
  }
}

// CORS対応
function doOptions(e) {
  return ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT);
}

// ============================================
// メインスキャン（毎朝トリガー）
// ============================================
function scanEmails() {
  const cutoff = new Date(Date.now() - SCAN_HOURS * 60 * 60 * 1000);
  const query = `after:${formatDateForSearch(cutoff)} -from:me`;
  const threads = GmailApp.search(query, 0, 100);

  // 未返信 or 自分の返信後に相手から新着があるスレッドを抽出
  const unreplied = [];
  for (const thread of threads) {
    const messages = thread.getMessages();
    const latest = messages[messages.length - 1];
    const latestIsFromMe = latest.getFrom().includes(MY_EMAIL);

    // 最新メッセージが自分 → 対応済み、スキップ
    if (latestIsFromMe) continue;

    // 最新が相手からのメール（自分が一度も返信してない or 返信後に相手が再返信）
    unreplied.push({
      threadId: thread.getId(),
      subject: thread.getFirstMessageSubject(),
      from: latest.getFrom(),
      date: latest.getDate().toISOString(),
      snippet: latest.getPlainBody().substring(0, 2000),
    });
  }

  if (unreplied.length === 0) {
    saveItems([]);
    return;
  }

  // --- 0段目: バックエンドの学習データでスキップ ---
  const skipList = getSkipList();
  const skipSet = new Set(skipList.map(e => e.toLowerCase()));
  const afterSkip = unreplied.filter(m => !skipSet.has(extractEmailAddress(m.from).toLowerCase()));

  if (afterSkip.length === 0) {
    saveItems([]);
    return;
  }

  // --- 1段目: Haikuでタイトル一括フィルタ ---
  const titles = afterSkip.map((m, i) => `${i}: ${m.subject}（${m.from}）`).join("\n");
  const filterPrompt = `メルマガや自動通知など明らかに返信不要なものの番号をJSON配列で返して。迷ったら残して。

${titles}`;

  const filterResult = callHaiku(filterPrompt);
  const excludeIndices = parseJsonArray(filterResult);

  const remaining = afterSkip.filter((_, i) => !excludeIndices.includes(i));

  if (remaining.length === 0) {
    saveItems([]);
    return;
  }

  // --- 2段目: Haikuで要対応判定 ---
  const details = remaining.map((m, i) =>
    `${i}: [${m.subject}] from: ${m.from}\n${m.snippet}`
  ).join("\n---\n");

  const judgePrompt = `返信が必要なものの番号をJSON配列で返して。

${details}`;

  const judgeResult = callHaiku(judgePrompt);
  const actionIndices = parseJsonArray(judgeResult);

  const actionItems = actionIndices
    .filter(i => i >= 0 && i < remaining.length)
    .map(i => ({
      threadId: remaining[i].threadId,
      subject: remaining[i].subject,
      from: remaining[i].from,
      date: remaining[i].date,
      snippet: remaining[i].snippet,
    }));

  // --- 3段目: AI要約（1行サマリー生成） ---
  if (actionItems.length > 0) {
    const summaryInput = actionItems.map((m, i) =>
      `${i}: [${m.subject}] from: ${m.from}\n${m.snippet.substring(0, 500)}`
    ).join("\n---\n");

    const summaryPrompt = `各メールの要点を1行（30文字以内）で要約して。相手が何を求めているかを書いて。
JSON配列で返して。例: ["見積もりへの回答を求めている", "日程候補への返答待ち"]

${summaryInput}`;

    const summaryResult = callHaiku(summaryPrompt);
    const summaries = parseJsonArray(summaryResult);

    for (let i = 0; i < actionItems.length; i++) {
      actionItems[i].summary = summaries[i] || "";
    }
  }

  // 既存データとマージ（古いのも残す）
  const existing = getStoredItems();
  const existingIds = new Set(existing.map(e => e.threadId));
  const merged = [
    ...existing,
    ...actionItems.filter(a => !existingIds.has(a.threadId)),
  ];

  saveItems(merged);
}

// ============================================
// 返信チェック（数時間おきトリガー）
// ============================================
function checkReplies() {
  const items = getStoredItems();
  if (items.length === 0) return;

  const stillNeeded = [];
  const needsJudgment = [];

  for (const item of items) {
    try {
      const thread = GmailApp.getThreadById(item.threadId);
      if (!thread) continue;

      const messages = thread.getMessages();
      const latest = messages[messages.length - 1];
      const latestIsFromMe = latest.getFrom().includes(MY_EMAIL);

      if (latestIsFromMe) {
        // 自分が最後に返信 → 対応済み、消す
        continue;
      }

      // 最新が相手から → まだ対応必要 or 再返信が来た
      const latestDate = latest.getDate().toISOString();
      if (latestDate !== item.date) {
        // 新しいメッセージがある → Haikuで判定が必要
        needsJudgment.push({
          ...item,
          date: latestDate,
          snippet: latest.getPlainBody().substring(0, 2000),
          from: latest.getFrom(),
        });
      } else {
        stillNeeded.push(item);
      }
    } catch (e) {
      // スレッドが見つからない場合はスキップ
    }
  }

  // 新着メッセージをHaikuで一括判定
  if (needsJudgment.length > 0) {
    const details = needsJudgment.map((m, i) =>
      `${i}: [${m.subject}] from: ${m.from}\n${m.snippet}`
    ).join("\n---\n");

    const prompt = `返信が必要なものの番号をJSON配列で返して。

${details}`;

    const result = callHaiku(prompt);
    const actionIndices = parseJsonArray(result);

    for (const i of actionIndices) {
      if (i >= 0 && i < needsJudgment.length) {
        stillNeeded.push(needsJudgment[i]);
      }
    }
  }

  saveItems(stillNeeded);
}

// ============================================
// 重複・不整合の掃除（週1トリガー）
// ============================================
function cleanup() {
  const items = getStoredItems();
  // threadIdで重複排除（新しい方を残す）
  const seen = new Map();
  for (const item of items) {
    if (!seen.has(item.threadId) || new Date(item.date) > new Date(seen.get(item.threadId).date)) {
      seen.set(item.threadId, item);
    }
  }
  saveItems([...seen.values()]);
}

// ============================================
// Haiku API呼び出し
// ============================================
function callHaiku(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  const response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    payload: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
    muteHttpExceptions: true,
  });

  const data = JSON.parse(response.getContentText());
  return data.content[0].text;
}

// ============================================
// バックエンド連携
// ============================================

function getSkipList() {
  const backendUrl = PropertiesService.getScriptProperties().getProperty("BACKEND_URL");
  const userId = PropertiesService.getScriptProperties().getProperty("BACKEND_USER_ID");
  if (!backendUrl || !userId) return [];

  try {
    const response = UrlFetchApp.fetch(`${backendUrl}/skip-list?userId=${userId}`, {
      muteHttpExceptions: true,
    });
    const data = JSON.parse(response.getContentText());
    return data.skipEmails || [];
  } catch (e) {
    console.log("スキップリスト取得失敗（バックエンド未接続）:", e);
    return [];
  }
}

function extractEmailAddress(from) {
  const match = from.match(/<(.+?)>/);
  return match ? match[1] : from;
}

// ============================================
// ユーティリティ
// ============================================
function getStoredItems() {
  const raw = PropertiesService.getScriptProperties().getProperty("email_items");
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveItems(items) {
  PropertiesService.getScriptProperties().setProperty("email_items", JSON.stringify(items));
}

function parseJsonArray(text) {
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]);
  } catch {
    return [];
  }
}

function formatDateForSearch(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy/MM/dd");
}

// ============================================
// 初期セットアップ用
// ============================================
function setupTriggers() {
  // 既存トリガー削除
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // 毎朝7時にスキャン
  ScriptApp.newTrigger("scanEmails")
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();

  // 3時間おきに返信チェック
  ScriptApp.newTrigger("checkReplies")
    .timeBased()
    .everyHours(3)
    .create();

  // 毎週月曜に重複掃除
  ScriptApp.newTrigger("cleanup")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(6)
    .create();
}
