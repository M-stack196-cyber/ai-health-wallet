import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, ScrollView, Share, Text, View } from "react-native";
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
import { Button, Card, Field, BodyText, Notice, Choices, styles } from "./ui";
export function PatientWorkspace({ session }: { session: PatientSession }) {
  const [tab, setTab] = useState("Records");
  const [notice, setNotice] = useState("");
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.body}
    >
      <View style={styles.row}>
        <Text style={styles.brand}>✚ healthwallet</Text>
        <Button
          title="Log out"
          secondary
          onPress={() =>
            void session.logout().catch(() => {
              session.clear();
            })
          }
        />
      </View>
      <Text style={styles.eyebrow}>PATIENT WORKSPACE · DEVELOPMENT</Text>
      <View style={styles.row}>
        {[
          "Records",
          "Upload",
          "Timeline",
          "Summaries",
          "Ask records",
          "Sharing",
          "Profile",
        ].map((t) => (
          <Button
            key={t}
            title={t}
            secondary={tab !== t}
            onPress={() => {
              setNotice("");
              setTab(t);
            }}
          />
        ))}
      </View>
      <Text style={styles.title}>{tab}</Text>
      <Notice message={notice} />
      <Panel key={tab} session={session}>
        {(context) =>
          tab === "Profile" ? (
            <ProfilePanel {...context} />
          ) : tab === "Upload" ? (
            <UploadPanel
              {...context}
              onUploaded={() => {
                setTab("Records");
                setNotice(
                  "Original uploaded. Extraction and AI completion are separate.",
                );
              }}
            />
          ) : tab === "Records" ? (
            <RecordsPanel {...context} />
          ) : tab === "Timeline" ? (
            <TimelinePanel {...context} />
          ) : tab === "Summaries" ? (
            <HistoryPanel {...context} />
          ) : tab === "Ask records" ? (
            <RagPanel {...context} />
          ) : (
            <SharingPanel {...context} />
          )
        }
      </Panel>
      <BodyText muted>{medicalNotice}</BodyText>
    </ScrollView>
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
      <View key={reset} style={{ gap: 16 }}>
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
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: "Confirm", style: "destructive", onPress: action },
  ]);
}
export function ProfilePanel({ api, run, busy, session }: Context) {
  const [profile, setProfile] = useState<Profile>(),
    [guardian, setGuardian] = useState<Guardian>(),
    [name, setName] = useState(""),
    [dob, setDob] = useState(""),
    [phone, setPhone] = useState(""),
    [sex, setSex] = useState(""),
    [guardianEmail, setGuardianEmail] = useState("");
  const loadGuardian = async () => setGuardian((await api.guardian()).guardian);
  useEffect(() => {
    void run(async () => {
      const p = (await api.profile()).patient;
      setProfile(p);
      setName(p.full_name);
      setDob(p.date_of_birth ?? "");
      setPhone(p.phone_number ?? "");
      setSex(p.sex_gender ?? "");
      await loadGuardian();
    });
  }, []);
  return (
    <>
      <Card>
        <Text style={styles.eyebrow}>YOUR PROFILE</Text>
        {profile && (
          <BodyText>{profile.email} · email cannot be edited here</BodyText>
        )}
        <Field label="Full name" value={name} onChange={setName} />
        <Field
          label="Date of birth (YYYY-MM-DD)"
          value={dob}
          onChange={setDob}
        />
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
        <Button
          title="Save profile"
          disabled={busy || !profile}
          onPress={() =>
            void run(async () => {
              setProfile(
                (
                  await api.updateProfile({
                    full_name: name,
                    date_of_birth: dob || null,
                    phone_number: phone || null,
                    sex_gender: sex || null,
                  })
                ).patient,
              );
            }, "Profile updated.")
          }
        />
      </Card>
      <Card>
        <Text style={styles.eyebrow}>GUARDIAN</Text>
        <BodyText>Status: {guardian?.status ?? "Loading"}</BodyText>
        {guardian?.email && <BodyText>{guardian.email}</BodyText>}
        <BodyText muted>
          Replacement requires new consent. Guardian medical notifications
          remain separately gated.
        </BodyText>
        <Field
          label="Guardian email"
          value={guardianEmail}
          onChange={setGuardianEmail}
          keyboard="email-address"
        />
        <Button
          title={
            guardian && ["PENDING", "ACTIVE"].includes(guardian.status)
              ? "Replace guardian"
              : "Add guardian"
          }
          disabled={busy || !guardian || !guardianEmail}
          onPress={() => {
            const replacement =
              !!guardian && ["PENDING", "ACTIVE"].includes(guardian.status);
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
            secondary
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
      </Card>
      <DeletionRequestCard api={api} session={session} run={run} busy={busy} />
    </>
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
      <Card>
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
    <Card>
      <Text style={styles.eyebrow}>PRIVACY & ACCOUNT</Text>
      <BodyText>Request account deletion</BodyText>
      <BodyText muted>
        If you continue, your access ends right away: you are signed out
        everywhere, doctor shares stop and your guardian link is removed. You
        cannot undo this from the app. Nothing is permanently deleted yet,
        because the deletion and retention rules are still waiting for a legal
        decision. Individual document access can be removed from the record
        library.
      </BodyText>
      {!open ? (
        <Button
          title="Start deletion request"
          secondary
          disabled={busy}
          onPress={() => setOpen(true)}
        />
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
          <Button
            title="Submit deletion request"
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
        </>
      )}
    </Card>
  );
}
export function UploadPanel({
  api,
  run,
  busy,
  live,
  onUploaded,
}: Context & { onUploaded: () => void }) {
  const [asset, setAsset] = useState<DocumentPicker.DocumentPickerAsset>(),
    [category, setCategory] = useState<Category>("lab_report"),
    [hospital, setHospital] = useState(""),
    [date, setDate] = useState("");
  async function pick() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/jpeg", "image/png"],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return;
    const next = result.assets[0];
    if (!live()) {
      new File(next.uri).delete();
      return;
    }
    try {
      validateFile(next.name, next.mimeType ?? "");
      if (asset) {
        const previous = new File(asset.uri);
        if (previous.exists) previous.delete();
      }
      setAsset(next);
    } catch (e) {
      new File(next.uri).delete();
      throw e;
    }
  }
  const assetRef = useRef(asset);
  assetRef.current = asset;
  useEffect(
    () => () => {
      if (assetRef.current) {
        const f = new File(assetRef.current.uri);
        if (f.exists) f.delete();
      }
    },
    [],
  );
  async function upload() {
    if (!asset) throw new InputError("Choose a file first.");
    validateFile(asset.name, asset.mimeType ?? "");
    if (!hospital.trim()) throw new InputError("Enter the hospital name.");
    await api.upload(
      pickedForm(asset, {
        category,
        hospital_name: hospital.trim(),
        ...(date ? { document_date: date } : {}),
      }),
    );
    if (live()) onUploaded();
  }
  return (
    <Card>
      <BodyText muted>
        Your original is preserved privately. The server validates size, format,
        signature and integrity.
      </BodyText>
      <Button
        title={
          asset ? "Choose a different file" : "Choose PDF, JPG, JPEG or PNG"
        }
        secondary
        disabled={busy}
        onPress={() => void run(pick)}
      />
      {asset && (
        <BodyText>
          {asset.name} · {asset.size ?? "Unknown"} bytes
        </BodyText>
      )}
      <Choices
        label="Category"
        value={category}
        values={categories}
        onChange={(v) => setCategory(v as Category)}
      />
      <Field label="Hospital name" value={hospital} onChange={setHospital} />
      <Field
        label="Document date (YYYY-MM-DD, optional)"
        value={date}
        onChange={setDate}
      />
      <Button
        title={busy ? "Uploading / validating…" : "Upload original"}
        disabled={busy || !asset}
        onPress={() => void run(upload)}
      />
      <BodyText muted>
        Upload activity is indeterminate; completion is shown only after server
        confirmation.
      </BodyText>
    </Card>
  );
}
export function RecordsPanel(context: Context) {
  const { api, run, busy, live } = context;
  const [records, setRecords] = useState<MedicalDocument[]>([]),
    [more, setMore] = useState(false),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [hospital, setHospital] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [detail, setDetail] = useState<MedicalDocument>();
  async function load(append = false) {
    const r = await api.records({
      limit: 20,
      offset: append ? records.length : 0,
      category: (category as Category) || undefined,
      hospital: hospital || undefined,
      uploaded_from: from || undefined,
      uploaded_to: to || undefined,
    });
    if (live()) {
      setRecords(append ? [...records, ...r.documents] : r.documents);
      setMore(r.pagination.has_more);
    }
  }
  useEffect(() => {
    void run(() => load());
  }, []);
  return (
    <>
      <Card>
        <Field
          label="Search loaded records"
          value={search}
          onChange={setSearch}
        />
        <Choices
          label="Category filter"
          value={category}
          values={{ "": "All", ...categories }}
          onChange={setCategory}
        />
        <Field
          label="Hospital filter"
          value={hospital}
          onChange={setHospital}
        />
        <Field
          label="Uploaded from (YYYY-MM-DD)"
          value={from}
          onChange={setFrom}
        />
        <Field label="Uploaded to (YYYY-MM-DD)" value={to} onChange={setTo} />
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
        <BodyText muted>
          Search matches the loaded page. Load more for additional results.
        </BodyText>
      </Card>
      {searchLoaded(records, search).map((d) => (
        <Card key={d.id}>
          <Text style={styles.eyebrow}>{d.category_label}</Text>
          <BodyText>{d.original_filename}</BodyText>
          <BodyText muted>
            {d.hospital_name} · {d.document_date ?? d.uploaded_at.slice(0, 10)}{" "}
            · {d.processing_status}
          </BodyText>
          <Button
            title={"Open " + d.original_filename}
            secondary
            disabled={busy}
            onPress={() =>
              void run(async () => {
                setDetail(undefined);
                setDetail((await api.record(d.id)).document);
              })
            }
          />
        </Card>
      ))}
      {!records.length && !busy && (
        <BodyText>No available records match the filters.</BodyText>
      )}
      {more && (
        <Button
          title="Load more records"
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
          }}
        />
      )}
    </>
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
    <Card>
      <Text style={styles.eyebrow}>RECORD DETAILS</Text>
      <BodyText>{d.original_filename}</BodyText>
      <BodyText muted>
        {d.content_type} · {d.size_bytes} bytes · Uploaded{" "}
        {new Date(d.uploaded_at).toLocaleString()}
      </BodyText>
      <BodyText>
        Extraction: {processing?.status ?? "Not loaded"}
        {processing?.failure_code
          ? ` · ${processing.failure_code.replaceAll("_", " ")}`
          : ""}
      </BodyText>
      <BodyText muted>
        Extraction readiness does not imply OCR/AI completion.
      </BodyText>
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
      {processing?.retry_allowed ? (
        <Button
          title="Retry extraction"
          disabled={busy}
          onPress={() =>
            void run(async () => {
              await api.retry(d.id);
              setProcessing((await api.processing(d.id)).processing);
            }, "Retry accepted by backend.")
          }
        />
      ) : (
        <BodyText muted>
          Retry is not currently approved or available for this source.
        </BodyText>
      )}
      <Button
        title="View / download original"
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
      <Choices
        label="Document category"
        value={category}
        values={categories}
        onChange={(v) => setCategory(v as Category)}
      />
      <Field label="Hospital name" value={hospital} onChange={setHospital} />
      <Field
        label="Document date (YYYY-MM-DD, optional)"
        value={date}
        onChange={setDate}
      />
      <Button
        title="Save document metadata"
        secondary
        disabled={busy}
        onPress={() =>
          void run(async () => {
            await api.metadata(d.id, {
              category,
              hospital_name: hospital,
              document_date: date || null,
            });
            setSummary(undefined);
          }, "Metadata updated. Refresh the record library for current dates.")
        }
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
      {job && (
        <>
          <BodyText>Summary job: {job.status}</BodyText>
          <Button
            title="Refresh summary job"
            secondary
            disabled={busy}
            onPress={() =>
              void run(async () => setJob((await api.summaryJob(job.id)).job))
            }
          />
          {job.status === "failed" && (
            <Button
              title="Retry summary job"
              secondary
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  await api.retrySummary(job.id);
                  setJob((await api.summaryJob(job.id)).job);
                })
              }
            />
          )}
        </>
      )}
      {summary && <SummaryCard summary={summary} />}
      <Button
        title="Delete record access"
        secondary
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
    </Card>
  );
}
function SummaryCard({ summary }: { summary: Summary }) {
  return (
    <View style={{ gap: 10 }}>
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
export function TimelinePanel({ api, run, busy }: Context) {
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
    <>
      <BodyText muted>
        Newest first · document date, otherwise UTC upload date. Deleted and
        restricted sources are excluded by the backend.
      </BodyText>
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
      {timeline?.entries.map((e) => (
        <Card key={e.source_document_id}>
          <Text style={styles.eyebrow}>{e.event_date}</Text>
          <BodyText>{e.document.original_filename}</BodyText>
          <BodyText muted>
            {e.date_source === "document_date"
              ? "Document date"
              : "Upload date fallback"}{" "}
            · {e.document.processing_status}
          </BodyText>
          <Button
            title="Open timeline source"
            secondary
            disabled={busy}
            onPress={() =>
              void run(async () =>
                setSource((await api.record(e.source_document_id)).document),
              )
            }
          />
        </Card>
      ))}
      {source && (
        <Card>
          <BodyText>{source.original_filename}</BodyText>
          <BodyText>
            {source.category_label} · {source.hospital_name} ·{" "}
            {source.processing_status}
          </BodyText>
          <BodyText muted>
            Document date: {source.document_date ?? "Not provided"}. Uploaded:{" "}
            {source.uploaded_at}
          </BodyText>
        </Card>
      )}
      {timeline && !timeline.entries.length && (
        <BodyText>No available timeline records.</BodyText>
      )}
      {timeline?.pagination.has_more && (
        <Button
          title="Load more timeline entries"
          disabled={busy}
          onPress={() => void run(() => load(true))}
        />
      )}
    </>
  );
}
export function HistoryPanel({ api, run, busy }: Context) {
  const [id, setId] = useState(""),
    [history, setHistory] = useState<History>();
  return (
    <>
      <Card>
        <BodyText>Longitudinal summary</BodyText>
        <BodyText muted>
          Available lab evidence is summarized in separate source sections.
          Unsupported or contradictory evidence is not inferred.
        </BodyText>
        <Button
          title="Request history summary"
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
      </Card>
      {history && (
        <Card>
          <BodyText>Status: {history.status ?? "Unavailable"}</BodyText>
          {history.status === "failed" && (
            <BodyText>
              Summary processing failed. No completed history is available.
            </BodyText>
          )}
          {history.entries.map((e) => (
            <View key={e.source_document_id} style={styles.divider}>
              <Text style={styles.eyebrow}>
                {e.date} · {e.date_source}
              </Text>
              <BodyText>
                {e.text ?? "Insufficient supported evidence."}
              </BodyText>
              <Button
                title="Check history source"
                secondary
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    const record = (await api.record(e.source_document_id))
                      .document;
                    Alert.alert(
                      "Source record",
                      record.original_filename + " · " + record.hospital_name,
                    );
                  })
                }
              />
            </View>
          ))}
          {!history.entries.length && (
            <BodyText>No completed source sections yet.</BodyText>
          )}
          {history.limitations?.map((l) => (
            <BodyText key={l} muted>
              {l}
            </BodyText>
          ))}
        </Card>
      )}
    </>
  );
}
export function RagPanel({ api, run, busy }: Context) {
  const [question, setQuestion] = useState(""),
    [result, setResult] = useState<RagResult>();
  return (
    <>
      <Card>
        <BodyText muted>
          Ask a factual question grounded in your available records. This tool
          cannot diagnose or recommend treatment.
        </BodyText>
        <Field
          label="Question about your records"
          value={question}
          onChange={setQuestion}
          multiline
        />
        <Button
          title="Ask my records"
          disabled={busy || !question.trim()}
          onPress={() => {
            setResult(undefined);
            void run(async () => setResult((await api.ask(question)).result));
          }}
        />
      </Card>
      {result && (
        <Card>
          <Text style={styles.eyebrow}>
            {result.status === "insufficient"
              ? "INSUFFICIENT EVIDENCE"
              : "GROUNDED RESPONSE"}
          </Text>
          <BodyText>{result.answer}</BodyText>
          <BodyText muted>Mode: {result.mode}</BodyText>
          {result.citations.map((c) => (
            <View key={c.id} style={styles.divider}>
              <BodyText>
                {c.id} · {c.document_name}
              </BodyText>
              <BodyText muted>
                {c.document_date ?? c.upload_date?.slice(0, 10)} ·{" "}
                {c.page === null ? "Page unavailable" : `Page ${c.page}`}
              </BodyText>
              <BodyText>“{c.quote}”</BodyText>
              <Button
                title={"Check citation " + c.id}
                secondary
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    const record = (await api.record(c.document_id)).document;
                    Alert.alert(
                      "Citation source",
                      record.original_filename + " · " + record.hospital_name,
                    );
                  })
                }
              />
            </View>
          ))}
          {!result.citations.length && (
            <BodyText>No supporting citations available.</BodyText>
          )}
        </Card>
      )}
    </>
  );
}
export function SharingPanel({ api, run, busy, live }: Context) {
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
    <>
      <Card>
        <Text style={styles.eyebrow}>CHOOSE EXACTLY WHAT TO SHARE</Text>
        <BodyText muted>
          Nothing is selected by default. Each grant includes only the records
          you select.
        </BodyText>
        {records.map((d) => (
          <Button
            key={d.id}
            title={`${selected.includes(d.id) ? "✓ " : ""}${d.original_filename}`}
            secondary={!selected.includes(d.id)}
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
        ))}
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
        <BodyText>{selected.length} records selected (maximum 20)</BodyText>
        <Choices
          label="Sharing method"
          value={method}
          values={{ unique_link: "Online link", qr_code: "QR code" }}
          onChange={setMethod}
        />
        <Button
          title="Create selected-record share"
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
              }
            });
          }}
        />
        {created && (
          <View style={{ gap: 12 }}>
            <BodyText>
              Share created · expires{" "}
              {new Date(created.grant.expires_at).toLocaleString()}
            </BodyText>
            {created.qr_svg && (
              <SvgXml
                xml={created.qr_svg}
                width={220}
                height={220}
                accessibilityLabel="Backend-generated selected-record share QR code"
              />
            )}
            <Button
              title="Copy link"
              secondary
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  if (grantState(created.grant) !== "Active") {
                    setCreated(undefined);
                    throw new InputError(
                      "This share has expired. Create a new share.",
                    );
                  }
                  if (!(await Clipboard.setStringAsync(created.share_url)))
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
            <BodyText muted>
              The opaque link is held only on this screen until copied or shared
              explicitly. Clipboard and exported copies remain outside app
              control.
            </BodyText>
          </View>
        )}
        <Button
          title="Refresh shares & selection"
          secondary
          disabled={busy}
          onPress={() => void run(load)}
        />
      </Card>
      {grants.map((g) => (
        <Card key={g.id}>
          <BodyText>
            {g.sharing_method === "qr_code" ? "QR share" : "Online link"} ·{" "}
            {grantState(g, now)}
          </BodyText>
          <BodyText muted>
            Created {new Date(g.created_at).toLocaleString()} · expires{" "}
            {new Date(g.expires_at).toLocaleString()}
          </BodyText>
          {grantState(g, now) === "Active" && (
            <Button
              title="Revoke share"
              secondary
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
                    }, "Share revoked."),
                )
              }
            />
          )}
        </Card>
      ))}
      {!grants.length && !busy && <BodyText>No sharing grants yet.</BodyText>}
    </>
  );
}
