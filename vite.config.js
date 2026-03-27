import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/sono-mail-taiou-shita/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "そのメール対応した？",
        short_name: "対応した？",
        description: "未対応メールチェッカー",
        theme_color: "#f8f8f7",
        background_color: "#f8f8f7",
        display: "standalone",
        start_url: "/sono-mail-taiou-shita/",
        icons: [
          {
            src: "icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
    }),
  ],
});
