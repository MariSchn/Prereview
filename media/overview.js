(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const GROUPS = [
    ['awaitingYou', 'Awaiting you'],
    ['awaitingAgent', 'Awaiting agent'],
    ['resolved', 'Resolved'],
  ];
  const saved = vscode.getState() || { resolvedOpen: false };
  let state = null;
  let editing = null;
  let focusKey = null;

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      state = event.data.state;
      render();
    }
  });
  vscode.postMessage({ type: 'ready' });

  function post(message) {
    vscode.postMessage(message);
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'html') el.innerHTML = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  function button(label, kind, onclick) {
    return h('button', { class: kind, type: 'button', onclick }, label);
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function ago(iso) {
    const seconds = (Date.now() - Date.parse(iso)) / 1000;
    if (isNaN(seconds)) return '';
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  function textarea(key, props, initial = '') {
    const area = h('textarea', { 'data-key': key, ...props });
    area.value = initial;
    const sync = () => area.classList.toggle('filled', area.value.trim() !== '');
    area.addEventListener('input', sync);
    sync();
    return area;
  }

  function onSubmit(area, send) {
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        send();
      }
    });
  }

  function render() {
    const drafts = new Map();
    let focused = null;
    for (const area of app.querySelectorAll('textarea[data-key]')) {
      const key = area.getAttribute('data-key');
      drafts.set(key, area.value);
      if (area === document.activeElement) focused = { key, start: area.selectionStart, end: area.selectionEnd };
    }
    app.replaceChildren(header(), description(), ...groups(), newComment());
    for (const area of app.querySelectorAll('textarea[data-key]')) {
      const key = area.getAttribute('data-key');
      if (drafts.has(key)) {
        area.value = drafts.get(key);
        area.dispatchEvent(new Event('input'));
      }
    }
    const target = focusKey ? { key: focusKey } : focused;
    focusKey = null;
    if (target) {
      const area = app.querySelector(`textarea[data-key="${CSS.escape(target.key)}"]`);
      if (area) {
        area.focus();
        if (target.start !== undefined) area.setSelectionRange(target.start, target.end);
      }
    }
  }

  function header() {
    const s = state;
    const counts = GROUPS.filter(([status]) => s.counts[status]).map(([status, label]) =>
      h('span', { class: `chip ${status}` }, h('span', { class: 'dot' }), `${s.counts[status]} ${label.toLowerCase()}`),
    );
    return h(
      'header',
      { class: 'header' },
      h('h1', { class: s.titleFromAgent ? 'title' : 'title untitled' }, s.title),
      h(
        'div',
        { class: 'meta' },
        s.titleFromAgent
          ? [h('code', { class: 'branch' }, s.base), h('span', {}, '←'), h('code', { class: 'branch' }, s.target)]
          : null,
        s.worktree ? h('span', { title: `Checked out in ${s.worktree}` }, 'worktree') : null,
        s.titleFromAgent || s.worktree ? h('span', {}, '·') : null,
        h('span', {}, plural(s.files, 'file')),
        h('span', { class: 'added' }, `+${s.added}`),
        h('span', { class: 'deleted' }, `−${s.deleted}`),
      ),
      counts.length ? h('div', { class: 'chips' }, counts) : null,
      h(
        'div',
        { class: 'actions' },
        button('Copy path for agent', 'primary', () => post({ type: 'command', name: 'copyReviewPath' })),
        button('Open all changes', 'secondary', () => post({ type: 'command', name: 'openAllChanges' })),
        button('Finish review', 'secondary', () => post({ type: 'command', name: 'finishReview' })),
      ),
    );
  }

  function description() {
    return h(
      'section',
      { class: 'card description' },
      h(
        'div',
        { class: 'card-head' },
        h('img', { class: 'avatar small', src: state.icons.agent, alt: '' }),
        h('span', { class: 'author' }, 'agent'),
        h('span', { class: 'muted' }, 'description'),
      ),
      state.description
        ? h('div', { class: 'card-body markdown', html: state.description })
        : h('div', { class: 'card-body empty' }, 'No description yet. The agent writes one when it picks up the review.'),
    );
  }

  function groups() {
    if (!state.threads.length) {
      return [
        h(
          'div',
          { class: 'empty-state' },
          'No comments yet. Comment on lines in the diff, or leave a general comment below.',
        ),
      ];
    }
    return GROUPS.map(([status, label]) => {
      const threads = state.threads.filter((t) => t.status === status);
      if (!threads.length) return null;
      const heading = h('h2', {}, label, h('span', { class: 'count' }, threads.length));
      if (status !== 'resolved') return h('section', { class: 'group' }, heading, threads.map(thread));
      return h(
        'details',
        {
          class: 'group',
          open: saved.resolvedOpen,
          ontoggle: (event) => {
            saved.resolvedOpen = event.target.open;
            vscode.setState(saved);
          },
        },
        h('summary', {}, heading),
        threads.map(thread),
      );
    });
  }

  function thread(t) {
    return h(
      'article',
      { class: `thread ${t.status}` },
      h(
        'div',
        { class: 'thread-head' },
        t.file
          ? h(
              'a',
              {
                class: 'location',
                href: '#',
                title: 'Open in diff',
                onclick: (event) => {
                  event.preventDefault();
                  post({ type: 'open', id: t.id });
                },
              },
              t.file,
            )
          : h('span', { class: 'location general' }, 'General comment'),
        t.where ? h('span', { class: 'muted' }, t.where) : null,
        h('span', { class: 'spacer' }),
        t.outdated ? h('span', { class: 'pill outdated', title: 'The code this comment was left on has changed' }, 'Outdated') : null,
      ),
      t.snippet ? snippet(t) : null,
      h(
        'div',
        { class: 'comments' },
        t.comments.map((c, i) => comment(t, c, i)),
      ),
      replyBox(t),
    );
  }

  function snippet(t) {
    return h(
      'div',
      { class: `snippet${t.base ? ' base' : ''}` },
      t.snippet.lines.map((line, i) =>
        h('div', { class: 'line' }, h('span', { class: 'ln' }, t.snippet.start + i), h('span', { class: 'code' }, line || ' ')),
      ),
    );
  }

  function comment(t, c, i) {
    const isEditing = editing && editing.id === t.id && editing.index === i;
    return h(
      'div',
      { class: 'comment' },
      h('img', { class: 'avatar', src: c.mine ? state.icons.reviewer : state.icons.agent, alt: '' }),
      h(
        'div',
        { class: 'comment-main' },
        h(
          'div',
          { class: 'comment-head' },
          h('span', { class: 'author' }, c.author),
          c.time ? h('span', { class: 'muted', title: new Date(c.time).toLocaleString() }, ago(c.time)) : null,
          h('span', { class: 'spacer' }),
          isEditing
            ? null
            : h(
                'span',
                { class: 'comment-actions' },
                c.mine
                  ? button('Edit', 'link', () => {
                      editing = { id: t.id, index: i };
                      focusKey = `edit:${t.id}:${i}`;
                      render();
                    })
                  : null,
                button('Delete', 'link', () => post({ type: 'delete', id: t.id, index: i })),
              ),
        ),
        isEditing ? editBox(t, c, i) : h('div', { class: 'markdown', html: c.html }),
      ),
    );
  }

  function editBox(t, c, i) {
    const area = textarea(`edit:${t.id}:${i}`, { rows: 4 }, c.body);
    const cancel = () => {
      editing = null;
      render();
    };
    const save = () => {
      const body = area.value.trim();
      if (!body) return;
      post({ type: 'edit', id: t.id, index: i, body });
      editing = null;
    };
    onSubmit(area, save);
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') cancel();
    });
    return h('div', { class: 'editor' }, area, h('div', { class: 'buttons' }, button('Cancel', 'secondary', cancel), button('Save', 'primary', save)));
  }

  function replyBox(t) {
    const area = textarea(`reply:${t.id}`, { class: 'reply', rows: 1, placeholder: 'Reply…' });
    const send = () => {
      const body = area.value.trim();
      if (!body) return;
      post({ type: 'reply', id: t.id, body });
      area.value = '';
      area.dispatchEvent(new Event('input'));
    };
    onSubmit(area, send);
    const resolved = t.status === 'resolved';
    return h(
      'div',
      { class: 'reply-box' },
      area,
      h(
        'div',
        { class: 'buttons' },
        button(resolved ? 'Reopen' : 'Resolve', 'secondary', () => post({ type: 'resolve', id: t.id, resolved: !resolved })),
        button('Reply', 'primary send', send),
      ),
    );
  }

  function newComment() {
    const area = textarea('new', { rows: 3, placeholder: 'Leave a general comment for the agent…' });
    const send = () => {
      const body = area.value.trim();
      if (!body) return;
      post({ type: 'comment', body });
      area.value = '';
      area.dispatchEvent(new Event('input'));
    };
    onSubmit(area, send);
    return h(
      'section',
      { class: 'new-comment' },
      h('h2', {}, 'General comment'),
      area,
      h('div', { class: 'buttons' }, h('span', { class: 'hint muted' }, '⌘/Ctrl + Enter to send'), button('Comment', 'primary', send)),
    );
  }
})();
