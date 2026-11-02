-- M13 Phase 2: patient account management permissions. Admins read account/verification status and
-- change only account_status (active <-> suspended); no permission here reaches medical content.
INSERT INTO public.admin_role_permissions(role_name,permission)
SELECT r.name,p.permission FROM public.admin_roles r
CROSS JOIN (VALUES('admin.patients.read'),('admin.patients.suspend'),('admin.patients.reactivate')) AS p(permission);
-- Supports the status filter and newest-first keyset paging of the admin account list.
CREATE INDEX patients_admin_list_idx ON public.patients(account_status,created_at DESC,id DESC);
