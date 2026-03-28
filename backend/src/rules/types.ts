import type { ActionType, ConditionalOperator, MatchType } from "@prisma/client";

/** メールのパース済みデータ */
export interface ParsedMessage {
  id: string;
  threadId: string;
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  body: string;
  snippet: string;
  date: Date;
  headers: {
    listUnsubscribe?: string;
    replyTo?: string;
  };
  labelIds: string[];
}

/** ルール＋アクション */
export interface RuleWithActions {
  id: string;
  name: string;
  instructions: string | null;
  fromPattern: string | null;
  toPattern: string | null;
  subjectPattern: string | null;
  bodyPattern: string | null;
  conditionalOperator: ConditionalOperator;
  enabled: boolean;
  order: number;
  runOnThreads: boolean;
  actions: {
    id: string;
    type: ActionType;
    label: string | null;
    to: string | null;
    content: string | null;
    webhookUrl: string | null;
    order: number;
  }[];
}

/** マッチ結果 */
export interface RuleMatch {
  rule: RuleWithActions;
  matchType: MatchType;
  reason: string;
}

/** ルール実行結果 */
export interface RunRulesResult {
  matches: RuleMatch[];
  skippedReason?: string;
}

/** アクション実行結果 */
export interface ActionResult {
  type: ActionType;
  success: boolean;
  error?: string;
}
