// Credentials come from ../config.js (gitignored) — copy config.example.js to create it.
const config = window.BOOK_TRACKER_CONFIG;
if (!config?.supabaseUrl || !config?.supabaseKey) {
  document.body.textContent = 'Missing config.js — copy config.example.js to config.js and fill in your Supabase URL and publishable key.';
  throw new Error('admin: missing BOOK_TRACKER_CONFIG');
}

const supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);

const STATUS_LABELS = {
  want_to_read: 'Want to read',
  reading: 'Reading',
  paused: 'Paused',
  finished: 'Finished',
  abandoned: 'Abandoned'
};

const $ = (id) => document.getElementById(id);
const form = $('book-form');
const isbnInput = $('isbn');
const statusInput = $('status');
const currentPageInput = $('current_page');
const totalPagesInput = $('total_pages');
const progressInput = $('progress_percent');
const startedInput = $('started_on');
const finishedInput = $('finished_on');
const saveBtn = $('save-btn');
const detailInputs = ['title', 'subtitle', 'authors', 'cover_url', 'publisher', 'published_year'].map($);

let books = [];         // every row for this account, including archived
let editing = null;     // row currently loaded in the form, or null when adding
let lookup = null;      // Open Library extras for the ISBN in the form (saved with the book)
let ratingTouched = false;
let appShown = false;

// ---------- Auth ----------
// onAuthStateChange fires on page load (INITIAL_SESSION), sign-in, sign-out and when a
// session can't be refreshed, so an expired session drops back to the login form.
supabaseClient.auth.onAuthStateChange((event, session) => {
  if (session) {
    showApp(session);
  } else {
    showLogin(appShown ? 'Your session has ended — please sign in again.' : '');
  }
});

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('login-btn');
  $('login-error').textContent = '';
  button.disabled = true;
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: $('email').value,
      password: $('password').value
    });
    if (error) $('login-error').textContent = error.message;
  } catch (err) {
    console.error('admin: sign-in failed', err);
    $('login-error').textContent = 'Sign-in failed — check the console for details.';
  } finally {
    button.disabled = false;
  }
});

$('logout-btn').addEventListener('click', async () => {
  appShown = false;
  await supabaseClient.auth.signOut();
});

function showApp(session) {
  $('user-email').textContent = session.user?.email ?? '';
  if (appShown) return; // token refreshes also fire this
  appShown = true;
  $('login').style.display = 'none';
  $('app').style.display = 'block';
  $('password').value = '';
  // Supabase calls must not run inside the auth callback itself.
  setTimeout(loadBooks, 0);
}

function showLogin(message) {
  appShown = false;
  books = [];
  resetForm();
  $('book-rows').replaceChildren();
  $('login').style.display = 'block';
  $('app').style.display = 'none';
  $('login-error').textContent = message;
}

// ---------- Helpers ----------
function toIntOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

