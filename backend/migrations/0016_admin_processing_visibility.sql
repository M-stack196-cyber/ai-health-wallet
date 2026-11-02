-- M13 Phase 3: read-only processing visibility and owner-fenced retry permissions. No permission here reaches
-- documents, extracted text, summaries or originals; the admin views read job metadata only.
INSERT INTO public.admin_role_permissions(role_name,permission)
SELECT r.name,p.permission FROM public.admin_roles r
CROSS JOIN (VALUES('admin.processing.read'),('admin.processing.retry')) AS p(permission);
-- Supports the state/error filters and newest-first keyset paging of the admin job list.
CREATE INDEX document_processing_admin_list_idx ON public.document_processing_jobs(state,updated_at DESC,document_id DESC);
CREATE INDEX document_processing_admin_recent_idx ON public.document_processing_jobs(updated_at DESC,document_id DESC);
