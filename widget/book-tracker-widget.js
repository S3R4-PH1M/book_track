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
      ${showArrows ? '<button class="bt-arrow bt-arrow-prev" id="prev" aria-label="Previous book">&#8249;</button>' : ''}
      <div class="bt-viewport" id="viewport"></div>
      ${showArrows ? '<button class="bt-arrow bt-arrow-next" id="next" aria-label="Next book">&#8250;</button>' : ''}
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
    this._renderCurrentCard();
  }

  _renderCurrentCard() {
    const viewport = this._root.getElementById('viewport');
    viewport.innerHTML = this._cardHtml(this._books[this._index]);

    const counter = this._root.getElementById('counter');
    if (counter) counter.textContent = `${this._index + 1} / ${this._books.length}`;
  }

  _renderError(message) {
    const carousel = this._root.getElementById('carousel');
    if (carousel) carousel.innerHTML = `<div class="bt-error">${this._escape(message)}</div>`;
  }

  _cardHtml(book) {
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
      <div class="bt-card">
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
      :host { display: block; font-family: system-ui, -apple-system, sans-serif; max-width: 320px; }
      .bt-carousel { position: relative; }
      .bt-arrow {
        position: absolute;
        top: 42px;
        transform: translateY(-50%);
        width: 30px;
        height: 30px;
        border: none;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.35);
        color: #fff;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1;
        transition: background 0.15s ease;
      }
      .bt-arrow:hover { background: rgba(0, 0, 0, 0.6); }
      .bt-arrow-prev { left: 4px; }
      .bt-arrow-next { right: 4px; }
      .bt-counter { text-align: center; font-size: 11px; color: #888; margin-top: 6px; }
      .bt-card { display: flex; gap: 12px; padding: 12px; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; }
      .bt-cover { width: 56px; height: 84px; object-fit: cover; border-radius: 4px; flex-shrink: 0; background: #eee; }
      .bt-cover-placeholder { display: block; }
      .bt-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
      .bt-title { font-weight: 600; font-size: 14px; }
      .bt-author { font-size: 12px; color: #666; }
      .bt-status { font-size: 11px; text-transform: capitalize; color: #888; }
      progress { width: 100%; height: 6px; }
      .bt-percent { font-size: 11px; color: #666; }
      .bt-pages { font-size: 11px; color: #888; }
      .bt-rating { font-size: 13px; color: #e8b923; }
      .bt-loading, .bt-empty, .bt-error { padding: 16px; font-size: 13px; color: #666; }
      .bt-error { color: #b00020; }
    `;
  }
}

customElements.define('book-tracker-widget', BookTrackerWidget);
