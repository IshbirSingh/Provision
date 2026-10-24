// Step 1: the editable review table.

const dataEl = document.getElementById('review-data');
if (dataEl) initReview(JSON.parse(dataEl.textContent));

function initReview({ records, products }) {
  const PAGE_SIZE = 50;
  const tbody = document.querySelector('#records-table tbody');
  const pager = document.getElementById('pager');
  const empty = document.getElementById('records-empty');
  const byId = new Map(records.map((r) => [r.id, r]));
  let filter = 'attention';
  let page = 0;
  // Rows shown under "Needs checking" stay visible after they are fixed, so
  // the list doesn't jump while someone is working through it.
  const pinned = new Set(records.filter((r) => r.status !== 'ok').map((r) => r.id));

  const visible = () => (filter === 'all' ? records : records.filter((r) => pinned.has(r.id)));

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) node.append(c);
    return node;
  }

  function productSelect(rec) {
    const select = el('select', { name: 'productId', 'aria-label': `Product, row ${rec.rowNumber}` });
    select.append(el('option', { value: '' }, rec.productId ? '' : `– ${rec.productName || 'choose'} –`));
    Object.entries(products)
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .forEach(([id, p]) => select.append(el('option', { value: id, selected: id === rec.productId }, p.name)));
    return select;
  }

  function issueList(rec) {
    if (!rec.issues.length) return el('span', { class: 'hint' }, rec.status === 'ok' ? 'OK' : '');
    return el('ul', { class: 'issues' }, rec.issues.map((i) => el('li', { class: `issue issue--${i.level}` }, i.message)));
  }

  function row(rec) {
    const tr = el('tr', { class: `rec rec--${rec.status}`, 'data-id': rec.id });
    const label = (f) => `${f}, row ${rec.rowNumber}`;
    tr.append(
      el('td', { class: 'num' }, String(rec.rowNumber)),
      el('td', {}, el('input', { type: 'date', name: 'date', value: rec.date || '', 'aria-label': label('Date') })),
      el('td', {}, productSelect(rec)),
      el('td', {}, el('input', { type: 'number', name: 'quantity', min: '0', step: '1', value: rec.quantity ?? '', class: 'input--num', 'aria-label': label('Quantity') })),
      el('td', {}, el('input', { type: 'text', name: 'unit', value: rec.unit || '', class: 'input--unit', 'aria-label': label('Unit') })),
      el('td', {}, el('input', { type: 'date', name: 'expiryDate', value: rec.expiryDate || '', 'aria-label': label('Best before') })),
      el('td', {}, el('input', { type: 'text', name: 'notes', value: rec.notes || '', 'aria-label': label('Notes') })),
      el('td', { class: 'issues-cell' }, issueList(rec)),
      el('td', {}, el('input', { type: 'checkbox', name: 'include', checked: rec.include, 'aria-label': label('Include') })),
    );
    return tr;
  }

  function render() {
    const list = visible();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    tbody.replaceChildren(...list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(row));
    empty.hidden = list.length > 0;
    document.getElementById('n-attention').textContent = pinned.size;
    document.getElementById('n-all').textContent = records.length;

    pager.replaceChildren();
    if (pages > 1) {
      const btn = (text, target, disabled) => el('button', { type: 'button', class: 'link-button', disabled, onclick: () => { page = target; render(); } }, text);
      pager.append(
        btn('Previous', page - 1, page === 0),
        el('span', {}, ` Page ${page + 1} of ${pages} `),
        btn('Next', page + 1, page >= pages - 1),
      );
    }
  }

  function updateCounts(c) {
    document.getElementById('count-ok').textContent = c.ok || 0;
    document.getElementById('count-warning').textContent = c.warning || 0;
    document.getElementById('count-excluded').textContent = c.excluded || 0;
    const usable = (c.ok || 0) + (c.warning || 0);
    document.getElementById('approve-count').textContent = usable;
    document.getElementById('approve-button').disabled = usable === 0;
  }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({ error: 'Unexpected response' }));
    if (!res.ok) throw new Error(json.error || 'Could not save');
    return json;
  }

  function showError(cell, message) {
    cell.querySelector('.save-error')?.remove();
    if (message) cell.append(el('span', { class: 'save-error' }, message));
  }

  tbody.addEventListener('change', async (event) => {
    const input = event.target;
    const tr = input.closest('tr');
    const rec = byId.get(tr.dataset.id);
    const value = input.type === 'checkbox' ? input.checked : input.value;
    try {
      const { record, counts } = await post('/review/record', { id: rec.id, changes: { [input.name]: value } });
      Object.assign(rec, record);
      if (record.status !== 'ok') pinned.add(rec.id);
      tr.replaceWith(row(rec));
      updateCounts(counts);
    } catch (err) {
      showError(input.closest('td'), err.message);
    }
  });

  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      page = 0;
      document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('is-active', b === button));
      render();
    });
  });

  document.getElementById('add-row').addEventListener('click', async () => {
    try {
      const { record, counts } = await post('/review/record/new', {});
      records.push(record);
      byId.set(record.id, record);
      pinned.add(record.id);
      page = Math.ceil(visible().length / PAGE_SIZE) - 1;
      render();
      updateCounts(counts);
      tbody.querySelector(`tr[data-id="${record.id}"] input`)?.focus();
    } catch (err) {
      alert(err.message);
    }
  });

  // Product edits
  const productsTable = document.getElementById('products-table');
  productsTable.addEventListener('change', async (event) => {
    const input = event.target;
    const tr = input.closest('tr');
    try {
      const { product, counts } = await post('/review/product', { id: tr.dataset.product, changes: { [input.name]: input.value } });
      products[product.id] = { name: product.name, unit: product.unit };
      showError(input.closest('td'), null);
      updateCounts(counts);
      render();
    } catch (err) {
      showError(input.closest('td'), err.message);
    }
  });

  document.getElementById('add-product').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      await post('/review/product/new', Object.fromEntries(new FormData(form)));
      window.location.reload();
    } catch (err) {
      alert(err.message);
    }
  });

  render();
}
