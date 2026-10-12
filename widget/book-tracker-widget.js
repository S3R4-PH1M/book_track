const BT_STATUS_LABELS = {
  want_to_read: 'Want to read',
  reading: 'Reading',
  paused: 'Paused',
  finished: 'Finished',
  abandoned: 'Abandoned'
};
const BT_COLUMNS = 'isbn_13,title,author,cover_url,status,progress_percent,current_page,total_pages,rating,finished_on';
const BT_CACHE_TTL_MS = 10 * 60 * 1000;
const BT_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;500&display=swap';

class BookTrackerWidget extends HTMLElement {
  static get observedAttributes() {
    return ['project-url', 'anon-key', 'limit', 'status', 'start'];
  }

  connectedCallback() {
    // Moving the element around the DOM reconnects it; the shadow root and data survive.
    if (this._root) return;
    this._root = this.attachShadow({ mode: 'open' });
    BookTrackerWidget._loadFonts();
    this._renderShell();
    this._load();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (!this._root || oldValue === newValue) return;
    // Several attributes are often set together; reload once.
    clearTimeout(this._reloadTimer);
    this._reloadTimer = setTimeout(() => this._load(), 0);
  }

  // @font-face inside a shadow root is ignored by Chrome and Safari, so the font
  // stylesheet goes in the page <head> (once, however many widgets there are).
  static _loadFonts() {
    if (document.getElementById('book-tracker-widget-fonts')) return;
    const link = document.createElement('link');
    link.id = 'book-tracker-widget-fonts';
    link.rel = 'stylesheet';
    link.href = BT_FONTS_URL;
    document.head.append(link);
  }

  get projectUrl() {
    return (this.getAttribute('project-url') || '').replace(/\/$/, '');
  }

  get anonKey() {
    return this.getAttribute('anon-key') || '';
  }

  get limit() {
    const n = parseInt(this.getAttribute('limit'), 10);
    return Math.min(Math.max(Number.isNaN(n) ? 20 : n, 1), 100);
  }

  // e.g. status="reading,finished"; unknown values are ignored.
  get statuses() {
    return (this.getAttribute('status') || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s in BT_STATUS_LABELS);
  }

  get _endpoint() {
    const params = new URLSearchParams({
      select: BT_COLUMNS,
      // Current reads first, so a limited fetch always includes them; then most recently finished.
      order: 'status_rank.asc,sort_order.asc,finished_on.desc.nullslast,created_at.desc',
      limit: String(this.limit)
    });
    if (this.statuses.length) params.set('status', `in.(${this.statuses.join(',')})`);
    return `${this.projectUrl}/rest/v1/public_books?${params}`;
  }

  async _load() {
    if (!this.projectUrl || !this.anonKey) {
      this._renderError('Missing required project-url or anon-key attribute.', false);
      return;
    }

    const loadId = (this._loadId = (this._loadId || 0) + 1);
    const cacheKey = `book-tracker-widget:${this._endpoint}`;
    const cached = this._readCache(cacheKey);
    if (cached) this._renderList(cached.books);
    if (cached && Date.now() - cached.savedAt < BT_CACHE_TTL_MS) return;

    try {
      // Read the column-limited public view, and name the columns explicitly, so nothing
      // private added to the books table later can leak through the public anon key.
      const response = await fetch(this._endpoint, {
        headers: { apikey: this.anonKey, Authorization: `Bearer ${this.anonKey}` }
      });
      if (!response.ok) throw new Error(`Backend returned ${response.status}`);
      const books = await this._fillMissingMetadata(await response.json());
      if (loadId !== this._loadId) return; // attributes changed while loading
      this._writeCache(cacheKey, books);
      if (!cached || JSON.stringify(cached.books) !== JSON.stringify(books)) this._renderList(books);
    } catch (error) {
      console.error('book-tracker-widget: failed to load books', error);
      if (loadId === this._loadId && !cached) this._renderError('Could not load books right now.', true);
    }
  }

