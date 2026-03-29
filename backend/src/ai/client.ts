import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

export interface AiResponse {
  text: string;
}

/** 高速モデル（フィルタ、カテゴリ分類） */
export async function callFast(prompt: string, system?: string): Promise<string> {
  const res = await anthropic.messages.create({
    model: config.aiModel,
    max_tokens: 2048,
    system: system || undefined,
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content[0];
  return block.type === "text" ? block.text : "";
}

/** 強力モデル（ルール選択、返信ドラフト） */
export async function callStrong(prompt: string, system?: string): Promise<string> {
  const res = await anthropic.messages.create({
    model: config.aiModelStrong,
    max_tokens: 4096,
    system: system || undefined,
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content[0];
  return block.type === "text" ? block.text : "";
}

/** JSON応答をパース */
export function parseJsonResponse<T>(text: string): T | null {
  // ```json ... ``` ブロックまたは直接JSONを抽出
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    const arrayMatch = text.match(/(\[[\s\S]*?\])/);
    if (arrayMatch) {
      try { return JSON.parse(arrayMatch[1]); } catch { return null; }
    }
    return null;
  }
  try { return JSON.parse(jsonMatch[1]); } catch { return null; }
}
