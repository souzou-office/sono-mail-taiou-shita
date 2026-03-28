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
  const pending = getStoredItems();
  const awaiting = getAwaitingItems();
  const output = ContentService.createTextOutput(JSON.stringify({ pending, awaiting }))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}

// 軽量な返信済みチェック（消さずに replied フラグを立てる）
function quickReplyCheck() {
  const items = getStoredItems();
  if (items.length === 0) return;

  let changed = false;
  for (const item of items) {
    try {
      const thread = GmailApp.getThreadById(item.threadId);
      if (!thread) continue;
      const messages = thread.getMessages();
      const latest = messages[messages.length - 1];
      const wasReplied = item.replied || false;
      const isReplied = latest.getFrom().includes(MY_EMAIL);
      if (isReplied !== wasReplied) {
        item.replied = isReplied;
        changed = true;
      }
    } catch (e) {
      // エラー時はそのまま
    }
  }

  if (changed) {
    saveItems(items);
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

  // --- 3段目: AI要約 + 優先度スコアリング ---
  if (actionItems.length > 0) {
    const summaryInput = actionItems.map((m, i) =>
      `${i}: [${m.subject}] from: ${m.from}\n${m.snippet.substring(0, 500)}`
    ).join("\n---\n");

    const summaryPrompt = `各メールについて以下をJSON配列で返して。
各要素は {"summary": "要点を1行30文字以内", "priority": 1〜5} の形式。
priorityの基準:
5=今すぐ対応（期限切れ・緊急の依頼）
4=早めに対応（明確な質問・見積もり依頼）
3=普通（確認依頼・日程調整）
2=急がない（参考情報の共有・軽い相談）
1=ほぼ不要（CC共有・FYI）

${summaryInput}`;

    const summaryResult = callHaiku(summaryPrompt);
    const parsed = parseJsonArrayOfObjects(summaryResult);

    for (let i = 0; i < actionItems.length; i++) {
      if (parsed[i]) {
        actionItems[i].summary = parsed[i].summary || "";
        actionItems[i].priority = parsed[i].priority || 3;
      }
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
// 返信待ちスキャン（自分→相手で返事なし）
// ============================================
function scanAwaitingReplies() {
  const cutoff = new Date(Date.now() - SCAN_HOURS * 60 * 60 * 1000);
  const query = `after:${formatDateForSearch(cutoff)} from:me`;
  const threads = GmailApp.search(query, 0, 100);

  const awaiting = [];
  for (const thread of threads) {
    const messages = thread.getMessages();
    const latest = messages[messages.length - 1];
    const latestIsFromMe = latest.getFrom().includes(MY_EMAIL);

    // 最新が自分 → 相手からまだ返信なし
    if (!latestIsFromMe) continue;

    // 1通だけのスレッド（自分から送っただけ）もチェック
    // ただし、noreply系は除外
    const recipients = latest.getTo() + " " + (latest.getCc() || "");
    if (/noreply|no-reply|mailer-daemon/i.test(recipients)) continue;

    const sentDate = latest.getDate();
    const hoursAgo = (Date.now() - sentDate.getTime()) / (1000 * 60 * 60);
    // 送ってから6時間以内はまだ待つ
    if (hoursAgo < 6) continue;

    awaiting.push({
      threadId: thread.getId(),
      subject: thread.getFirstMessageSubject(),
      to: recipients.split(",")[0].trim(),
      date: sentDate.toISOString(),
      snippet: latest.getPlainBody().substring(0, 500),
    });
  }

  // AI判定: 返信を期待しているメールだけ残す
  if (awaiting.length === 0) {
    saveAwaitingItems([]);
    return;
  }

  const details = awaiting.map((m, i) =>
    `${i}: [${m.subject}] to: ${m.to}\n${m.snippet}`
  ).join("\n---\n");

  const prompt = `以下は自分が送ったメールです。相手からの返信を待っているものの番号をJSON配列で返して。
情報共有や挨拶だけのメールは除外して。質問・依頼・確認を含むものだけ残して。

${details}`;

  const result = callHaiku(prompt);
  const indices = parseJsonArray(result);

  const awaitingItems = indices
    .filter(i => i >= 0 && i < awaiting.length)
    .map(i => ({
      threadId: awaiting[i].threadId,
      subject: awaiting[i].subject,
      to: awaiting[i].to,
      date: awaiting[i].date,
      type: "awaiting_reply",
    }));

  // AI要約
  if (awaitingItems.length > 0) {
    const summaryInput = awaitingItems.map((m, i) => {
      const orig = awaiting.find(a => a.threadId === m.threadId);
      return `${i}: [${m.subject}] to: ${m.to}\n${orig ? orig.snippet : ""}`;
    }).join("\n---\n");

    const summaryPrompt = `各メールで相手に何を求めているか1行（30文字以内）で要約して。JSON配列で返して。
例: ["見積書の送付を依頼した", "契約書の確認を求めた"]

${summaryInput}`;

    const summaryResult = callHaiku(summaryPrompt);
    const summaries = parseJsonArray(summaryResult);
    for (let i = 0; i < awaitingItems.length; i++) {
      awaitingItems[i].summary = summaries[i] || "";
    }
  }

  // 既存とマージ
  const existing = getAwaitingItems();
  const existingIds = new Set(existing.map(e => e.threadId));
  const merged = [
    ...existing.filter(e => {
      // 返信が来たものは消す
      try {
        const thread = GmailApp.getThreadById(e.threadId);
        if (!thread) return false;
        const messages = thread.getMessages();
        const latest = messages[messages.length - 1];
        return latest.getFrom().includes(MY_EMAIL); // まだ自分が最後 → 残す
      } catch (_) { return false; }
    }),
    ...awaitingItems.filter(a => !existingIds.has(a.threadId)),
  ];

  saveAwaitingItems(merged);
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

function getAwaitingItems() {
  const raw = PropertiesService.getScriptProperties().getProperty("awaiting_items");
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveAwaitingItems(items) {
  PropertiesService.getScriptProperties().setProperty("awaiting_items", JSON.stringify(items));
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

function parseJsonArrayOfObjects(text) {
  const match = text.match(/\[[\s\S]*\]/);
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

  // 3時間おきに返信チェック + 返信待ちスキャン
  ScriptApp.newTrigger("checkReplies")
    .timeBased()
    .everyHours(3)
    .create();

  ScriptApp.newTrigger("scanAwaitingReplies")
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
