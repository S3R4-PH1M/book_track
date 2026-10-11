// Fill these in from Supabase: Project Settings > API.
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_PUBLIC_ANON_KEY';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const loginSection = document.getElementById('login');
const appSection = document.getElementById('app');
const loginError = document.getElementById('login-error');
const formError = document.getElementById('form-error');
const form = document.getElementById('book-form');
const currentPageInput = document.getElementById('current_page');
const totalPagesInput = document.getElementById('total_pages');
const progressInput = document.getElementById('progress_percent');

document.getElementById('login-btn').addEventListener('click', async () => {
  loginError.textContent = '';
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      loginError.textContent = error.message;
      return;
    }
    showApp();
  } catch (err) {
    console.error('admin: sign-in failed', err);
    loginError.textContent = 'Sign-in failed — check the console for details.';
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  showLogin();
});

function showApp() {
  loginSection.style.display = 'none';
  appSection.style.display = 'block';
  loadBooks();
}

function showLogin() {
  loginSection.style.display = 'block';
  appSection.style.display = 'none';
}

async function init() {
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    showApp();
  } else {
    showLogin();
  }
}
init();

function recomputeProgress() {
  const cur = parseInt(currentPageInput.value, 10);
  const total = parseInt(totalPagesInput.value, 10);
  if (!Number.isNaN(cur) && !Number.isNaN(total) && total > 0) {
    progressInput.value = Math.round((cur / total) * 100);
  }
}
currentPageInput.addEventListener('input', recomputeProgress);
totalPagesInput.addEventListener('input', recomputeProgress);

function toIntOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.textContent = '';

  const id = document.getElementById('book-id').value || undefined;
  const payload = {
    isbn: document.getElementById('isbn').value.trim(),
    status: document.getElementById('status').value,
    current_page: toIntOrNull(currentPageInput.value),
    total_pages: toIntOrNull(totalPagesInput.value),
    progress_percent: toIntOrNull(progressInput.value) ?? 0,
    rating: toIntOrNull(document.getElementById('rating').value),
    sort_order: toIntOrNull(document.getElementById('sort_order').value) ?? 0
  };

  const query = id
    ? supabaseClient.from('books').update(payload).eq('id', id)
    : supabaseClient.from('books').insert(payload);

  const { error } = await query;
  if (error) {
    formError.textContent = error.message;
    return;
  }
  resetForm();
  await loadBooks();
});

document.getElementById('cancel-edit').addEventListener('click', resetForm);

function resetForm() {
  form.reset();
  document.getElementById('book-id').value = '';
  progressInput.value = '0';
}

async function loadBooks() {
  const { data, error } = await supabaseClient
    .from('books')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });

  const tbody = document.getElementById('book-rows');
  if (error) {
    tbody.innerHTML = `<tr><td colspan="5">${error.message}</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map((row) => `
    <tr>
      <td>${row.isbn}</td>
      <td>${row.status}</td>
      <td>${row.progress_percent}%</td>
      <td>${row.rating ?? '-'}</td>
      <td>
        <button data-edit="${row.id}" type="button">Edit</button>
        <button data-delete="${row.id}" type="button">Delete</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => editRow(data.find((r) => r.id === btn.dataset.edit)));
  });
  tbody.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteRow(btn.dataset.delete));
  });
}

function editRow(row) {
  document.getElementById('book-id').value = row.id;
  document.getElementById('isbn').value = row.isbn;
  document.getElementById('status').value = row.status;
  currentPageInput.value = row.current_page ?? '';
  totalPagesInput.value = row.total_pages ?? '';
  progressInput.value = row.progress_percent ?? 0;
  document.getElementById('rating').value = row.rating ?? '';
  document.getElementById('sort_order').value = row.sort_order ?? 0;
}

async function deleteRow(id) {
  if (!confirm('Delete this book?')) return;
  const { error } = await supabaseClient.from('books').delete().eq('id', id);
  if (error) {
    alert(error.message);
    return;
  }
  await loadBooks();
}
