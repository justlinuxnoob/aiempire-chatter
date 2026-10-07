// Secrets, set in Cloudflare → Workers → aiempire-chatter → Settings → Variables and Secrets.
// Bindings (DB, FAN_CHAT) come from wrangler.jsonc via `npm run types`.
declare global {
  interface Env {
    TELEGRAM_BOT_TOKEN: string;
    RUNPOD_API_KEY: string;
    // Optional: lets test scripts start simulations (POST /admin/...).
    ADMIN_KEY?: string;
    // Only set by the local tests, to point at fake Telegram / RunPod servers.
    TELEGRAM_API?: string;
    RUNPOD_API?: string;
  }
}

export {};
