import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SvgXml } from "react-native-svg";

export const palette = {
  // Core dark emerald theme tokens
  background: "#091411",
  sidebar: "#0D1C17",
  paper: "#0F211B",
  elevated: "#132922",
  inputBg: "#0B1914",
  line: "#1B362D",
  lineStrong: "#25493D",
  ink: "#EBF5F0",
  inkSecondary: "#C5D8CF",
  muted: "#7D9B8E",
  green: "#2AC384",
  greenHover: "#22A971",
  greenDarkText: "#052015",
  greenSoft: "rgba(42, 195, 132, 0.14)",
  greenBorder: "rgba(42, 195, 132, 0.34)",
  amber: "#F59E0B",
  amberSoft: "rgba(245, 158, 11, 0.14)",
  amberBorder: "rgba(245, 158, 11, 0.32)",
  blue: "#60A5FA",
  blueSoft: "rgba(96, 165, 250, 0.14)",
  blueBorder: "rgba(96, 165, 250, 0.32)",
  danger: "#F87171",
  dangerSoft: "rgba(248, 113, 113, 0.10)",
  dangerBorder: "rgba(248, 113, 113, 0.35)",
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  body: { padding: 24, gap: 18, paddingBottom: 48 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandBadge: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: palette.green,
    alignItems: "center",
    justifyContent: "center",
  },
  brandBadgePlus: {
    color: palette.greenDarkText,
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 20,
  },
  brand: {
    fontSize: 19,
    fontWeight: "700",
    color: palette.ink,
    letterSpacing: -0.3,
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.4,
    color: palette.muted,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: palette.ink,
    letterSpacing: -0.5,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: palette.ink,
    letterSpacing: -0.2,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: palette.ink,
  },
  text: { fontSize: 14, lineHeight: 21, color: palette.ink },
  secondaryTextBody: {
    fontSize: 14,
    lineHeight: 21,
    color: palette.inkSecondary,
  },
  muted: { fontSize: 13, lineHeight: 19, color: palette.muted },
  smallMuted: { fontSize: 12, lineHeight: 17, color: palette.muted },
  card: {
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 14,
    padding: 20,
    gap: 14,
  },
  subCard: {
    backgroundColor: palette.elevated,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    padding: 14,
    gap: 8,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "center",
  },
  between: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  input: {
    backgroundColor: palette.inputBg,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: palette.ink,
    fontSize: 14,
    minHeight: 46,
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: palette.inkSecondary,
    marginBottom: 6,
  },
  button: {
    backgroundColor: palette.green,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 16,
    minHeight: 44,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: {
    fontWeight: "700",
    fontSize: 13,
    color: palette.greenDarkText,
  },
  secondary: {
    backgroundColor: palette.elevated,
    borderWidth: 1,
    borderColor: palette.lineStrong,
  },
  secondaryText: { color: palette.ink, fontWeight: "600" },
  dangerButton: {
    backgroundColor: palette.dangerSoft,
    borderWidth: 1,
    borderColor: palette.dangerBorder,
  },
  dangerButtonText: {
    color: palette.danger,
    fontWeight: "600",
  },
  notice: {
    backgroundColor: palette.amberSoft,
    borderWidth: 1,
    borderColor: palette.amberBorder,
    padding: 14,
    borderRadius: 10,
  },
  authContent: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 22,
    paddingBottom: 48,
    backgroundColor: palette.background,
  },
  authWrap: { width: "100%", maxWidth: 480, alignSelf: "center", gap: 20 },
  authCard: {
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 16,
    padding: 32,
    gap: 16,
    ...(Platform.OS === "web"
      ? ({ boxShadow: "0 16px 40px rgba(0,0,0,0.45)" } as object)
      : {
          shadowColor: "#000",
          shadowOpacity: 0.4,
          shadowRadius: 20,
          shadowOffset: { width: 0, height: 8 },
          elevation: 6,
        }),
  },
  authHeader: { gap: 8, marginBottom: 4 },
  linkBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    columnGap: 18,
    rowGap: 10,
  },
  fieldError: {
    fontSize: 12,
    lineHeight: 18,
    color: palette.danger,
    marginTop: 6,
  },
  link: { fontSize: 13, fontWeight: "600", color: palette.green },
  divider: {
    borderBottomWidth: 1,
    borderColor: palette.line,
    paddingBottom: 14,
    marginBottom: 4,
  },
  selected: {
    borderColor: palette.green,
    backgroundColor: palette.greenSoft,
    borderWidth: 1.5,
  },
});

export function BrandLogo({ size = "md" }: { size?: "sm" | "md" }) {
  const dim = size === "sm" ? 26 : 30;
  return (
    <View style={styles.brandRow}>
      <View style={[styles.brandBadge, { width: dim, height: dim }]}>
        <Text style={styles.brandBadgePlus}>+</Text>
      </View>
      <Text style={[styles.brand, size === "sm" && { fontSize: 17 }]}>
        healthwallet
      </Text>
    </View>
  );
}

