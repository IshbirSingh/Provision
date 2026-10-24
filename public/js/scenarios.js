// Step 3: scenario cards, sliders and the active-adjustments summary.

const form = document.getElementById('scenario-form');
const { owner, preview } = JSON.parse(document.getElementById('scenario-data').textContent);

const $ = (id) => document.getElementById(id);
const scenarioId = () => form.querySelector('input[name="scenarioId"]:checked')?.value;

function isActive(key) {
  const block = form.querySelector(`[data-adjustment="${key}"]`);
  return owner[key] === scenarioId() || block.querySelector('input[name^="combine"]').checked;
}

function describeReserve(days) {
  const el = $('reserve-effect');
  if (!el) return;
  const raised = preview.filter((p) => p.from !== null && days >= p.from).map((p) => p.name);
  const lowest = preview.filter((p) => p.from !== null).sort((a, b) => a.from - b.from)[0];
  if (raised.length) {
    el.textContent = `At ${days} days this raises the Balanced target for ${raised.length} of ${preview.length} products: ${raised.slice(0, 5).join(', ')}${raised.length > 5 ? '…' : ''}.`;
  } else if (lowest) {
    el.textContent = `At ${days} days this changes no Balanced target: each already covers more. It starts to apply from ${lowest.from} days (${lowest.name}). Approximate preview without other adjustments.`;
  }
}

function update() {
  const id = scenarioId();
  for (const key of Object.keys(owner)) {
    const block = form.querySelector(`[data-adjustment="${key}"]`);
    const owned = owner[key] === id;
    const combine = block.querySelector('input[name^="combine"]');
    block.classList.toggle('is-owned', owned);
    combine.closest('label').hidden = owned;
    block.querySelector('[data-owned-text]').hidden = !owned;
    const active = isActive(key);
    block.classList.toggle('is-inactive', !active);
    block.querySelectorAll('input[type="range"], #reduceQuantities').forEach((el) => { el.disabled = !active; });
  }
  const reduce = $('reduceQuantities');
  $('quantityReductionPct').disabled = !isActive('delivery') || !reduce.checked;
  $('reduction-row').classList.toggle('is-inactive', $('quantityReductionPct').disabled);

  const demand = Number($('demandIncreasePct').value);
  const reserve = Number($('reserveDays').value);
  const delay = Number($('delayDays').value);
  const reduction = Number($('quantityReductionPct').value);
  $('demand-out').textContent = `${demand}%`;
  $('reserve-out').textContent = `${reserve} day${reserve === 1 ? '' : 's'}`;
  $('delay-out').textContent = `${delay} day${delay === 1 ? '' : 's'}`;
  $('reduction-out').textContent = `${reduction}% less`;
  describeReserve(reserve);

  const items = [];
  const hypo = ' <span class="tag tag--warn">Hypothetical</span>';
  if (isActive('demand')) items.push(demand ? `Demand ${demand}% higher than the approved forecast.${hypo}` : 'Demand increase set to 0%, so demand is as forecast.');
  if (isActive('reserve')) items.push(`Emergency reserve of ${reserve} days of average demand for Balanced and Resilient.`);
  if (isActive('delivery')) {
    items.push(delay ? `Every delivery arrives ${delay} day${delay === 1 ? '' : 's'} later than the approved lead time.${hypo}` : 'Extra delivery delay set to 0 days.');
    if (reduce.checked && reduction) items.push(`Deliveries bring ${reduction}% less than ordered.${hypo}`);
  }
  if (!items.length) items.push('No adjustments: the approved baseline only.');
  $('active-list').innerHTML = items.map((t) => `<li class="note">${t}</li>`).join('');
}

form.addEventListener('input', update);
form.addEventListener('change', update);
update();
