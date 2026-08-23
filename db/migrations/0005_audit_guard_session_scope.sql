-- Refines the append-only guard from 0003.
--
-- The trigger stays, but it now recognises one explicit, session-scoped opt-out:
-- `app.allow_audit_mutation = 'on'`. The seed and the database tests set it with
-- `SET LOCAL`, so it lives for exactly one transaction on exactly one connection.
--
-- Why not `ALTER TABLE ... DISABLE TRIGGER`, which is what 0003 forced: that takes
-- an ACCESS EXCLUSIVE lock on `audit_events`, so parallel test files serialise on it
-- and deadlock. Worse, a disabled trigger is global — for the seconds it is off,
-- *every* connection can rewrite the audit log, including the running app.
--
-- The real enforcement was never the trigger. It is the revoked UPDATE/DELETE grant
-- on the application's database role (0003), which no session setting can restore.
-- The trigger is the second layer, for databases provisioned without that role.

create or replace function audit_events_append_only() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.allow_audit_mutation', true), 'off') = 'on' then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  raise exception 'audit_events is append-only: % is not permitted', tg_op
    using errcode = 'restrict_violation',
          hint = 'Teardown in the seed and tests sets app.allow_audit_mutation; nothing else may.';
end;
$$;
