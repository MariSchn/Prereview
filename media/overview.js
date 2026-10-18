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

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAC = /Mac/.test(navigator.userAgent);
  const ICONS = {
    file: '<path d="M4 1.75h4.75l3.25 3.25v9.25H4z"/><path d="M8.75 1.75V5H12"/>',
    comment: '<path d="M2.25 3.25h11.5v8H8.5L5 14v-2.75H2.25z"/>',
    branch: '<circle cx="4.75" cy="3.5" r="1.5"/><circle cx="4.75" cy="12.5" r="1.5"/><circle cx="11.25" cy="4.75" r="1.5"/><path d="M4.75 5v6M11.25 6.25c0 3-6.5 2.25-6.5 4.75"/>',
    arrow: '<path d="M12.5 8h-9M7 4.5 3.5 8 7 11.5"/>',
    worktree: '<path d="M1.75 3.25h4.5l1.5 1.5h6.5v8.5H1.75z"/>',
    copy: '<rect x="5.75" y="5.75" width="7.5" height="8" rx="1.25"/><path d="M10.25 5.75V3.5c0-.7-.55-1.25-1.25-1.25H4c-.7 0-1.25.55-1.25 1.25V10c0 .7.55 1.25 1.25 1.25h1.75"/>',
    diff: '<path d="M3.75 1.75h5l3.5 3.5v9h-8.5z"/><path d="M8 5.5v3.5M6.25 7.25h3.5M6.25 11.5h3.5"/>',
    finish: '<circle cx="8" cy="8" r="6.25"/><path d="m5.5 8.25 1.75 1.75 3.25-3.5"/>',
    check: '<path d="m3.25 8.5 3 3 6.5-7"/>',
    reopen: '<path d="M3 8a5 5 0 1 0 1.46-3.54"/><path d="M3.25 2.25v2.5h2.5"/>',
    edit: '<path d="M10.75 2.5 13.5 5.25 6 12.75H3.25V10z"/>',
    trash: '<path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4.25 4.25l.6 9h6.3l.6-9"/>',
    outdated: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75V8l2.25 1.5"/>',
    chevron: '<path d="m6 3.75 4.25 4.25L6 12.25"/>',
    awaitingYou: '<circle cx="8" cy="8" r="6"/><circle class="f" cx="8" cy="8" r="2.75"/>',
    awaitingAgent: '<circle cx="8" cy="8" r="6"/><path class="f" d="M8 4.25a3.75 3.75 0 0 1 0 7.5z"/>',
    resolved: '<circle class="f" cx="8" cy="8" r="6.75"/><path class="cut" d="m5.25 8.25 1.85 1.85 3.65-3.85"/>',
  };
  const AVATAR_GLYPHS = {
    reviewer: [
      'M8 3.7a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z',
      'M3.4 13.1C4.2 11 5.9 9.9 8 9.9s3.8 1.1 4.6 3.2A7.4 7.4 0 0 1 8 15a7.4 7.4 0 0 1-4.6-1.9z',
    ],
    agent: [
      'M7 3.5c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4z',
      'M11.4 9.6c.2 1.2.6 1.6 1.8 1.8-1.2.2-1.6.6-1.8 1.8-.2-1.2-.6-1.6-1.8-1.8 1.2-.2 1.6-.6 1.8-1.8z',
    ],
  };

  function svg(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  }

  function avatar(mine, small) {
    const kind = mine ? 'reviewer' : 'agent';
    const el = svg('svg', { class: `avatar ${kind}${small ? ' small' : ''}`, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
    el.append(svg('circle', { class: 'bg', cx: 8, cy: 8, r: 7.7 }));
    for (const d of AVATAR_GLYPHS[kind]) el.append(svg('path', { class: 'fg', d }));
    return el;
  }

  function icon(name, cls) {
    const el = svg('svg', { class: `icon icon-${name}${cls ? ` ${cls}` : ''}`, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
    el.innerHTML = ICONS[name];
    return el;
  }

  function filePath(file) {
    const slash = file.lastIndexOf('/');
    return [slash >= 0 ? h('span', { class: 'dir' }, file.slice(0, slash + 1)) : null, h('span', { class: 'base' }, file.slice(slash + 1))];
  }

  function button(label, kind, onclick, iconName) {
    return h('button', { class: kind, type: 'button', onclick }, iconName ? icon(iconName) : null, label);
  }

  function iconButton(name, label, onclick, kind = '') {
    return h('button', { class: `icon-button ${kind}`, type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
  }

  function keys(...names) {
    return names.map((name) => h('kbd', {}, name));
  }

  function diffBlocks(added, deleted) {
    const total = added + deleted;
    const green = total ? Math.round((added / total) * 5) : 0;
    const red = total ? 5 - green : 0;
    return h(
      'span',
      { class: 'blocks', 'aria-hidden': 'true' },
      Array.from({ length: 5 }, (_, i) => h('span', { class: i < green ? 'block added' : i < green + red ? 'block deleted' : 'block' })),
    );
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
      h('span', { class: `stat ${status}` }, icon(status), h('strong', {}, s.counts[status]), label.toLowerCase()),
    );
    return h(
      'header',
      { class: 'header' },
      h('h1', { class: s.titleFromAgent ? 'title' : 'title untitled' }, s.title),
      h(
        'div',
        { class: 'meta' },
        s.titleFromAgent
          ? h(
              'span',
              { class: 'branches' },
              h('code', { class: 'branch', title: 'Base' }, icon('branch'), s.base),
              icon('arrow', 'into'),
              h('code', { class: 'branch', title: 'Under review' }, icon('branch'), s.target),
            )
          : null,
        s.worktree ? h('span', { class: 'meta-item', title: `Checked out in ${s.worktree}` }, icon('worktree'), 'In worktree') : null,
        h('span', { class: 'meta-item' }, icon('file'), plural(s.files, 'file')),
        h(
          'span',
          { class: 'meta-item diffstat', title: `${s.added} added, ${s.deleted} deleted` },
          h('span', { class: 'added' }, `+${s.added}`),
          h('span', { class: 'deleted' }, `−${s.deleted}`),
          diffBlocks(s.added, s.deleted),
        ),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h('div', { class: 'summary' }, counts.length ? counts : h('span', { class: 'stat' }, 'No threads yet')),
        h(
          'div',
          { class: 'actions' },
          button('Copy path for agent', 'primary', () => post({ type: 'command', name: 'copyReviewPath' }), 'copy'),
          button('Open all changes', 'secondary', () => post({ type: 'command', name: 'openAllChanges' }), 'diff'),
          button('Finish review', 'ghost danger', () => post({ type: 'command', name: 'finishReview' }), 'finish'),
        ),
      ),
    );
  }

  function description() {
    return h(
      'section',
      { class: state.description ? 'card description' : 'card description pending' },
      h(
        'div',
        { class: 'card-head' },
        avatar(false, true),
        h('span', { class: 'author' }, 'Agent'),
        h('span', { class: 'muted' }, state.description ? 'wrote a description' : 'adds a title and description when it picks up the review'),
      ),
      state.description ? h('div', { class: 'card-body markdown', html: state.description }) : null,
    );
  }

  function groups() {
    if (!state.threads.length) {
      return [
        h(
          'div',
          { class: 'empty-state' },
          h('span', { class: 'empty-icon' }, icon('comment')),
          h('strong', {}, 'No comments yet'),
          h('span', { class: 'muted' }, 'Comment on lines in the diff, or leave a general comment below.'),
        ),
      ];
    }
    return GROUPS.map(([status, label]) => {
      const threads = state.threads.filter((t) => t.status === status);
      if (!threads.length) return null;
      const collapsible = status === 'resolved';
      const heading = h(
        'h2',
        { class: `group-head ${status}` },
        icon(status),
        h('span', {}, label),
        h('span', { class: 'count' }, threads.length),
        h('span', { class: 'rule' }),
        collapsible ? icon('chevron', 'toggle') : null,
      );
      if (!collapsible) return h('section', { class: 'group' }, heading, threads.map(thread));
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
    const resolved = t.status === 'resolved';
    return h(
      'article',
      { class: `card thread ${t.status}` },
      h(
        'div',
        { class: 'card-head' },
        icon(t.file ? 'file' : 'comment', 'kind'),
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
              filePath(t.file),
            )
          : h('span', { class: 'location general' }, 'General comment'),
        t.where ? h('span', { class: 'where' }, t.where) : null,
        h('span', { class: 'spacer' }),
        t.outdated
          ? h('span', { class: 'pill outdated', title: 'The code this comment was left on has changed' }, icon('outdated'), 'Outdated')
          : null,
        button(resolved ? 'Reopen' : 'Resolve', 'ghost', () => post({ type: 'resolve', id: t.id, resolved: !resolved }), resolved ? 'reopen' : 'check'),
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
      avatar(c.mine),
      h(
        'div',
        { class: 'comment-main' },
        h(
          'div',
          { class: 'comment-head' },
          h('span', { class: 'author' }, c.author),
          c.time ? h('span', { class: 'time', title: new Date(c.time).toLocaleString() }, ago(c.time)) : null,
          h('span', { class: 'spacer' }),
          isEditing
            ? null
            : h(
                'span',
                { class: 'comment-actions' },
                c.mine
                  ? iconButton('edit', 'Edit', () => {
                      editing = { id: t.id, index: i };
                      focusKey = `edit:${t.id}:${i}`;
                      render();
                    })
                  : null,
                iconButton('trash', 'Delete', () => post({ type: 'delete', id: t.id, index: i }), 'danger'),
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
    return h(
      'div',
      { class: 'editor' },
      area,
      h('div', { class: 'buttons' }, button('Cancel', 'ghost', cancel), button('Save', 'primary', save)),
    );
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
    return h(
      'div',
      { class: 'reply-box' },
      area,
      h('div', { class: 'buttons' }, h('span', { class: 'hint' }, keys(MAC ? '⌘' : 'Ctrl', 'Enter'), ' to send'), button('Reply', 'primary', send)),
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
      avatar(true),
      h(
        'div',
        { class: 'composer' },
        area,
        h(
          'div',
          { class: 'composer-foot' },
          h('span', { class: 'hint' }, keys(MAC ? '⌘' : 'Ctrl', 'Enter'), ' to send'),
          button('Comment', 'primary', send),
        ),
      ),
    );
  }
})();