const ICONS: Record<string, string> = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  records:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  timeline:
    '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  summaries:
    '<path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/>',
  ask:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  sharing:
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  profile:
    '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  shield:
    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  search:
    '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  lab:
    '<path d="M9 3h6"/><path d="M10 3v6.5L5.5 18A2 2 0 0 0 7.2 21h9.6a2 2 0 0 0 1.7-3L14 9.5V3"/>',
  prescription:
    '<path d="M10.5 20.5 19 12a4.95 4.95 0 1 0-7-7L3.5 13.5a4.95 4.95 0 1 0 7 7Z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/>',
  lock:
    '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  check:
    '<circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>',
  info:
    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  chevronRight:
    '<polyline points="9 18 15 12 9 6"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  trash:
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  filter:
    '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  send:
    '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  copy:
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  users:
    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
};

export function Icon({
  name,
  size = 16,
  color = palette.muted,
}: {
  name: keyof typeof ICONS | string;
  size?: number;
  color?: string;
}) {
  const body = ICONS[name] ?? ICONS.records;
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return <SvgXml xml={xml} width={size} height={size} />;
}

export function Badge({
  label,
  tone = "green",
  icon,
}: {
  label: string;
  tone?: "green" | "amber" | "blue" | "neutral" | "danger";
  icon?: string;
}) {
  const map = {
    green: {
      bg: palette.greenSoft,
      border: palette.greenBorder,
      text: palette.green,
    },
    amber: {
      bg: palette.amberSoft,
      border: palette.amberBorder,
      text: palette.amber,
    },
    blue: {
      bg: palette.blueSoft,
      border: palette.blueBorder,
      text: palette.blue,
    },
    danger: {
      bg: palette.dangerSoft,
      border: palette.dangerBorder,
      text: palette.danger,
    },
    neutral: {
      bg: palette.elevated,
      border: palette.lineStrong,
      text: palette.inkSecondary,
    },
  }[tone];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        backgroundColor: map.bg,
        borderWidth: 1,
        borderColor: map.border,
        paddingHorizontal: 9,
        paddingVertical: 3,
        borderRadius: 999,
      }}
    >
      {icon && <Icon name={icon} size={12} color={map.text} />}
      <Text style={{ fontSize: 11, fontWeight: "600", color: map.text }}>
        {label}
      </Text>
    </View>
  );
}

export function TextLink({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={(state) => [
        disabled && { opacity: 0.5 },
        (state as { hovered?: boolean }).hovered && {
          textDecorationLine: "underline" as const,
        },
      ]}
    >
      <Text style={styles.link}>{title}</Text>
    </Pressable>
  );
}

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
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
  danger = false,
  icon,
  compact = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
  icon?: string;
  compact?: boolean;
}) {
  const iconColor = danger
    ? palette.danger
    : secondary
      ? palette.ink
      : palette.greenDarkText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={(state) => [
        styles.button,
        compact && { minHeight: 36, paddingVertical: 7, paddingHorizontal: 12 },
        secondary && styles.secondary,
        danger && styles.dangerButton,
        !secondary &&
          !danger &&
          !disabled &&
          ((state as { hovered?: boolean }).hovered || state.pressed) && {
            backgroundColor: palette.greenHover,
          },
        (secondary || danger) &&
          !disabled &&
          ((state as { hovered?: boolean }).hovered || state.pressed) && {
            borderColor: palette.green,
          },
        disabled && { opacity: 0.48 },
      ]}
    >
      {icon && <Icon name={icon} size={15} color={iconColor} />}
      <Text
        style={[
          styles.buttonText,
          secondary && styles.secondaryText,
          danger && styles.dangerButtonText,
        ]}
      >
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
  placeholder,
  error = "",
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  secret?: boolean;
  keyboard?: KeyboardTypeOptions;
  multiline?: boolean;
  placeholder?: string;
  error?: string;
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
        placeholder={placeholder}
        placeholderTextColor={palette.muted}
        style={[
          styles.input,
          multiline && { minHeight: 96, textAlignVertical: "top" },
        ]}
      />
      {!!error && (
        <Text accessibilityLiveRegion="polite" style={styles.fieldError}>
          {error}
        </Text>
      )}
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
        <View style={[styles.row, { paddingVertical: 4 }]}>
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
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          backgroundColor: palette.inputBg,
          borderWidth: 1,
          borderColor: palette.line,
          borderRadius: 12,
          padding: 5,
        }}
      >
        {Object.entries(values).map(([v, l]) => {
          const active = value === v;
          return (
            <Pressable
              key={v}
              accessibilityRole="radio"
              accessibilityLabel={l}
              accessibilityState={{ checked: active }}
              onPress={() => onChange(v)}
              style={[
                {
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: "transparent",
                },
                active && styles.selected,
              ]}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: active ? "600" : "500",
                  color: active ? palette.ink : palette.muted,
                }}
              >
                {l}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
