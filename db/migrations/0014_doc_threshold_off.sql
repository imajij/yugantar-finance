-- The supporting-document threshold stops being a gate.
--
-- `line_item_doc_threshold_paise` (PRD 7.1) is the amount at or above which a line
-- item must carry a quotation or a listing before any request can attach to it —
-- the one hard block in the product that falls on somebody other than the person
-- who caused it. A member with a receipt in hand was refused because the line item
-- their HOD wrote has no quote on it, and nothing they can do fixes that.
--
-- Zero turns it off everywhere it is read: the block in `lib/services/reimbursements.ts`,
-- flag F13, the chip on the budget screen, the warning in the create form and the
-- `needs_documents` column behind /budget-review all test for a non-zero threshold
-- first. Documents stay, and so does everything that reads them without demanding
-- them: F14 still compares the planned amount against the lowest quote, and the
-- quotes are still on the line item, in the department statement and on every
-- request charged against it.
--
-- Data, not schema: the seed now ships 0, and this is the same change for the fests
-- that were created before it. Setting the key back to an amount in paise re-arms
-- the gate for that fest without a deploy.
UPDATE "fests"
   SET "settings" = "settings" || '{"line_item_doc_threshold_paise": 0}'::jsonb
 WHERE ("settings" ? 'line_item_doc_threshold_paise')
   AND coalesce(("settings"->>'line_item_doc_threshold_paise')::bigint, 0) <> 0;
