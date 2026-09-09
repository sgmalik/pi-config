import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event: any, ctx: any) => {
    console.log("[ROUTER DEBUG] session_start fired");
    console.log("[ROUTER DEBUG]   event.reason:", event?.reason);
    console.log("[ROUTER DEBUG]   event keys:", Object.keys(event || {}));
    console.log("[ROUTER DEBUG]   ctx.model?.id:", ctx.model?.id?.slice?.(0, 60));
    console.log("[ROUTER DEBUG]   ctx.model?.name:", ctx.model?.name);
  });
}
