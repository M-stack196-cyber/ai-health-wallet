// Web only. Wraps the unchanged app with a plain, always-visible statement of what a browser cannot do.
import React from "react";
import { View, Text } from "react-native";
import App from "../App";
import { palette } from "./ui";

export const WEB_NOTICE =
  "Web preview (local development only, not a release or device build). " +
  "Screen-capture protection is NOT available in a browser. " +
  "Your sign-in is kept in memory only, so reloading this page signs you out. " +
  "Downloaded originals are saved by your browser, outside this app's control. " +
  "Native sharing may be unavailable here; use Copy link.";

export default function WebApp() {
  return (
    <View style={{ flex: 1 }}>
      <View
        accessibilityRole="alert"
        style={{ backgroundColor: "#fff3cd", borderBottomWidth: 1, borderBottomColor: palette.line, padding: 10 }}
      >
        <Text style={{ color: "#5c4400", fontSize: 13 }}>{WEB_NOTICE}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <App />
      </View>
    </View>
  );
}
