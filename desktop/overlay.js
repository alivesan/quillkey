(() => {
  const widget = document.getElementById('widget');
  const toggle = document.getElementById('toggle');
  const cancel = document.getElementById('cancel');
  const title = document.getElementById('title');
  const detail = document.getElementById('detail');
  const phases = new Set(['idle', 'connecting', 'recording', 'processing', 'success', 'error']);
  const defaults = {
    idle: ['QuillKey', 'Click to dictate'],
    connecting: ['Getting ready…', 'Opening your microphone'],
    recording: ['Listening', 'Click to finish and paste'],
    processing: ['Finishing…', 'Transcribing and pasting your words'],
    success: ['Pasted', 'Click to dictate again'],
    error: ['Couldn’t finish', 'Click to try again']
  };
  const action = value => window.quillkey.overlayAction(value);
  widget.addEventListener('mouseenter', () => action('hover-enter'));
  widget.addEventListener('mouseleave', () => action('hover-leave'));
  toggle.addEventListener('click', () => { if (!toggle.disabled) action('toggle'); });
  cancel.addEventListener('click', event => {
    event.stopPropagation();
    if (!cancel.disabled) action('cancel');
  });
  window.quillkey.onStatus(value => {
    if (!value || typeof value !== 'object') return;
    const phase = phases.has(value.phase) ? value.phase : 'idle';
    const active = ['connecting', 'recording', 'processing'].includes(phase);
    widget.dataset.phase = phase;
    widget.classList.toggle('expanded', active || value.expanded === true);
    title.textContent = typeof value.title === 'string' && value.title ? value.title : defaults[phase][0];
    detail.textContent = typeof value.message === 'string' && value.message ? value.message : defaults[phase][1];
    toggle.disabled = phase === 'connecting' || phase === 'processing';
    toggle.setAttribute('aria-label', phase === 'recording' ? 'Finish dictation and paste' : toggle.disabled ? defaults[phase][0] : 'Start dictation');
    toggle.setAttribute('aria-busy', String(toggle.disabled));
    toggle.title = phase === 'recording' ? 'Click to finish and paste' : toggle.disabled ? defaults[phase][0] : 'Click to dictate · Hold Ctrl + Alt + Space';
    cancel.classList.toggle('available', active);
    cancel.disabled = !active;
  });
})();
