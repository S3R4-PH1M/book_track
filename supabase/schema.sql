-- Run this in the Supabase SQL editor (Project > SQL Editor > New query) once per project.

create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  isbn text not null,
  status text not null default 'reading' check (status in ('want_to_read', 'reading', 'finished')),
  progress_percent int not null default 0 check (progress_percent between 0 and 100),
  current_page int check (current_page >= 0),
  total_pages int check (total_pages >= 0),
  rating int check (rating between 0 and 5),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table books enable row level security;

-- RLS policies only take effect on top of a base GRANT — without this, Postgres
-- rejects access before policies are even checked ("permission denied for table books").
grant select on books to anon;
grant select, insert, update, delete on books to authenticated;

-- Anyone (including the public widget, using the anon key) can read the list.
create policy "Public read access"
  on books for select
  to anon
  using (true);

-- Only a signed-in admin user (via the admin page) can write.
create policy "Authenticated insert"
  on books for insert
  to authenticated
  with check (true);

create policy "Authenticated update"
  on books for update
  to authenticated
  using (true);

create policy "Authenticated delete"
  on books for delete
  to authenticated
  using (true);

-- Keep updated_at current on every edit.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger books_set_updated_at
before update on books
for each row execute function set_updated_at();
