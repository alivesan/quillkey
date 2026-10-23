window.quillkey.onStatus(value => {
  document.getElementById('title').textContent = value.title || 'QuillKey';
  document.getElementById('detail').textContent = value.message || 'Your audio stays on this PC';
});
