// Add and remove storage rows on the organisation form.
document.addEventListener('click', (event) => {
  const add = event.target.closest('[data-add-row]');
  if (add) {
    const tbody = document.getElementById(add.dataset.addRow).tBodies[0];
    const template = tbody.rows[tbody.rows.length - 1];
    // Next free index, so removed rows never cause duplicate field names.
    const used = [...tbody.querySelectorAll('[name]')].map((el) => Number(el.name.match(/\[(\d+)\]/)?.[1] ?? -1));
    const index = Math.max(-1, ...used) + 1;
    const row = template.cloneNode(true);
    row.querySelectorAll('input, select').forEach((el) => {
      el.name = el.name.replace(/\[\d+\]/, `[${index}]`);
      if (el.tagName === 'INPUT') el.value = el.type === 'number' && el.name.endsWith('[count]') ? '1' : '';
      else el.selectedIndex = 0;
    });
    tbody.appendChild(row);
    row.querySelector('input').focus();
    return;
  }

  const remove = event.target.closest('[data-remove-row]');
  if (remove) {
    const row = remove.closest('tr');
    const tbody = row.parentElement;
    if (tbody.rows.length > 1) row.remove();
    else row.querySelectorAll('input').forEach((el) => { el.value = el.name.endsWith('[count]') ? '1' : ''; });
  }
});
