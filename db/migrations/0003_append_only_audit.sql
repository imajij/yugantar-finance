-- PRD 18.2 rule 7 / 21.3: `audit_events` is append-only.
--
-- Two layers, because either alone has a gap:
--   1. A trigger that refuses UPDATE and DELETE. Enforced for every role including
--      the owner, and it survives a mis-provisioned database.
--   2. Revoked grants for the application role, so the attempt never reaches the
--      trigger in the first place. Applied only when that role exists — a local
--      Docker database has no separate app role, a Neon deployment does.
--
-- Soft delete is the rule everywhere else (`deleted_at`), so no table needs DELETE.

create or replace function audit_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append-only: % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;
--> statement-breakpoint

drop trigger if exists audit_events_no_update on audit_events;
--> statement-breakpoint
create trigger audit_events_no_update
  before update on audit_events
  for each row execute function audit_events_append_only();
--> statement-breakpoint

drop trigger if exists audit_events_no_delete on audit_events;
--> statement-breakpoint
create trigger audit_events_no_delete
  before delete on audit_events
  for each row execute function audit_events_append_only();
--> statement-breakpoint

-- Grants for the application role, when one is provisioned.
-- Set it with:  ALTER DATABASE <db> SET app.role_name = 'yugantar_app';
do $$
declare
  app_role text := current_setting('app.role_name', true);
begin
  if app_role is null or app_role = '' then
    raise notice 'app.role_name not set — skipping audit_events grant revocation';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = app_role) then
    raise notice 'role % does not exist — skipping audit_events grant revocation', app_role;
    return;
  end if;

  execute format('revoke update, delete, truncate on audit_events from %I', app_role);
  execute format('grant insert, select on audit_events to %I', app_role);
end;
$$;