function textOrNull(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function splitList(value) {
  return String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function today() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

function httpsOrNull(url) {
  if (!url) return null;
  const fixed = String(url).replace(/^http:\/\//, 'https://');
  return fixed.startsWith('https://') ? fixed : null;
}

// Mirrors public.isbn_to_13 in the database, so problems show up before saving.
function isbnTo13(raw) {
  const s = String(raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  let core;
  if (/^\d{9}[\dX]$/.test(s)) {
    let total = 0;
    for (let i = 0; i < 10; i++) total += (10 - i) * (s[i] === 'X' ? 10 : Number(s[i]));
    if (total % 11 !== 0) return null;
    core = '978' + s.slice(0, 9);
  } else if (/^97[89]\d{10}$/.test(s)) {
    core = s.slice(0, 12);
  } else {
    return null;
  }
  let total = 0;
  for (let i = 0; i < 12; i++) total += Number(core[i]) * (i % 2 ? 3 : 1);
  const check = (10 - (total % 10)) % 10;
  if (s.length === 13 && Number(s[12]) !== check) return null;
  return core + check;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function button(label, onClick, props = {}) {
  return el('button', { type: 'button', textContent: label, onclick: onClick, ...props });
}

function coverEl(url) {
  const safe = httpsOrNull(url);
  if (!safe) return el('div', { className: 'cover-placeholder' });
  const img = el('img', { src: safe, alt: '', loading: 'lazy', decoding: 'async', width: 56, height: 84 });
  img.addEventListener('error', () => img.replaceWith(el('div', { className: 'cover-placeholder' })));
  return img;
}

function bookName(row) {
  return row.title || (row.isbn_13 ? `ISBN ${row.isbn_13}` : 'Untitled book');
}

// Turns database errors into something actionable.
function describeError(error) {
  const message = error?.message ?? String(error);
  if (/jwt|token/i.test(message) && /expired|invalid/i.test(message)) {
    supabaseClient.auth.signOut();
    return 'Your session has expired — please sign in again.';
  }
  if (error?.code === '23505') return 'This book is already in your list.';
  if (error?.code === '22023') return `${message}. ${error.hint ?? ''}`.trim();
  if (error?.code === '23514') {
    const byConstraint = {
      books_pages_order: "Current page can't be more than total pages.",
      books_dates_order: "Finished date can't be before the start date.",
      books_cover_https: 'Cover URL must start with https://',
      books_has_identity: 'Enter an ISBN, or at least a title.',
      books_rating_check: 'Rating must be between 0 and 5.',
      books_year_check: 'Year published looks wrong.'
    };
    const match = Object.keys(byConstraint).find((name) => message.includes(name));
    if (match) return byConstraint[match];
  }
  return message;
}

function setFormError(text) {
  $('form-error').textContent = text;
  if (text) $('form-message').textContent = '';
}

function setFormMessage(text) {
  $('form-message').textContent = text;
  if (text) $('form-error').textContent = '';
}

// ---------- Open Library ----------
async function fetchOpenLibrary(isbn13) {
  const response = await fetch(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn13}&format=json&jscmd=data`
  );
  if (!response.ok) throw new Error(`Open Library returned ${response.status}`);
  const meta = (await response.json())[`ISBN:${isbn13}`];
  if (!meta) return null;

  // The edition record has the work key (links editions of the same book) and language.
  let edition = null;
  if (meta.key) {
    try {
      const editionResponse = await fetch(`https://openlibrary.org${meta.key}.json`);
      if (editionResponse.ok) edition = await editionResponse.json();
    } catch (err) {
      console.warn('admin: could not load edition record', err);
    }
  }

  const year = String(meta.publish_date ?? '').match(/\d{4}/)?.[0];
  return {
    title: meta.title ?? null,
    subtitle: meta.subtitle ?? null,
    authors: (meta.authors ?? []).map((a) => a.name).filter(Boolean),
    cover_url: httpsOrNull(meta.cover?.medium ?? meta.cover?.large ?? meta.cover?.small),
    publisher: meta.publishers?.[0]?.name ?? null,
    published_year: year ? Number(year) : null,
    page_count: Number.isInteger(meta.number_of_pages) ? meta.number_of_pages : null,
    language: edition?.languages?.[0]?.key?.split('/').pop() ?? null,
    ol_edition_key: meta.key ?? null,
    ol_work_key: edition?.works?.[0]?.key ?? null,
    metadata: { open_library: meta },
    metadata_fetched_at: new Date().toISOString()
  };
}

function metadataColumns(result) {
  const { title, subtitle, authors, cover_url, publisher, published_year, page_count, language,
    ol_edition_key, ol_work_key, metadata, metadata_fetched_at } = result;
  return { title, subtitle, authors, cover_url, publisher, published_year, page_count, language,
    ol_edition_key, ol_work_key, metadata, metadata_fetched_at };
}

// ---------- ISBN lookup in the form ----------
let lastLookedUp = null;

isbnInput.addEventListener('change', () => lookupIsbn(false));
$('lookup-btn').addEventListener('click', () => lookupIsbn(true));

async function lookupIsbn(force) {
  const raw = isbnInput.value.trim();
  const status = $('lookup-status');
  showDuplicate(null);
  if (!raw) {
    status.textContent = '';
    return;
  }
  const isbn13 = isbnTo13(raw);
  if (!isbn13) {
    status.textContent = "That isn't a valid ISBN — check for typos (10 or 13 digits).";
    return;
  }
  if (!force && isbn13 === lastLookedUp) return;
  lastLookedUp = isbn13;

  const existing = books.find((b) => b.isbn_13 === isbn13 && b.id !== editing?.id);
  if (existing) showDuplicate(existing);

  status.textContent = 'Looking up on Open Library…';
  $('lookup-btn').disabled = true;
  try {
    const result = await fetchOpenLibrary(isbn13);
    if (isbnTo13(isbnInput.value) !== isbn13) return; // ISBN changed while we were waiting
    if (!result) {
      lookup = null;
      status.textContent = 'Not found on Open Library — fill in the details below yourself.';
      $('details').open = true;
      updatePreview();
      return;
    }
    lookup = result;
    $('title').value = result.title ?? '';
    $('subtitle').value = result.subtitle ?? '';
    $('authors').value = result.authors.join(', ');
    $('cover_url').value = result.cover_url ?? '';
    $('publisher').value = result.publisher ?? '';
    $('published_year').value = result.published_year ?? '';
    if (!totalPagesInput.value && result.page_count) {
      totalPagesInput.value = result.page_count;
      syncProgress();
    }
    status.textContent = 'Found on Open Library. Check this is the right edition before saving.';
    updatePreview();
  } catch (err) {
    console.error('admin: Open Library lookup failed', err);
    status.textContent = 'Open Library lookup failed — try again, or fill in the details yourself.';
    $('details').open = true;
  } finally {
    $('lookup-btn').disabled = false;
  }
}

function updatePreview() {
  const preview = $('preview');
  const title = textOrNull($('title').value);
  if (!title) {
    preview.hidden = true;
    return;
  }
  const authors = splitList($('authors').value).join(', ');
  const facts = [
    textOrNull($('publisher').value),
    textOrNull($('published_year').value),
    totalPagesInput.value ? `${totalPagesInput.value} pages` : null
  ].filter(Boolean).join(' · ');
  preview.replaceChildren(
    coverEl($('cover_url').value),
    el('div', {},
      el('div', { className: 'title', textContent: title }),
      textOrNull($('subtitle').value) && el('div', { textContent: $('subtitle').value }),
      el('div', { textContent: authors || 'Unknown author' }),
      facts && el('div', { className: 'hint', textContent: facts })
    )
  );
  preview.hidden = false;
}
detailInputs.forEach((input) => input.addEventListener('input', updatePreview));

function showDuplicate(row) {
  const notice = $('duplicate-notice');
  if (!row) {
    notice.hidden = true;
    notice.replaceChildren();
    return;
  }
  const archived = !!row.archived_at;
  notice.replaceChildren(
    `${archived ? 'An archived entry' : 'Already in your list'}: “${bookName(row)}”.`,
    archived
      ? button('Restore it instead', () => restoreBook(row))
      : button('Edit it instead', () => startEdit(row))
  );
  notice.hidden = false;
}

// ---------- Status, progress & rating ----------
function syncProgress() {
  const cur = toIntOrNull(currentPageInput.value);
  const total = toIntOrNull(totalPagesInput.value);
  const derived = cur !== null && total !== null && total > 0;
  if (derived) progressInput.value = Math.min(100, Math.max(0, Math.round((cur / total) * 100)));
  progressInput.disabled = derived;
  $('progress-hint').textContent = derived ? '(from pages)' : '(set manually, e.g. for audiobooks)';
}
currentPageInput.addEventListener('input', syncProgress);
totalPagesInput.addEventListener('input', () => {
  syncProgress();
  updatePreview();
});

function applyStatus(userChanged) {
  const status = statusInput.value;
  $('progress-fields').hidden = status === 'want_to_read';
  $('started-field').hidden = status === 'want_to_read';
  $('finished-field').hidden = status !== 'finished';
  if (!userChanged) return;
  if (status === 'finished') {
    if (totalPagesInput.value) currentPageInput.value = totalPagesInput.value;
    progressInput.value = 100;
    if (!finishedInput.value) finishedInput.value = today();
    syncProgress();
  }
  if (status === 'reading' && !startedInput.value) startedInput.value = today();
}
statusInput.addEventListener('change', () => applyStatus(true));

function setRating(value) {
  document.querySelectorAll('input[name="rating"]').forEach((input) => {
    input.checked = Number(input.value) === value;
  });
  updateRatingText();
}

function getRating() {
  const checked = document.querySelector('input[name="rating"]:checked');
  if (checked) return Number(checked.value);
  // A legacy 0 rating has no star to select; keep it unless the rating was changed.
  return !ratingTouched && editing?.rating === 0 ? 0 : null;
}

function updateRatingText() {
  const rating = getRating();
  $('rating-text').textContent = rating === null ? 'Not rated' : `${rating} / 5`;
}

document.querySelectorAll('input[name="rating"]').forEach((input) => {
  input.addEventListener('change', () => {
    ratingTouched = true;
    updateRatingText();
  });
});
$('clear-rating').addEventListener('click', () => {
  ratingTouched = true;
  setRating(null);
});

// ---------- Form ----------
function resetForm() {
  form.reset();
  editing = null;
  lookup = null;
  lastLookedUp = null;
  ratingTouched = false;
  progressInput.value = '0';
  $('form-heading').textContent = 'Add a book';
  saveBtn.textContent = 'Add book';
  $('lookup-status').textContent = '';
  $('details').open = false;
  $('preview').hidden = true;
  showDuplicate(null);
  setFormError('');
  syncProgress();
  applyStatus(false);
  updateRatingText();
}
$('cancel-edit').addEventListener('click', () => {
  resetForm();
  setFormMessage('');
});

function startEdit(row) {
  resetForm();
  editing = row;
  isbnInput.value = row.isbn ?? '';
  lastLookedUp = row.isbn_13;
  $('title').value = row.title ?? '';
  $('subtitle').value = row.subtitle ?? '';
  $('authors').value = (row.authors ?? []).join(', ');
  $('cover_url').value = row.cover_url ?? '';
  $('publisher').value = row.publisher ?? '';
  $('published_year').value = row.published_year ?? '';
  statusInput.value = row.status;
  $('format').value = row.format ?? '';
  currentPageInput.value = row.current_page ?? '';
  totalPagesInput.value = row.total_pages ?? '';
  progressInput.value = row.progress_percent ?? 0;
  startedInput.value = row.started_on ?? '';
  finishedInput.value = row.finished_on ?? '';
  setRating(row.rating);
  $('tags').value = (row.tags ?? []).join(', ');
  $('notes').value = row.notes ?? '';
  $('sort_order').value = row.sort_order ?? 0;
  if (!row.title) $('details').open = true;

  $('form-heading').textContent = `Editing: ${bookName(row)}`;
  saveBtn.textContent = 'Save changes';
  syncProgress();
  applyStatus(false);
  updatePreview();
  setFormMessage('');

  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  form.classList.remove('flash');
  void form.offsetWidth; // restart the highlight animation
  form.classList.add('flash');
  isbnInput.focus({ preventScroll: true });
}

function buildPayload() {
  const status = statusInput.value;
  return {
    isbn: textOrNull(isbnInput.value),
    title: textOrNull($('title').value),
    subtitle: textOrNull($('subtitle').value),
    authors: splitList($('authors').value),
    cover_url: textOrNull($('cover_url').value),
    publisher: textOrNull($('publisher').value),
    published_year: toIntOrNull($('published_year').value),
    status,
    format: $('format').value || null,
    current_page: toIntOrNull(currentPageInput.value),
    total_pages: toIntOrNull(totalPagesInput.value),
    progress_percent: Math.min(100, Math.max(0, toIntOrNull(progressInput.value) ?? 0)),
    started_on: startedInput.value || null,
    finished_on: status === 'finished' ? finishedInput.value || null : null,
    rating: getRating(),
    tags: splitList($('tags').value),
    notes: textOrNull($('notes').value),
    sort_order: toIntOrNull($('sort_order').value) ?? 0,
    ...(lookup && {
      page_count: lookup.page_count,
      language: lookup.language,
      ol_edition_key: lookup.ol_edition_key,
      ol_work_key: lookup.ol_work_key,
      metadata: lookup.metadata,
      metadata_fetched_at: lookup.metadata_fetched_at
    })
  };
}

function validate(payload) {
  if (payload.isbn && !isbnTo13(payload.isbn)) return "That isn't a valid ISBN — check for typos.";
  if (!payload.isbn && !payload.title) return 'Enter an ISBN, or at least a title.';
  if (payload.current_page !== null && payload.total_pages !== null && payload.current_page > payload.total_pages) {
    return "Current page can't be more than total pages.";
  }
  if (payload.cover_url && !payload.cover_url.startsWith('https://')) return 'Cover URL must start with https://';
  if (payload.started_on && payload.finished_on && payload.finished_on < payload.started_on) {
    return "Finished date can't be before the start date.";
  }
  return null;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saveBtn.disabled) return;
  setFormError('');
  const payload = buildPayload();
  const problem = validate(payload);
  if (problem) {
    setFormError(problem);
    return;
  }

  const label = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    // Catch duplicates before the database does, so we can offer to edit the existing entry.
    const isbn13 = payload.isbn ? isbnTo13(payload.isbn) : null;
    if (isbn13 && isbn13 !== editing?.isbn_13) {
      let query = supabaseClient.from('books').select('*').eq('isbn_13', isbn13).is('archived_at', null);
      if (editing) query = query.neq('id', editing.id);
      const { data: dupes, error: dupeError } = await query.limit(1);
      if (dupeError) throw dupeError;
      if (dupes.length) {
        showDuplicate(dupes[0]);
        setFormError('This book is already in your list.');
        return;
      }
    }

    const query = editing
      ? supabaseClient.from('books').update(payload).eq('id', editing.id)
      : supabaseClient.from('books').insert(payload);
    const { data, error } = await query.select().single();
    if (error) {
      setFormError(describeError(error));
      return;
    }
    upsertLocal(data);
    resetForm();
    setFormMessage(`Saved “${bookName(data)}”.`);
  } catch (err) {
    console.error('admin: save failed', err);
    setFormError(describeError(err));
  } finally {
    saveBtn.disabled = false;
    if (saveBtn.textContent === 'Saving…') saveBtn.textContent = label;
  }
});