  // Titles and covers are stored in the database by the admin page. For rows saved before
  // that (or by another tool), look them all up on Open Library in one batched request.
  async _fillMissingMetadata(rows) {
    const missing = rows.filter((row) => row.isbn_13 && (!row.title || !row.cover_url));
    let meta = {};
    if (missing.length) {
      try {
        const bibkeys = missing.map((row) => `ISBN:${row.isbn_13}`).join(',');
        const response = await fetch(
          `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(bibkeys)}&format=json&jscmd=data`
        );
        if (!response.ok) throw new Error(`Open Library returned ${response.status}`);
        meta = await response.json();
      } catch (error) {
        console.error('book-tracker-widget: failed to load metadata from Open Library', error);
      }
    }

    return rows.map((row) => {
      const found = row.isbn_13 ? meta[`ISBN:${row.isbn_13}`] : null;
      const foundAuthors = (found?.authors || []).map((a) => a.name).join(', ');
      return {
        ...row,
        title: row.title || found?.title || 'Unknown title',
        author: row.author || foundAuthors || 'Unknown author',
        cover_url: this._https(row.cover_url) || this._https(found?.cover?.medium)
      };
    });
  }

  _https(url) {
    if (!url) return null;
    const fixed = String(url).replace(/^http:\/\//, 'https://');
    return fixed.startsWith('https://') ? fixed : null;
  }

  // sessionStorage can be unavailable (private mode, blocked storage): caching is best-effort.
  _readCache(key) {
    try {
      const value = JSON.parse(sessionStorage.getItem(key));
      return value && Array.isArray(value.books) ? value : null;
    } catch {
      return null;
    }
  }

  _writeCache(key, books) {
    try {
      sessionStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), books }));
    } catch {
      // ignore
    }
  }

  _renderShell() {
    this._root.innerHTML = `
      <style>${this._css()}</style>
      <div class="bt-carousel" id="carousel"><div class="bt-loading">Loading books…</div></div>
    `;
  }

  _renderList(books) {
    this._books = books;
    const carousel = this._root.getElementById('carousel');

    if (!books.length) {
      carousel.innerHTML = '<div class="bt-empty">No books yet.</div>';
      return;
    }

    const startAt = this.getAttribute('start') === 'first' ? -1 : books.findIndex((book) => book.status === 'reading');
    this._index = startAt !== -1 ? startAt : 0;
    this._renderCarouselChrome(carousel);
    this._renderCurrentCard();
  }

  _renderCarouselChrome(carousel) {
    const showArrows = this._books.length > 1;
    carousel.innerHTML = `
      <div class="bt-stage" id="stage" role="region" aria-roledescription="carousel"
           aria-label="Books I'm reading"${showArrows ? ' tabindex="0"' : ''}>
        ${showArrows ? '<button class="bt-arrow bt-arrow-prev" id="prev" aria-label="Previous book">&#8249;</button>' : ''}
        <div class="bt-viewport" id="viewport"></div>
        ${showArrows ? '<button class="bt-arrow bt-arrow-next" id="next" aria-label="Next book">&#8250;</button>' : ''}
      </div>
      ${showArrows ? '<div class="bt-counter" id="counter" aria-hidden="true"></div>' : ''}
      <div class="bt-sr-only" id="announce" aria-live="polite"></div>
    `;

    // Every card is rendered up front and stacked in one grid cell, so the viewport is
    // always as tall as the tallest book and the page doesn't jump when stepping through.
    const viewport = this._root.getElementById('viewport');
    viewport.innerHTML = this._books.map((book) => this._cardHtml(book)).join('');
    for (const img of viewport.querySelectorAll('img')) {
      img.addEventListener('error', () => {
        img.outerHTML = '<div class="bt-cover bt-cover-placeholder"></div>';
      });
    }

    if (!showArrows) return;
    this._root.getElementById('prev').addEventListener('click', () => this._step(-1));
    this._root.getElementById('next').addEventListener('click', () => this._step(1));

    const stage = this._root.getElementById('stage');
    stage.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') this._step(-1);
      else if (event.key === 'ArrowRight') this._step(1);
      else return;
      event.preventDefault();
    });

    // Swipe on touch screens (vertical scrolling still works: touch-action: pan-y).
    let startX = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'mouse') startX = event.clientX;
    });
    viewport.addEventListener('pointerup', (event) => {
      if (startX === null) return;
      const dx = event.clientX - startX;
      startX = null;
      if (Math.abs(dx) >= 40) this._step(dx < 0 ? 1 : -1);
    });
    viewport.addEventListener('pointercancel', () => {
      startX = null;
    });
  }

  _step(direction) {
    const len = this._books.length;
    this._index = (this._index + direction + len) % len;
    this._renderCurrentCard(direction);
  }

  _renderCurrentCard(direction) {
    const cards = this._root.getElementById('viewport').children;
    for (const [i, card] of [...cards].entries()) {
      card.classList.toggle('bt-active', i === this._index);
      card.classList.remove('bt-slide-next', 'bt-slide-prev');
    }
    if (direction) {
      const active = cards[this._index];
      void active.offsetWidth; // restart the slide animation when stepping quickly
      active.classList.add(direction === 1 ? 'bt-slide-next' : 'bt-slide-prev');
    }

    const book = this._books[this._index];
    const counter = this._root.getElementById('counter');
    if (counter) counter.textContent = `${this._index + 1} / ${this._books.length}`;
    if (direction) {
      this._root.getElementById('announce').textContent =
        `Book ${this._index + 1} of ${this._books.length}: ${book.title} by ${book.author}`;
    }
  }

  _renderError(message, canRetry) {
    const carousel = this._root.getElementById('carousel');
    if (!carousel) return;
    carousel.innerHTML = `
      <div class="bt-error">${this._escape(message)}
        ${canRetry ? '<button class="bt-retry" id="retry" type="button">Retry</button>' : ''}
      </div>`;
    const retry = this._root.getElementById('retry');
    if (retry) {
      retry.addEventListener('click', () => {
        carousel.innerHTML = '<div class="bt-loading">Loading books…</div>';
        this._load();
      });
    }
  }

  _formatMonth(isoDate) {
    if (!isoDate) return '';
    const date = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  _cardHtml(book) {
    const rating = Number.isInteger(book.rating) ? book.rating : null;
    const stars = rating !== null ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : '';
    const cover = book.cover_url
      ? `<img class="bt-cover" src="${this._escape(book.cover_url)}" alt="${this._escape(book.title)} cover"
             width="56" height="84" loading="lazy" decoding="async" />`
      : '<div class="bt-cover bt-cover-placeholder"></div>';
    const hasPages = book.current_page != null && book.total_pages != null;
    const pages = hasPages ? `<div class="bt-pages">${book.current_page}/${book.total_pages} pages</div>` : '';
    const statusLabel = BT_STATUS_LABELS[book.status] || String(book.status || '').replaceAll('_', ' ');
    const finished = book.status === 'finished' && book.finished_on
      ? `<div class="bt-finished">Finished ${this._escape(this._formatMonth(book.finished_on))}</div>`
      : '';
    const progress = Number.isInteger(book.progress_percent) ? book.progress_percent : 0;
    const showProgress = book.status !== 'want_to_read';

    return `
      <div class="bt-card">
        ${cover}
        <div class="bt-info">
          <div class="bt-title">${this._escape(book.title)}</div>
          <div class="bt-author">${this._escape(book.author)}</div>
          <div class="bt-status">${this._escape(statusLabel)}</div>
          ${showProgress ? `<div class="bt-progress">
            <progress max="100" value="${progress}" aria-label="Progress">${progress}%</progress>
            <span class="bt-percent">${progress}%</span>
          </div>` : ''}
          ${showProgress ? pages : ''}
          ${finished}
          ${rating !== null ? `<div class="bt-rating" aria-label="Rated ${rating} out of 5">${stars}</div>` : ''}
        </div>
      </div>
    `;
  }

  _escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  // Theme from the host page by setting any --bt-* property on the element, e.g.
  //   book-tracker-widget { --bt-bg: #fff; --bt-fg: #222; --bt-max-width: 400px; }
  _css() {
    return `
      :host {
        --bg: var(--bt-bg, #0A0A0A);
        --fg: var(--bt-fg, #c3e28d);
        --fg-dim: var(--bt-fg-dim, rgba(195, 226, 141, 0.6));
        --line: var(--bt-line, rgba(195, 226, 141, 0.22));
        --line-strong: var(--bt-line-strong, rgba(195, 226, 141, 0.4));
        --accent: var(--bt-accent, #e8b923);
        --error: var(--bt-error, #ff4d4d);
        --font-display: var(--bt-font-display, "Bebas Neue", Impact, "Arial Narrow", sans-serif);
        --font-body: var(--bt-font-body, Helvetica, Arial, sans-serif);
        --font-mono: var(--bt-font-mono, "IBM Plex Mono", ui-monospace, "Courier New", monospace);
        display: block;
        max-width: var(--bt-max-width, 440px);
        font-family: var(--font-body);
        background: var(--bg);
        color: var(--fg);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
      * { box-sizing: border-box; }
      .bt-sr-only {
        position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
      }
      .bt-stage { display: flex; align-items: stretch; gap: 0.5rem; padding: 0.75rem 0.75rem 0; }
      .bt-stage:focus-visible { outline: 1px solid var(--fg); outline-offset: -1px; }
      .bt-viewport {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        touch-action: pan-y;
        display: grid;
        grid-template-columns: minmax(0, 1fr); /* cards shrink to fit instead of overflowing */
      }
      .bt-arrow {
        flex: 0 0 28px;
        width: 28px;
        border: 1px solid var(--line-strong);
        background: var(--bg);
        color: var(--fg);
        font-family: var(--font-mono);
        font-size: 16px;
        line-height: 1;
        padding: 0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .bt-arrow:hover { background: var(--fg); color: var(--bg); }
      .bt-arrow:active { transform: translateY(1px); }
      .bt-arrow:focus-visible { outline: 1px solid var(--fg); outline-offset: 2px; }
      .bt-counter {
        text-align: center;
        font-family: var(--font-mono);
        font-size: 0.7rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--fg-dim);
        margin-top: 0.5rem;
      }
      .bt-card {
        display: flex;
        gap: 0.75rem;
        padding: 1rem;
        border: 1px solid var(--line-strong);
        grid-area: 1 / 1;
        visibility: hidden;
      }
      .bt-card.bt-active { visibility: visible; }
      .bt-slide-next { animation: bt-slide-in-right 0.5s ease-out; }
      .bt-slide-prev { animation: bt-slide-in-left 0.5s ease-out; }
      @keyframes bt-slide-in-right {
        from { transform: translateX(60px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes bt-slide-in-left {
        from { transform: translateX(-60px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .bt-slide-next, .bt-slide-prev { animation: none; }
      }
      .bt-cover { width: 56px; height: 84px; object-fit: cover; border: 1px solid var(--line-strong); flex-shrink: 0; background: var(--bg); }
      .bt-cover-placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        border-style: dashed;
        text-align: center;
        padding: 0.25rem;
      }
      .bt-cover-placeholder::after {
        content: "NO COVER";
        font-family: var(--font-mono);
        font-size: 0.55rem;
        letter-spacing: 0.06em;
        color: var(--fg-dim);
      }
      .bt-info { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; flex: 1; }
      .bt-title {
        font-family: var(--font-display);
        font-weight: 400;
        font-size: 1.2rem;
        line-height: 1.15;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--fg);
      }
      .bt-author { font-family: var(--font-body); font-size: 0.75rem; color: var(--fg-dim); }
      .bt-status {
        display: inline-block;
        width: fit-content;
        font-family: var(--font-mono);
        font-size: 0.65rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--fg-dim);
        border: 1px solid var(--line);
        padding: 0.15rem 0.4rem;
      }
      /* Short bar with its value beside it, and a visible track, so it reads as a gauge rather than a divider. */
      .bt-progress { display: flex; align-items: center; gap: 0.5rem; }
      progress {
        flex: 1;
        min-width: 0;
        max-width: 180px;
        height: 8px;
        appearance: none;
        -webkit-appearance: none;
        border: 1px solid var(--line-strong);
        background: var(--line);
      }
      progress::-webkit-progress-bar { background: var(--line); }
      progress::-webkit-progress-value { background: var(--fg); }
      progress::-moz-progress-bar { background: var(--fg); }
      .bt-percent, .bt-pages, .bt-finished { font-family: var(--font-mono); font-size: 0.65rem; color: var(--fg-dim); }
      .bt-rating { font-size: 0.85rem; letter-spacing: 0.05em; color: var(--accent); }
      .bt-loading, .bt-empty, .bt-error {
        padding: 1rem;
        font-family: var(--font-mono);
        font-size: 0.75rem;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--fg-dim);
      }
      .bt-error { color: var(--error); }
      .bt-retry {
        display: block;
        margin-top: 0.75rem;
        border: 1px solid var(--line-strong);
        background: var(--bg);
        color: var(--fg);
        font-family: var(--font-mono);
        font-size: 0.7rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        padding: 0.35rem 0.75rem;
        cursor: pointer;
      }
      .bt-retry:hover { background: var(--fg); color: var(--bg); }
    `;
  }
}

if (!customElements.get('book-tracker-widget')) {
  customElements.define('book-tracker-widget', BookTrackerWidget);
}
