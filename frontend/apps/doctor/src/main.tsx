import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
// Consume a QR/link fragment once and remove the secret from browser history.
const entry = location.hash.startsWith("#/share/") ? location.href : "";
history.replaceState(null, "", location.pathname);
createRoot(document.getElementById("root")!).render(
  <App initialEntry={entry} />,
);
