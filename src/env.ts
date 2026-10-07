// Secrets, set in Cloudflare → Workers → aiempire-chatter → Settings → Variables and Secrets.
// Bindings (DB, FAN_CHAT) come from wrangler.jsonc via `npm run types`.
declare global {
  interface Env {
    TELEGRAM_BOT_TOKEN: string;
    RUNPOD_API_KEY: string;
    // From your Fanvue app (fanvue.com/developers/apps). Also the base of the token encryption key.
    FANVUE_CLIENT_ID: string;
    FANVUE_CLIENT_SECRET: string;
    // Optional: lets test scripts start simulations (POST /admin/...).
    ADMIN_KEY?: string;
    // Only set by the local tests, to point at fake Telegram / RunPod servers.
    TELEGRAM_API?: string;
    RUNPOD_API?: string;
    FANVUE_API?: string;
    FANVUE_AUTH?: string;
  }
}

export {};
