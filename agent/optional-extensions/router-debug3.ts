import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event: any, ctx: any) => {
    const out = {
      eventType: event?.type,
      eventReason: event?.reason,
      eventKeys: Object.keys(event || {}),
      ctxModelId: ctx.model?.id?.slice?.(0, 80),
      ctxModelName: ctx.model?.name,
      sessionId: ctx.sessionId,
    };
    fs.appendFileSync("/tmp/router-debug.log", JSON.stringify(out) + "\n");
  });
}
