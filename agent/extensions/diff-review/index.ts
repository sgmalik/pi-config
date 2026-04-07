import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { getDiffReviewFiles } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import type { ReviewSubmitPayload, ReviewWindowMessage } from "./types.js";
import { buildReviewHtml } from "./ui.js";

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

type WaitingEditorResult = "escape" | "window-settled";

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  /**
   * Show a blocking TUI overlay while the native review window is open.
   * The user can press Escape to cancel the review.
   */
  function showWaitingUI(ctx: ExtensionCommandContext, ref: string): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            `The native diff review window is open (comparing against ${ref}).`,
            "Press Escape to cancel and close the review window.",
          ];
          // truncateToWidth with pad=true already pads to target width — no extra .padEnd() needed
          return [
            borderTop,
            ...lines.map((line) =>
              `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true)}${theme.fg("border", "│")}`
            ),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  /**
   * Wait for the Glimpse window to send a message or close.
   * Shared by both interactive and headless code paths.
   */
  function waitForWindow(window: GlimpseWindow): Promise<ReviewWindowMessage | null> {
    return new Promise<ReviewWindowMessage | null>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        window.removeListener("message", onMessage);
        window.removeListener("closed", onClosed);
        window.removeListener("error", onError);
        if (activeWindow === window) {
          activeWindow = null;
        }
      };

      const settle = (value: ReviewWindowMessage | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const onMessage = (data: unknown): void => {
        settle(data as ReviewWindowMessage);
      };

      const onClosed = (): void => {
        settle(null);
      };

      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      window.on("message", onMessage);
      window.on("closed", onClosed);
      window.on("error", onError);
    });
  }

  /**
   * Handle the review result — either insert into the editor (interactive)
   * or write to stdout (headless / print mode).
   */
  function deliverResult(ctx: ExtensionCommandContext, prompt: string): void {
    if (ctx.hasUI) {
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted diff review feedback into the editor.", "info");
    } else {
      process.stdout.write(prompt + "\n");
    }
  }

  /**
   * Log a message — uses notify in interactive mode, stderr in headless.
   */
  function log(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
    } else {
      process.stderr.write(`${message}\n`);
    }
  }

  /**
   * Headless code path — no TUI overlay, waits for the Glimpse window directly,
   * writes the composed prompt to stdout.
   */
  async function reviewDiffHeadless(ctx: ExtensionCommandContext, reviewWindow: GlimpseWindow, files: import("./types.js").DiffReviewFile[]): Promise<void> {
    try {
      const message = await waitForWindow(reviewWindow);
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        log(ctx, "Diff review cancelled.");
        return;
      }

      if (!isSubmitPayload(message)) {
        log(ctx, "Diff review returned an unknown payload.", "error");
        return;
      }

      const prompt = composeReviewPrompt(files, message);

      if (prompt.trim().length === 0 || prompt === "Address the following code review feedback:") {
        log(ctx, "No feedback — review submitted with no comments.");
        return;
      }

      deliverResult(ctx, prompt);
    } catch (error) {
      closeActiveWindow();
      const msg = error instanceof Error ? error.message : String(error);
      log(ctx, `Diff review failed: ${msg}`, "error");
    }
  }

  /**
   * Interactive code path — shows TUI overlay, races Escape against the
   * Glimpse window, inserts the prompt into the editor.
   */
  async function reviewDiffInteractive(ctx: ExtensionCommandContext, ref: string, reviewWindow: GlimpseWindow, files: import("./types.js").DiffReviewFile[]): Promise<void> {
    const waitingUI = showWaitingUI(ctx, ref);

    try {
      const windowMessagePromise = waitForWindow(reviewWindow);

      const result = await Promise.race([
        windowMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await windowMessagePromise.catch(() => null);
        ctx.ui.notify("Diff review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await windowMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Diff review cancelled.", "info");
        return;
      }

      if (!isSubmitPayload(message)) {
        ctx.ui.notify("Diff review returned an unknown payload.", "error");
        return;
      }

      const prompt = composeReviewPrompt(files, message);

      if (prompt.trim().length === 0 || prompt === "Address the following code review feedback:") {
        ctx.ui.notify("No feedback to insert — review submitted with no comments.", "info");
        return;
      }

      deliverResult(ctx, prompt);
    } catch (error) {
      waitingUI.dismiss();
      await waitingUI.promise.catch(() => {});
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Diff review failed: ${message}`, "error");
    }
  }

  async function reviewDiff(ctx: ExtensionCommandContext, ref: string): Promise<void> {
    if (activeWindow != null) {
      log(ctx, "A diff review window is already open.", "warning");
      return;
    }

    const { repoRoot, files } = await getDiffReviewFiles(pi, ctx.cwd, ref);
    if (files.length === 0) {
      log(ctx, `No changes found against ${ref}.`);
      return;
    }

    const html = buildReviewHtml({ repoRoot, files });
    const reviewWindow = open(html, {
      width: 1680,
      height: 1020,
      title: `pi diff review (vs ${ref})`,
    });
    activeWindow = reviewWindow;

    log(ctx, `Reviewing ${files.length} file(s) against ${ref}.`);

    if (ctx.hasUI) {
      await reviewDiffInteractive(ctx, ref, reviewWindow, files);
    } else {
      await reviewDiffHeadless(ctx, reviewWindow, files);
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a native diff review window and insert review feedback into the editor",
    handler: async (args, ctx) => {
      // Optional argument: ref to diff against (default: HEAD)
      const ref = args.trim() || "HEAD";
      await reviewDiff(ctx, ref);
    },
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