// ---------- List ----------
async function loadBooks() {
  $('list-summary').textContent = 'Loading…';
  const { data, error } = await supabaseClient
    .from('books')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) {
    $('list-summary').textContent = '';
    $('book-rows').replaceChildren(el('tr', {}, el('td', { colSpan: 6, className: 'error', textContent: describeError(error) })));
    return;
  }
  books = data;
  renderBooks();
}

// Patch one row locally instead of reloading the whole list.
function upsertLocal(row) {
  const index = books.findIndex((b) => b.id === row.id);
  if (index === -1) books.unshift(row);
  else books[index] = row;
  books.sort((a, b) => a.sort_order - b.sort_order || b.created_at.localeCompare(a.created_at));
  renderBooks();
}

function matchesSearch(row, term) {
  if (!term) return true;
  return [row.title, row.subtitle, row.authors_display, row.isbn, row.isbn_13, row.isbn_10, ...(row.tags ?? [])]
    .some((value) => value && String(value).toLowerCase().includes(term));
}

function renderBooks() {
  const term = $('search').value.trim().toLowerCase();
  const status = $('status-filter').value;
  const showArchived = $('show-archived').checked;
  const archivedCount = books.filter((b) => b.archived_at).length;
  const visible = books.filter((row) =>
    (showArchived || !row.archived_at) && (!status || row.status === status) && matchesSearch(row, term)
  );

  const missing = books.filter((b) => !b.archived_at && b.isbn_13 && (!b.title || !b.cover_url)).length;
  $('refresh-missing').hidden = missing === 0;
  $('refresh-missing').textContent = `Fill in missing details (${missing})`;

  let summary = `${visible.length} of ${books.length - (showArchived ? 0 : archivedCount)} books`;
  if (!showArchived && archivedCount) summary += ` · ${archivedCount} archived (hidden)`;
  $('list-summary').textContent = summary;

  $('book-rows').replaceChildren(...(visible.length
    ? visible.map(bookRow)
    : [el('tr', {}, el('td', { colSpan: 6, className: 'hint', textContent: books.length ? 'No books match.' : 'No books yet — add one above.' }))]));
}
['input', 'change'].forEach((type) => {
  $('search').addEventListener(type, renderBooks);
  $('status-filter').addEventListener(type, renderBooks);
  $('show-archived').addEventListener(type, renderBooks);
});

