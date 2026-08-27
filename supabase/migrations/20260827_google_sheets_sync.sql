-- Stepping Stones: Google Sheets server-side connection + sync metadata
-- Run this AFTER the applications and user_settings tables already exist.

-- 1) Keep the long-lived Google refresh token in a server-only table.
--    The token itself is encrypted by the Edge Function before insertion.
create table if not exists public.google_connections (
  user_id uuid primary key
    references auth.users(id)
    on delete cascade,

  google_email text not null,

  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_connections enable row level security;

-- No browser role receives access to this table.
revoke all on table public.google_connections from anon, authenticated;
grant all on table public.google_connections to service_role;


-- 2) Make user_settings compatible with the Edge Function.
alter table public.user_settings
  add column if not exists google_sheet_url text;

alter table public.user_settings
  add column if not exists updated_at timestamptz not null default now();


-- 3) Record whether an application has already been appended to Sheets.
--    This keeps normal repeated client calls from writing the same application twice.
alter table public.applications
  add column if not exists google_sheet_synced_at timestamptz;

alter table public.applications
  add column if not exists google_sheet_row integer;


-- Helpful indexes for server-side lookup.
create index if not exists applications_user_created_idx
  on public.applications(user_id, created_at desc);

create index if not exists applications_google_sync_idx
  on public.applications(user_id, google_sheet_synced_at);


-- Optional verification:
-- select column_name, data_type
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('applications', 'user_settings', 'google_connections')
-- order by table_name, ordinal_position;
