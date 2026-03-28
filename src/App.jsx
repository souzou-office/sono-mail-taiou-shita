import { useState, useEffect } from "react";

const GAS_URL = import.meta.env.VITE_GAS_URL || "";
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

function urgencyLevel(dateStr) {
  const hours = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
  if (hours > 48) return "urgent";
  if (hours > 24) return "warning";
  return "normal";
}

const STATUS_CONFIG = {
  urgent: { label: "至急", bg: "#fde8e8", color: "#c53030", border: "#feb2b2" },
  warning: { label: "要注意", bg: "#fef6e7", color: "#c05621", border: "#fbd38d" },
  normal: { label: "未対応", bg: "#e8f4f8", color: "#2b6cb0", border: "#90cdf4" },
};

export default function App() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [dismissed, setDismissed] = useState({});

  useEffect(() => {
    if (!GAS_URL) {
      setItems([
        { threadId: "1", messageId: "m1", subject: "設立の件で相談", from: "田中太郎 <tanaka@example.com>", date: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString() },
        { threadId: "2", messageId: "m2", subject: "登記費用の見積依頼", from: "山田不動産 <yamada@fudosan.co.jp>", date: new Date(Date.now() - 1000 * 60 * 60 * 8).toISOString() },
        { threadId: "3", messageId: "m3", subject: "口座開設書類の確認", from: "〇〇銀行 法人営業部 <houjin@bank.co.jp>", date: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString() },
        { threadId: "4", messageId: "m4", subject: "定款認証の日程について", from: "公証役場 <koushou@example.jp>", date: new Date(Date.now() - 1000 * 60 * 60 * 52).toISOString() },
        { threadId: "5", messageId: "m5", subject: "契約書の修正点について", from: "佐藤弁護士事務所 <sato@law.jp>", date: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString() },
      ]);
      return;
    }
    fetch(GAS_URL)
      .then((r) => r.json())
      .then((data) => setItems(data.pending || data))
      .catch(() => setError("取得できませんでした"));
  }, []);

  function handleDismiss(item) {
    setDismissed((prev) => ({ ...prev, [item.threadId]: true }));

    if (API_URL) {
      fetch(`${API_URL}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "demo",
          messageId: item.messageId,
          threadId: item.threadId,
          senderEmail: extractEmail(item.from),
          needsReply: false,
        }),
      }).catch(() => {});
    }

    // 500ms後にリストから消す
    setTimeout(() => {
      setItems((prev) => prev.filter((it) => it.threadId !== item.threadId));
      setDismissed((prev) => { const next = { ...prev }; delete next[item.threadId]; return next; });
    }, 500);
  }

  const visibleItems = items?.filter((i) => !dismissed[i.threadId]) || [];
  const urgentCount = visibleItems.filter((i) => urgencyLevel(i.date) === "urgent").length;
  const warningCount = visibleItems.filter((i) => urgencyLevel(i.date) === "warning").length;

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
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {/* ===== 白ヘッダー ===== */}
      <header style={{
        background: "#fff",
        borderBottom: "1px solid #e5e5e3",
        padding: "12px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt="そのメール対応した？"
            style={{ height: 36 }}
            onError={(e) => { e.target.style.display = "none"; }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
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
        </div>
      </header>

      {/* ===== メインコンテンツ ===== */}
      <div style={{ padding: "24px 24px 80px", maxWidth: 1000, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a1a" }}>未対応メール</h2>
          {items && (
            <span style={{ fontSize: 13, color: "#999" }}>{visibleItems.length}件</span>
          )}
        </div>

        {/* ===== テーブル ===== */}
        <div style={{
          background: "#fff",
          borderRadius: 8,
          border: "1px solid #e5e5e3",
          overflow: "hidden",
        }}>
          {/* ヘッダー */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "minmax(200px, 2fr) 100px 160px minmax(100px, 1fr) 80px 60px",
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

          {visibleItems.map((item, i) => {
            const level = urgencyLevel(item.date);
            const status = STATUS_CONFIG[level];
            const isDismissing = dismissed[item.threadId];

            return (
              <div
                key={item.threadId}
                className="table-row"
                onMouseEnter={() => setHoveredId(item.threadId)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(200px, 2fr) 100px 160px minmax(100px, 1fr) 80px 60px",
                  borderBottom: i < visibleItems.length - 1 ? "1px solid #f0f0ee" : "none",
                  animation: `fadeIn 0.2s ease ${i * 0.03}s both`,
                  opacity: isDismissing ? 0.3 : 1,
                }}
              >
                {/* 件名 */}
                <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <a
                    className="open-btn"
                    href={`https://mail.google.com/mail/u/0/#inbox/${item.threadId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 11, color: "#7c5cfc", whiteSpace: "nowrap", fontWeight: 500, textDecoration: "none" }}
                  >
                    Open
                  </a>
                  <span style={{ fontSize: 13, color: "#1a1a1a", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {item.subject}
                  </span>
                </div>

                {/* ステータス */}
                <div style={{ padding: "10px 12px", display: "flex", alignItems: "center" }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
                    background: status.bg, color: status.color, border: `1px solid ${status.border}`, whiteSpace: "nowrap",
                  }}>
                    {status.label}
                  </span>
                </div>

                {/* 送信者 */}
                <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
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
                <div style={{ padding: "10px 12px", fontSize: 12, color: "#888", display: "flex", alignItems: "center" }}>
                  {formatDate(item.date)}
                </div>

                {/* 経過 */}
                <div style={{ padding: "10px 12px", fontSize: 12, color: status.color, fontWeight: 600, display: "flex", alignItems: "center", fontVariantNumeric: "tabular-nums" }}>
                  {timeAgo(item.date)}
                </div>

                {/* 対応不要ボタン */}
                <div style={{ padding: "10px 8px", display: "flex", alignItems: "center" }}>
                  <button
                    className="dismiss-btn"
                    onClick={() => handleDismiss(item)}
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
            );
          })}

          {items && visibleItems.length > 0 && (
            <div style={{ padding: "8px 16px", fontSize: 12, color: "#bbb", borderTop: "1px solid #f0f0ee" }}>
              {visibleItems.length}件表示中
            </div>
          )}
        </div>
      </div>
    </>
  );
}
