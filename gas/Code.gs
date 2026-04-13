// ============================================
// 未対応メールチェッカー - GAS Backend
// ============================================
// 設定: スクリプトプロパティに以下を設定
//   ANTHROPIC_API_KEY: Anthropic APIキー
//   BACKEND_URL: バックエンドのURL（例: https://xxx.com/api）
//   BACKEND_USER_ID: バックエンドのユーザーID
//   ALLOWED_ORIGINS: フロント側のURL（CORS用）

const MODEL = "claude-sonnet-4-6";
const SCAN_HOURS = 24;
const MAX_BODY_CHARS = 10000;
const BATCH_SIZE = 10;
const MY_EMAIL = PropertiesService.getScriptProperties().getProperty("MY_EMAIL") || Session.getActiveUser().getEmail();

// ============================================
// Web API（フロント用）
// ============================================
function checkToken(e) {
  const token = PropertiesService.getScriptProperties().getProperty("API_TOKEN");
  if (!token) return true;
  const given = (e && e.parameter && e.parameter.token) || "";
  return given === token;
}

function unauthorized() {
  return ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  if (!checkToken(e)) return unauthorized();

  // 設定保存
  if (e && e.parameter && e.parameter.action === "saveSettings") {
    if (e.parameter.watchEmails !== undefined) {
      PropertiesService.getScriptProperties().setProperty("WATCH_EMAILS", e.parameter.watchEmails);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 設定取得
  if (e && e.parameter && e.parameter.action === "settings") {
    const settings = {
      watchEmails: PropertiesService.getScriptProperties().getProperty("WATCH_EMAILS") || "",
      scanHours: SCAN_HOURS,
    };
    return ContentService.createTextOutput(JSON.stringify(settings))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 学習: 不要な送信者を登録
  if (e && e.parameter && e.parameter.action === "learn") {
    const senderEmail = e.parameter.senderEmail || "";
    if (senderEmail) {
      const learned = getLearnedPatterns();
      const existing = learned.find(p => p.senderEmail === senderEmail);
      if (existing) {
        existing.hitCount++;
      } else {
        learned.push({ senderEmail, result: "返信不要", hitCount: 1 });
      }
      saveLearnedPatterns(learned);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 学習状況取得
  if (e && e.parameter && e.parameter.action === "learningStats") {
    const learned = getLearnedPatterns();
    const confirmed = learned.filter(p => p.hitCount >= 3);
    const stats = {
      learnedPatterns: {
        total: learned.length,
        confirmed: confirmed.length,
        items: learned.sort((a, b) => b.hitCount - a.hitCount).slice(0, 20),
      },
      feedbackCount: learned.reduce((sum, p) => sum + p.hitCount, 0),
    };
    return ContentService.createTextOutput(JSON.stringify(stats))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // スレッド除外（済み・不要）
  if (e && e.parameter && e.parameter.action === "dismiss") {
    const threadId = e.parameter.threadId || "";
    const type = e.parameter.type || "pending"; // "pending" or "awaiting"
    if (threadId) {
      const key = type === "awaiting" ? "dismissed_awaiting" : "dismissed_threads";
      const ids = getDismissedIds(key);
      if (!ids.includes(threadId)) {
        ids.push(threadId);
        saveDismissedIds(key, ids);
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // アクセス時に返信済みチェック（リアルタイム性向上）
  quickReplyCheck();
  const pending = getStoredItems();
  const awaiting = getAwaitingItems();
  const dismissedPending = getDismissedIds("dismissed_threads");
  const dismissedAwaiting = getDismissedIds("dismissed_awaiting");
  const output = ContentService.createTextOutput(JSON.stringify({
    pending: pending.filter(i => !dismissedPending.includes(i.threadId)),
    awaiting: awaiting.filter(i => !dismissedAwaiting.includes(i.threadId)),
  }))
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
      const isReplied = MY_EMAIL ? latest.getFrom().includes(MY_EMAIL) : false;
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

function doPost(e) {
  if (!checkToken(e)) return unauthorized();
  const body = JSON.parse(e.postData.contents);

  if (body.action === "saveSettings") {
    if (body.watchEmails !== undefined) {
      PropertiesService.getScriptProperties().setProperty("WATCH_EMAILS", body.watchEmails);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ error: "unknown action" }))
    .setMimeType(ContentService.MimeType.JSON);
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
  // スクリプトプロパティ WATCH_EMAILS に監視アドレスをカンマ区切りで設定（例: ikeda@souzou-office.jp,info@souzou-office.jp）
  const watchEmails = (PropertiesService.getScriptProperties().getProperty("WATCH_EMAILS") || "").split(",").map(e => e.trim()).filter(Boolean);
  const toQuery = watchEmails.length > 0
    ? `{${watchEmails.map(e => `to:${e}`).join(" ")}}`
    : "";
  const query = `after:${formatDateForSearch(cutoff)} -from:me ${toQuery}`;
  console.log("検索クエリ: " + query);
  const threads = GmailApp.search(query, 0, 200);
  console.log("Gmail検索結果: " + threads.length + "件");

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
      snippet: latest.getPlainBody().substring(0, MAX_BODY_CHARS),
    });
  }

  console.log("未返信: " + unreplied.length + "件");
  if (unreplied.length === 0) {
    console.log("未返信0件のため終了（既存データは保持）");
    return;
  }

  // --- バックエンドの学習データでスキップ ---
  const skipList = getSkipList();
  const skipSet = new Set(skipList.map(e => e.toLowerCase()));
  const afterSkip = unreplied.filter(m => !skipSet.has(extractEmailAddress(m.from).toLowerCase()));

  if (afterSkip.length === 0) {
    return;
  }

  // --- 学習データでスキップ（3回以上「不要」にした送信者を自動除外） ---
  const learned = getLearnedPatterns();
  const learnedSkip = new Set(learned.filter(p => p.hitCount >= 3).map(p => p.senderEmail.toLowerCase()));
  const afterLearned = afterSkip.filter(m => !learnedSkip.has(extractEmailAddress(m.from).toLowerCase()));

  if (afterLearned.length === 0) {
    return;
  }

  // --- ルールベースで明らかに不要なものを除外 ---
  const SKIP_PATTERNS = [
    /noreply@/i, /no-reply@/i, /mailer-daemon@/i,
    /notification@/i, /notifications@/i, /alert@/i, /alerts@/i,
    /news@/i, /newsletter@/i, /info@/i, /support@/i,
    /do-not-reply@/i, /donotreply@/i,
  ];
  const SKIP_SUBJECTS = [
    /unsubscribe/i, /配信停止/i, /メルマガ/i, /ニュースレター/i,
  ];
  const filtered = afterLearned.filter(m => {
    const email = (m.from.match(/<(.+?)>/) || [])[1] || m.from;
    if (SKIP_PATTERNS.some(p => p.test(email))) return false;
    if (SKIP_SUBJECTS.some(p => p.test(m.subject))) return false;
    return true;
  });

  console.log(`スキャン結果: Gmail ${threads.length}件 → 未返信 ${unreplied.length}件 → スキップリスト後 ${afterSkip.length}件 → 学習除外後 ${afterLearned.length}件 → ルールフィルタ後 ${filtered.length}件 → AIに送信`);

  if (filtered.length === 0) {
    return;
  }

  // --- Claude Sonnetで判定+分析（バッチ処理） ---
  const actionItems = [];

  for (let start = 0; start < filtered.length; start += BATCH_SIZE) {
    const batch = filtered.slice(start, start + BATCH_SIZE);
    const mailList = batch.map((m, i) =>
      `=== メール ${i} ===\n件名: ${m.subject}\n差出人: ${m.from}\n本文:\n${m.snippet}`
    ).join("\n\n");

    const prompt = `あなたはメールの仕分けアシスタントです。
以下のメールを読んで、「自分が返信しないといけないもの」だけを選んでください。

【返信が必要】
- 質問されている（「いかがでしょうか？」「ご確認ください」「ご都合は？」など）
- 日程調整を求められている
- 承認・確認・判断を求められている
- 何かを依頼されている
- 見積もりや提案への回答を求められている

【返信不要（除外する）】
- メルマガ、ニュースレター、自動通知、広告
- noreply@やno-reply@からのメール
- 「よろしくお願いします」「ありがとうございます」「承知しました」「了解です」だけのメール
- 一方的な報告・共有で、返信を求めていないもの
- 挨拶やお礼だけで終わっているメール
- サービスからの通知（注文確認、発送通知、パスワードリセットなど）

厳しめに判定してください。本当に返信が必要なものだけ選んでください。
迷ったら除外してください。

返信が必要なメールについて、以下の形式のJSON配列で返してください。該当なしなら[]を返してください。
[{
  "index": メール番号,
  "summary": "要点を1行30文字以内",
  "action": "具体的にやるべきこと。不要ならnull",
  "deadline": "期限があれば記載。なければnull",
  "priority": 1〜5の数値,
  "mood": "calm/urgent/frustrated/formal/friendly"
}]

priorityの基準:
5=今すぐ対応（期限切れ・怒っている・緊急）
4=早めに対応（明確な質問・見積もり・期限あり）
3=普通（確認依頼・日程調整）
2=急がない（参考情報・軽い相談）
1=ほぼ不要（CC共有・FYI）

${mailList}`;

    const result = callClaude(prompt);
    const match = result.match(/\[[\s\S]*\]/);
    let judged = [];
    try { judged = JSON.parse(match[0]); } catch { judged = []; }

    for (const j of judged) {
      if (j.index >= 0 && j.index < batch.length) {
        actionItems.push({
          threadId: batch[j.index].threadId,
          subject: batch[j.index].subject,
          from: batch[j.index].from,
          date: batch[j.index].date,
          snippet: batch[j.index].snippet.substring(0, 500),
          summary: j.summary || "",
          action: j.action || null,
          deadline: j.deadline || null,
          priority: j.priority || 3,
          mood: j.mood || "calm",
        });
      }
    }
  }

  console.log(`AI判定結果: ${actionItems.length}件が返信必要`);

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
          snippet: latest.getPlainBody().substring(0, MAX_BODY_CHARS),
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

    const result = callClaude(prompt);
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

  // AI判定+要約を1回で
  if (awaiting.length === 0) {
    saveAwaitingItems([]);
    return;
  }

  const awaitingItems = [];
  for (let start = 0; start < awaiting.length; start += BATCH_SIZE) {
    const batch = awaiting.slice(start, start + BATCH_SIZE);
    const details = batch.map((m, i) =>
      `=== メール ${i} ===\n件名: ${m.subject}\n宛先: ${m.to}\n本文:\n${m.snippet}`
    ).join("\n\n");

    const prompt = `以下は自分が送ったメールです。相手からの返信を待っているものだけ選んでください。
情報共有や挨拶だけのメールは除外。質問・依頼・確認を含むものだけ残して。

返信待ちのメールについてJSON配列で返してください。該当なしなら[]。
[{"index": 番号, "summary": "相手に何を求めているか1行30文字以内"}]

${details}`;

    const result = callClaude(prompt);
    const match = result.match(/\[[\s\S]*\]/);
    let judged = [];
    try { judged = JSON.parse(match[0]); } catch { judged = []; }

    for (const j of judged) {
      if (j.index >= 0 && j.index < batch.length) {
        awaitingItems.push({
          threadId: batch[j.index].threadId,
          subject: batch[j.index].subject,
          to: batch[j.index].to,
          date: batch[j.index].date,
          snippet: batch[j.index].snippet,
          summary: j.summary || "",
          type: "awaiting_reply",
        });
      }
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
function callClaude(prompt) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  const response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    payload: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
    muteHttpExceptions: true,
  });

  const data = JSON.parse(response.getContentText());
  if (data.error) {
    console.log("Claude APIエラー: " + JSON.stringify(data.error));
    throw new Error("Claude API: " + data.error.message);
  }
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

function getLearnedPatterns() {
  const raw = PropertiesService.getScriptProperties().getProperty("learned_patterns");
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function saveLearnedPatterns(patterns) {
  PropertiesService.getScriptProperties().setProperty("learned_patterns", JSON.stringify(patterns.slice(-500)));
}

function getDismissedIds(key) {
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function saveDismissedIds(key, ids) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(ids.slice(-500)));
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

  // 毎朝7時に返信待ちスキャン（scanEmailsの後）
  ScriptApp.newTrigger("scanAwaitingReplies")
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();

  // 毎週月曜に重複掃除
  ScriptApp.newTrigger("cleanup")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(6)
    .create();
}

// ============================================
// リセット＆再スキャン
// ============================================
function resetAndScan() {
  saveItems([]);
  scanEmails();
}
