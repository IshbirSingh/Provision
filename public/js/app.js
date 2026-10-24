// Shared behaviour for every page.

// Disable the submit button while a slow request runs (file reading, Nebius,
// simulation) so it isn't submitted twice.
document.querySelectorAll('form[data-busy]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    const button = event.submitter || form.querySelector('button[type="submit"]');
    if (!button) return;
    // Keep the clicked button's name/value in the submission.
    if (button.name) {
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = button.name;
      hidden.value = button.value;
      form.append(hidden);
    }
    button.disabled = true;
    button.textContent = form.dataset.busy;
  });
});
