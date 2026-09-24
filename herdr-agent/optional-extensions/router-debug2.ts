import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event: any, ctx: any) => {
    console.log("[ROUTER DEBUG2] full event:", JSON.stringify(event, null, 2));
    console.log("[ROUTER DEBUG2] full ctx.model:", ctx.model);
  });
}
