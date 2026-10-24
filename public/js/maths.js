// Renders formulas written as TeX in data-tex attributes with KaTeX.
// <span data-tex="\hat\mu = 14.1"></span>, or data-display="block" for a line of its own.
document.querySelectorAll('[data-tex]').forEach((el) => {
  if (!window.katex) {
    el.textContent = el.dataset.tex;
    return;
  }
  katex.render(el.dataset.tex, el, { throwOnError: false, displayMode: el.dataset.display === 'block' });
});
