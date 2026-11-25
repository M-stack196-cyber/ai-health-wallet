import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { SvgXml } from "react-native-svg";
import {
  PatientSession,
  patientApi,
  ApiError,
  categories,
  DELETION_CONFIRMATION,
  medicalNotice,
  safeMessage,
  InputError,
  validateFile,
  searchLoaded,
  grantState,
  type Profile,
  type Guardian,
  type DeletionRequestResult,
  type MedicalDocument,
  type Category,
  type Processing,
  type Summary,
  type History,
  type Timeline,
  type RagResult,
  type Grant,
  type CreatedGrant,
} from "@health-wallet/api";
import { presentOriginal, pickedForm } from "./platform";
import { normalizeDate, checkDate } from "./dates";
import {
  Badge,
  BrandLogo,
  Button,
  Card,
  Field,
  BodyText,
  Icon,
  Notice,
  Choices,
  palette,
  styles,
} from "./ui";

type TabKey =
  | "Home"
  | "Records"
  | "Upload"
  | "Timeline"
  | "Summaries"
  | "Ask records"
  | "Sharing"
  | "Profile";

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatShortDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function greetingForTime(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function initialsOf(name?: string): string {
  if (!name) return "HW";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "HW";
}

export function PatientWorkspace({ session }: { session: PatientSession }) {
  const { width } = useWindowDimensions();
  const isWide = width >= 920;
  const [tab, setTab] = useState<TabKey>("Home");
  const [notice, setNotice] = useState("");
  const [globalSearch, setGlobalSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  const [profile, setProfile] = useState<Profile>();
  const [docs, setDocs] = useState<MedicalDocument[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);

  const refreshOverview = async () => {
    try {
      const api = patientApi(session);
      const [pRes, rRes, gRes] = await Promise.all([
        api.profile().catch(() => undefined),
        api.records({ limit: 50 }).catch(() => undefined),
        api.grants().catch(() => undefined),
      ]);
      if (pRes?.patient) setProfile(pRes.patient);
      if (rRes?.documents) setDocs(rRes.documents);
      if (gRes?.grants) setGrants(gRes.grants);
    } catch {
      // Handled inside individual panels
    }
  };

  useEffect(() => {
    void refreshOverview();
  }, [session]);

  const activeGrantsCount = useMemo(
    () => grants.filter((g) => grantState(g) === "Active").length,
    [grants],
  );
  const totalBytes = useMemo(
    () => docs.reduce((acc, d) => acc + (d.size_bytes || 0), 0),
    [docs],
  );

  const navigate = (next: TabKey) => {
    setNotice("");
    setMenuOpen(false);
    setTab(next);
  };

  const navGroups: {
    heading?: string;
    items: { key: TabKey; label: string; icon: string; badge?: number }[];
  }[] = [
    {
      items: [{ key: "Home", label: "Home", icon: "home" }],
    },
    {
      heading: "RECORDS",
      items: [
        {
          key: "Records",
          label: "All records",
          icon: "records",
          badge: docs.length,
        },
        { key: "Upload", label: "Upload", icon: "upload" },
        { key: "Timeline", label: "Timeline", icon: "timeline" },
      ],
    },
    {
      heading: "UNDERSTAND",
      items: [
        { key: "Summaries", label: "Summaries", icon: "summaries" },
        { key: "Ask records", label: "Ask records", icon: "ask" },
      ],
    },
    {
      heading: "CONTROL",
      items: [
        {
          key: "Sharing",
          label: "Sharing",
          icon: "sharing",
          badge: activeGrantsCount > 0 ? activeGrantsCount : undefined,
        },
        { key: "Profile", label: "Profile", icon: "profile" },
      ],
    },
  ];

  const renderSidebar = () => (
    <View
      style={{
        width: isWide ? 245 : "100%",
        backgroundColor: palette.sidebar,
        borderRightWidth: isWide ? 1 : 0,
        borderBottomWidth: isWide ? 0 : 1,
        borderColor: palette.line,
        padding: 16,
        justifyContent: "space-between",
        gap: 18,
      }}
    >
      <View style={{ gap: 18 }}>
        <View style={{ paddingHorizontal: 6, paddingTop: 4 }}>
          <BrandLogo />
        </View>

        {navGroups.map((group, idx) => (
          <View key={idx} style={{ gap: 4 }}>
            {group.heading && (
              <Text
                style={[
                  styles.eyebrow,
                  { paddingHorizontal: 10, marginBottom: 4, fontSize: 10 },
                ]}
              >
                {group.heading}
              </Text>
            )}
            {group.items.map((item) => {
              const active = tab === item.key;
              return (
                <Pressable
                  key={item.key}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                  accessibilityState={{ selected: active }}
                  onPress={() => navigate(item.key)}
                  style={(state) => [
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      paddingVertical: 10,
                      paddingHorizontal: 12,
                      borderRadius: 10,
                      backgroundColor: active
                        ? palette.greenSoft
                        : (state as { hovered?: boolean }).hovered
                          ? palette.elevated
                          : "transparent",
                      borderWidth: 1,
                      borderColor: active ? palette.greenBorder : "transparent",
                    },
                  ]}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <Icon
                      name={item.icon}
                      size={16}
                      color={active ? palette.green : palette.muted}
                    />
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: active ? "600" : "500",
                        color: active ? palette.green : palette.inkSecondary,
                      }}
                    >
                      {item.label}
                    </Text>
                  </View>
                  {typeof item.badge === "number" && (
                    <View
                      style={{
                        backgroundColor: active
                          ? palette.green
                          : palette.elevated,
                        paddingHorizontal: 8,
                        paddingVertical: 2,
                        borderRadius: 999,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 11,
                          fontWeight: "700",
                          color: active
                            ? palette.greenDarkText
                            : palette.inkSecondary,
                        }}
                      >
                        {item.badge}
                      </Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>

      <View
        style={{
          backgroundColor: palette.paper,
          borderWidth: 1,
          borderColor: palette.line,
          borderRadius: 12,
          padding: 12,
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Icon name="shield" size={15} color={palette.green} />
          <Text
            style={{ fontSize: 12, fontWeight: "600", color: palette.ink }}
          >
            Originals encrypted
          </Text>
        </View>
        <Text style={styles.smallMuted}>
          {docs.length} {docs.length === 1 ? "file" : "files"} ·{" "}
          {formatBytes(totalBytes)} of 1 GB
        </Text>
        <View
          style={{
            height: 4,
            borderRadius: 99,
            backgroundColor: palette.elevated,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              height: 4,
              width: `${Math.min(100, Math.max(4, Math.round((totalBytes / (1024 * 1024 * 1024)) * 100)))}%`,
              backgroundColor: palette.green,
            }}
          />
        </View>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, flexDirection: isWide ? "row" : "column", backgroundColor: palette.background }}>
      {isWide && renderSidebar()}

      <View style={{ flex: 1, backgroundColor: palette.background }}>
        <View
          style={{
            borderBottomWidth: 1,
            borderColor: palette.line,
            backgroundColor: palette.background,
            paddingHorizontal: 22,
            paddingVertical: 12,
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {!isWide && (
              <Button
                title={menuOpen ? "Close menu" : "Menu"}
                secondary
                compact
                onPress={() => setMenuOpen((v) => !v)}
              />
            )}
            <Text style={styles.muted}>
              Patient workspace{"  "}
              <Text style={{ color: palette.muted }}>›</Text>
              {"  "}
              <Text style={{ color: palette.ink, fontWeight: "600" }}>
                {tab === "Records" ? "Records" : tab}
              </Text>
            </Text>
          </View>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: palette.sidebar,
                borderWidth: 1,
                borderColor: palette.line,
                borderRadius: 10,
                paddingHorizontal: 12,
                height: 38,
                minWidth: isWide ? 260 : 180,
                gap: 8,
              }}
            >
              <Icon name="search" size={14} color={palette.muted} />
              <TextInput
                accessibilityLabel="Global search"
                value={globalSearch}
                onChangeText={(txt) => {
                  setGlobalSearch(txt);
                  if (txt.trim() && tab !== "Records") setTab("Records");
                }}
                placeholder="Search records, tests, hospitals"
                placeholderTextColor={palette.muted}
                style={{
                  flex: 1,
                  color: palette.ink,
                  fontSize: 13,
                  paddingVertical: 0,
                }}
              />
            </View>

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                backgroundColor: palette.amberSoft,
                borderWidth: 1,
                borderColor: palette.amberBorder,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 999,
              }}
            >
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 99,
                  backgroundColor: palette.amber,
                }}
              />
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: "600",
                  color: palette.amber,
                }}
              >
                Development
              </Text>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open profile"
              onPress={() => navigate("Profile")}
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                backgroundColor: "#6366F1",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>
                {initialsOf(profile?.full_name)}
              </Text>
            </Pressable>

            <Button
              title="Log out"
              secondary
              compact
              onPress={() =>
                void session.logout().catch(() => {
                  session.clear();
                })
              }
            />
          </View>
        </View>

        {!isWide && menuOpen && renderSidebar()}

        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.body,
            { maxWidth: 1220, width: "100%", alignSelf: "center" },
          ]}
        >
          <Notice message={notice} />
          <Panel key={tab} session={session}>
            {(context) =>
              tab === "Home" ? (
                <HomePanel
                  {...context}
                  profile={profile}
                  docs={docs}
                  grants={grants}
                  onNavigate={navigate}
                />
              ) : tab === "Profile" ? (
                <ProfilePanel
                  {...context}
                  onProfileUpdated={(p) => setProfile(p)}
                />
              ) : tab === "Upload" ? (
                <UploadPanel
                  {...context}
                  recentDocs={docs}
                  onUploaded={() => {
                    void refreshOverview();
                    setTab("Records");
                    setNotice(
                      "Original uploaded. Extraction and AI completion are separate.",
                    );
                  }}
                />
              ) : tab === "Records" ? (
                <RecordsPanel
                  {...context}
                  initialSearch={globalSearch}
                  onNavigateUpload={() => navigate("Upload")}
                  onListChanged={() => void refreshOverview()}
                />
              ) : tab === "Timeline" ? (
                <TimelinePanel {...context} />
              ) : tab === "Summaries" ? (
                <HistoryPanel {...context} />
              ) : tab === "Ask records" ? (
                <RagPanel {...context} onNavigate={navigate} />
              ) : (
                <SharingPanel
                  {...context}
                  onGrantsChanged={() => void refreshOverview()}
                />
              )
            }
          </Panel>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingTop: 12,
              borderTopWidth: 1,
              borderColor: palette.line,
            }}
          >
            <Icon name="info" size={14} color={palette.muted} />
            <Text style={styles.smallMuted}>{medicalNotice}</Text>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

