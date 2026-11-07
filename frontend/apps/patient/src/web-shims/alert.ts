// Web only. react-native-web's Alert does nothing, which would silently skip every confirmation. This uses the browser's own dialog.
type AlertButton = { text?: string; style?: string; onPress?: () => void };
// The shared screens were written for phones. Where their wording would be untrue in a browser, say the browser-accurate thing.
const browserWording: [string, string][] = [
  ["view or export this file using the device share sheet", "download this file through your browser"],
];
export default class Alert {
  static alert(title?: string, message?: string, buttons?: AlertButton[]): void {
    let said = message;
    for (const [phone, browser] of browserWording) said = said?.replace(phone, browser);
    const text = [title, said].filter(Boolean).join("\n\n");
    const actions = buttons ?? [];
    const confirm = actions.find((b) => b.style !== "cancel" && b.onPress);
    if (actions.length < 2 || !confirm) { window.alert(text); actions[0]?.onPress?.(); return; }
    if (window.confirm(text)) confirm.onPress?.();
    else actions.find((b) => b.style === "cancel")?.onPress?.();
  }
}