function bookRow(row) {
  const archived = !!row.archived_at;
  const identifiers = [row.isbn_13 ? `ISBN ${row.isbn_13}` : null, row.format].filter(Boolean).join(' · ');
  const pages = row.current_page !== null && row.total_pages !== null ? ` (${row.current_page}/${row.total_pages})` : '';
  const actions = archived
    ? [button('Restore', () => restoreBook(row)), button('Delete permanently', () => deleteBook(row))]
    : [
        button('Edit', () => startEdit(row)),
        row.isbn_13 && button('Refresh', () => refreshBook(row), { title: 'Re-fetch title, author and cover from Open Library' }),
        button('Archive', () => archiveBook(row))
      ];

  return el('tr', { className: archived ? 'archived' : '' },
    el('td', { className: 'cover' }, coverEl(row.cover_url)),
    el('td', {},
      el('div', { className: 'book-title', textContent: bookName(row) },
        !row.title && el('span', { className: 'badge warn', textContent: 'needs details' }),
        archived && el('span', { className: 'badge', textContent: 'archived' })),
      el('div', { className: 'book-sub', textContent: row.authors_display || 'Unknown author' }),
      el('div', { className: 'book-sub', textContent: identifiers }),
      row.tags?.length > 0 && el('div', { className: 'book-sub', textContent: row.tags.map((t) => `#${t}`).join(' ') })
    ),
    el('td', { textContent: STATUS_LABELS[row.status] ?? row.status }),
    el('td', { textContent: row.status === 'want_to_read' ? '—' : `${row.progress_percent}%${pages}` }),
    el('td', {
      className: row.rating === null ? 'rating-cell unrated' : 'rating-cell',
      textContent: row.rating === null ? '—' : '★'.repeat(row.rating) + '☆'.repeat(5 - row.rating),
      title: row.rating === null ? 'Not rated' : `${row.rating} / 5`
    }),
    el('td', { className: 'actions' }, ...actions.filter(Boolean))
  );
}

