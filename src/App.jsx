import { useState, useEffect } from "react";

const GAS_URL = import.meta.env.VITE_GAS_URL || "";

function extractName(from) {
  const match = from.match(/^(.+?)\s*</);
  return match ? match[1].trim() : from.split("@")[0];
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return "さっき";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function urgencyLevel(dateStr) {
  const hours = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
  if (hours > 48) return "urgent";
  if (hours > 24) return "warning";
  return "normal";
}

const COLORS = {
  urgent: "#d44",
  warning: "#e90",
  normal: "#ccc",
};

export default function App() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!GAS_URL) {
      setItems([
        { threadId: "1", subject: "設立の件で相談", from: "田中太郎 <tanaka@example.com>", date: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString() },
        { threadId: "2", subject: "登記費用の見積依頼", from: "山田不動産 <yamada@fudosan.co.jp>", date: new Date(Date.now() - 1000 * 60 * 60 * 8).toISOString() },
        { threadId: "3", subject: "口座開設書類の確認", from: "〇〇銀行 法人営業部 <houjin@bank.co.jp>", date: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString() },
        { threadId: "4", subject: "定款認証の日程について", from: "公証役場 <koushou@example.jp>", date: new Date(Date.now() - 1000 * 60 * 60 * 52).toISOString() },
      ]);
      return;
    }
    fetch(GAS_URL)
      .then((r) => r.json())
      .then((data) => setItems(data))
      .catch(() => setError("取得できませんでした"));
  }, []);

  const urgentCount =
    items?.filter((i) => urgencyLevel(i.date) === "urgent").length || 0;

  return (
    <>
      <style>{`
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #f8f8f7; }
        .row:hover { background: #f0f0ee; }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>

      <div
        style={{
          minHeight: "100vh",
          background: "#f8f8f7",
          fontFamily: "'Helvetica Neue', -apple-system, sans-serif",
          padding: "48px 20px",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <div style={{ marginBottom: 32 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: "#999",
                letterSpacing: "0.06em",
                marginBottom: 4,
              }}
            >
              未対応
            </div>
            {items && items.length > 0 && (
              <div style={{ fontSize: 11, color: "#bbb" }}>
                {items.length}件
                {urgentCount > 0 && ` · ${urgentCount}件が48h超`}
              </div>
            )}
          </div>

          {error && <div style={{ color: "#c44", fontSize: 13 }}>{error}</div>}

          {items === null && !error && (
            <div style={{ color: "#bbb", fontSize: 13 }}>...</div>
          )}

          {items && items.length === 0 && (
            <div
              style={{
                textAlign: "center",
                padding: "80px 0",
                color: "#ccc",
                fontSize: 13,
              }}
            >
              なし
            </div>
          )}

          {items &&
            items.length > 0 &&
            items.map((item, i) => {
              const level = urgencyLevel(item.date);
              return (
                <a
                  key={item.threadId}
                  className="row"
                  href={`https://mail.google.com/mail/u/0/#inbox/${item.threadId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 12,
                    padding: "14px 0",
                    borderTop: i === 0 ? "1px solid #e8e8e6" : "none",
                    borderBottom: "1px solid #e8e8e6",
                    textDecoration: "none",
                    color: "inherit",
                    animation: `fadeIn 0.25s ease ${i * 0.04}s both`,
                  }}
                >
                  <div
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: COLORS[level],
                      flexShrink: 0,
                      marginTop: 6,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        color: "#333",
                        fontWeight: 400,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {item.subject}
                    </div>
                    <div style={{ fontSize: 12, color: "#aaa", marginTop: 2 }}>
                      {extractName(item.from)}
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: COLORS[level],
                      flexShrink: 0,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {timeAgo(item.date)}
                  </div>
                </a>
              );
            })}
        </div>
      </div>
    </>
  );
}