type Context = {
  api: ReturnType<typeof patientApi>;
  session: PatientSession;
  run: (fn: () => Promise<void>, success?: string) => Promise<void>;
  busy: boolean;
  setMessage: (s: string) => void;
  live: () => boolean;
};

function discardPicked(uri: string) {
  if (Platform.OS === "web") {
    if (uri.startsWith("blob:")) URL.revokeObjectURL(uri);
    return;
  }
  const f = new File(uri);
  if (f.exists) f.delete();
}

function Panel({
  session,
  children,
}: {
  session: PatientSession;
  children: (context: Context) => ReactNode;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [reset, setReset] = useState(0);
  const mounted = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(fn: () => Promise<void>, success = "") {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await fn();
      if (mounted.current) setMessage(success);
    } catch (e) {
      if (mounted.current) {
        if (e instanceof ApiError && e.status === 404) setReset((v) => v + 1);
        setMessage(safeMessage(e));
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <Notice message={message} busy={busy} />
      <View key={reset} style={{ gap: 18 }}>
        {children({
          api: patientApi(session),
          session,
          run,
          busy,
          setMessage,
          live: () => mounted.current && session.authorized,
        })}
      </View>
    </>
  );
}

function confirm(title: string, message: string, action: () => void) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    if (window.confirm(`${title}\n\n${message}`)) action();
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: "Confirm", style: "destructive", onPress: action },
  ]);
}

/* ============================================================================
 * 1. HOME DASHBOARD
 * ========================================================================== */
