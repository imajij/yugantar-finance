-- PRD 19.4 — normative definition of the five numbers. Copied verbatim; do not hand-edit.
create view v_line_item_totals as
with r as (
  select line_item_id,
         coalesce(sum(amount_paise) filter (where status in ('SUBMITTED','HOD_ENDORSED')), 0) as pending,
         coalesce(sum(amount_paise) filter (where status in ('APPROVED','ON_HOLD')), 0)      as committed,
         coalesce(sum(amount_paise) filter (where status = 'PAID'), 0)                        as spent
  from reimbursement_requests
  where deleted_at is null
  group by line_item_id
),
paid as (
  select vendor_request_id, coalesce(sum(paid_paise), 0) as paid
  from vendor_milestones group by vendor_request_id
),
v as (
  select vr.line_item_id,
         coalesce(sum(vr.total_value_paise) filter (where vr.status = 'SUBMITTED'), 0) as pending,
         coalesce(sum(greatest(coalesce(vr.approved_value_paise, vr.total_value_paise) - coalesce(p.paid, 0), 0))
           filter (where vr.status in ('APPROVED','ADVANCE_PAID','DELIVERED','BALANCE_APPROVED')), 0) as committed,
         coalesce(sum(coalesce(p.paid, 0) - vr.refund_received_paise)
           filter (where vr.status in ('APPROVED','ADVANCE_PAID','DELIVERED','BALANCE_APPROVED','CLOSED','CANCELLED')), 0) as spent
  from vendor_requests vr
  left join paid p on p.vendor_request_id = vr.id
  where vr.deleted_at is null
  group by vr.line_item_id
)
select li.id            as line_item_id,
       li.fest_id,
       li.department_id,
       li.status,
       li.planned_paise,
       coalesce(r.pending, 0)   + coalesce(v.pending, 0)   as pending_paise,
       coalesce(r.committed, 0) + coalesce(v.committed, 0) as committed_paise,
       coalesce(r.spent, 0)     + coalesce(v.spent, 0)     as spent_paise,
       li.planned_paise
         - coalesce(r.pending, 0)   - coalesce(v.pending, 0)
         - coalesce(r.committed, 0) - coalesce(v.committed, 0)
         - coalesce(r.spent, 0)     - coalesce(v.spent, 0)   as available_paise
from line_items li
left join r on r.line_item_id = li.id
left join v on v.line_item_id = li.id
where li.deleted_at is null;--> statement-breakpoint
create view v_department_totals as
select d.id                                   as department_id,
       d.fest_id,
       d.kind,
       d.allocated_paise,
       coalesce(sum(t.planned_paise), 0)      as planned_paise,
       coalesce(sum(t.pending_paise), 0)      as pending_paise,
       coalesce(sum(t.committed_paise), 0)    as committed_paise,
       coalesce(sum(t.spent_paise), 0)        as spent_paise,
       d.allocated_paise
         - coalesce(sum(t.pending_paise), 0)
         - coalesce(sum(t.committed_paise), 0)
         - coalesce(sum(t.spent_paise), 0)    as available_paise
from departments d
left join v_line_item_totals t on t.department_id = d.id
where d.is_active
group by d.id;--> statement-breakpoint
create view v_income_totals as
with tr as (
  select income_entry_id, coalesce(sum(amount_paise), 0) as received
  from income_tranches group by income_entry_id
)
select i.fest_id,
       i.type,
       coalesce(sum(i.pledged_paise) filter (where i.status <> 'WRITTEN_OFF'), 0)                 as pledged_paise,
       coalesce(sum(tr.received), 0)                                                               as received_paise,
       coalesce(sum(greatest(i.pledged_paise, coalesce(tr.received, 0)))
         filter (where i.status <> 'WRITTEN_OFF'), 0)                                              as expected_paise
from income_entries i
left join tr on tr.income_entry_id = i.id
where i.deleted_at is null
group by i.fest_id, i.type;--> statement-breakpoint
create view v_fest_totals as
select f.id                                                   as fest_id,
       f.total_budget_paise,
       coalesce(sum(d.allocated_paise), 0)                    as allocated_paise,
       f.total_budget_paise - coalesce(sum(d.allocated_paise), 0) as reserve_paise,
       coalesce(sum(d.pending_paise), 0)                      as pending_paise,
       coalesce(sum(d.committed_paise), 0)                    as committed_paise,
       coalesce(sum(d.spent_paise), 0)                        as spent_paise,
       cash.received_paise                                    as income_received_paise,
       cash.pledged_paise                                     as income_pledged_paise,
       cash.expected_paise                                    as income_expected_paise,
       cash.received_paise - coalesce(sum(d.spent_paise), 0)  as cash_position_paise,
       cash.expected_paise
         - coalesce(sum(d.spent_paise), 0)
         - coalesce(sum(d.committed_paise), 0)
         - coalesce(sum(d.pending_paise), 0)                  as projected_close_paise
from fests f
left join v_department_totals d on d.fest_id = f.id
left join lateral (
  select coalesce(sum(received_paise), 0) as received_paise,
         coalesce(sum(pledged_paise), 0)  as pledged_paise,
         coalesce(sum(expected_paise), 0) as expected_paise
  from v_income_totals it
  where it.fest_id = f.id and it.type <> 'SPONSORSHIP_IN_KIND'       -- in-kind never counts toward cash
) cash on true
group by f.id, cash.received_paise, cash.pledged_paise, cash.expected_paise;
