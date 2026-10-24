// Plotly charts. Colours come from the stylesheet so charts match the page.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const baseLayout = () => ({
  margin: { l: 48, r: 12, t: 8, b: 36 },
  paper_bgcolor: css('--bg'),
  plot_bgcolor: css('--bg'),
  font: { family: css('--font'), size: 12, color: css('--text') },
  xaxis: { gridcolor: css('--rule'), linecolor: css('--border') },
  yaxis: { gridcolor: css('--rule'), linecolor: css('--border'), rangemode: 'tozero' },
  showlegend: true,
  legend: { orientation: 'h', y: -0.2 },
});
const config = { displayModeBar: false, responsive: true };

// Stock history with each count coloured by what happened since the last one.
function stockChart(el) {
  const s = JSON.parse(el.dataset.series);
  const unit = el.dataset.unit;
  const kinds = {
    fall: ['Fall (used for demand)', css('--accent')],
    rise: ['Rise (delivery or donation)', css('--info')],
    censored: ['Fell to zero', css('--alert')],
    excluded: ['Explained by notes', css('--warn')],
    unchanged: ['Unchanged', css('--muted')],
  };
  const traces = [{
    x: s.dates,
    y: s.stock,
    type: 'scatter',
    mode: 'lines',
    line: { color: css('--border'), width: 1.5 },
    name: `Stock (${unit}s)`,
    hovertemplate: `%{x}<br>%{y} ${unit}s<extra></extra>`,
  }];
  for (const [type, [label, color]] of Object.entries(kinds)) {
    const idx = s.types.map((t, i) => (t === type ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    traces.push({
      x: idx.map((i) => s.dates[i]),
      y: idx.map((i) => s.stock[i]),
      type: 'scatter',
      mode: 'markers',
      marker: { color, size: 7 },
      name: label,
      hovertemplate: `%{x}<br>%{y} ${unit}s<br>${label}<extra></extra>`,
    });
  }
  Plotly.newPlot(el, traces, { ...baseLayout(), height: 260 }, config);
}

// Draw charts inside <details> only when opened (keeps the page fast).
function drawWhenVisible(el, draw) {
  const details = el.closest('details');
  if (!details) return draw(el);
  const handler = () => {
    if (!details.open || el.dataset.drawn) return;
    el.dataset.drawn = '1';
    draw(el);
  };
  details.addEventListener('toggle', handler);
  handler();
}

document.querySelectorAll('[data-chart="stock"]').forEach((el) => drawWhenVisible(el, stockChart));

// Projected stock under the selected policy: mean with the 10th-90th
// percentile band across simulated futures.
function projectionChart(el) {
  const s = JSON.parse(el.dataset.series);
  if (!s) return;
  const unit = el.dataset.unit;
  const days = s.mean.map((_, i) => i);
  Plotly.newPlot(el, [
    { x: days, y: s.p90, type: 'scatter', mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
    {
      x: days, y: s.p10, type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tonexty',
      fillcolor: 'rgba(31, 92, 70, 0.15)', name: '10th–90th percentile', hovertemplate: `Day %{x}: %{y} ${unit}s (10th percentile)<extra></extra>`,
    },
    { x: days, y: s.mean, type: 'scatter', mode: 'lines', line: { color: css('--accent'), width: 2 }, name: 'Average', hovertemplate: `Day %{x}: %{y} ${unit}s on average<extra></extra>` },
  ], {
    ...baseLayout(),
    height: 220,
    xaxis: { ...baseLayout().xaxis, title: { text: 'Day' } },
    yaxis: { ...baseLayout().yaxis, title: { text: `Stock (${unit}s)` } },
  }, config);
}
document.querySelectorAll('[data-chart="projection"]').forEach((el) => drawWhenVisible(el, projectionChart));

// --- Policy comparison --------------------------------------------------------

const POLICIES = ['lean', 'balanced', 'resilient'];
const policyColor = (p) => css(`--${p}`);

function compareCharts(data) {
  const { labels, totals, distribution, products } = data;

  const measures = [
    ['Expected unmet demand', (t) => t.expectedUnmet],
    ['Expected waste', (t) => t.expectedWaste],
    ['Expected stock at end', (t) => t.expectedEnding],
  ];
  Plotly.newPlot('chart-outcomes', POLICIES.map((p) => ({
    type: 'bar',
    name: labels[p],
    x: measures.map(([m]) => m),
    y: measures.map(([, f]) => f(totals[p])),
    marker: { color: policyColor(p) },
    hovertemplate: `${labels[p]}<br>%{x}: %{y:,.0f} units<extra></extra>`,
  })), { ...baseLayout(), barmode: 'group', height: 300, yaxis: { ...baseLayout().yaxis, title: { text: 'Units' } } }, config);

  const edges = distribution.edges;
  const mids = edges.slice(0, -1).map((e, i) => (e + edges[i + 1]) / 2);
  Plotly.newPlot('chart-distribution', POLICIES.map((p) => ({
    type: 'scatter',
    mode: 'lines',
    line: { shape: 'hvh', color: policyColor(p), width: 2 },
    name: labels[p],
    x: mids,
    y: distribution.counts[p],
    hovertemplate: `${labels[p]}<br>~%{x:,.0f} units unmet: %{y} futures<extra></extra>`,
  })), {
    ...baseLayout(),
    height: 300,
    xaxis: { ...baseLayout().xaxis, title: { text: 'Total unmet demand (units)' } },
    yaxis: { ...baseLayout().yaxis, title: { text: 'Futures' } },
  }, config);

  const names = products.map((p) => p.name);
  Plotly.newPlot('chart-products', POLICIES.map((p) => ({
    type: 'bar',
    orientation: 'h',
    name: labels[p],
    y: names,
    x: products.map((row) => row[p]),
    marker: { color: policyColor(p) },
    hovertemplate: `${labels[p]}<br>%{y}: %{x:.0%}<extra></extra>`,
  })), {
    ...baseLayout(),
    barmode: 'group',
    height: Math.max(320, names.length * 34),
    margin: { l: 170, r: 12, t: 8, b: 40 },
    xaxis: { ...baseLayout().xaxis, tickformat: '.0%', range: [0, 1], title: { text: 'Chance of at least one shortage' } },
    yaxis: { ...baseLayout().yaxis, autorange: 'reversed', rangemode: undefined },
  }, config);
}

const compareEl = document.getElementById('compare-data');
if (compareEl) compareCharts(JSON.parse(compareEl.textContent));

// Open a product's details when its link is followed.
function openTarget() {
  const target = document.getElementById(location.hash.slice(1));
  if (!target) return;
  // Open the target and any dropdowns it sits inside.
  for (let el = target; el; el = el.parentElement?.closest('details')) {
    if (el.tagName === 'DETAILS') el.open = true;
  }
  target.scrollIntoView();
}
window.addEventListener('hashchange', openTarget);
openTarget();
