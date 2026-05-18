(function () {
  const defaultOptions = {
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Ya, hapus',
    cancelButtonText: 'Batal',
    reverseButtons: true,
    focusCancel: true,
    allowOutsideClick: false,
    allowEscapeKey: true
  };

  window.confirmDanger = async function confirmDanger(message, options = {}) {
    const text = String(message || '').trim();
    const result = window.Swal && typeof window.Swal.fire === 'function'
      ? await window.Swal.fire({
          ...defaultOptions,
          ...options,
          text
        })
      : { isConfirmed: window.confirm(text || 'Apakah anda yakin?') };

    return Boolean(result && result.isConfirmed);
  };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('form[data-confirm-delete]').forEach((form) => {
      if (form.dataset.confirmDeleteBound === '1') {
        return;
      }

      form.dataset.confirmDeleteBound = '1';
      form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const message = form.dataset.confirmDelete || 'Apakah anda yakin?';
        const title = form.dataset.confirmTitle || 'Konfirmasi hapus';
        const confirmed = await window.confirmDanger(message, {
          title,
          confirmButtonText: form.dataset.confirmButtonText || 'Ya, hapus'
        });

        if (confirmed) {
          form.submit();
        }
      });
    });
  });
})();
