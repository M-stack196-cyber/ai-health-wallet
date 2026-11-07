// Web only. Uses the browser's share sheet when it exists; otherwise says so plainly instead of failing silently.
import { InputError } from "@health-wallet/api";
export default class Share {
  static async share(content: { message?: string; url?: string; title?: string }): Promise<{ action: string }> {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      await navigator.share({ text: content.message, url: content.url, title: content.title });
      return { action: "sharedAction" };
    }
    throw new InputError("Native sharing is not available in this browser. Use Copy link instead.");
  }
  static get sharedAction(): string { return "sharedAction"; }
  static get dismissedAction(): string { return "dismissedAction"; }
}
