-- Book tracker schema for a NEW Supabase project.
-- Run in the Supabase SQL editor (Project > SQL Editor > New query). Safe to re-run.
--
--
-- Keep public sign-ups OFF (Authentication > Sign In / Providers > Email) so that account is your admin.

create extension if not exists pg_trgm with schema extensions;

-- ============ ISBN helpers ============
-- Strip everything except digits and X ("978-0-14..." / "ISBN 0140..." -> "97800140...").
create or replace function public.isbn_clean(raw text)
returns text language sql immutable set search_path = '' as $$
  select nullif(upper(regexp_replace(coalesce(raw, ''), '[^0-9Xx]', '', 'g')), '')
$$;

-- Any ISBN-10/13 -> checksum-validated ISBN-13, or NULL if it isn't a valid ISBN.
create or replace function public.isbn_to_13(raw text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  s text := public.isbn_clean(raw);
  core text;
  total int := 0;
  i int;
begin
  if s ~ '^\d{9}[\dX]$' then
    for i in 1..10 loop
      total := total + (11 - i) * case when substr(s, i, 1) = 'X' then 10 else substr(s, i, 1)::int end;
    end loop;
    if total % 11 <> 0 then return null; end if;
    core := '978' || left(s, 9);
  elsif s ~ '^97[89]\d{10}$' then
    core := left(s, 12);
  else
    return null;
  end if;

  total := 0;
  for i in 1..12 loop
    total := total + substr(core, i, 1)::int * case when i % 2 = 0 then 3 else 1 end;
  end loop;
  if length(s) = 13 and right(s, 1)::int <> (10 - total % 10) % 10 then return null; end if;
  return core || ((10 - total % 10) % 10)::text;
end $$;

-- ISBN-13 -> ISBN-10 (only 978-prefixed ISBNs have one).
create or replace function public.isbn_13_to_10(isbn13 text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  total int := 0;
  i int;
  chk int;
begin
  if isbn13 is null or isbn13 !~ '^978\d{10}$' then return null; end if;
  for i in 1..9 loop
    total := total + (11 - i) * substr(isbn13, 3 + i, 1)::int;
  end loop;
  chk := (11 - total % 11) % 11;
  return substr(isbn13, 4, 9) || case when chk = 10 then 'X' else chk::text end;
end $$;

-- ============ Table ============
do $$ begin
  create type public.book_status as enum ('want_to_read', 'reading', 'paused', 'finished', 'abandoned');
exception when duplicate_object then null; end $$;

create table if not exists public.books (
  id                  uuid primary key default gen_random_uuid(),
  isbn                text,                 -- as entered; isbn_13 is the canonical identifier
  status              public.book_status not null default 'reading',
  progress_percent    int not null default 0 check (progress_percent between 0 and 100),
  current_page        int check (current_page >= 0),
  total_pages         int check (total_pages >= 0),
  rating              int check (rating between 0 and 5),
  sort_order          int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  owner_id            uuid not null references auth.users(id),
  isbn_13             text,
  isbn_10             text,
  title               text,
  subtitle            text,
  authors             text[] not null default '{}',
  authors_display     text,                 -- maintained by trigger, for search/display
  cover_url           text,
  publisher           text,
  published_year      smallint,
  page_count          int,
  language            text,
  ol_work_key         text,                 -- e.g. /works/OL45804W (groups editions)
  ol_edition_key      text,                 -- e.g. /books/OL7353617M
  google_books_id     text,
  source_ref          text,                 -- e.g. Obsidian note slug (book-sync)
  metadata            jsonb not null default '{}'::jsonb,
  metadata_fetched_at timestamptz,
  format              text,
  started_on          date,
  finished_on         date,
  notes               text,
  tags                text[] not null default '{}',
  archived_at         timestamptz,
  constraint books_isbn_valid       check (isbn is null or isbn_13 is not null),
  constraint books_isbn13_format    check (isbn_13 is null or isbn_13 ~ '^97[89]\d{10}$'),
  constraint books_pages_order      check (current_page is null or total_pages is null or current_page <= total_pages),
  constraint books_dates_order      check (finished_on is null or started_on is null or finished_on >= started_on),
  constraint books_has_identity     check (isbn_13 is not null or ol_work_key is not null or source_ref is not null or title is not null),
  constraint books_cover_https      check (cover_url is null or cover_url like 'https://%'),
  constraint books_format_check     check (format is null or format in ('physical', 'ebook', 'audiobook')),
  constraint books_year_check       check (published_year is null or published_year between 0 and 2200),
  constraint books_page_count_check check (page_count is null or page_count >= 0)
);

alter table public.books enable row level security;

-- One active record per book per owner. Archived rows are ignored, so a book can be re-added.
create unique index if not exists books_owner_isbn13_uq
  on public.books (owner_id, isbn_13) where isbn_13 is not null and archived_at is null;
create unique index if not exists books_owner_source_ref_uq
  on public.books (owner_id, lower(source_ref)) where source_ref is not null;

create index if not exists books_list_idx     on public.books (owner_id, sort_order, created_at desc) where archived_at is null;
create index if not exists books_status_idx   on public.books (owner_id, status) where archived_at is null;
create index if not exists books_title_trgm   on public.books using gin (title extensions.gin_trgm_ops);
create index if not exists books_authors_trgm on public.books using gin (authors_display extensions.gin_trgm_ops);
create index if not exists books_work_idx     on public.books (ol_work_key) where ol_work_key is not null;
create index if not exists books_tags_idx     on public.books using gin (tags);

-- ============ Normalise + business rules on every write ============
-- security definer so service-role writes (book-sync) can read auth.users for the owner fallback.
create or replace function public.books_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.owner_id := coalesce(
    new.owner_id,
    auth.uid(),
    (select id from auth.users order by created_at limit 1)
  );

  -- Canonical ISBNs are always derived from what was entered; `isbn` itself is left as typed.
  new.isbn := nullif(btrim(new.isbn), '');
  new.isbn_13 := public.isbn_to_13(new.isbn);
  if new.isbn is not null and new.isbn_13 is null then
    raise exception 'Invalid ISBN: %', new.isbn
      using errcode = '22023', hint = 'ISBNs are 10 or 13 digits with a valid check digit.';
  end if;
  new.isbn_10 := public.isbn_13_to_10(new.isbn_13);

  new.authors := coalesce(new.authors, '{}');
  new.authors_display := nullif(array_to_string(new.authors, ', '), '');
  new.tags := coalesce(
    array(select distinct lower(btrim(t)) from unnest(new.tags) as t where btrim(t) <> '' order by 1),
    '{}'
  );
  new.metadata := coalesce(new.metadata, '{}'::jsonb);
  new.total_pages := coalesce(new.total_pages, new.page_count);

  -- Pages are the source of truth for progress when both are known.
  if new.current_page is not null and new.total_pages > 0 then
    new.progress_percent := least(100, round(new.current_page * 100.0 / new.total_pages));
  end if;
  new.progress_percent := least(100, greatest(0, coalesce(new.progress_percent, 0)));

  if new.status in ('reading', 'paused', 'finished', 'abandoned') and new.started_on is null
     and (tg_op = 'INSERT' or old.status = 'want_to_read') then
    new.started_on := least(current_date, coalesce(new.finished_on, current_date));
  end if;
  if new.status = 'finished' then
    new.progress_percent := 100;
    if new.total_pages is not null then new.current_page := new.total_pages; end if;
    new.finished_on := coalesce(new.finished_on, current_date);
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists books_before_write on public.books;
create trigger books_before_write
  before insert or update on public.books
  for each row execute function public.books_before_write();

-- ============ Reading history ============
create table if not exists public.reading_events (
  id               bigint generated always as identity primary key,
  book_id          uuid not null references public.books(id) on delete cascade,
  owner_id         uuid not null references auth.users(id),
  status           public.book_status not null,
  current_page     int,
  progress_percent int,
  created_at       timestamptz not null default now()
);
create index if not exists reading_events_book_idx on public.reading_events (book_id, created_at desc);

create or replace function public.books_log_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT'
     or new.status is distinct from old.status
     or new.current_page is distinct from old.current_page
     or new.progress_percent is distinct from old.progress_percent then
    insert into public.reading_events (book_id, owner_id, status, current_page, progress_percent)
    values (new.id, new.owner_id, new.status, new.current_page, new.progress_percent);
  end if;
  return null;
end $$;

drop trigger if exists books_log_event on public.books;
create trigger books_log_event
  after insert or update on public.books
  for each row execute function public.books_log_event();

-- ============ Audit trail ============
create table if not exists public.book_audit (
  id      bigint generated always as identity primary key,
  book_id uuid not null,               -- no FK: entries outlive deleted books
  action  text not null,
  old_row jsonb,
  new_row jsonb,
  actor   uuid default auth.uid(),
  at      timestamptz not null default now()
);
create index if not exists book_audit_book_idx on public.book_audit (book_id, at desc);

create or replace function public.books_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.book_audit (book_id, action, old_row, new_row)
  values (
    coalesce(new.id, old.id),
    tg_op,
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end
  );
  return null;
end $$;

drop trigger if exists books_audit on public.books;
create trigger books_audit
  after insert or update or delete on public.books
  for each row execute function public.books_audit();

-- ============ RLS & grants ============
-- RLS policies only take effect on top of a base GRANT. anon gets column-level SELECT on exactly
-- what public_books exposes (plus archived_at, which the view filters on); everything else,
-- e.g. notes, owner_id or metadata, stays private. Supabase's default privileges grant anon
-- everything on new tables, hence the revoke.
revoke all on public.books from anon;
grant select (isbn_13, title, subtitle, authors_display, cover_url, status, progress_percent,
              current_page, total_pages, rating, started_on, finished_on, sort_order, created_at,
              archived_at)
  on public.books to anon;
grant select, insert, update, delete on public.books to authenticated;

drop policy if exists books_anon_select on public.books;
drop policy if exists books_owner_select on public.books;
drop policy if exists books_owner_insert on public.books;
drop policy if exists books_owner_update on public.books;
drop policy if exists books_owner_delete on public.books;

-- The public widget (anon key) can read books that aren't archived.
create policy books_anon_select on public.books for select to anon
  using (archived_at is null);
-- A signed-in user can read and write only their own books.
create policy books_owner_select on public.books for select to authenticated
  using (owner_id = (select auth.uid()));
create policy books_owner_insert on public.books for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy books_owner_update on public.books for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy books_owner_delete on public.books for delete to authenticated
  using (owner_id = (select auth.uid()));

alter table public.reading_events enable row level security;
drop policy if exists reading_events_owner_select on public.reading_events;
create policy reading_events_owner_select on public.reading_events for select to authenticated
  using (owner_id = (select auth.uid()));
revoke all on public.reading_events from anon, authenticated;
grant select on public.reading_events to authenticated;

-- Audit is read from the SQL editor only: RLS on, no policies, no grants.
alter table public.book_audit enable row level security;
revoke all on public.book_audit from anon, authenticated;

-- ============ Views ============
-- The public widget reads this view, never the table directly. security_invoker makes it
-- respect the caller's RLS policies and column grants.
drop view if exists public.public_books;
create view public.public_books
with (security_invoker = true) as
select isbn_13, title, subtitle, authors_display as author, cover_url, status, progress_percent,
       current_page, total_pages, rating, started_on, finished_on, sort_order, created_at
from public.books
where archived_at is null;

revoke all on public.public_books from anon, authenticated;
grant select on public.public_books to anon, authenticated;

-- Records needing attention: select * from books_needing_attention where cardinality(issues) > 0;
drop view if exists public.books_needing_attention;
create view public.books_needing_attention
with (security_invoker = true) as
select id, isbn, title, status,
  array_remove(array[
    case when title is null       then 'missing title' end,
    case when cover_url is null   then 'missing cover' end,
    case when isbn_13 is null     then 'no ISBN' end,
    case when total_pages is null and status <> 'want_to_read' then 'no page count' end,
    case when status = 'reading' and updated_at < now() - interval '60 days' then 'stale (60 days without an update)' end,
    case when status = 'finished' and rating is null then 'unrated' end
  ], null) as issues
from public.books
where archived_at is null;

revoke all on public.books_needing_attention from anon, authenticated;
grant select on public.books_needing_attention to authenticated;
