class BookTrackerWidget extends HTMLElement {
  connectedCallback() {
    this._root = this.attachShadow({ mode: 'open' });
    this._renderShell();
    this._load();
  }

  get projectUrl() {
    return (this.getAttribute('project-url') || '').replace(/\/$/, '');
  }

  get anonKey() {
    return this.getAttribute('anon-key') || '';
  }

  get limit() {
    return this.getAttribute('limit') || '20';
  }

  async _load() {
    if (!this.projectUrl || !this.anonKey) {
      this._renderError('Missing required project-url or anon-key attribute.');
      return;
    }

    try {
      const endpoint = `${this.projectUrl}/rest/v1/books?select=*&order=sort_order.asc,created_at.desc&limit=${this.limit}`;
      const response = await fetch(endpoint, {
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${this.anonKey}`
        }
      });
      if (!response.ok) {
        throw new Error(`Backend returned ${response.status}`);
      }
      const rows = await response.json();
      const books = await Promise.all(rows.map((row) => this._enrich(row)));
      this._renderList(books);
    } catch (error) {
      console.error('book-tracker-widget: failed to load books', error);
      this._renderError('Could not load books right now.');
    }
  }

  async _enrich(row) {
    const fallback = { ...row, title: 'Unknown title', author: 'Unknown author', cover: null };
    if (!row.isbn) return fallback;

    try {
      const response = await fetch(
        `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(row.isbn)}&format=json&jscmd=data`
      );
      const data = await response.json();
      const meta = data[`ISBN:${row.isbn}`];
      if (!meta) return fallback;

      return {
        ...row,
        title: meta.title || fallback.title,
        author: (meta.authors || []).map((a) => a.name).join(', ') || fallback.author,
        cover: meta.cover?.medium || null
      };
    } catch (error) {
      console.error('book-tracker-widget: failed to load metadata for', row.isbn, error);
      return fallback;
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

    const readingIndex = books.findIndex((book) => book.status === 'reading');
    this._index = readingIndex !== -1 ? readingIndex : 0;
    this._renderCarouselChrome(carousel);
    this._renderCurrentCard();
  }

  _renderCarouselChrome(carousel) {
    const showArrows = this._books.length > 1;
    carousel.innerHTML = `
      <div class="bt-stage">
        ${showArrows ? '<button class="bt-arrow bt-arrow-prev" id="prev" aria-label="Previous book">&#8249;</button>' : ''}
        <div class="bt-viewport" id="viewport"></div>
        ${showArrows ? '<button class="bt-arrow bt-arrow-next" id="next" aria-label="Next book">&#8250;</button>' : ''}
      </div>
      ${showArrows ? '<div class="bt-counter" id="counter"></div>' : ''}
    `;

    if (showArrows) {
      this._root.getElementById('prev').addEventListener('click', () => this._step(-1));
      this._root.getElementById('next').addEventListener('click', () => this._step(1));
    }
  }

  _step(direction) {
    const len = this._books.length;
    this._index = (this._index + direction + len) % len;
    this._renderCurrentCard(direction);
  }

  _renderCurrentCard(direction) {
    const viewport = this._root.getElementById('viewport');
    const slideClass = direction === 1 ? ' bt-slide-next' : direction === -1 ? ' bt-slide-prev' : '';
    viewport.innerHTML = this._cardHtml(this._books[this._index], slideClass);

    const counter = this._root.getElementById('counter');
    if (counter) counter.textContent = `${this._index + 1} / ${this._books.length}`;
  }

  _renderError(message) {
    const carousel = this._root.getElementById('carousel');
    if (carousel) carousel.innerHTML = `<div class="bt-error">${this._escape(message)}</div>`;
  }

  _cardHtml(book, slideClass = '') {
    const rating = Number.isInteger(book.rating) ? book.rating : null;
    const stars = rating !== null ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : '';
    const cover = book.cover
      ? `<img class="bt-cover" src="${this._escape(book.cover)}" alt="${this._escape(book.title)} cover" />`
      : '<div class="bt-cover bt-cover-placeholder"></div>';
    const pages = book.current_page && book.total_pages
      ? `<div class="bt-pages">${book.current_page}/${book.total_pages} pages</div>`
      : '';
    const statusLabel = (book.status || '').replace('_', ' ');

    return `
      <div class="bt-card${slideClass}">
        ${cover}
        <div class="bt-info">
          <div class="bt-title">${this._escape(book.title)}</div>
          <div class="bt-author">${this._escape(book.author)}</div>
          <div class="bt-status">${this._escape(statusLabel)}</div>
          <progress max="100" value="${book.progress_percent || 0}"></progress>
          <span class="bt-percent">${book.progress_percent || 0}%</span>
          ${pages}
          ${rating !== null ? `<div class="bt-rating">${stars}</div>` : ''}
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

  _css() {
    return `
      @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;500&display=swap');

      :host {
        --bg: #0A0A0A;
        --fg: #c3e28d;
        --fg-dim: rgba(195, 226, 141, 0.6);
        --line: rgba(195, 226, 141, 0.22);
        --line-strong: rgba(195, 226, 141, 0.4);
        --font-display: "Bebas Neue", Impact, "Arial Narrow", sans-serif;
        --font-body: Helvetica, Arial, sans-serif;
        --font-mono: "IBM Plex Mono", ui-monospace, "Courier New", monospace;
        display: block;
        max-width: 320px;
        font-family: var(--font-body);
        background: var(--bg);
        color: var(--fg);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
      * { box-sizing: border-box; }
      .bt-stage { display: flex; align-items: stretch; gap: 0.5rem; padding: 0.75rem 0.75rem 0; }
      .bt-viewport { flex: 1; min-width: 0; overflow: hidden; }
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
      .bt-counter {
        text-align: center;
        font-family: var(--font-mono);
        font-size: 0.7rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--fg-dim);
        margin-top: 0.5rem;
      }
      .bt-card { display: flex; gap: 0.75rem; padding: 1rem; border: 1px solid var(--line-strong); }
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
      progress { width: 100%; height: 6px; appearance: none; -webkit-appearance: none; border: 1px solid var(--line); background: var(--bg); }
      progress::-webkit-progress-bar { background: var(--bg); }
      progress::-webkit-progress-value { background: var(--fg); }
      progress::-moz-progress-bar { background: var(--fg); }
      .bt-percent { font-family: var(--font-mono); font-size: 0.65rem; color: var(--fg-dim); }
      .bt-pages { font-family: var(--font-mono); font-size: 0.65rem; color: var(--fg-dim); }
      .bt-rating { font-size: 0.85rem; letter-spacing: 0.05em; color: #e8b923; }
      .bt-loading, .bt-empty, .bt-error {
        padding: 1rem;
        font-family: var(--font-mono);
        font-size: 0.75rem;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--fg-dim);
      }
      .bt-error { color: #ff4d4d; }
    `;
  }
}

customElements.define('book-tracker-widget', BookTrackerWidget);
