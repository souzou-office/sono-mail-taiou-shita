export const config = {
  port: parseInt(process.env.PORT || "3001"),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  aiModel: process.env.AI_MODEL || "claude-haiku-4-5-20251001",
  aiModelStrong: process.env.AI_MODEL_STRONG || "claude-sonnet-4-20250514",
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI || "http://localhost:3001/auth/google/callback",
  },
  scanHours: parseInt(process.env.SCAN_HOURS || "48"),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
};
