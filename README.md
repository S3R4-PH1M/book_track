# Book Tracker Widget:

An embeddable widget that shows a scrollable list of books you're tracking - title/author/cover
pulled live from Open Library based upon ISBN, progress/status/rating pulled from your own backend (I used Supabase),
plus a private admin page for adding/updating entries.

## 1. Create a Supabase project (free tier):

1. Go to https://supabase.com and sign up / create a new project.
2. Once it's ready, open **SQL Editor > New query**, paste in the contents of
   `supabase/schema.sql`, and run it. This creates the `books` table and locks down RLS so:
   - anyone can **read** the list (needed for the public widget), but
   - only a **signed-in** user can write (needed for the admin page).
3. Create your admin login: **Authentication > Users > Add user**, set an email + password.
   This is the only account that will be able to add/edit/delete books.
4. Get your API credentials: 
   - **Integrations > Data API** — copy the **API URL** (only copy the URL up to **...supabase.co**)
   - **Project Settings > API** — copy the **anon public** key (not the `service_role` key — never put that in client-side code).

## 2. Configure the admin page

Edit `admin/admin.js` and set:

```js
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_PUBLIC_ANON_KEY';
```

Open `admin/index.html` in a browser, sign in with the user you created, and add books by ISBN
(title/author/cover are looked up automatically — you only enter status, pages, progress, and
rating).

## 3. Embed the widget

`widget/book-tracker-widget.js` is the whole widget — a self-contained custom element with no
build step and no dependencies. It only ever *reads* from Supabase (via the public anon key,
which is safe to expose because of the row-level-security policy from step 1).

```html
<script src="path/to/book-tracker-widget.js"></script>
<book-tracker-widget
  project-url="https://YOUR-PROJECT.supabase.co"
  anon-key="YOUR_PUBLIC_ANON_KEY"
  limit="20">
</book-tracker-widget>
```

See `widget/demo.html` for a working example — open it directly in a browser after filling in
your project URL and anon key.

Attributes:

| Attribute      | Required | Description                                  |
|----------------|----------|-----------------------------------------------|
| `project-url`  | yes      | Your Supabase project URL                     |
| `anon-key`     | yes      | Your Supabase anon public key                 |
| `limit`        | no       | Max books to show (default 20)                |

The widget renders inside Shadow DOM, so its styles won't leak into or clash with the host page.

## How it works

- **Widget** → reads rows from `books` via Supabase's REST API, then enriches each with
  title/author/cover from the Open Library Books API (`openlibrary.org/api/books`) by ISBN.
- **Admin page** → signs in via Supabase Auth, then inserts/updates/deletes rows in `books`
  directly from the browser using the authenticated session.
- **Progress** is stored per book as `progress_percent` (0-100), optionally alongside
  `current_page`/`total_pages` — the admin form auto-computes the percentage from page counts,
  but you can override it directly.
- **Rating** is a whole number 0-5, shown as stars.
- **Status** is one of `want_to_read`, `reading`, `finished`.

## Files

```
widget/book-tracker-widget.js   the embeddable widget (custom element)
widget/demo.html                standalone page demonstrating the widget
admin/index.html, admin.js      private page for managing book entries
supabase/schema.sql             run once in the Supabase SQL editor
```