function HomePanel({
  profile,
  docs,
  grants,
  onNavigate,
}: Context & {
  profile?: Profile;
  docs: MedicalDocument[];
  grants: Grant[];
  onNavigate: (tab: TabKey) => void;
}) {
  const { width } = useWindowDimensions();
  const isTwoCol = width >= 960;

  const firstName = profile?.full_name?.trim().split(/\s+/)[0] || "there";
  const labCount = docs.filter((d) => d.category === "lab_report").length;
  const rxCount = docs.filter((d) => d.category === "prescription").length;
  const hospitalsCount = new Set(
    docs.map((d) => d.hospital_name.trim()).filter(Boolean),
  ).size;
  const activeShare = grants.find((g) => grantState(g) === "Active");

  return (
    <View style={{ gap: 20 }}>
      <View style={styles.between}>
        <View style={{ gap: 6, flex: 1, minWidth: 260 }}>
          <Text style={styles.title}>
            {greetingForTime()}, {firstName}
          </Text>
          <View style={styles.row}>
            <Text style={styles.muted}>
              <Text style={{ color: palette.ink, fontWeight: "700" }}>
                {docs.length}
              </Text>{" "}
              records ·{" "}
              <Text style={{ color: palette.ink, fontWeight: "700" }}>
                {labCount}
              </Text>{" "}
              lab reports ·{" "}
              <Text style={{ color: palette.ink, fontWeight: "700" }}>
                {rxCount}
              </Text>{" "}
              prescriptions ·{" "}
              <Text style={{ color: palette.ink, fontWeight: "700" }}>
                {hospitalsCount}
              </Text>{" "}
              hospitals and labs
            </Text>
            {activeShare && <Badge label="1 active share" tone="green" />}
          </View>
        </View>

        <View style={styles.row}>
          <Button
            title="Ask your records"
            secondary
            icon="ask"
            onPress={() => onNavigate("Ask records")}
          />
          <Button
            title="Upload a record"
            icon="upload"
            onPress={() => onNavigate("Upload")}
          />
        </View>
      </View>

      <View
        style={{
          flexDirection: isTwoCol ? "row" : "column",
          gap: 18,
          alignItems: "flex-start",
        }}
      >
        <View style={{ flex: 1.5, width: "100%", gap: 16 }}>
          <Card>
            <View style={styles.between}>
              <View>
                <Text style={styles.sectionTitle}>Recent records</Text>
                <Text style={styles.smallMuted}>
                  Latest uploaded medical documents and extraction states
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="All records"
                onPress={() => onNavigate("Records")}
              >
                <Text style={styles.link}>All records →</Text>
              </Pressable>
            </View>

            {docs.length === 0 ? (
              <View style={styles.subCard}>
                <BodyText>No records uploaded yet.</BodyText>
                <BodyText muted>
                  Upload a lab report or prescription to organize your medical
                  timeline and generate grounded summaries.
                </BodyText>
              </View>
            ) : (
              <View style={{ gap: 10 }}>
                {docs.slice(0, 4).map((d) => {
                  const isRx = d.category === "prescription";
                  return (
                    <Pressable
                      key={d.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${d.original_filename}`}
                      onPress={() => onNavigate("Records")}
                      style={[
                        styles.subCard,
                        {
                          flexDirection: "row",
                          justifyContent: "space-between",
                          alignItems: "center",
                        },
                      ]}
                    >
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 12,
                          flex: 1,
                        }}
                      >
                        <View
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 10,
                            backgroundColor: isRx
                              ? palette.blueSoft
                              : palette.greenSoft,
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Icon
                            name={isRx ? "prescription" : "lab"}
                            size={16}
                            color={isRx ? palette.blue : palette.green}
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.cardTitle}>
                            {d.original_filename}
                          </Text>
                          <Text style={styles.smallMuted}>
                            {d.hospital_name} ·{" "}
                            {formatShortDate(d.document_date ?? d.uploaded_at)}
                          </Text>
                        </View>
                      </View>
                      <Badge
                        label={d.category_label}
                        tone={isRx ? "blue" : "green"}
                      />
                    </Pressable>
                  );
                })}
              </View>
            )}
          </Card>

          <Card>
            <View style={styles.between}>
              <View>
                <Text style={styles.sectionTitle}>Doctor sharing status</Text>
                <Text style={styles.smallMuted}>
                  Time-limited, revocable links to specific records you choose
                </Text>
              </View>
              <Button
                title="Manage sharing"
                secondary
                compact
                onPress={() => onNavigate("Sharing")}
              />
            </View>
            <BodyText muted>
              {activeShare
                ? `Active share expires ${new Date(activeShare.expires_at).toLocaleString()}.`
                : "No active doctor share links right now. Create a link or QR code whenever you visit a clinic."}
            </BodyText>
          </Card>
        </View>

        <View style={{ flex: 1, width: "100%", gap: 16 }}>
          <Card>
            <View style={styles.between}>
              <View>
                <Text style={styles.sectionTitle}>
                  Summary from your records
                </Text>
                <Text style={styles.smallMuted}>
                  {docs.length} documents indexed
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Full summary"
                onPress={() => onNavigate("Summaries")}
              >
                <Text style={styles.link}>Full summary</Text>
              </Pressable>
            </View>

            <View style={styles.subCard}>
              <Text style={styles.cardTitle}>Evidence-grounded overview</Text>
              <BodyText muted>
                Health Wallet reads only the lab reports and prescriptions you
                upload. Generate a longitudinal history summary or ask a
                question with exact document citations.
              </BodyText>
            </View>

            <View style={styles.row}>
              <Button
                title="Open summaries"
                secondary
                compact
                icon="summaries"
                onPress={() => onNavigate("Summaries")}
              />
              <Button
                title="View timeline"
                secondary
                compact
                icon="timeline"
                onPress={() => onNavigate("Timeline")}
              />
            </View>

            <Text style={styles.smallMuted}>
              Informational only — not medical advice.
            </Text>
          </Card>
        </View>
      </View>
    </View>
  );
}

/* ============================================================================
 * 2. ALL RECORDS + DETAIL DRAWER
 * ========================================================================== */
export function RecordsPanel(
  context: Context & {
    initialSearch?: string;
    onNavigateUpload?: () => void;
    onListChanged?: () => void;
  },
) {
  const {
    api,
    run,
    busy,
    live,
    initialSearch = "",
    onNavigateUpload,
    onListChanged,
  } = context;
  const [records, setRecords] = useState<MedicalDocument[]>([]),
    [more, setMore] = useState(false),
    [search, setSearch] = useState(initialSearch),
    [category, setCategory] = useState(""),
    [hospital, setHospital] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [showFilters, setShowFilters] = useState(false),
    [detail, setDetail] = useState<MedicalDocument>();

  useEffect(() => {
    setSearch(initialSearch);
  }, [initialSearch]);

  async function load(append = false, catOverride?: string) {
    const activeCat = catOverride !== undefined ? catOverride : category;
    const r = await api.records({
      limit: 20,
      offset: append ? records.length : 0,
      category: (activeCat as Category) || undefined,
      hospital: hospital || undefined,
      uploaded_from: normalizeDate(from) || undefined,
      uploaded_to: normalizeDate(to) || undefined,
    });
    if (live()) {
      setRecords(append ? [...records, ...r.documents] : r.documents);
      setMore(r.pagination.has_more);
    }
  }

  useEffect(() => {
    void run(() => load());
  }, []);

  const filtered = searchLoaded(records, search);
  const labCount = records.filter((d) => d.category === "lab_report").length;
  const rxCount = records.filter((d) => d.category === "prescription").length;
  const otherCount = records.filter(
    (d) => d.category === "other_medical_document",
  ).length;

  const filterChips: { key: string; label: string; count?: number }[] = [
    { key: "", label: "All", count: records.length },
    { key: "lab_report", label: "Lab report", count: labCount },
    { key: "prescription", label: "Prescription", count: rxCount },
    { key: "other_medical_document", label: "Other", count: otherCount },
  ];

  return (
    <View style={{ gap: 18 }}>
      <View style={styles.between}>
        <View style={{ gap: 4 }}>
          <Text style={styles.title}>Records</Text>
          <BodyText muted>
            Every original you have uploaded. Open a record to see its values,
            source and integrity check.
          </BodyText>
        </View>
        {onNavigateUpload && (
          <Button title="Upload" icon="upload" onPress={onNavigateUpload} />
        )}
      </View>

      <Card>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              backgroundColor: palette.inputBg,
              borderWidth: 1,
              borderColor: palette.line,
              borderRadius: 10,
              paddingHorizontal: 14,
              height: 46,
              gap: 10,
            }}
          >
            <Icon name="search" size={16} color={palette.muted} />
            <TextInput
              accessibilityLabel="Search loaded records"
              value={search}
              onChangeText={setSearch}
              placeholder="Search by test, medicine or hospital"
              placeholderTextColor={palette.muted}
              style={{ flex: 1, color: palette.ink, fontSize: 14 }}
            />
          </View>
          <Button
            title="Filters"
            secondary
            icon="filter"
            onPress={() => setShowFilters((v) => !v)}
          />
        </View>

        <View style={styles.row}>
          {filterChips.map((chip) => {
            const active = category === chip.key;
            return (
              <Pressable
                key={chip.key || "all"}
                accessibilityRole="radio"
                accessibilityLabel={chip.label}
                accessibilityState={{ checked: active }}
                onPress={() => {
                  setCategory(chip.key);
                  setDetail(undefined);
                  void run(() => load(false, chip.key));
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 999,
                  backgroundColor: active ? palette.ink : palette.elevated,
                  borderWidth: 1,
                  borderColor: active ? palette.ink : palette.lineStrong,
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: "600",
                    color: active ? palette.background : palette.inkSecondary,
                  }}
                >
                  {chip.label}
                </Text>
                {typeof chip.count === "number" && (
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: "700",
                      color: active ? palette.background : palette.muted,
                    }}
                  >
                    {chip.count}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>

        {showFilters && (
          <View
            style={{
              gap: 12,
              paddingTop: 10,
              borderTopWidth: 1,
              borderColor: palette.line,
            }}
          >
            <Field
              label="Hospital filter"
              value={hospital}
              onChange={setHospital}
              placeholder="e.g. Chughtai Lab, Gulberg"
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              <View style={{ flex: 1, minWidth: 180 }}>
                <Field
                  label="Uploaded from (e.g. 2026-11-09)"
                  value={from}
                  onChange={setFrom}
                />
              </View>
              <View style={{ flex: 1, minWidth: 180 }}>
                <Field
                  label="Uploaded to (e.g. 2026-11-09)"
                  value={to}
                  onChange={setTo}
                />
              </View>
            </View>
            <Button
              title="Apply filters / refresh"
              secondary
              disabled={busy}
              onPress={() => {
                setDetail(undefined);
                setRecords([]);
                void run(() => load());
              }}
            />
          </View>
        )}
      </Card>

      <View style={styles.between}>
        <Text style={styles.smallMuted}>
          <Text style={{ color: palette.ink, fontWeight: "700" }}>
            {filtered.length}
          </Text>{" "}
          of {records.length} records
        </Text>
        <Text style={styles.smallMuted}>Newest document first</Text>
      </View>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <View
          style={{
            flexDirection: "row",
            paddingHorizontal: 18,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderColor: palette.line,
            backgroundColor: palette.sidebar,
          }}
        >
          <Text style={[styles.eyebrow, { flex: 2.2 }]}>RECORD</Text>
          <Text style={[styles.eyebrow, { flex: 1.5 }]}>HOSPITAL OR LAB</Text>
          <Text style={[styles.eyebrow, { flex: 1.1 }]}>TYPE</Text>
          <Text style={[styles.eyebrow, { flex: 1, textAlign: "right" }]}>
            DOCUMENT DATE
          </Text>
        </View>

        {filtered.map((d, idx) => {
          const isRx = d.category === "prescription";
          const isOther = d.category === "other_medical_document";
          const isSelected = detail?.id === d.id;
          return (
            <View
              key={d.id}
              style={{
                borderBottomWidth: idx === filtered.length - 1 ? 0 : 1,
                borderColor: palette.line,
                backgroundColor: isSelected ? palette.elevated : "transparent",
                paddingHorizontal: 18,
                paddingVertical: 14,
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 10,
              }}
            >
              <View
                style={{
                  flex: 2.2,
                  minWidth: 210,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <View
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    backgroundColor: isRx
                      ? palette.blueSoft
                      : isOther
                        ? palette.elevated
                        : palette.greenSoft,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon
                    name={isRx ? "prescription" : isOther ? "records" : "lab"}
                    size={16}
                    color={
                      isRx
                        ? palette.blue
                        : isOther
                          ? palette.muted
                          : palette.green
                    }
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{d.original_filename}</Text>
                  <Text style={styles.smallMuted}>
                    {d.processing_status} · {formatBytes(d.size_bytes)}
                  </Text>
                </View>
              </View>

              <View style={{ flex: 1.5, minWidth: 140 }}>
                <Text style={styles.secondaryTextBody}>{d.hospital_name}</Text>
              </View>

              <View
                style={{ flex: 1.1, minWidth: 110, alignItems: "flex-start" }}
              >
                <Badge
                  label={d.category_label}
                  tone={isRx ? "blue" : isOther ? "neutral" : "green"}
                  icon={isRx ? "prescription" : isOther ? "records" : "lab"}
                />
              </View>

              <View
                style={{
                  flex: 1,
                  minWidth: 150,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: 10,
                }}
              >
                <Text style={styles.muted}>
                  {formatShortDate(d.document_date ?? d.uploaded_at)}
                </Text>
                <Button
                  title={"Open " + d.original_filename}
                  secondary
                  compact
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      setDetail(undefined);
                      setDetail((await api.record(d.id)).document);
                    })
                  }
                />
              </View>
            </View>
          );
        })}

        {!filtered.length && !busy && (
          <View style={{ padding: 24 }}>
            <BodyText muted>No available records match the filters.</BodyText>
          </View>
        )}
      </Card>

      {more && (
        <Button
          title="Load more records"
          secondary
          disabled={busy}
          onPress={() => void run(() => load(true))}
        />
      )}

      {detail && (
        <RecordDetail
          key={detail.id}
          {...context}
          document={detail}
          onRemoved={() => {
            setRecords((previous) =>
              previous.filter((record) => record.id !== detail.id),
            );
            setDetail(undefined);
            onListChanged?.();
          }}
        />
      )}
    </View>
  );
}

export function RecordDetail({
  api,
  run,
  busy,
  live,
  document: d,
  onRemoved,
}: { document: MedicalDocument; onRemoved: () => void } & Context) {
  const [processing, setProcessing] = useState<Processing>(),
    [summary, setSummary] = useState<Summary>(),
    [job, setJob] = useState<{ id: string; status: string }>(),
    [hospital, setHospital] = useState(d.hospital_name),
    [date, setDate] = useState(d.document_date ?? ""),
    [dateError, setDateError] = useState(""),
    [category, setCategory] = useState<Category>(d.category),
    [removed, setRemoved] = useState(false);

  useEffect(() => {
    void run(async () =>
      setProcessing((await api.processing(d.id)).processing),
    );
  }, []);

  if (removed)
    return (
      <Card>
        <BodyText>
          Record access removed. Retention policy remains pending; original
          erasure is not claimed.
        </BodyText>
      </Card>
    );

  return (
    <Card style={{ borderColor: palette.greenBorder }}>
      <View style={styles.between}>
        <View>
          <Text style={styles.eyebrow}>RECORD DETAILS & INTEGRITY</Text>
          <Text style={[styles.sectionTitle, { marginTop: 4 }]}>
            {d.original_filename}
          </Text>
          <Text style={styles.smallMuted}>
            {d.content_type} · {d.size_bytes} bytes · Uploaded{" "}
            {new Date(d.uploaded_at).toLocaleString()}
          </Text>
        </View>
        <Badge
          label={`Extraction: ${processing?.status ?? "Not loaded"}`}
          tone="green"
        />
      </View>

      <BodyText>
        Extraction: {processing?.status ?? "Not loaded"}
        {processing?.failure_code
          ? ` · ${processing.failure_code.replaceAll("_", " ")}`
          : ""}
      </BodyText>

      {d.sha256 && (
        <View style={styles.subCard}>
          <Text style={styles.smallMuted}>
            SHA-256 fingerprint:{" "}
            <Text style={{ color: palette.inkSecondary }}>{d.sha256}</Text>
          </Text>
        </View>
      )}

      <BodyText muted>
        Extraction readiness does not imply OCR/AI completion.
      </BodyText>

      <View style={styles.row}>
        <Button
          title="View / download original"
          icon="download"
          disabled={busy}
          onPress={() =>
            confirm(
              "Open original?",
              "You may view or export this file using the device share sheet. Exported copies remain outside app control.",
              () =>
                void run(async () => {
                  const blob = await api.original(d.id);
                  if (live()) await presentOriginal(blob, d, live);
                }),
            )
          }
        />
        <Button
          title="Refresh processing status"
          secondary
          disabled={busy}
          onPress={() =>
            void run(async () =>
              setProcessing((await api.processing(d.id)).processing),
            )
          }
        />
        {processing?.retry_allowed && (
          <Button
            title="Retry extraction"
            secondary
            disabled={busy}
            onPress={() =>
              void run(async () => {
                await api.retry(d.id);
                setProcessing((await api.processing(d.id)).processing);
              }, "Retry accepted by backend.")
            }
          />
        )}
      </View>

      {!processing?.retry_allowed && (
        <Text style={styles.smallMuted}>
          Retry is not currently approved or available for this source.
        </Text>
      )}

      <View style={styles.divider} />

      <Choices
        label="Document category"
        value={category}
        values={categories}
        onChange={(v) => setCategory(v as Category)}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        <View style={{ flex: 1, minWidth: 200 }}>
          <Field label="Hospital name" value={hospital} onChange={setHospital} />
        </View>
        <View style={{ flex: 1, minWidth: 200 }}>
          <Field
            label="Document date (e.g. 2026-11-09 or 9/11/2026, optional)"
            value={date}
            onChange={(v) => {
              setDate(v);
              setDateError("");
            }}
            error={dateError}
          />
        </View>
      </View>

      <View style={styles.row}>
        <Button
          title="Save document metadata"
          secondary
          disabled={busy}
          onPress={() => {
            const checked = checkDate(date, "document");
            setDateError(checked.error);
            if (checked.error) return;
            void run(async () => {
              await api.metadata(d.id, {
                category,
                hospital_name: hospital,
                document_date: checked.value || null,
              });
              setSummary(undefined);
            }, "Metadata updated. Refresh the record library for current dates.");
          }}
        />
        <Button
          title="Load report summary"
          secondary
          disabled={busy}
          onPress={() => {
            setSummary(undefined);
            void run(async () => setSummary((await api.summary(d.id)).summary));
          }}
        />
        <Button
          title="Request report summary"
          secondary
          disabled={busy}
          onPress={() =>
            void run(async () => setJob((await api.requestSummary(d.id)).job))
          }
        />
      </View>

      {job && (
        <View style={styles.subCard}>
          <BodyText>Summary job: {job.status}</BodyText>
          <View style={styles.row}>
            <Button
              title="Refresh summary job"
              secondary
              compact
              disabled={busy}
              onPress={() =>
                void run(async () => setJob((await api.summaryJob(job.id)).job))
              }
            />
            {job.status === "failed" && (
              <Button
                title="Retry summary job"
                secondary
                compact
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    await api.retrySummary(job.id);
                    setJob((await api.summaryJob(job.id)).job);
                  })
                }
              />
            )}
          </View>
        </View>
      )}

      {summary && <SummaryCard summary={summary} />}

      <View style={{ alignItems: "flex-start", paddingTop: 4 }}>
        <Button
          title="Delete record access"
          danger
          icon="trash"
          disabled={busy}
          onPress={() =>
            confirm(
              "Remove this record?",
              "Access will be restricted and current sharing may be revoked. This does not confirm original-file erasure.",
              () =>
                void run(async () => {
                  await api.remove(d.id);
                  setSummary(undefined);
                  setRemoved(true);
                  onRemoved();
                }, "Document access removed. Retention policy pending."),
            )
          }
        />
      </View>
    </Card>
  );
}

function SummaryCard({ summary }: { summary: Summary }) {
  return (
    <View style={styles.subCard}>
      <Text style={styles.eyebrow}>INFORMATIONAL · {summary.mode}</Text>
      <BodyText>{summary.text || "Insufficient supported evidence."}</BodyText>
      <BodyText muted>
        Generated {new Date(summary.generated_at).toLocaleString()} ·{" "}
        {summary.provider ?? "Provider unspecified"} ·{" "}
        {summary.model ?? "Model unspecified"}
      </BodyText>
      {summary.limitations.map((l) => (
        <BodyText key={l} muted>
          {l}
        </BodyText>
      ))}
    </View>
  );
}

/* ============================================================================
 * 3. UPLOAD A RECORD
 * ========================================================================== */
export function UploadPanel({
  api,
  run,
  busy,
  live,
  recentDocs = [],
  onUploaded,
}: Context & {
  recentDocs?: MedicalDocument[];
  onUploaded: () => void;
}) {
  const { width } = useWindowDimensions();
  const isTwoCol = width >= 960;

  const [asset, setAsset] = useState<DocumentPicker.DocumentPickerAsset>(),
    [category, setCategory] = useState<Category>("lab_report"),
    [hospital, setHospital] = useState(""),
    [date, setDate] = useState(""),
    [dateError, setDateError] = useState("");

  async function pick() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/jpeg", "image/png"],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return;
    const next = result.assets[0];
    if (!live()) {
      discardPicked(next.uri);
      return;
    }
    try {
      validateFile(next.name, next.mimeType ?? "");
      if (asset) discardPicked(asset.uri);
      setAsset(next);
    } catch (e) {
      discardPicked(next.uri);
      throw e;
    }
  }

  const assetRef = useRef(asset);
  assetRef.current = asset;
  useEffect(
    () => () => {
      if (assetRef.current) discardPicked(assetRef.current.uri);
    },
    [],
  );

  async function upload() {
    if (!asset) throw new InputError("Choose a file first.");
    validateFile(asset.name, asset.mimeType ?? "");
    if (!hospital.trim()) throw new InputError("Enter the hospital name.");
    const checked = checkDate(date, "document");
    setDateError(checked.error);
    if (checked.error) return;
    await api.upload(
      await pickedForm(asset, {
        category,
        hospital_name: hospital.trim(),
        ...(checked.value ? { document_date: checked.value } : {}),
      }),
    );
    if (live()) onUploaded();
  }

  const nextSteps = [
    {
      icon: "shield",
      title: "Checked",
      desc: "Size, format, file signature and integrity are validated on the server.",
    },
    {
      icon: "lock",
      title: "Stored as the original",
      desc: "Your file is encrypted and never altered. A fingerprint proves it later.",
    },
    {
      icon: "lab",
      title: "Values read",
      desc: "Test names, results and lab ranges are extracted so you can search and track them.",
    },
    {
      icon: "check",
      title: "Ready",
      desc: "It appears in Records and Timeline, and can be used in answers.",
    },
  ];

  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>Upload a record</Text>
        <BodyText muted>
          Add a lab report, prescription or any medical document. We keep your
          original file exactly as you upload it.
        </BodyText>
      </View>

      <View
        style={{
          flexDirection: isTwoCol ? "row" : "column",
          gap: 18,
          alignItems: "flex-start",
        }}
      >
        <Card style={{ flex: 1.5, width: "100%" }}>
          <View
            style={{
              borderWidth: 1.5,
              borderStyle: "dashed",
              borderColor: asset ? palette.green : palette.lineStrong,
              backgroundColor: asset ? palette.greenSoft : palette.inputBg,
              borderRadius: 14,
              paddingVertical: 28,
              paddingHorizontal: 20,
              alignItems: "center",
              gap: 10,
            }}
          >
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                backgroundColor: palette.elevated,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="upload" size={20} color={palette.green} />
            </View>
            <Text style={styles.sectionTitle}>
              Drop a file here or choose one
            </Text>
            {asset ? (
              <BodyText>
                {asset.name} · {asset.size ?? "Unknown"} bytes
              </BodyText>
            ) : (
              <Text style={styles.smallMuted}>
                One file at a time, up to 20 MB
              </Text>
            )}
            <View style={[styles.row, { marginTop: 4 }]}>
              {["PDF", "JPG", "JPEG", "PNG"].map((ext) => (
                <View
                  key={ext}
                  style={{
                    backgroundColor: palette.elevated,
                    borderWidth: 1,
                    borderColor: palette.line,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 6,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 10,
                      fontWeight: "700",
                      color: palette.inkSecondary,
                    }}
                  >
                    {ext}
                  </Text>
                </View>
              ))}
            </View>
            <View style={{ marginTop: 6 }}>
              <Button
                title={
                  asset
                    ? "Choose a different file"
                    : "Choose PDF, JPG, JPEG or PNG"
                }
                secondary
                disabled={busy}
                onPress={() => void run(pick)}
              />
            </View>
          </View>

          <Choices
            label="Category"
            value={category}
            values={categories}
            onChange={(v) => setCategory(v as Category)}
          />

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
            <View style={{ flex: 1, minWidth: 210 }}>
              <Field
                label="Hospital name"
                value={hospital}
                onChange={setHospital}
                placeholder="e.g. Chughtai Lab, Gulberg"
              />
            </View>
            <View style={{ flex: 1, minWidth: 210 }}>
              <Field
                label="Document date (e.g. 2026-11-09 or 9/11/2026, optional)"
                value={date}
                onChange={(v) => {
                  setDate(v);
                  setDateError("");
                }}
                placeholder="YYYY-MM-DD"
                error={dateError}
              />
              <Text style={[styles.smallMuted, { marginTop: 4 }]}>
                The date printed on the report, not today.
              </Text>
            </View>
          </View>

          <View
            style={[
              styles.between,
              {
                paddingTop: 12,
                borderTopWidth: 1,
                borderColor: palette.line,
              },
            ]}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name="lock" size={14} color={palette.muted} />
              <Text style={styles.smallMuted}>
                Encrypted in transit and at rest
              </Text>
            </View>
            <Button
              title={busy ? "Uploading / validating…" : "Upload original"}
              icon="upload"
              disabled={busy || !asset}
              onPress={() => void run(upload)}
            />
          </View>
        </Card>

        <View style={{ flex: 1, width: "100%", gap: 16 }}>
          <Card>
            <Text style={styles.sectionTitle}>Uploads</Text>
            {recentDocs[0] ? (
              <View
                style={[
                  styles.subCard,
                  {
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                  },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>
                    {recentDocs[0].original_filename}
                  </Text>
                  <Text style={styles.smallMuted}>
                    {formatBytes(recentDocs[0].size_bytes)} ·{" "}
                    {formatShortDate(recentDocs[0].uploaded_at)}
                  </Text>
                </View>
                <Badge label="✓ Saved" tone="green" />
              </View>
            ) : (
              <BodyText muted>
                No recent uploads yet in this session.
              </BodyText>
            )}
            <Text style={styles.smallMuted}>
              A file counts as uploaded only after the server confirms it.
            </Text>
          </Card>

          <Card>
            <Text style={styles.sectionTitle}>What happens next</Text>
            <View style={{ gap: 14 }}>
              {nextSteps.map((step) => (
                <View
                  key={step.title}
                  style={{
                    flexDirection: "row",
                    alignItems: "flex-start",
                    gap: 12,
                  }}
                >
                  <View
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 999,
                      backgroundColor: palette.elevated,
                      borderWidth: 1,
                      borderColor: palette.lineStrong,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon name={step.icon} size={14} color={palette.green} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.cardTitle}>{step.title}</Text>
                    <Text style={styles.smallMuted}>{step.desc}</Text>
                  </View>
                </View>
              ))}
            </View>
          </Card>
        </View>
      </View>
    </View>
  );
}

/* ============================================================================
 * 4. TIMELINE
 * ========================================================================== */
export function TimelinePanel({ api, run, busy }: Context) {
  const { width } = useWindowDimensions();
  const isTwoCol = width >= 960;

  const [timeline, setTimeline] = useState<Timeline>(),
    [source, setSource] = useState<MedicalDocument>();

  async function load(append = false) {
    const r = await api.timeline({
      limit: 20,
      offset: append ? (timeline?.entries.length ?? 0) : 0,
    });
    setTimeline(
      append && timeline
        ? { ...r, entries: [...timeline.entries, ...r.entries] }
        : r,
    );
  }

  useEffect(() => {
    void run(() => load());
  }, []);

  return (
    <View style={{ gap: 18 }}>
      <View style={styles.between}>
        <View style={{ gap: 4 }}>
          <Text style={styles.title}>Timeline</Text>
          <BodyText muted>
            Your medical history in order, newest first. Ordered by the date on
            each document, or the upload date if none was given.
          </BodyText>
        </View>
        <Button
          title="Refresh timeline"
          disabled={busy}
          secondary
          onPress={() => {
            setTimeline(undefined);
            setSource(undefined);
            void run(() => load());
          }}
        />
      </View>

      <View
        style={{
          flexDirection: isTwoCol ? "row" : "column",
          gap: 18,
          alignItems: "flex-start",
        }}
      >
        <View style={{ flex: 1.5, width: "100%", gap: 14 }}>
          {timeline?.entries.map((e) => {
            const isRx = e.document.category === "prescription";
            return (
              <Card key={e.source_document_id}>
                <View style={styles.between}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <View
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 99,
                        backgroundColor: isRx ? palette.blue : palette.green,
                      }}
                    />
                    <Text style={styles.eyebrow}>{e.event_date}</Text>
                  </View>
                  <Badge
                    label={e.document.category_label}
                    tone={isRx ? "blue" : "green"}
                  />
                </View>

                <Text style={styles.cardTitle}>
                  {e.document.original_filename}
                </Text>
                <BodyText muted>
                  {e.date_source === "document_date"
                    ? "Document date"
                    : "Upload date fallback"}{" "}
                  · {e.document.processing_status}
                </BodyText>

                <View style={{ alignItems: "flex-start" }}>
                  <Button
                    title="Open timeline source"
                    secondary
                    compact
                    disabled={busy}
                    onPress={() =>
                      void run(async () =>
                        setSource(
                          (await api.record(e.source_document_id)).document,
                        ),
                      )
                    }
                  />
                </View>
              </Card>
            );
          })}

          {source && (
            <Card style={{ borderColor: palette.greenBorder }}>
              <Text style={styles.eyebrow}>SELECTED TIMELINE SOURCE</Text>
              <Text style={styles.cardTitle}>{source.original_filename}</Text>
              <BodyText>
                {source.category_label} · {source.hospital_name} ·{" "}
                {source.processing_status}
              </BodyText>
              <BodyText muted>
                Document date: {source.document_date ?? "Not provided"}.
                Uploaded: {source.uploaded_at}
              </BodyText>
            </Card>
          )}

          {timeline && !timeline.entries.length && (
            <Card>
              <BodyText muted>No available timeline records.</BodyText>
            </Card>
          )}

          {timeline?.pagination.has_more && (
            <Button
              title="Load more timeline entries"
              secondary
              disabled={busy}
              onPress={() => void run(() => load(true))}
            />
          )}
        </View>

        <View style={{ flex: 1, width: "100%", gap: 16 }}>
          <Card>
            <Text style={styles.sectionTitle}>Track a test</Text>
            <BodyText muted>
              Follow a repeated measurement across dates as more lab reports are
              extracted into your timeline.
            </BodyText>
            <View style={styles.subCard}>
              <Text style={styles.cardTitle}>Chronological integrity</Text>
              <Text style={styles.smallMuted}>
                Deleted and restricted sources are automatically excluded by the
                backend so doctors and summaries only reflect active records.
              </Text>
            </View>
          </Card>
        </View>
      </View>
    </View>
  );
}

/* ============================================================================
 * 5. SUMMARIES (LONGITUDINAL HISTORY)
 * ========================================================================== */
export function HistoryPanel({ api, run, busy }: Context) {
  const { width } = useWindowDimensions();
  const isTwoCol = width >= 960;

  const [id, setId] = useState(""),
    [history, setHistory] = useState<History>();

  return (
    <View style={{ gap: 18 }}>
      <View style={styles.between}>
        <View style={{ gap: 4 }}>
          <Text style={styles.title}>Summaries</Text>
          <BodyText muted>
            A structured read-through of your uploaded reports. Every statement
            links back to the document it came from.
          </BodyText>
        </View>
        <View style={styles.row}>
          {id && (
            <Button
              title="Refresh history summary"
              secondary
              disabled={busy}
              onPress={() =>
                void run(async () => setHistory((await api.history(id)).history))
              }
            />
          )}
          <Button
            title="Request history summary"
            icon="summaries"
            disabled={busy}
            onPress={() => {
              setHistory(undefined);
              void run(async () => {
                const result = await api.requestHistory();
                setId(result.history.id);
                setHistory((await api.history(result.history.id)).history);
              });
            }}
          />
        </View>
      </View>

      <View
        style={{
          flexDirection: isTwoCol ? "row" : "column",
          gap: 18,
          alignItems: "flex-start",
        }}
      >
        <View style={{ flex: 1.5, width: "100%", gap: 16 }}>
          <Card>
            <View style={styles.between}>
              <Text style={styles.sectionTitle}>Longitudinal summary</Text>
              {history && (
                <BodyText>Status: {history.status ?? "Unavailable"}</BodyText>
              )}
            </View>
            <BodyText muted>
              Available lab evidence is summarized in separate source sections.
              Unsupported or contradictory evidence is not inferred.
            </BodyText>

            {history && (
              <View style={{ gap: 14 }}>
                {history.status === "failed" && (
                  <View style={styles.subCard}>
                    <BodyText>
                      Summary processing failed. No completed history is
                      available.
                    </BodyText>
                  </View>
                )}

                {history.entries.map((e) => (
                  <View key={e.source_document_id} style={styles.subCard}>
                    <Text style={styles.eyebrow}>
                      {e.date} · {e.date_source}
                    </Text>
                    <BodyText>
                      {e.text ?? "Insufficient supported evidence."}
                    </BodyText>
                    <View style={{ alignItems: "flex-start", marginTop: 4 }}>
                      <Button
                        title="Check history source"
                        secondary
                        compact
                        disabled={busy}
                        onPress={() =>
                          void run(async () => {
                            const record = (
                              await api.record(e.source_document_id)
                            ).document;
                            Alert.alert(
                              "Source record",
                              record.original_filename +
                                " · " +
                                record.hospital_name,
                            );
                          })
                        }
                      />
                    </View>
                  </View>
                ))}

                {!history.entries.length && (
                  <BodyText muted>No completed source sections yet.</BodyText>
                )}

                {history.limitations?.map((l) => (
                  <Text key={l} style={styles.smallMuted}>
                    {l}
                  </Text>
                ))}
              </View>
            )}
          </Card>
        </View>

        <View style={{ flex: 1, width: "100%" }}>
          <Card>
            <Text style={styles.sectionTitle}>How this is written</Text>
            <View style={{ gap: 10 }}>
              <Text style={styles.muted}>
                • Written only from the documents in your account. Nothing is
                assumed or filled in.
              </Text>
              <Text style={styles.muted}>
                • If two reports disagree, both are shown rather than choosing
                between them.
              </Text>
              <Text style={styles.muted}>
                • Does not diagnose conditions, suggest medicines or replace a
                doctor.
              </Text>
            </View>
          </Card>
        </View>
      </View>
    </View>
  );
}

/* ============================================================================
 * 6. ASK RECORDS (RAG Q&A)
 * ========================================================================== */
export function RagPanel({
  api,
  run,
  busy,
  onNavigate,
}: Context & { onNavigate?: (tab: TabKey) => void }) {
  const { width } = useWindowDimensions();
  const isTwoCol = width >= 960;

  const [question, setQuestion] = useState(""),
    [result, setResult] = useState<RagResult>();

  const promptSuggestions = [
    "Why was my last Vitamin D flagged?",
    "Has my HbA1c gone down?",
    "What is my current Vitamin D dose?",
    "What did my complete blood count show?",
  ];

  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>Ask your records</Text>
        <BodyText muted>
          Questions are answered only from the documents you have uploaded.
          Every answer cites its source.
        </BodyText>
      </View>

      <View
        style={{
          flexDirection: isTwoCol ? "row" : "column",
          gap: 18,
          alignItems: "flex-start",
        }}
      >
        <View style={{ flex: 1.5, width: "100%", gap: 16 }}>
          <Card>
            <View style={styles.row}>
              {promptSuggestions.map((prompt) => (
                <Pressable
                  key={prompt}
                  accessibilityRole="button"
                  accessibilityLabel={prompt}
                  onPress={() => setQuestion(prompt)}
                  style={{
                    backgroundColor: palette.elevated,
                    borderWidth: 1,
                    borderColor: palette.lineStrong,
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                    borderRadius: 999,
                  }}
                >
                  <Text style={{ fontSize: 12, color: palette.inkSecondary }}>
                    {prompt}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Field
              label="Question about your records"
              value={question}
              onChange={setQuestion}
              multiline
              placeholder="Ask something about your records..."
            />

            <View style={styles.between}>
              <Text style={styles.smallMuted}>
                Grounded retrieval · zero external medical guessing
              </Text>
              <Button
                title="Ask my records"
                icon="send"
                disabled={busy || !question.trim()}
                onPress={() => {
                  setResult(undefined);
                  void run(async () =>
                    setResult((await api.ask(question)).result),
                  );
                }}
              />
            </View>
          </Card>

          {result && (
            <Card style={{ borderColor: palette.greenBorder }}>
              <View style={styles.between}>
                <Text style={styles.eyebrow}>
                  {result.status === "insufficient"
                    ? "INSUFFICIENT EVIDENCE"
                    : "GROUNDED RESPONSE"}
                </Text>
                <Badge label={`Mode: ${result.mode}`} tone="green" />
              </View>

              <BodyText>{result.answer}</BodyText>

              {result.citations.length > 0 && (
                <View style={{ gap: 10, marginTop: 4 }}>
                  <Text style={styles.eyebrow}>CITATIONS</Text>
                  {result.citations.map((c) => (
                    <View key={c.id} style={styles.subCard}>
                      <View style={styles.between}>
                        <Text style={styles.cardTitle}>
                          {c.id} · {c.document_name}
                        </Text>
                        <Text style={styles.smallMuted}>
                          {c.document_date ?? c.upload_date?.slice(0, 10)} ·{" "}
                          {c.page === null
                            ? "Page unavailable"
                            : `Page ${c.page}`}
                        </Text>
                      </View>
                      <BodyText muted>“{c.quote}”</BodyText>
                      <View style={{ alignItems: "flex-start" }}>
                        <Button
                          title={"Check citation " + c.id}
                          secondary
                          compact
                          disabled={busy}
                          onPress={() =>
                            void run(async () => {
                              const record = (await api.record(c.document_id))
                                .document;
                              Alert.alert(
                                "Citation source",
                                record.original_filename +
                                  " · " +
                                  record.hospital_name,
                              );
                            })
                          }
                        />
                      </View>
                    </View>
                  ))}
                </View>
              )}

              {!result.citations.length && (
                <BodyText muted>No supporting citations available.</BodyText>
              )}
            </Card>
          )}
        </View>

        <View style={{ flex: 1, width: "100%", gap: 16 }}>
          <Card>
            <Text style={styles.sectionTitle}>What it can do</Text>
            <View style={{ gap: 10 }}>
              <Text style={styles.muted}>
                • Find values, dates, reference ranges and doctor notes in your
                files.
              </Text>
              <Text style={styles.muted}>
                • Compare numbers across dates and point to each report it used.
              </Text>
              <Text style={styles.muted}>
                • Say so plainly when your records do not contain the answer.
              </Text>
            </View>
          </Card>

          <Card>
            <Text style={styles.sectionTitle}>What it will not do</Text>
            <BodyText muted>
              It will not diagnose, tell you whether to change a dose, or use
              anything outside your uploaded records.
            </BodyText>
            {onNavigate && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="See all records"
                onPress={() => onNavigate("Records")}
              >
                <Text style={styles.link}>See all records →</Text>
              </Pressable>
            )}
          </Card>
        </View>
      </View>
    </View>
  );
}

/* ============================================================================
 * 7. SHARING
 * ========================================================================== */
export function SharingPanel({
  api,
  run,
  busy,
  live,
  onGrantsChanged,
}: Context & { onGrantsChanged?: () => void }) {
  const { width } = useWindowDimensions();
  const isTwoCol = width >= 960;

  const [records, setRecords] = useState<MedicalDocument[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [grants, setGrants] = useState<Grant[]>([]),
    [created, setCreated] = useState<CreatedGrant>(),
    [method, setMethod] = useState("unique_link"),
    [more, setMore] = useState(false),
    [now, setNow] = useState(Date.now());

  async function load() {
    setSelected([]);
    setCreated(undefined);
    const [r, g] = await Promise.all([
      api.records({ limit: 100 }),
      api.grants(),
    ]);
    if (live()) {
      setRecords(r.documents);
      setMore(r.pagination.has_more);
      setGrants(g.grants);
    }
  }

  useEffect(() => {
    void run(load);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (created && grantState(created.grant, now) !== "Active")
      setCreated(undefined);
  }, [created, now]);

  return (
    <View style={{ gap: 18 }}>
      <View style={styles.between}>
        <View style={{ gap: 4 }}>
          <Text style={styles.title}>Sharing</Text>
          <BodyText muted>
            Share specific records with a doctor using a link or QR code. Every
            share expires and can be turned off immediately.
          </BodyText>
        </View>
        <Button
          title="Refresh shares & selection"
          secondary
          disabled={busy}
          onPress={() => void run(load)}
        />
      </View>

      <View
        style={{
          flexDirection: isTwoCol ? "row" : "column",
          gap: 18,
          alignItems: "flex-start",
        }}
      >
        <Card style={{ flex: 1.4, width: "100%" }}>
          <View style={styles.between}>
            <View>
              <Text style={styles.sectionTitle}>Create a share</Text>
              <Text style={styles.smallMuted}>
                Nothing is selected by default. Each grant includes only the
                records you select.
              </Text>
            </View>
            <Badge
              label={`${selected.length} of 20 selected`}
              tone={selected.length > 0 ? "green" : "neutral"}
            />
          </View>

          <Choices
            label="Sharing method"
            value={method}
            values={{ unique_link: "Online link", qr_code: "QR code" }}
            onChange={setMethod}
          />

          <View style={{ gap: 8 }}>
            <Text style={styles.label}>Records to include</Text>
            {records.map((d) => {
              const isChecked = selected.includes(d.id);
              return (
                <Button
                  key={d.id}
                  title={`${isChecked ? "✓ " : ""}${d.original_filename}`}
                  secondary={!isChecked}
                  disabled={busy}
                  onPress={() => {
                    setCreated(undefined);
                    setSelected((ids) =>
                      ids.includes(d.id)
                        ? ids.filter((i) => i !== d.id)
                        : [...ids, d.id],
                    );
                  }}
                />
              );
            })}
            {more && (
              <Button
                title="Load more selectable records"
                secondary
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    const r = await api.records({
                      limit: 100,
                      offset: records.length,
                    });
                    setRecords([...records, ...r.documents]);
                    setMore(r.pagination.has_more);
                  })
                }
              />
            )}
          </View>

          <BodyText>{selected.length} records selected (maximum 20)</BodyText>

          <Button
            title="Create selected-record share"
            icon="sharing"
            disabled={busy || !selected.length || selected.length > 20}
            onPress={() => {
              setCreated(undefined);
              void run(async () => {
                const grant = await api.share(
                  [...selected],
                  method as "qr_code" | "unique_link",
                );
                if (live()) {
                  setCreated(grant);
                  setSelected([]);
                  setGrants((await api.grants()).grants);
                  onGrantsChanged?.();
                }
              });
            }}
          />

          {created && (
            <View
              style={[
                styles.subCard,
                { borderColor: palette.greenBorder, gap: 12 },
              ]}
            >
              <BodyText>
                Share created · expires{" "}
                {new Date(created.grant.expires_at).toLocaleString()}
              </BodyText>
              {created.qr_svg && (
                <View
                  style={{
                    backgroundColor: "#fff",
                    padding: 12,
                    borderRadius: 12,
                    alignSelf: "flex-start",
                  }}
                >
                  <SvgXml
                    xml={created.qr_svg}
                    width={200}
                    height={200}
                    accessibilityLabel="Backend-generated selected-record share QR code"
                  />
                </View>
              )}
              <View style={styles.row}>
                <Button
                  title="Copy link"
                  icon="copy"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      if (grantState(created.grant) !== "Active") {
                        setCreated(undefined);
                        throw new InputError(
                          "This share has expired. Create a new share.",
                        );
                      }
                      if (
                        !(await Clipboard.setStringAsync(created.share_url))
                      )
                        throw new InputError(
                          "The link could not be copied on this device.",
                        );
                    }, "Link copied. Keep your clipboard private; expiry and revocation remain enforced by the backend.")
                  }
                />
                <Button
                  title="Share link"
                  secondary
                  onPress={() =>
                    void run(async () => {
                      if (grantState(created.grant) !== "Active") {
                        setCreated(undefined);
                        throw new InputError(
                          "This share has expired. Create a new share.",
                        );
                      }
                      await Share.share({ message: created.share_url });
                    })
                  }
                />
              </View>
              <Text style={styles.smallMuted}>
                The opaque link is held only on this screen until copied or
                shared explicitly. Clipboard and exported copies remain outside
                app control.
              </Text>
            </View>
          )}
        </Card>

        <View style={{ flex: 1, width: "100%", gap: 14 }}>
          <Card>
            <Text style={styles.sectionTitle}>Your shares</Text>
            <BodyText muted>
              Active links can be revoked immediately. Expired links stop
              working automatically.
            </BodyText>

            {grants.map((g) => {
              const state = grantState(g, now);
              const isActive = state === "Active";
              return (
                <View key={g.id} style={styles.subCard}>
                  <View style={styles.between}>
                    <Text style={styles.cardTitle}>
                      {g.sharing_method === "qr_code"
                        ? "QR share"
                        : "Online link"}
                    </Text>
                    <Badge
                      label={state}
                      tone={
                        isActive
                          ? "green"
                          : state === "Revoked"
                            ? "danger"
                            : "neutral"
                      }
                    />
                  </View>
                  <Text style={styles.smallMuted}>
                    Created {new Date(g.created_at).toLocaleString()}
                  </Text>
                  <Text style={styles.smallMuted}>
                    Expires {new Date(g.expires_at).toLocaleString()}
                  </Text>
                  {isActive && (
                    <View style={{ alignItems: "flex-start", marginTop: 4 }}>
                      <Button
                        title="Revoke share"
                        danger
                        compact
                        disabled={busy}
                        onPress={() =>
                          confirm(
                            "Revoke this share?",
                            "The doctor will lose access on the next request. Files already exported cannot be recalled.",
                            () =>
                              void run(async () => {
                                await api.revoke(g.id);
                                setCreated(undefined);
                                setGrants((await api.grants()).grants);
                                onGrantsChanged?.();
                              }, "Share revoked."),
                          )
                        }
                      />
                    </View>
                  )}
                </View>
              );
            })}

            {!grants.length && !busy && (
              <BodyText muted>No sharing grants yet.</BodyText>
            )}
          </Card>
        </View>
      </View>
    </View>
  );
}

/* ============================================================================
 * 8. PROFILE & ACCOUNT
 * ========================================================================== */
export function ProfilePanel({
  api,
  run,
  busy,
  session,
  onProfileUpdated,
}: Context & { onProfileUpdated?: (p: Profile) => void }) {
  const { width } = useWindowDimensions();
  const isTwoCol = width >= 920;

  const [profile, setProfile] = useState<Profile>(),
    [guardian, setGuardian] = useState<Guardian>(),
    [name, setName] = useState(""),
    [dob, setDob] = useState(""),
    [dobError, setDobError] = useState(""),
    [phone, setPhone] = useState(""),
    [sex, setSex] = useState(""),
    [guardianEmail, setGuardianEmail] = useState("");

  const loadGuardian = async () => setGuardian((await api.guardian()).guardian);

  useEffect(() => {
    void run(async () => {
      const p = (await api.profile()).patient;
      setProfile(p);
      onProfileUpdated?.(p);
      setName(p.full_name);
      setDob(p.date_of_birth ?? "");
      setPhone(p.phone_number ?? "");
      setSex(p.sex_gender ?? "");
      await loadGuardian();
    });
  }, []);

  const sectionLinks = [
    { icon: "profile", label: "Personal details" },
    { icon: "users", label: "Guardian" },
    { icon: "lock", label: "Sign-in and devices" },
    { icon: "trash", label: "Delete account" },
  ];

  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>Profile</Text>
        <BodyText muted>
          Your account details, emergency contact and privacy controls.
        </BodyText>
      </View>

      <View
        style={{
          flexDirection: isTwoCol ? "row" : "column",
          gap: 20,
          alignItems: "flex-start",
        }}
      >
        {isTwoCol && (
          <View style={{ width: 210, gap: 6 }}>
            {sectionLinks.map((item) => (
              <View
                key={item.label}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingVertical: 9,
                  paddingHorizontal: 12,
                  borderRadius: 8,
                }}
              >
                <Icon name={item.icon} size={15} color={palette.muted} />
                <Text style={{ fontSize: 13, color: palette.inkSecondary }}>
                  {item.label}
                </Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ flex: 1, width: "100%", gap: 18 }}>
          <Card>
            <View style={styles.between}>
              <View>
                <Text style={styles.sectionTitle}>Personal details</Text>
                {profile && (
                  <Text style={styles.smallMuted}>
                    {profile.email} · email cannot be edited here
                  </Text>
                )}
              </View>
              <Badge label="Verified account" tone="green" />
            </View>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
              <View style={{ flex: 1, minWidth: 210 }}>
                <Field label="Full name" value={name} onChange={setName} />
              </View>
              <View style={{ flex: 1, minWidth: 210 }}>
                <Field
                  label="Date of birth (e.g. 2026-11-09 or 9/11/2026)"
                  value={dob}
                  onChange={(v) => {
                    setDob(v);
                    setDobError("");
                  }}
                  error={dobError}
                />
              </View>
            </View>

            <Field
              label="Phone (optional)"
              value={phone}
              onChange={setPhone}
              keyboard="phone-pad"
            />

            <Choices
              label="Sex / gender"
              value={sex}
              values={{
                "": "Not provided",
                female: "Female",
                male: "Male",
                other: "Other",
                prefer_not_to_say: "Prefer not to say",
              }}
              onChange={setSex}
            />

            <View style={styles.between}>
              <Text style={styles.smallMuted}>
                Some labs print different reference ranges by sex. This helps
                match them.
              </Text>
              <Button
                title="Save profile"
                disabled={busy || !profile}
                onPress={() => {
                  const birth = checkDate(dob, "birth");
                  setDobError(birth.error);
                  if (birth.error) return;
                  void run(async () => {
                    const updated = (
                      await api.updateProfile({
                        full_name: name,
                        date_of_birth: birth.value || null,
                        phone_number: phone || null,
                        sex_gender: sex || null,
                      })
                    ).patient;
                    setProfile(updated);
                    onProfileUpdated?.(updated);
                  }, "Profile updated.");
                }}
              />
            </View>
          </Card>

          <Card>
            <View style={styles.between}>
              <View>
                <Text style={styles.sectionTitle}>Guardian</Text>
                <Text style={styles.smallMuted}>
                  Someone who can be contacted about your records. They get no
                  access unless you share with them.
                </Text>
              </View>
              <BodyText>Status: {guardian?.status ?? "Loading"}</BodyText>
            </View>

            {guardian?.email && (
              <View style={styles.subCard}>
                <BodyText>{guardian.email}</BodyText>
              </View>
            )}

            <BodyText muted>
              Replacement requires new consent. Guardian medical notifications
              remain separately gated.
            </BodyText>

            <Field
              label="Guardian email"
              value={guardianEmail}
              onChange={setGuardianEmail}
              keyboard="email-address"
              placeholder="guardian@example.com"
            />

            <View style={styles.row}>
              <Button
                title={
                  guardian && ["PENDING", "ACTIVE"].includes(guardian.status)
                    ? "Replace guardian"
                    : "Add guardian"
                }
                disabled={busy || !guardian || !guardianEmail}
                onPress={() => {
                  const replacement =
                    !!guardian &&
                    ["PENDING", "ACTIVE"].includes(guardian.status);
                  const perform = () =>
                    void run(async () => {
                      await api.setGuardian(guardianEmail, replacement);
                      setGuardianEmail("");
                      await loadGuardian();
                    }, "Guardian invitation pending acceptance.");
                  if (replacement)
                    confirm(
                      "Replace guardian?",
                      "The previous guardian loses access immediately. New acceptance is required.",
                      perform,
                    );
                  else perform();
                }}
              />

              {guardian?.status === "PENDING" && (
                <Button
                  title="Resend guardian invitation"
                  disabled={busy}
                  secondary
                  onPress={() =>
                    void run(async () => {
                      await api.resendGuardian();
                      await loadGuardian();
                    }, "Invitation resend requested. Wait before requesting another.")
                  }
                />
              )}

              {guardian && ["PENDING", "ACTIVE"].includes(guardian.status) && (
                <Button
                  title="Remove guardian"
                  disabled={busy}
                  danger
                  onPress={() =>
                    confirm(
                      "Remove guardian?",
                      "Their current consent will be revoked.",
                      () =>
                        void run(async () => {
                          await api.removeGuardian();
                          await loadGuardian();
                        }, "Guardian removed."),
                    )
                  }
                />
              )}

              <Button
                title="Refresh guardian status"
                disabled={busy}
                secondary
                onPress={() => void run(loadGuardian)}
              />
            </View>
          </Card>

          <Card>
            <View style={styles.between}>
              <Text style={styles.sectionTitle}>Sign-in and devices</Text>
              <Button
                title="Sign out of this device"
                secondary
                compact
                onPress={() =>
                  void session.logout().catch(() => {
                    session.clear();
                  })
                }
              />
            </View>
            <View
              style={[
                styles.subCard,
                {
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                },
              ]}
            >
              <View>
                <Text style={styles.cardTitle}>Current session</Text>
                <Text style={styles.smallMuted}>
                  Active now · Encrypted token storage
                </Text>
              </View>
              <Badge label="This device" tone="green" />
            </View>
          </Card>

          <DeletionRequestCard
            api={api}
            session={session}
            run={run}
            busy={busy}
          />
        </View>
      </View>
    </View>
  );
}

function DeletionRequestCard({
  api,
  session,
  run,
  busy,
}: Pick<Context, "api" | "session" | "run" | "busy">) {
  const [open, setOpen] = useState(false),
    [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [result, setResult] = useState<DeletionRequestResult>();

  if (result)
    return (
      <Card style={{ borderColor: palette.dangerBorder }}>
        <Text style={styles.eyebrow}>DELETION REQUESTED</Text>
        <BodyText>
          Your request was received. Access to this account has ended: every
          sign-in, doctor share and guardian link was stopped.
        </BodyText>
        <BodyText muted>
          Nothing has been permanently deleted yet. The rules for how long data
          is kept and when it is erased are still waiting for a legal decision.
          {result.deletion_request.state === "blocked_legal_hold"
            ? " A legal hold is active, so deletion stays blocked until it is released."
            : ""}
        </BodyText>
        <Button
          title="Sign out"
          onPress={() =>
            void session.logout().catch(() => {
              session.clear();
            })
          }
        />
      </Card>
    );

  const ready = password.length > 0 && confirmation === DELETION_CONFIRMATION;

  return (
    <Card style={{ borderColor: palette.dangerBorder }}>
      <Text style={[styles.sectionTitle, { color: palette.danger }]}>
        Request account deletion
      </Text>
      <BodyText muted>
        If you continue, your access ends right away: you are signed out
        everywhere, doctor shares stop and your guardian link is removed. You
        cannot undo this from the app. Nothing is permanently deleted yet,
        because the deletion and retention rules are still waiting for a legal
        decision. Individual document access can be removed from the record
        library.
      </BodyText>
      {!open ? (
        <View style={{ alignItems: "flex-start" }}>
          <Button
            title="Start deletion request"
            danger
            icon="trash"
            disabled={busy}
            onPress={() => setOpen(true)}
          />
        </View>
      ) : (
        <>
          <Field
            label="Current password"
            value={password}
            onChange={setPassword}
            secret
          />
          <Field
            label={"Type " + DELETION_CONFIRMATION + " to confirm"}
            value={confirmation}
            onChange={setConfirmation}
          />
          <View style={styles.row}>
            <Button
              title="Submit deletion request"
              danger
              disabled={busy || !ready}
              onPress={() =>
                confirm(
                  "Request account deletion?",
                  "Your access ends immediately. This cannot be undone from the app.",
                  () =>
                    void run(async () => {
                      try {
                        setResult(
                          await api.requestAccountDeletion(
                            password,
                            confirmation,
                          ),
                        );
                      } finally {
                        setPassword("");
                      }
                    }),
                )
              }
            />
            <Button
              title="Cancel"
              secondary
              disabled={busy}
              onPress={() => {
                setOpen(false);
                setPassword("");
                setConfirmation("");
              }}
            />
          </View>
        </>
      )}
    </Card>
  );
}
