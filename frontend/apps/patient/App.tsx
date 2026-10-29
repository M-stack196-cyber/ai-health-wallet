import React, { useEffect, useRef, useState } from "react";
import {
  AppState,
  ScrollView,
  Text,
  View,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as ScreenCapture from "expo-screen-capture";
import {
  PatientSession,
  patientApi,
  medicalNotice,
  safeMessage,
  InputError,
  type Registration,
} from "@health-wallet/api";
import { createSession, clearFiles } from "./src/platform";
import {
  Button,
  Card,
  Field,
  BodyText,
  Notice,
  Choices,
  styles,
} from "./src/ui";
import { PatientWorkspace } from "./src/Workspace";
export default function App({
  session: provided,
}: {
  session?: PatientSession;
}) {
  const [configuration] = useState(() => {
    try {
      return { session: provided ?? createSession(), error: "" };
    } catch {
      return {
        session: undefined,
        error: "Configure a secure API connection before using Health Wallet.",
      };
    }
  });
  const session = configuration.session;
  const [signedIn, setSignedIn] = useState(false),
    [active, setActive] = useState(AppState.currentState === "active"),
    [ready, setReady] = useState(false),
    [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!session) {
      setReady(true);
      return;
    }
    let mounted = true;
    const remove = session.onClear(() => {
      if (mounted) {
        setSignedIn(false);
        setGeneration((v) => v + 1);
      }
    });
    void (async () => {
      await clearFiles();
      const restored = await session.restore();
      if (mounted) {
        setSignedIn(restored);
        setReady(true);
      }
    })();
    void ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    const subscription = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
      void clearFiles();
      if (state === "active" && session.authorized) {
        void patientApi(session)
          .profile()
          .then(() => {
            if (mounted) setSignedIn(true);
          })
          .catch(() => session.clear())
          .finally(() => {
            if (mounted) setReady(true);
          });
      }
    });
    return () => {
      mounted = false;
      remove();
      subscription.remove();
      void clearFiles();
      void ScreenCapture.allowScreenCaptureAsync().catch(() => {});
    };
  }, [session]);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          {!ready ? (
            <View style={styles.body}>
              <BodyText>Restoring your secure session…</BodyText>
            </View>
          ) : session ? (
            <>
              {signedIn ? (
                <PatientWorkspace key={generation} session={session} />
              ) : (
                <Auth
                  key={generation}
                  session={session}
                  onLogin={() => setSignedIn(true)}
                />
              )}
            </>
          ) : (
            <View style={styles.body}>
              <Notice message={configuration.error} />
            </View>
          )}
          {!active && (
            <View
              accessibilityViewIsModal
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
                backgroundColor: "#f4f7f1",
                padding: 24,
                justifyContent: "center",
              }}
            >
              <Text style={styles.brand}>✚ healthwallet</Text>
              <BodyText>Return to the app to continue securely.</BodyText>
            </View>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
