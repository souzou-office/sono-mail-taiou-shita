import type { GmailClient } from "../gmail/client.js";
import type { ParsedMessage, RuleMatch, ActionResult } from "./types.js";
import { aiGenerateDraft } from "../ai/classify-email.js";

/**
 * マッチしたルールのアクションを実行する（Inbox Zero の execute.ts に相当）
 */
export async function executeActions(
  gmail: GmailClient,
  message: ParsedMessage,
  match: RuleMatch,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const actions = match.rule.actions.sort((a, b) => a.order - b.order);

  for (const action of actions) {
    try {
      switch (action.type) {
        case "ARCHIVE":
          await gmail.archive(message.id);
          results.push({ type: action.type, success: true });
          break;

        case "LABEL":
          if (action.label) {
            await gmail.addLabel(message.id, action.label);
            results.push({ type: action.type, success: true });
          }
          break;

        case "MARK_READ":
          await gmail.markRead(message.id);
          results.push({ type: action.type, success: true });
          break;

        case "MARK_SPAM":
          await gmail.markSpam(message.id);
          results.push({ type: action.type, success: true });
          break;

        case "DRAFT_REPLY": {
          const draftBody = action.content
            ? await aiGenerateDraft(message, action.content)
            : "（返信ドラフト）";
          await gmail.createDraft(
            message.threadId,
            message.fromAddress,
            `Re: ${message.subject}`,
            draftBody,
          );
          results.push({ type: action.type, success: true });
          break;
        }

        case "REPLY": {
          const replyBody = action.content
            ? await aiGenerateDraft(message, action.content)
            : "";
          if (replyBody) {
            await gmail.sendReply(
              message.threadId,
              message.fromAddress,
              `Re: ${message.subject}`,
              replyBody,
            );
            results.push({ type: action.type, success: true });
          }
          break;
        }

        case "FORWARD":
          if (action.to) {
            await gmail.forward(message.id, action.to);
            results.push({ type: action.type, success: true });
          }
          break;

        case "CALL_WEBHOOK":
          if (action.webhookUrl) {
            await fetch(action.webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                messageId: message.id,
                threadId: message.threadId,
                from: message.from,
                subject: message.subject,
                snippet: message.snippet,
                rule: match.rule.name,
                matchType: match.matchType,
              }),
            });
            results.push({ type: action.type, success: true });
          }
          break;
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Action ${action.type} failed:`, errMsg);
      results.push({ type: action.type, success: false, error: errMsg });
    }
  }

  return results;
}
