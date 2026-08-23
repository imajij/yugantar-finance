-- PRD 20.9 `/tickets/similar` — trigram search over ticket titles.
--
-- Half the asks raised during fest week are the same ask twice ("generator for
-- stage" from two people an hour apart). Catching that while somebody is still
-- typing is far cheaper than triaging both, so the lookup has to tolerate typos:
-- trigram similarity, not `ilike`.
--
-- The GIST index makes it a range scan rather than a sequential one across every
-- ticket in the fest, which matters on the ~800/fest sizing in section 14.

create extension if not exists pg_trgm;
--> statement-breakpoint

create index if not exists tickets_title_trgm_idx
  on tickets using gist (title gist_trgm_ops)
  where deleted_at is null;
