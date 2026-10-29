-- Synthetic M10 qualification only. Clinical/privacy/provider activation remains gated.
CREATE TABLE public.guardian_notification_enrollments(
 patient_id UUID PRIMARY KEY REFERENCES public.patients(id),
 synthetic_fixture BOOLEAN NOT NULL CHECK(synthetic_fixture),enrolled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.guardian_serious_rules(
 id TEXT NOT NULL,version TEXT NOT NULL,definition JSONB NOT NULL CHECK(jsonb_typeof(definition)='object'),
 definition_sha256 TEXT NOT NULL CHECK(definition_sha256 ~ '^[a-f0-9]{64}$'),
 approval_status TEXT NOT NULL CHECK(approval_status IN ('non_clinical_demo','pending_review','clinically_approved')),
 approval_metadata JSONB NOT NULL CHECK(jsonb_typeof(approval_metadata)='object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(id,version),UNIQUE(id,version,definition_sha256),
 CHECK(approval_status<>'clinically_approved' OR (approval_metadata ? 'qualified_approver' AND approval_metadata ? 'approval_reference'))
);
CREATE TABLE public.guardian_medical_jobs(
 id UUID PRIMARY KEY,patient_id UUID NOT NULL REFERENCES public.patients(id),relationship_id UUID NOT NULL,
 recipient_hash TEXT NOT NULL CHECK(recipient_hash ~ '^[a-f0-9]{64}$'),patient_security_version BIGINT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('routine_digest','serious_alert')),policy_sha256 TEXT NOT NULL CHECK(policy_sha256 ~ '^[a-f0-9]{64}$'),
 window_start TIMESTAMPTZ,window_end TIMESTAMPTZ,not_before TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','retry_wait','delivered','permanent_failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 5),
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),claim_token UUID,lease_expires_at TIMESTAMPTZ,
 content_sha256 TEXT CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),provider_reference_hash TEXT CHECK(provider_reference_hash ~ '^[a-f0-9]{64}$'),
 failure_code TEXT CHECK(failure_code IN ('recipient_denied','source_denied','policy_changed','content_changed','transport','timeout','rejected','invalid_receipt','lease_expired')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),delivered_at TIMESTAMPTZ,
 UNIQUE(id,patient_id),FOREIGN KEY(relationship_id,patient_id) REFERENCES public.guardian_relationships(id,patient_id),
 CHECK((state='running' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state<>'running' AND claim_token IS NULL AND lease_expires_at IS NULL)),
 CHECK((state='delivered')=(delivered_at IS NOT NULL)),CHECK(delivered_at IS NULL OR delivered_at>=created_at),CHECK(attempts<=max_attempts),
 CHECK((kind='routine_digest' AND window_start IS NOT NULL AND window_end>window_start AND not_before=window_end)
 OR (kind='serious_alert' AND window_start IS NULL AND window_end IS NULL))
);
CREATE INDEX guardian_medical_due ON public.guardian_medical_jobs(patient_id,not_before,next_attempt_at,id) WHERE state IN ('pending','retry_wait','running');
CREATE INDEX guardian_medical_relationship ON public.guardian_medical_jobs(relationship_id,patient_id);
CREATE TABLE public.guardian_routine_sources(
 summary_id UUID PRIMARY KEY,patient_id UUID NOT NULL,document_id UUID NOT NULL,snapshot_id UUID NOT NULL,
 eligible_at TIMESTAMPTZ NOT NULL,job_id UUID,
 UNIQUE(summary_id,patient_id),UNIQUE(document_id,patient_id,snapshot_id),FOREIGN KEY(summary_id,document_id,patient_id) REFERENCES public.ai_report_summaries(id,document_id,patient_id),
 FOREIGN KEY(snapshot_id,document_id,patient_id) REFERENCES public.summary_source_snapshots(id,document_id,patient_id),
 FOREIGN KEY(job_id,patient_id) REFERENCES public.guardian_medical_jobs(id,patient_id)
);
CREATE INDEX guardian_routine_unclaimed ON public.guardian_routine_sources(patient_id,eligible_at,summary_id) WHERE job_id IS NULL;
CREATE INDEX guardian_routine_job ON public.guardian_routine_sources(job_id,patient_id);
CREATE TABLE public.guardian_rule_results(
 id UUID PRIMARY KEY,patient_id UUID NOT NULL,document_id UUID NOT NULL,snapshot_id UUID NOT NULL,
 rule_id TEXT NOT NULL,rule_version TEXT NOT NULL,definition_sha256 TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('TRIGGERED','NOT_TRIGGERED','INDETERMINATE')),
 result JSONB NOT NULL CHECK(jsonb_typeof(result)='object' AND result ? 'outcome' AND result->>'outcome'=outcome),job_id UUID,evaluated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,patient_id),UNIQUE(id,document_id,patient_id,snapshot_id),UNIQUE(snapshot_id,rule_id,rule_version),
 FOREIGN KEY(rule_id,rule_version,definition_sha256) REFERENCES public.guardian_serious_rules(id,version,definition_sha256),
 FOREIGN KEY(snapshot_id,document_id,patient_id) REFERENCES public.summary_source_snapshots(id,document_id,patient_id),
 FOREIGN KEY(job_id,patient_id) REFERENCES public.guardian_medical_jobs(id,patient_id)
);
CREATE INDEX guardian_rule_patient ON public.guardian_rule_results(patient_id,evaluated_at,id);
CREATE INDEX guardian_rule_unclaimed ON public.guardian_rule_results(patient_id,evaluated_at,id) WHERE job_id IS NULL AND outcome='TRIGGERED';
CREATE TABLE public.guardian_medical_items(
 id UUID PRIMARY KEY,job_id UUID NOT NULL,patient_id UUID NOT NULL,document_id UUID NOT NULL,snapshot_id UUID NOT NULL,
 summary_id UUID,rule_result_id UUID,included BOOLEAN NOT NULL DEFAULT true,
 reference_hash TEXT NOT NULL UNIQUE CHECK(reference_hash ~ '^[a-f0-9]{64}$'),reference_expires_at TIMESTAMPTZ,
 UNIQUE(job_id,document_id,snapshot_id,summary_id),
 FOREIGN KEY(job_id,patient_id) REFERENCES public.guardian_medical_jobs(id,patient_id),
 FOREIGN KEY(snapshot_id,document_id,patient_id) REFERENCES public.summary_source_snapshots(id,document_id,patient_id),
 FOREIGN KEY(summary_id,document_id,patient_id) REFERENCES public.ai_report_summaries(id,document_id,patient_id),
 FOREIGN KEY(rule_result_id,document_id,patient_id,snapshot_id) REFERENCES public.guardian_rule_results(id,document_id,patient_id,snapshot_id),
 CHECK((summary_id IS NOT NULL)<>(rule_result_id IS NOT NULL))
);
CREATE INDEX guardian_item_job ON public.guardian_medical_items(job_id,patient_id,id);
CREATE INDEX guardian_item_document ON public.guardian_medical_items(document_id,patient_id);
CREATE TABLE public.guardian_medical_events(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),patient_id UUID NOT NULL REFERENCES public.patients(id),job_id UUID,
 event TEXT NOT NULL CHECK(event IN ('digest_eligible','digest_queued','attempt','delivered','failed','recipient_denied','source_denied','rule_evaluated','serious_trigger','serious_queued','indeterminate','lease_recovered')),
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(job_id,patient_id) REFERENCES public.guardian_medical_jobs(id,patient_id)
);
CREATE INDEX guardian_medical_event_patient ON public.guardian_medical_events(patient_id,occurred_at,id);
REVOKE ALL ON public.guardian_notification_enrollments,public.guardian_serious_rules,public.guardian_medical_jobs,public.guardian_routine_sources,public.guardian_rule_results,public.guardian_medical_items,public.guardian_medical_events FROM PUBLIC,health_wallet_app;
GRANT SELECT,INSERT ON public.guardian_notification_enrollments,public.guardian_serious_rules,public.guardian_medical_events TO health_wallet_app;
GRANT SELECT,INSERT,UPDATE ON public.guardian_medical_jobs,public.guardian_routine_sources,public.guardian_rule_results,public.guardian_medical_items TO health_wallet_app;
-- Current source/summary binding is shared by dispatch and emailed-original access.
CREATE FUNCTION public.guardian_medical_item_current(item UUID,patient UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.guardian_medical_items i JOIN public.summary_source_snapshots s
 ON (s.id,s.document_id,s.patient_id)=(i.snapshot_id,i.document_id,i.patient_id)
 WHERE i.id=item AND i.patient_id=patient AND i.included AND public.summary_source_current(s)
 AND ((i.summary_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.ai_report_summaries a WHERE a.id=i.summary_id AND a.patient_id=patient AND a.document_id=i.document_id
 AND a.source_snapshot_id=i.snapshot_id AND a.summary_contract_version=1 AND a.processing_status='completed'))
 OR (i.rule_result_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.guardian_rule_results r JOIN public.guardian_serious_rules d ON (d.id,d.version,d.definition_sha256)=(r.rule_id,r.rule_version,r.definition_sha256) WHERE r.id=i.rule_result_id AND r.patient_id=patient AND r.document_id=i.document_id AND r.snapshot_id=i.snapshot_id AND r.outcome='TRIGGERED' AND d.approval_status='non_clinical_demo'))))
$$;
REVOKE ALL ON FUNCTION public.guardian_medical_item_current(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_medical_item_current(UUID,UUID) TO health_wallet_app;