// ---------- Row actions ----------
async function updateRow(row, changes) {
  const { data, error } = await supabaseClient.from('books').update(changes).eq('id', row.id).select().single();
  if (error) {
    alert(describeError(error));
    return null;
  }
  upsertLocal(data);
  if (editing?.id === row.id) editing = data;
  return data;
}

async function archiveBook(row) {
  if (!confirm(`Archive “${bookName(row)}”? It disappears from the widget but can be restored.`)) return;
  const updated = await updateRow(row, { archived_at: new Date().toISOString() });
  if (updated && editing?.id === row.id) resetForm();
}

async function restoreBook(row) {
  const updated = await updateRow(row, { archived_at: null });
  if (updated) {
    showDuplicate(null);
    setFormMessage(`Restored “${bookName(updated)}”.`);
  }
}

async function deleteBook(row) {
  if (!confirm(`Permanently delete “${bookName(row)}”? This can't be undone.`)) return;
  if (!confirm('Are you sure? Its reading history is deleted too.')) return;
  const { error } = await supabaseClient.from('books').delete().eq('id', row.id);
  if (error) {
    alert(describeError(error));
    return;
  }
  books = books.filter((b) => b.id !== row.id);
  renderBooks();
}

// quiet (bulk) mode only fills empty fields, so hand-edited details are never overwritten.
async function refreshBook(row, { quiet = false } = {}) {
  if (!quiet && row.title && !confirm(`Replace the title, author and cover of “${row.title}” with Open Library's details?`)) return false;
  try {
    const result = await fetchOpenLibrary(row.isbn_13);
    if (!result) {
      if (!quiet) alert(`ISBN ${row.isbn_13} wasn't found on Open Library. Use Edit to fill in the details yourself.`);
      return false;
    }
    const isEmpty = (v) => v === null || v === undefined || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.keys(v).length === 0);
    const changes = Object.fromEntries(
      Object.entries(metadataColumns(result)).filter(([key]) => !quiet || isEmpty(row[key]))
    );
    if (Object.keys(changes).length === 0) return false;
    return !!(await updateRow(row, changes));
  } catch (err) {
    console.error('admin: refresh failed', err);
    if (!quiet) alert('Open Library lookup failed — try again later.');
    return false;
  }
}

$('refresh-missing').addEventListener('click', async () => {
  const targets = books.filter((b) => !b.archived_at && b.isbn_13 && (!b.title || !b.cover_url));
  const btn = $('refresh-missing');
  btn.disabled = true;
  let updated = 0;
  for (const [i, row] of targets.entries()) {
    btn.textContent = `Looking up ${i + 1} of ${targets.length}…`;
    if (await refreshBook(row, { quiet: true })) updated++;
  }
  btn.disabled = false;
  renderBooks();
  $('list-summary').textContent += ` · Filled in ${updated} of ${targets.length}`;
});

resetForm();
