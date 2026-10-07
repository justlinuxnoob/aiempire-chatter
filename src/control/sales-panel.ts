// /sales in the control bot: prices and limits for selling.

import { getSettings, setSetting, type Member } from "../db";
import { esc, send, type Button } from "../telegram";
import { SALES_FIELDS } from "./fields";
import { approvalsOn } from "../photos/generate";

export async function showSales(env: Env, owner: Member): Promise<void> {
  const settings = await getSettings(env, owner.id);
  const lines = SALES_FIELDS.map((f) => {
    const value = settings[f.key] ?? f.default;
    const shown = f.unit === "$" ? `$${value}` : f.unit === "%" ? `${value}%` : value;
    return `<b>${esc(f.label)}:</b> ${esc(shown)}${settings[f.key] ? "" : " <i>(default)</i>"}`;
  });
  lines.push(`<b>Approve new photos before sending:</b> ${approvalsOn(settings) ? "yes" : "no"}`);
  const buttons: Button[][] = [];
  for (let i = 0; i < SALES_FIELDS.length; i += 2) {
    buttons.push(SALES_FIELDS.slice(i, i + 2).map((f) => ({ text: `✏️ ${f.label}`, callback_data: `edit:${f.key}` })));
  }
  buttons.push([{ text: approvalsOn(settings) ? "Stop asking me to approve photos" : "Ask me to approve photos", callback_data: "sales:approval" }]);
  await send(
    env,
    owner.telegram_chat_id,
    `💰 <b>Sales settings</b>\n\n${lines.join("\n")}\n\nVault photo prices are set per photo in /catalog.`,
    buttons,
  );
}

export async function onSalesButton(env: Env, owner: Member, action: string): Promise<void> {
  if (action === "approval") {
    const settings = await getSettings(env, owner.id);
    await setSetting(env, owner.id, "photo_approval", approvalsOn(settings) ? "off" : "on");
  }
  await showSales(env, owner);
}
