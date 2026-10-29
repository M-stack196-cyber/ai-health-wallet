import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
} from "react-native";
export const palette = {
  ink: "#23453b",
  muted: "#6b7f72",
  green: "#226b59",
  background: "#f4f7f1",
  line: "#dce5d8",
  paper: "#fff",
  amber: "#826025",
};
export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  body: { padding: 22, gap: 16, paddingBottom: 45 },
  brand: { fontSize: 24, fontWeight: "700", color: palette.green },
  eyebrow: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 2,
    color: palette.muted,
  },
  title: { fontSize: 30, fontWeight: "600", color: palette.ink },
  text: { fontSize: 14, lineHeight: 22, color: palette.ink },
  muted: { fontSize: 12, lineHeight: 19, color: palette.muted },
  card: {
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 14,
    padding: 20,
    gap: 12,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "center",
  },
  input: {
    backgroundColor: "#fbfdf9",
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 9,
    padding: 13,
    color: palette.ink,
    minHeight: 48,
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: palette.ink,
    marginBottom: 6,
  },
  button: {
    backgroundColor: palette.green,
    borderRadius: 9,
    padding: 14,
    minHeight: 48,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: { fontWeight: "600", fontSize: 13, color: "#fff" },
  secondary: { backgroundColor: "#e8f0e5" },
  secondaryText: { color: palette.green },
  notice: {
    backgroundColor: "#fff2dc",
    borderWidth: 1,
    borderColor: "#ead7b3",
    padding: 14,
    borderRadius: 10,
  },
  divider: {
    borderBottomWidth: 1,
    borderColor: palette.line,
    paddingBottom: 14,
    marginBottom: 5,
  },
  selected: { borderColor: palette.green, borderWidth: 2 },
});
export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}
export function BodyText({
  children,
  muted = false,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  return <Text style={muted ? styles.muted : styles.text}>{children}</Text>;
}
export function Button({
  title,
  onPress,
  disabled = false,
  secondary = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.button,
        secondary && styles.secondary,
        disabled && { opacity: 0.5 },
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryText]}>
        {title}
      </Text>
    </Pressable>
  );
}
export function Field({
  label,
  value,
  onChange,
  secret = false,
  keyboard = "default",
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  secret?: boolean;
  keyboard?: KeyboardTypeOptions;
  multiline?: boolean;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboard}
        multiline={multiline}
        style={[
          styles.input,
          multiline && { minHeight: 100, textAlignVertical: "top" },
        ]}
      />
    </View>
  );
}
export function Notice({
  message,
  busy = false,
}: {
  message: string;
  busy?: boolean;
}) {
  return (
    <View accessibilityLiveRegion="polite">
      {busy && (
        <View style={styles.row}>
          <ActivityIndicator color={palette.green} />
          <BodyText>Working securely…</BodyText>
        </View>
      )}
      {!!message && (
        <View style={styles.notice}>
          <BodyText>{message}</BodyText>
        </View>
      )}
    </View>
  );
}
export function Choices({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: Record<string, string>;
  onChange: (s: string) => void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        {Object.entries(values).map(([v, l]) => (
          <Pressable
            key={v}
            accessibilityRole="radio"
            accessibilityLabel={l}
            accessibilityState={{ checked: value === v }}
            onPress={() => onChange(v)}
            style={[styles.input, value === v && styles.selected]}
          >
            <Text style={styles.text}>{l}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