export function Auth({
  session,
  onLogin,
}: {
  session: PatientSession;
  onLogin: () => void;
}) {
  const api = patientApi(session),
    [mode, setMode] = useState("Sign in"),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [fullName, setFullName] = useState(""),
    [dob, setDob] = useState(""),
    [sex, setSex] = useState(""),
    [phone, setPhone] = useState(""),
    [guardian, setGuardian] = useState(""),
    [token, setToken] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const locked = useRef(false);
  async function run(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(safeMessage(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const switchMode = (m: string) => {
    setMode(m);
    setPassword("");
    setToken("");
    setMessage("");
  };
  async function submit() {
    await run(async () => {
      if (mode === "Sign in") {
        await session.login(email, password);
        setPassword("");
        onLogin();
      } else if (mode === "Register") {
        const input: Registration = {
          full_name: fullName,
          email,
          password,
          ...(dob ? { date_of_birth: dob } : {}),
          ...(sex ? { sex_gender: sex } : {}),
          ...(phone ? { phone_number: phone } : {}),
          ...(guardian ? { pending_guardian_email: guardian } : {}),
        };
        await api.register(input);
        setPassword("");
        setMode("Verify email");
        setMessage(
          "Registration received. Complete email verification before signing in.",
        );
      } else if (mode === "Verify email") {
        await api.verify(token.trim());
        setToken("");
        setMode("Sign in");
        setMessage("Email verified. You can now sign in.");
      } else if (mode === "Recover password") {
        await api.forgot(email);
        setMode("Reset password");
        setMessage(
          "If the email is eligible and verified, a recovery email will be sent.",
        );
      } else {
        await session.reset(token.trim(), password);
        setToken("");
        setPassword("");
        setMode("Sign in");
        setMessage(
          "Password reset. All previous sessions are invalid. Sign in again.",
        );
      }
    });
  }
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.body}
    >
      <Text style={styles.brand}>✚ healthwallet</Text>
      <Text style={styles.eyebrow}>YOUR RECORDS. YOUR CONTROL.</Text>
      <Text style={styles.title}>
        {mode === "Sign in" ? "Welcome back." : mode}
      </Text>
      <BodyText muted>
        Keep your medical records together and share only what you choose.
      </BodyText>
      <Card>
        {(mode === "Sign in" ||
          mode === "Register" ||
          mode === "Recover password") && (
          <Field
            label="Email"
            value={email}
            onChange={setEmail}
            keyboard="email-address"
          />
        )}
        {mode === "Register" && (
          <>
            <Field label="Full name" value={fullName} onChange={setFullName} />
            <Field
              label="Date of birth (YYYY-MM-DD)"
              value={dob}
              onChange={setDob}
            />
            <Choices
              label="Sex / gender (optional)"
              value={sex}
              values={{
                female: "Female",
                male: "Male",
                other: "Other",
                prefer_not_to_say: "Prefer not to say",
              }}
              onChange={setSex}
            />
            <Field
              label="Phone (optional)"
              value={phone}
              onChange={setPhone}
              keyboard="phone-pad"
            />
            <Field
              label="Guardian email (optional)"
              value={guardian}
              onChange={setGuardian}
              keyboard="email-address"
            />
          </>
        )}
        {(mode === "Verify email" || mode === "Reset password") && (
          <>
            <Field
              label="Complete code from email"
              value={token}
              onChange={setToken}
              secret
            />
            <BodyText muted>
              Paste the full token supplied by the email. Expired or invalid
              codes require a new email.
            </BodyText>
          </>
        )}
        {(mode === "Sign in" ||
          mode === "Register" ||
          mode === "Reset password") && (
          <>
            <Field
              label={mode === "Reset password" ? "New password" : "Password"}
              value={password}
              onChange={setPassword}
              secret
            />
            {mode !== "Sign in" && (
              <BodyText muted>
                Use at least 15 characters. Your password is never trimmed.
              </BodyText>
            )}
          </>
        )}
        <Button
          title={mode === "Recover password" ? "Send recovery email" : mode}
          disabled={busy}
          onPress={() => void submit()}
        />
        {mode === "Verify email" && (
          <>
            <Field
              label="Email for resend"
              value={email}
              onChange={setEmail}
              keyboard="email-address"
            />
            <Button
              title="Resend verification email"
              secondary
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  await api.resend(email);
                  setMessage(
                    "If eligible, an email will be sent. Wait before requesting another.",
                  );
                })
              }
            />
          </>
        )}
        <Notice message={message} busy={busy} />
      </Card>
      <View style={styles.row}>
        {[
          "Sign in",
          "Register",
          "Verify email",
          "Recover password",
          "Reset password",
        ]
          .filter((m) => m !== mode)
          .map((m) => (
            <Button
              key={m}
              title={m}
              secondary
              disabled={busy}
              onPress={() => switchMode(m)}
            />
          ))}
      </View>
      <BodyText muted>{medicalNotice}</BodyText>
    </ScrollView>
  );
}
