-- M13 Phase 4: read-only status views. Each permission reaches metadata only: no guardian or doctor email,
-- no link secret or token digest, no OTP, no email payload or content digest, and no medical content.
INSERT INTO public.admin_role_permissions(role_name,permission)
SELECT r.name,p.permission FROM public.admin_roles r
CROSS JOIN (VALUES('admin.guardians.read'),('admin.shares.read'),('admin.deliveries.read')) AS p(permission);
-- Newest-first keyset paging of the four status lists.
CREATE INDEX guardian_relationships_admin_list_idx ON public.guardian_relationships(created_at DESC,id DESC);
CREATE INDEX doctor_sharing_grants_admin_list_idx ON public.doctor_sharing_grants(created_at DESC,id DESC);
CREATE INDEX security_email_admin_list_idx ON public.patient_security_email_deliveries(created_at DESC,id DESC);
CREATE INDEX guardian_medical_jobs_admin_list_idx ON public.guardian_medical_jobs(created_at DESC,id DESC);
