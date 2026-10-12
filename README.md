# Book Tracker Widget:

An embeddable widget that shows a scrollable list of books you're tracking - title/author/cover
looked up on Open Library by ISBN and stored in your own backend (I used Supabase) alongside
progress/status/rating, plus a private admin page for adding/updating entries.

## 1. Create a Supabase project (free tier):

1. Go to https://supabase.com and sign up / create a new project.
2. Once it's ready, open **SQL Editor > New query**, paste in the contents of
   `supabase/schema.sql`, and run it. This creates the `books` table (plus reading history and an
   audit log) and a `public_books` view, and locks down RLS so:
   - anyone can **read** the public columns of non-archived books via `public_books` (needed for
     the widget), but
   - a **signed-in** user can only read and write their own books (needed for the admin page).
3. Create your admin login: **Authentication > Users > Add user**, set an email + password.
   Then turn off public sign-ups (**Authentication > Sign In / Providers > Email > Allow new users
   to sign up** = off). Books added with the service-role key (e.g. a sync script) are assigned
   to the first account, so this should be the only one.
4. Get your API credentials: 
   - **Integrations > Data API** — copy the **API URL** (only copy the URL up to **...supabase.co**)
   - **Project Settings > API Keys** — copy the **publishable** key (starts with `sb_publishable_`).
     Never use the **secret** key (`sb_secret_…`) or the legacy `service_role` key in client-side
     code: they bypass row-level security. (Older projects may show a legacy `anon` key instead,
     which also works.)

## 2. Configure the admin page

Copy `config.example.js` to `config.js` (in the project root) and fill in your values:

```js
window.BOOK_TRACKER_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseKey: 'sb_publishable_YOUR_KEY'
};
```

`config.js` is gitignored so your project details aren't committed. The admin page and the demo
both read it.

Open `admin/index.html` in a browser, sign in with the user you created, and add books by ISBN.
Hyphens are fine, and ISBN-10 and ISBN-13 are treated as the same book. The admin page looks the
ISBN up on Open Library and shows a preview so you can check it's the right edition. Title,
author and cover are saved with the book, and you can override them under **Book details**.

- Books are **archived** rather than deleted, so they can be restored. Permanent delete is only offered for archived books.
- Adding a book that's already tracked offers to edit the existing entry instead.
- **Refresh** re-fetches a book's details from Open Library. **Fill in missing details** does this for every book without a title or cover, without overwriting anything you've edited.

## 3. Embed the widget

`widget/book-tracker-widget.js` is the whole widget — a self-contained custom element with no
build step and no dependencies. It only ever *reads* from Supabase, via the publishable key and
the `public_books` view. The key is safe to expose because RLS and column grants from step 1 limit
anon access to reading the public columns.

```html
<script src="path/to/book-tracker-widget.js"></script>
<book-tracker-widget
  project-url="https://YOUR-PROJECT.supabase.co"
  anon-key="sb_publishable_YOUR_KEY"
  limit="20">
</book-tracker-widget>
```

See `widget/demo.html` for a working example — open it directly in a browser once `config.js`
exists.

Attributes:

| Attribute      | Required | Description                                  |
|----------------|----------|-----------------------------------------------|
| `project-url`  | yes      | Your Supabase project URL                     |
| `anon-key`     | yes      | Your Supabase publishable key                 |
| `limit`        | no       | Max books to show (1–100, default 20)         |
| `status`       | no       | Only show these statuses, e.g. `reading,finished` |
| `start`        | no       | `reading` (default: open on the first book being read) or `first` |

The widget renders inside Shadow DOM, so its styles won't leak into or clash with the host page.
Restyle it from the host page with `--bt-*` custom properties, e.g.

```css
book-tracker-widget { --bt-bg: #fff; --bt-fg: #222; --bt-fg-dim: #666; --bt-max-width: 400px; }
```

Available: `--bt-bg`, `--bt-fg`, `--bt-fg-dim`, `--bt-line`, `--bt-line-strong`, `--bt-accent`
(stars), `--bt-error`, `--bt-font-display`, `--bt-font-body`, `--bt-font-mono`, `--bt-max-width`.

It supports the arrow keys (when focused) and swiping on touch screens. Data is cached for 10
minutes per browser tab (`sessionStorage`).

## How it works

- **Widget** → one request to the `public_books` view via Supabase's REST API. Title, author
  and cover come from the database. Books saved without them get one batched Open Library lookup.
- **Admin page** → signs in via Supabase Auth, then reads and writes rows in `books` directly from
  the browser using the authenticated session.
- **ISBNs**: `isbn` keeps what was typed. The database derives a checksum-validated `isbn_13`
  (and `isbn_10`), rejects invalid ISBNs, and allows each book only once among non-archived books.
- **Progress** is stored as `progress_percent` (0-100). When `current_page` and `total_pages` are
  both set, the database calculates it from them. Otherwise (e.g. audiobooks) you set it yourself.
- **Status** is one of `want_to_read`, `reading`, `paused`, `finished`, `abandoned`. Starting a
  book sets `started_on`. Finishing it sets progress to 100% and `finished_on` to today, unless
  you set a date.
- **Rating** is 1-5 stars, or empty for "not rated".
- **History**: every status/progress change is logged in `reading_events`, and every change to a
  book is kept in `book_audit`, which is readable from the SQL editor.
  `books_needing_attention` lists books missing a title, cover or page count.

## Files

```
widget/book-tracker-widget.js   the embeddable widget (custom element)
widget/demo.html                standalone page demonstrating the widget
admin/index.html, admin.js      private page for managing book entries
config.example.js               template for config.js (gitignored; holds URL + publishable key)
supabase/schema.sql             run once in the Supabase SQL editor (new projects)
```
