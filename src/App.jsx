import { useState, useEffect } from "react";

const GAS_URL = import.meta.env.VITE_GAS_URL || "";
const API_TOKEN = import.meta.env.VITE_API_TOKEN || "";
const API_URL = import.meta.env.VITE_API_URL || "";

function extractName(from) {
  const match = from.match(/^(.+?)\s*</);
  return match ? match[1].trim() : from.split("@")[0];
}

function extractEmail(from) {
  const match = from.match(/<(.+?)>/);
  return match ? match[1] : from;
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return "さっき";
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function urgencyLevel(dateStr, priority) {
  const hours = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
  // 優先度が高いと早めに至急になる
  if (priority >= 5 || hours > 48) return "urgent";
  if (priority >= 4 || hours > 24) return "warning";
  if (priority <= 1) return "low";
  return "normal";
}

const STATUS_CONFIG = {
  urgent: { label: "至急", bg: "#fde8e8", color: "#c53030", border: "#feb2b2" },
  warning: { label: "要注意", bg: "#fef6e7", color: "#c05621", border: "#fbd38d" },
  normal: { label: "未対応", bg: "#e8f4f8", color: "#2b6cb0", border: "#90cdf4" },
  low: { label: "低", bg: "#f5f5f4", color: "#888", border: "#e5e5e3" },
  replied: { label: "返信済", bg: "#f0fdf4", color: "#16a34a", border: "#bbf7d0" },
};

const MOOD_CONFIG = {
  urgent: { label: "急ぎ", color: "#c53030", bg: "#fde8e8" },
  frustrated: { label: "不満", color: "#9b2c2c", bg: "#fde8e8" },
  formal: { label: "丁寧", color: "#2b6cb0", bg: "#e8f4f8" },
  friendly: { label: "親しみ", color: "#16a34a", bg: "#f0fdf4" },
  calm: { label: "平常", color: "#888", bg: "#f5f5f4" },
};

const PRIORITY_LABELS = {
  5: { label: "最優先", bg: "#fde8e8", color: "#c53030" },
  4: { label: "高", bg: "#fef6e7", color: "#c05621" },
  3: { label: "中", bg: "#e8f4f8", color: "#2b6cb0" },
  2: { label: "低", bg: "#f0fdf4", color: "#16a34a" },
  1: { label: "低", bg: "#f5f5f4", color: "#888" },
};

export default function App() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [dismissed, setDismissed] = useState({});
  const [undoItem, setUndoItem] = useState(null);
  const [undoTimer, setUndoTimer] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [learningStats, setLearningStats] = useState(null);
  const [showStats, setShowStats] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [sortKey, setSortKey] = useState("priority");
  const [activeTab, setActiveTab] = useState("pending");
  const [awaitingItems, setAwaitingItems] = useState([]);

  function loadItems() {
    if (!GAS_URL) {
      setItems([
        { threadId: "1", messageId: "m1", subject: "設立の件で相談", summary: "定款3点の確認と打合せ日程の調整", action: "来週火曜か水曜で打合せ日程を返信", deadline: "来週中", priority: 3, mood: "friendly", replied: true, snippet: "田中です。お世話になっております。\n\n先日お話しした設立の件ですが、定款の内容について確認したい点がございます。\n\n具体的には以下の3点です。\n1. 事業目的の記載範囲\n2. 役員構成と任期\n3. 株式の譲渡制限について\n\n来週あたりでお時間いただけますでしょうか。\n火曜か水曜の午後が都合良いです。\n\nよろしくお願いいたします。", from: "田中太郎 <tanaka@example.com>", date: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString() },
        { threadId: "2", messageId: "m2", subject: "登記費用の見積依頼", summary: "見積もり32万円の確認を求めている", action: "見積書を確認して不明点があれば質問", deadline: "今月末", priority: 4, mood: "formal", snippet: "山田不動産の山田です。\n\nご依頼いただいた登記費用の見積書を添付いたします。\n\n【内訳】\n・登録免許税: 150,000円\n・司法書士報酬: 80,000円\n・定款認証費用: 52,000円\n・印紙代: 40,000円\n合計: 322,000円（税込）\n\nご確認の上、ご不明点がございましたらお知らせください。\n見積有効期限は今月末までとなります。", from: "山田不動産 <yamada@fudosan.co.jp>", date: new Date(Date.now() - 1000 * 60 * 60 * 8).toISOString() },
        { threadId: "3", messageId: "m3", subject: "口座開設書類の確認", summary: "必要書類の準備と来店予約の連絡待ち", action: "書類5点を準備して支店に予約連絡", deadline: null, priority: 3, mood: "calm", snippet: "〇〇銀行 法人営業部でございます。\n\n法人口座開設に必要な書類をご案内いたします。\n\n【必要書類】\n① 登記簿謄本（発行から3ヶ月以内）\n② 印鑑証明書（発行から3ヶ月以内）\n③ 代表者の本人確認書類（運転免許証等）\n④ 会社の実印\n⑤ 届出印（銀行届出用）\n\nご準備でき次第、最寄りの支店窓口までお越しください。\n事前にご予約いただけるとスムーズです。\n\n何かご不明な点がございましたらお気軽にお問い合わせください。", from: "〇〇銀行 法人営業部 <houjin@bank.co.jp>", date: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString() },
        { threadId: "4", messageId: "m4", subject: "定款認証の日程について", summary: "3候補から希望日時の返答を求めている", action: "4/3, 4/5, 4/8のいずれかで希望日を返信", deadline: "早めに", priority: 5, mood: "urgent", snippet: "公証役場の佐々木です。\n\n定款認証の予約日程について候補をお送りします。\n\n【候補日時】\n・4月3日（木）14:00〜\n・4月5日（土）10:00〜\n・4月8日（火）15:30〜\n\nいずれかでご都合はいかがでしょうか。\n所要時間は約30分〜1時間を見込んでおります。\n\n当日は以下をお持ちください。\n・定款3通\n・発起人全員の印鑑証明書\n・身分証明書\n\nご返信お待ちしております。", from: "公証役場 <koushou@example.jp>", date: new Date(Date.now() - 1000 * 60 * 60 * 52).toISOString() },
        { threadId: "5", messageId: "m5", subject: "契約書の修正点について", summary: "契約書3箇所の修正案への確認待ち", action: "第3条・第7条・第12条の修正案を確認して返信", deadline: null, priority: 4, mood: "formal", snippet: "佐藤法律事務所の佐藤です。\n\n契約書のドラフトを確認いたしました。\n以下の点について修正が必要と考えます。\n\n【修正箇所】\n■ 第3条（支払条件）\n現行: 「納品後30日以内」\n修正案: 「検収完了後30日以内」に変更を推奨します。\n\n■ 第7条（免責事項）\n天災等の不可抗力条項が不十分です。\n具体的な事由の列挙を追加すべきです。\n\n■ 第12条（契約解除）\n解除通知の方法について、書面に限定することを推奨します。\n\n修正案を別途お送りしますので、ご確認をお願いいたします。", from: "佐藤弁護士事務所 <sato@law.jp>", date: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString() },
      ]);
      setAwaitingItems([
        { threadId: "a1", subject: "請求書を送付しました", summary: "請求書の確認・処理を待っている", to: "経理部 <keiri@example.com>", date: new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString(), type: "awaiting_reply" },
        { threadId: "a2", subject: "ミーティング議事録の共有", summary: "議事録の内容確認を依頼した", to: "チームメンバー <team@example.com>", date: new Date(Date.now() - 1000 * 60 * 60 * 50).toISOString(), type: "awaiting_reply" },
        { threadId: "a3", subject: "見積もり依頼の件", summary: "見積もりの作成・送付を依頼した", to: "取引先 <vendor@example.com>", date: new Date(Date.now() - 1000 * 60 * 60 * 75).toISOString(), type: "awaiting_reply" },
      ]);
      return;
    }
    setRefreshing(true);
    fetch(`${GAS_URL}?token=${API_TOKEN}`)
      .then((r) => r.json())
      .then((data) => {
        const dismissedIds = loadDismissedIds();
        const pending = (data.pending || data).filter((it) => !dismissedIds.includes(it.threadId));
        setItems(pending);
        setAwaitingItems(data.awaiting || []);
        setError(null);
      })
      .catch(() => setError("取得できませんでした"))
      .finally(() => setRefreshing(false));
  }

  function loadLearningStats() {
    if (!API_URL) {
      setLearningStats({
        learnedPatterns: { total: 3, confirmed: 1, items: [
          { senderEmail: "noreply@github.com", result: "返信不要", hitCount: 5, confirmed: true },
          { senderEmail: "tanaka@example.com", result: "返信必要", hitCount: 2, confirmed: false },
          { senderEmail: "info@newsletter.jp", result: "返信不要", hitCount: 1, confirmed: false },
        ]},
        senderCategories: { total: 4, breakdown: { HUMAN: 2, NEWSLETTER: 1, NOTIFICATION: 1 } },
        feedbackCount: 7,
      });
      return;
    }
    fetch(`${API_URL}/learning-stats?userId=demo`)
      .then((r) => r.json())
      .then((data) => setLearningStats(data))
      .catch(() => {});
  }

  useEffect(() => { loadItems(); }, []);

  function handleReplied(item) {
    setItems((prev) => prev ? prev.filter((it) => it.threadId !== item.threadId) : prev);
  }

  function handleDismiss(item) {
    // 前のundoタイマーがあれば確定させる
    if (undoTimer) {
      clearTimeout(undoTimer);
      confirmDismiss();
    }

    setDismissed((prev) => ({ ...prev, [item.threadId]: true }));
    setUndoItem(item);

    // 5秒後に確定（API送信）
    const timer = setTimeout(() => {
      confirmDismiss(item);
    }, 5000);
    setUndoTimer(timer);
  }

  function saveDismissedIds(ids) {
    try { localStorage.setItem("dismissed_threads", JSON.stringify(ids)); } catch (e) {}
  }

  function loadDismissedIds() {
    try { return JSON.parse(localStorage.getItem("dismissed_threads") || "[]"); } catch (e) { return []; }
  }

  function confirmDismiss(item) {
    const target = item || undoItem;
    if (!target) return;

    if (API_URL) {
      fetch(`${API_URL}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "demo",
          messageId: target.messageId,
          threadId: target.threadId,
          senderEmail: extractEmail(target.from),
          needsReply: false,
        }),
      }).catch(() => {});
    }

    const ids = loadDismissedIds();
    if (!ids.includes(target.threadId)) { ids.push(target.threadId); saveDismissedIds(ids); }

    setItems((prev) => prev ? prev.filter((it) => it.threadId !== target.threadId) : prev);
    setDismissed((prev) => { const next = { ...prev }; delete next[target.threadId]; return next; });
    setUndoItem(null);
    setUndoTimer(null);
  }

  function handleUndo() {
    if (!undoItem) return;
    if (undoTimer) clearTimeout(undoTimer);
    const ids = loadDismissedIds().filter((id) => id !== undoItem.threadId);
    saveDismissedIds(ids);
    setDismissed((prev) => { const next = { ...prev }; delete next[undoItem.threadId]; return next; });
    setUndoItem(null);
    setUndoTimer(null);
  }

  const visibleItems = items?.filter((i) => !dismissed[i.threadId]) || [];
  const urgentCount = visibleItems.filter((i) => urgencyLevel(i.date, i.priority) === "urgent").length;
  const warningCount = visibleItems.filter((i) => urgencyLevel(i.date, i.priority) === "warning").length;

  // タブタイトルに件数バッジ
  useEffect(() => {
    const total = visibleItems.length + awaitingItems.length;
    document.title = total > 0 ? `(${total}) そのメール対応した？` : "そのメール対応した？";
  }, [visibleItems.length, awaitingItems.length]);

  // ソート（返信済みは常に下、至急→要注意→未対応→低の順）
  const urgencyOrder = { urgent: 0, warning: 1, normal: 2, low: 3, replied: 4 };
  const sortedItems = [...visibleItems].sort((a, b) => {
    if (a.replied !== b.replied) return a.replied ? 1 : -1;
    if (sortKey === "priority") {
      // まずステータス順（至急→要注意→未対応→低）
      const ua = urgencyOrder[urgencyLevel(a.date, a.priority)] || 2;
      const ub = urgencyOrder[urgencyLevel(b.date, b.priority)] || 2;
      if (ua !== ub) return ua - ub;
      // 同じステータスなら古い順（放置が長い方が上）
      return new Date(a.date) - new Date(b.date);
    }
    if (sortKey === "date") return new Date(b.date) - new Date(a.date);
    if (sortKey === "sender") return extractName(a.from).localeCompare(extractName(b.from));
    return 0;
  });

  return (
    <>
      <style>{`
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #f5f5f4; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .table-row { transition: background 0.15s, opacity 0.4s; }
        .table-row:hover { background: #f8f7ff; }
        .open-btn, .dismiss-btn { opacity: 0; transition: opacity 0.15s; }
        .table-row:hover .open-btn, .table-row:hover .dismiss-btn { opacity: 1; }
        .dismiss-btn:hover { background: #fee2e2 !important; color: #b91c1c !important; }
        .replied-btn:hover { background: #dcfce7 !important; color: #16a34a !important; }
        .undo-toast { animation: slideUp 0.2s ease; }
        .undo-btn:hover { background: #4338ca !important; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        @media (max-width: 768px) {
          .table-header { display: none !important; }
          .table-row .grid-row { display: flex !important; flex-wrap: wrap !important; gap: 4px 12px !important; padding: 10px 14px !important; }
          .table-row .grid-row > * { padding: 0 !important; }
          .table-row .grid-row .col-subject { width: 100% !important; margin-bottom: 2px; }
          .table-row .grid-row .col-status { order: 2; }
          .table-row .grid-row .col-sender { order: 3; }
          .table-row .grid-row .col-date { order: 4; }
          .table-row .grid-row .col-elapsed { order: 5; }
          .table-row .grid-row .col-btn { order: 6; }
          .sort-bar { flex-wrap: wrap !important; }
          .open-btn, .dismiss-btn { opacity: 1 !important; }
          .open-btn { display: inline-flex !important; padding: 6px 12px !important; font-size: 13px !important; background: #f3f0ff !important; border-radius: 6px !important; }
          .header-inner { flex-wrap: wrap !important; gap: 8px !important; padding: 6px 14px !important; }
          .header-inner img { height: 40px !important; }
          .header-inner { padding: 8px 14px !important; }
          .header-right { flex-wrap: wrap !important; }
          .undo-toast { left: 14px !important; right: 14px !important; transform: none !important; bottom: 16px !important; }
        }
      `}</style>

      {/* ===== 白ヘッダー ===== */}
      <header style={{
        background: "#fff",
        borderBottom: "1px solid #e5e5e3",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}>
        <div className="header-inner" style={{
          maxWidth: 1200,
          margin: "0 auto",
          padding: "4px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img
              src={`${import.meta.env.BASE_URL}logo.png`}
              alt="そのメール対応した？"
              style={{ height: 48 }}
              onError={(e) => { e.target.style.display = "none"; }}
            />
          </div>
          <div className="header-right" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            {urgentCount > 0 && (
              <span style={{ background: STATUS_CONFIG.urgent.bg, color: STATUS_CONFIG.urgent.color, padding: "2px 8px", borderRadius: 10, fontWeight: 600 }}>
                至急 {urgentCount}
              </span>
            )}
            {warningCount > 0 && (
              <span style={{ background: STATUS_CONFIG.warning.bg, color: STATUS_CONFIG.warning.color, padding: "2px 8px", borderRadius: 10, fontWeight: 600 }}>
                要注意 {warningCount}
              </span>
            )}
            <button
              onClick={() => { setShowStats(!showStats); if (!showStats && !learningStats) loadLearningStats(); }}
              className="stats-btn"
              style={{
                fontSize: 11, color: "#666", background: showStats ? "#f0f0ee" : "#fff", border: "1px solid #e5e5e3",
                borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontWeight: 500,
              }}
            >
              学習状況
            </button>
            <button
              onClick={loadItems}
              disabled={refreshing}
              className="refresh-btn"
              style={{
                fontSize: 11, color: "#666", background: "#fff", border: "1px solid #e5e5e3",
                borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontWeight: 500,
                opacity: refreshing ? 0.5 : 1,
              }}
            >
              {refreshing ? "更新中..." : "更新"}
            </button>
          </div>
        </div>
      </header>

      {/* ===== メインコンテンツ ===== */}
      <div style={{ padding: "24px 24px 80px", maxWidth: 1200, margin: "0 auto" }}>
        <div className="sort-bar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              onClick={() => setActiveTab("pending")}
              style={{
                fontSize: 16, fontWeight: activeTab === "pending" ? 700 : 500, padding: "6px 14px",
                border: "none", borderBottom: activeTab === "pending" ? "2px solid #7c5cfc" : "2px solid transparent",
                background: "none", cursor: "pointer", color: activeTab === "pending" ? "#1a1a1a" : "#999",
              }}
            >
              未対応 {items ? <span style={{ fontSize: 12, fontWeight: 600, color: activeTab === "pending" ? "#7c5cfc" : "#ccc" }}>{visibleItems.length}</span> : null}
            </button>
            <button
              onClick={() => setActiveTab("awaiting")}
              style={{
                fontSize: 16, fontWeight: activeTab === "awaiting" ? 700 : 500, padding: "6px 14px",
                border: "none", borderBottom: activeTab === "awaiting" ? "2px solid #7c5cfc" : "2px solid transparent",
                background: "none", cursor: "pointer", color: activeTab === "awaiting" ? "#1a1a1a" : "#999",
              }}
            >
              返信待ち {awaitingItems.length > 0 ? <span style={{ fontSize: 12, fontWeight: 600, color: activeTab === "awaiting" ? "#7c5cfc" : "#ccc" }}>{awaitingItems.length}</span> : null}
            </button>
          </div>
          <div style={{ display: "flex", gap: 4, fontSize: 11 }}>
            {[
              { key: "priority", label: "優先度順" },
              { key: "date", label: "新しい順" },
              { key: "sender", label: "送信者順" },
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSortKey(key)}
                style={{
                  padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontWeight: 500,
                  border: sortKey === key ? "1px solid #7c5cfc" : "1px solid #e5e5e3",
                  background: sortKey === key ? "#f3f0ff" : "#fff",
                  color: sortKey === key ? "#7c5cfc" : "#888",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ===== 学習状況パネル ===== */}
        {showStats && learningStats && (
          <div style={{
            background: "#fff", borderRadius: 8, border: "1px solid #e5e5e3",
            padding: 16, marginBottom: 16, animation: "fadeIn 0.2s ease",
          }}>
            <div style={{ display: "flex", gap: 24, marginBottom: 12, fontSize: 13 }}>
              <div>
                <span style={{ color: "#999" }}>学習パターン: </span>
                <span style={{ fontWeight: 600 }}>{learningStats.learnedPatterns.total}件</span>
                <span style={{ color: "#16a34a", marginLeft: 4 }}>({learningStats.learnedPatterns.confirmed}件確定)</span>
              </div>
              <div>
                <span style={{ color: "#999" }}>フィードバック数: </span>
                <span style={{ fontWeight: 600 }}>{learningStats.feedbackCount}回</span>
              </div>
              <div>
                <span style={{ color: "#999" }}>送信者分類: </span>
                <span style={{ fontWeight: 600 }}>{learningStats.senderCategories.total}件</span>
              </div>
            </div>

            {learningStats.learnedPatterns.items.length > 0 && (
              <div style={{ fontSize: 12, color: "#555" }}>
                <div style={{ fontWeight: 600, marginBottom: 6, color: "#888" }}>学習済み送信者</div>
                {learningStats.learnedPatterns.items.map((p, i) => (
                  <div key={i} style={{ display: "flex", gap: 12, padding: "3px 0", alignItems: "center" }}>
                    <span style={{ minWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.senderEmail}</span>
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 3,
                      background: p.result === "返信必要" ? "#e8f4f8" : "#f5f5f4",
                      color: p.result === "返信必要" ? "#2b6cb0" : "#888",
                    }}>
                      {p.result}
                    </span>
                    <span style={{ color: "#bbb" }}>{p.hitCount}回</span>
                    {p.confirmed && <span style={{ color: "#16a34a", fontSize: 10, fontWeight: 600 }}>確定</span>}
                  </div>
                ))}
              </div>
            )}

            {Object.keys(learningStats.senderCategories.breakdown).length > 0 && (
              <div style={{ fontSize: 12, color: "#555", marginTop: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6, color: "#888" }}>送信者カテゴリ内訳</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {Object.entries(learningStats.senderCategories.breakdown).map(([cat, count]) => (
                    <span key={cat} style={{ background: "#f5f5f4", padding: "2px 8px", borderRadius: 4, fontSize: 11 }}>
                      {cat}: {count}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== 未対応テーブル ===== */}
        {activeTab === "pending" && <div style={{
          background: "#fff",
          borderRadius: 8,
          border: "1px solid #e5e5e3",
          overflow: "hidden",
        }}>
          {/* ヘッダー */}
          <div className="table-header" style={{
            display: "grid",
            gridTemplateColumns: "minmax(200px, 2fr) 160px 200px minmax(100px, 1fr) 80px 60px 60px",
            borderBottom: "1px solid #e5e5e3",
            background: "#fafaf9",
            fontSize: 11,
            fontWeight: 600,
            color: "#888",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}>
            <div style={{ padding: "8px 16px" }}>件名</div>
            <div style={{ padding: "8px 12px" }}>ステータス</div>
            <div style={{ padding: "8px 12px" }}>送信者</div>
            <div style={{ padding: "8px 12px" }}>受信日時</div>
            <div style={{ padding: "8px 12px" }}>経過</div>
            <div style={{ padding: "8px 12px" }}></div>
            <div style={{ padding: "8px 12px" }}></div>
          </div>

          {items === null && !error && (
            <div style={{ padding: "48px 16px", textAlign: "center", color: "#bbb", fontSize: 13 }}>読み込み中...</div>
          )}

          {error && (
            <div style={{ padding: "48px 16px", textAlign: "center", color: "#c53030", fontSize: 13 }}>{error}</div>
          )}

          {items && visibleItems.length === 0 && (
            <div style={{ padding: "64px 16px", textAlign: "center", color: "#bbb" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>0</div>
              <div style={{ fontSize: 13 }}>全部対応済み!</div>
            </div>
          )}

          {sortedItems.map((item, i) => {
            const level = item.replied ? "replied" : urgencyLevel(item.date, item.priority);
            const status = STATUS_CONFIG[level];
            const isDismissing = dismissed[item.threadId];
            const isExpanded = expandedId === item.threadId;

            return (
              <div
                key={item.threadId}
                className="table-row"
                onMouseEnter={() => setHoveredId(item.threadId)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => setExpandedId(isExpanded ? null : item.threadId)}
                style={{
                  borderBottom: i < sortedItems.length - 1 ? "1px solid #f0f0ee" : "none",
                  animation: `fadeIn 0.2s ease ${i * 0.03}s both`,
                  opacity: isDismissing ? 0.3 : item.replied ? 0.65 : 1,
                  cursor: "pointer",
                }}
              >
              <div className="grid-row" style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(200px, 2fr) 160px 200px minmax(100px, 1fr) 80px 60px 60px",
              }}>
                {/* 件名 + AI要約 */}
                <div className="col-subject" style={{ padding: "10px 16px", display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
                  <a
                    className="open-btn"
                    href={`https://mail.google.com/mail/u/0/#inbox/${item.threadId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); window.open(`https://mail.google.com/mail/u/0/#inbox/${item.threadId}`, "_blank"); }}
                    onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); window.open(`https://mail.google.com/mail/u/0/#inbox/${item.threadId}`, "_blank"); }}
                    style={{ fontSize: 11, color: "#7c5cfc", whiteSpace: "nowrap", fontWeight: 500, textDecoration: "none", marginTop: 2 }}
                  >
                    Open
                  </a>
                  <div style={{ minWidth: 0, overflow: "hidden" }}>
                    <span style={{ fontSize: 13, color: "#1a1a1a", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                      {item.subject}
                    </span>
                    {item.summary && (
                      <span style={{ fontSize: 11, color: "#999", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                        {item.summary}
                      </span>
                    )}
                  </div>
                </div>

                {/* ステータス + 優先度 */}
                <div className="col-status" style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
                    background: status.bg, color: status.color, border: `1px solid ${status.border}`, whiteSpace: "nowrap",
                  }}>
                    {status.label}
                  </span>
                  {item.mood && MOOD_CONFIG[item.mood] && item.mood !== "calm" && (
                    <span style={{
                      fontSize: 10, fontWeight: 500, padding: "1px 5px", borderRadius: 3,
                      background: MOOD_CONFIG[item.mood].bg,
                      color: MOOD_CONFIG[item.mood].color,
                      whiteSpace: "nowrap",
                    }}>
                      {MOOD_CONFIG[item.mood].label}
                    </span>
                  )}
                </div>

                {/* 送信者 */}
                <div className="col-sender" style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: "50%",
                    background: `hsl(${item.from.charCodeAt(0) * 7 % 360}, 50%, 65%)`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, color: "#fff", fontWeight: 700, flexShrink: 0,
                  }}>
                    {extractName(item.from).charAt(0)}
                  </div>
                  <span style={{ fontSize: 12, color: "#555", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {extractName(item.from)}
                  </span>
                </div>

                {/* 受信日時 */}
                <div className="col-date" style={{ padding: "10px 12px", fontSize: 12, color: "#888", display: "flex", alignItems: "center" }}>
                  {formatDate(item.date)}
                </div>

                {/* 経過 */}
                <div className="col-elapsed" style={{ padding: "10px 12px", fontSize: 12, color: status.color, fontWeight: 600, display: "flex", alignItems: "center", fontVariantNumeric: "tabular-nums" }}>
                  {timeAgo(item.date)}
                </div>

                {/* 対応済みボタン */}
                <div className="col-btn" style={{ padding: "10px 8px", display: "flex", alignItems: "center" }}>
                  <button
                    className="dismiss-btn replied-btn"
                    onClick={(e) => { e.stopPropagation(); handleReplied(item); }}
                    title="返信済み（リストから消します）"
                    style={{
                      fontSize: 11, color: "#999", background: "#f5f5f4", border: "1px solid #e5e5e3",
                      borderRadius: 4, padding: "2px 6px", cursor: "pointer", whiteSpace: "nowrap",
                    }}
                  >
                    済み
                  </button>
                </div>

                {/* 対応不要ボタン */}
                <div className="col-btn" style={{ padding: "10px 8px", display: "flex", alignItems: "center" }}>
                  <button
                    className="dismiss-btn"
                    onClick={(e) => { e.stopPropagation(); handleDismiss(item); }}
                    title="返信不要（AIが学習します）"
                    style={{
                      fontSize: 11, color: "#999", background: "#f5f5f4", border: "1px solid #e5e5e3",
                      borderRadius: 4, padding: "2px 6px", cursor: "pointer", whiteSpace: "nowrap",
                    }}
                  >
                    不要
                  </button>
                </div>
              </div>

              {/* アクションアイテム + メール本文プレビュー */}
              {isExpanded && (
                <div style={{
                  borderTop: "1px solid #f0f0ee", marginTop: 2,
                  animation: "fadeIn 0.15s ease",
                }}>
                  {/* アクションアイテムカード */}
                  {item.action && (
                    <div style={{
                      margin: "10px 16px 0", padding: "8px 12px",
                      background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6,
                      fontSize: 12, display: "flex", gap: 8, alignItems: "flex-start",
                    }}>
                      <span style={{ fontWeight: 700, color: "#b45309", flexShrink: 0 }}>TODO</span>
                      <div>
                        <span style={{ color: "#92400e" }}>{item.action}</span>
                        {item.deadline && (
                          <span style={{ marginLeft: 8, fontSize: 11, color: "#c53030", fontWeight: 600 }}>
                            期限: {item.deadline}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 本文 */}
                  {item.snippet && (
                    <div style={{
                      padding: "10px 16px 12px", fontSize: 12, color: "#555",
                      lineHeight: 1.7, maxHeight: 300, overflowY: "auto",
                      whiteSpace: "pre-wrap", wordBreak: "break-word",
                    }}>
                      {item.snippet}
                    </div>
                  )}
                </div>
              )}
              </div>
            );
          })}

          {items && sortedItems.length > 0 && (
            <div style={{ padding: "8px 16px", fontSize: 12, color: "#bbb", borderTop: "1px solid #f0f0ee" }}>
              {visibleItems.length}件表示中
            </div>
          )}
        </div>}

        {/* ===== 返信待ちテーブル ===== */}
        {activeTab === "awaiting" && <div style={{
          background: "#fff",
          borderRadius: 8,
          border: "1px solid #e5e5e3",
          overflow: "hidden",
        }}>
          {/* ヘッダー */}
          <div className="table-header" style={{
            display: "grid",
            gridTemplateColumns: "minmax(200px, 2fr) 160px minmax(100px, 1fr) 80px",
            borderBottom: "1px solid #e5e5e3",
            background: "#fafaf9",
            fontSize: 11,
            fontWeight: 600,
            color: "#888",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}>
            <div style={{ padding: "8px 16px" }}>件名</div>
            <div style={{ padding: "8px 12px" }}>送信先</div>
            <div style={{ padding: "8px 12px" }}>送信日時</div>
            <div style={{ padding: "8px 12px" }}>経過</div>
          </div>

          {awaitingItems.length === 0 && (
            <div style={{ padding: "64px 16px", textAlign: "center", color: "#bbb" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>0</div>
              <div style={{ fontSize: 13 }}>返信待ちなし</div>
            </div>
          )}

          {awaitingItems.map((item, i) => {
            const level = urgencyLevel(item.date, item.priority);
            const status = STATUS_CONFIG[level];

            return (
              <div
                key={item.threadId}
                className="table-row"
                onClick={() => setExpandedId(expandedId === `aw_${item.threadId}` ? null : `aw_${item.threadId}`)}
                style={{
                  borderBottom: i < awaitingItems.length - 1 ? "1px solid #f0f0ee" : "none",
                  animation: `fadeIn 0.2s ease ${i * 0.03}s both`,
                  cursor: "pointer",
                }}
              >
                <div className="grid-row" style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(200px, 2fr) 160px minmax(100px, 1fr) 80px",
                }}>
                  {/* 件名 + AI要約 */}
                  <div className="col-subject" style={{ padding: "10px 16px", display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
                    <a
                      className="open-btn"
                      href={`https://mail.google.com/mail/u/0/#sent/${item.threadId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); window.open(`https://mail.google.com/mail/u/0/#sent/${item.threadId}`, "_blank"); }}
                      onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); window.open(`https://mail.google.com/mail/u/0/#sent/${item.threadId}`, "_blank"); }}
                      style={{ fontSize: 11, color: "#7c5cfc", whiteSpace: "nowrap", fontWeight: 500, textDecoration: "none", marginTop: 2 }}
                    >
                      Open
                    </a>
                    <div style={{ minWidth: 0, overflow: "hidden" }}>
                      <span style={{ fontSize: 13, color: "#1a1a1a", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                        {item.subject}
                      </span>
                      {item.summary && (
                        <span style={{ fontSize: 11, color: "#999", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
                          {item.summary}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 送信先 */}
                  <div className="col-sender" style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span style={{ fontSize: 12, color: "#555", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {item.to ? extractName(item.to) : ""}
                    </span>
                  </div>

                  {/* 送信日時 */}
                  <div className="col-date" style={{ padding: "10px 12px", fontSize: 12, color: "#888", display: "flex", alignItems: "center" }}>
                    {formatDate(item.date)}
                  </div>

                  {/* 経過 */}
                  <div className="col-elapsed" style={{ padding: "10px 12px", fontSize: 12, color: status.color, fontWeight: 600, display: "flex", alignItems: "center", fontVariantNumeric: "tabular-nums" }}>
                    {timeAgo(item.date)}
                  </div>
                </div>

                {/* プレビュー */}
                {expandedId === `aw_${item.threadId}` && (item.snippet || item.summary) && (
                  <div style={{
                    borderTop: "1px solid #f0f0ee", marginTop: 2,
                    animation: "fadeIn 0.15s ease",
                  }}>
                    <div style={{
                      padding: "10px 16px 12px", fontSize: 12, color: "#555",
                      lineHeight: 1.7, maxHeight: 300, overflowY: "auto",
                      whiteSpace: "pre-wrap", wordBreak: "break-word",
                    }}>
                      {item.snippet || item.summary}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {awaitingItems.length > 0 && (
            <div style={{ padding: "8px 16px", fontSize: 12, color: "#bbb", borderTop: "1px solid #f0f0ee" }}>
              {awaitingItems.length}件表示中
            </div>
          )}
        </div>}
      </div>

      {/* ===== Undoトースト ===== */}
      {undoItem && (
        <div className="undo-toast" style={{
          position: "fixed",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          background: "#1a1a1a",
          color: "#fff",
          borderRadius: 8,
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: 13,
          boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
          zIndex: 100,
        }}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            不要にしました
          </span>
          <button
            className="undo-btn"
            onClick={handleUndo}
            style={{
              background: "#5b21b6",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              padding: "4px 12px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            取り消す
          </button>
        </div>
      )}
    </>
  );
}
