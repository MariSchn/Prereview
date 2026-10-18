(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const GROUPS = [
    ['awaitingYou', 'Awaiting you'],
    ['awaitingAgent', 'Awaiting agent'],
    ['resolved', 'Resolved'],
  ];
  const FILE_STATUS = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed' };
  const VIEWED = {
    unviewed: ['circle', 'Mark as viewed'],
    viewed: ['resolved', 'Mark as not viewed'],
    updated: ['awaitingYou', 'Changed since you viewed it. Mark as viewed'],
  };
  const saved = vscode.getState() || { resolvedOpen: false };
  const seen = new Set();
  const wide = matchMedia('(min-width: 1100px)');
  let primed = false;
  let scrolled = false;
  let jumps = 0;
  let state = null;
  let editing = null;
  let focusKey = null;
  let composing = false;
  const titleObserver = new IntersectionObserver(([entry]) => {
    scrolled = !entry.isIntersecting && entry.boundingClientRect.top < 0;
    app.querySelector('.topbar')?.classList.toggle('visible', scrolled);
  });

  window.addEventListener('compositionstart', () => (composing = true));
  window.addEventListener('compositionend', () => {
    composing = false;
    if (state) render();
  });
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      state = event.data.state;
      if (!composing) render();
    }
  });
  wide.addEventListener('change', () => state && render());
  vscode.postMessage({ type: 'ready' });
  setInterval(() => {
    for (const el of app.querySelectorAll('time[datetime]')) el.textContent = ago(el.getAttribute('datetime'));
  }, 30000);

  function post(message) {
    vscode.postMessage(message);
  }

  const UNSAFE_TAGS = 'script, style, link, meta, base, iframe, frame, frameset, object, embed, form, input, button, textarea, select';

  function sanitize(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    for (const el of template.content.querySelectorAll(UNSAFE_TAGS)) el.remove();
    for (const el of template.content.querySelectorAll('*')) {
      for (const { name, value } of [...el.attributes]) {
        const url = /(^|:)(href|src|action|formaction)$/.test(name) && /^javascript:/i.test(value.replace(/[\s\x00-\x1f]/g, ''));
        const keep = name === 'class' && value.split(/\s+/).filter((c) => c.startsWith('hljs')).join(' ');
        if (keep) el.setAttribute('class', keep);
        else if (name.startsWith('on') || name === 'style' || name === 'class' || name === 'id' || name.startsWith('data-') || url) {
          el.removeAttribute(name);
        }
      }
    }
    return template.content;
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'html') el.replaceChildren(sanitize(value));
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
    circle: '<circle cx="8" cy="8" r="6"/>',
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

  function emptyArt() {
    const el = svg('svg', { class: 'empty-art', viewBox: '0 0 76 56', 'aria-hidden': 'true' });
    el.innerHTML =
      '<path class="you" d="M9 4h30a5 5 0 0 1 5 5v14a5 5 0 0 1-5 5H20l-8 7v-7H9a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5z"/>' +
      '<path class="you line" d="M12 12.5h22M12 19.5h14"/>' +
      '<path class="agent" d="M37 18h30a5 5 0 0 1 5 5v14a5 5 0 0 1-5 5h-3v7l-8-7H37a5 5 0 0 1-5-5V23a5 5 0 0 1 5-5z"/>' +
      '<path class="agent line" d="M40 26.5h24M40 33.5h16"/>';
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

  function button(label, kind, onclick, iconName, key) {
    return h('button', { class: kind, type: 'button', 'data-key': key, onclick }, iconName ? icon(iconName) : null, label);
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

  function command(name) {
    return () => post({ type: 'command', name });
  }

  function reduceMotion() {
    return document.body.classList.contains('vscode-reduce-motion');
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
    const active = document.activeElement;
    let focused = active instanceof HTMLElement && active.dataset.key ? { key: active.dataset.key } : null;
    for (const area of app.querySelectorAll('textarea[data-key]')) {
      const key = area.getAttribute('data-key');
      drafts.set(key, area.value);
      if (area === document.activeElement) focused = { key, start: area.selectionStart, end: area.selectionEnd };
    }
    const before = new Map();
    for (const el of app.querySelectorAll('[data-flip]')) {
      const rect = el.getBoundingClientRect();
      if (rect.height) before.set(el.dataset.flip, rect.top);
    }
    const animate = primed && !reduceMotion();
    const content = h('div', { class: 'content' }, description(), ...groups(), newComment());
    app.replaceChildren(
      topbar(),
      header(),
      h('div', { class: 'layout' }, wide.matches ? [content, rail()] : [statusCard(), content, filesCard()]),
    );
    primed = true;
    titleObserver.disconnect();
    titleObserver.observe(app.querySelector('.title'));
    if (animate) {
      for (const el of app.querySelectorAll('[data-flip]')) {
        const rect = el.getBoundingClientRect();
        if (!rect.height) continue;
        const top = before.get(el.dataset.flip);
        if (top === undefined) {
          el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'ease-out' });
        } else if (Math.abs(top - rect.top) > 1) {
          el.animate([{ transform: `translateY(${top - rect.top}px)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
        }
      }
    }
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
      const el = app.querySelector(`[data-key="${CSS.escape(target.key)}"]`);
      if (el) {
        el.focus();
        if (target.start !== undefined) el.setSelectionRange(target.start, target.end);
      }
    }
  }

  function header() {
    const s = state;
    return h(
      'header',
      { class: 'header' },
      h(
        'div',
        { class: 'header-top' },
        h('h1', { class: s.titleFromAgent ? 'title' : 'title untitled' }, s.title),
        h(
          'div',
          { class: 'actions' },
          button('Finish review', 'ghost danger', command('finishReview'), 'finish'),
          button('Open all changes', 'secondary', command('openAllChanges'), 'diff'),
          copyButton('primary'),
        ),
      ),
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
        h('span', { class: 'meta-item' }, icon('file'), plural(s.files.length, 'file')),
        h(
          'span',
          { class: 'meta-item diffstat', title: `${s.added} added, ${s.deleted} deleted` },
          h('span', { class: 'added' }, `+${s.added}`),
          h('span', { class: 'deleted' }, `−${s.deleted}`),
          diffBlocks(s.added, s.deleted),
        ),
      ),
    );
  }

  function copyButton(kind) {
    let reset;
    const el = button(
      'Copy path for agent',
      kind,
      () => {
        post({ type: 'copyPath' });
        el.style.minWidth = `${el.offsetWidth}px`;
        el.replaceChildren(icon('check'), 'Copied');
        clearTimeout(reset);
        reset = setTimeout(() => el.replaceChildren(icon('copy'), 'Copy path for agent'), 1600);
      },
      'copy',
    );
    return el;
  }

  function status() {
    const { counts, threads } = state;
    if (counts.awaitingYou) {
      const waiting = threads.filter((t) => t.status === 'awaitingYou');
      const text = `${plural(counts.awaitingYou, 'thread')} ${counts.awaitingYou === 1 ? 'needs' : 'need'} your reply.`;
      return ['awaitingYou', 'Your turn', text, () => button('Go to thread', 'secondary', () => jumpTo(waiting[jumps++ % waiting.length].id))];
    }
    if (counts.awaitingAgent) return ['awaitingAgent', "Agent's turn", 'Copy the review path and send it to your agent.', () => copyButton('secondary')];
    if (counts.resolved) {
      return ['resolved', 'All threads resolved', 'Finish the review once you are happy with the changes.', () => button('Finish review', 'secondary', command('finishReview'), 'finish')];
    }
    return ['idle', 'Ready for review', 'Open the changes and comment on any line.', () => button('Open all changes', 'secondary', command('openAllChanges'), 'diff')];
  }

  function statusIcon(tone) {
    return icon(tone === 'idle' ? 'comment' : tone);
  }

  function topbar() {
    const [tone, title] = status();
    return h(
      'div',
      { class: `topbar${scrolled ? ' visible' : ''}` },
      h(
        'div',
        { class: 'topbar-inner' },
        h('span', { class: `topbar-status ${tone}` }, statusIcon(tone), title),
        h('span', { class: 'topbar-title' }, state.title),
        copyButton('primary'),
      ),
    );
  }

  function rail() {
    return h('aside', { class: 'rail' }, statusCard(), filesCard());
  }

  function statusCard() {
    const { counts, threads, files } = state;
    const [tone, title, text, action] = status();
    const viewed = files.filter((f) => f.viewed === 'viewed').length;
    const updated = files.filter((f) => f.viewed === 'updated').length;
    return h(
      'section',
      { class: `card status-card ${tone}` },
      h(
        'div',
        { class: 'status-main' },
        h('span', { class: 'status-icon' }, statusIcon(tone)),
        h('div', { class: 'status-text' }, h('strong', {}, title), h('span', { class: 'muted' }, text)),
      ),
      h('div', { class: 'status-action' }, action()),
      threads.length || files.length
        ? h(
            'div',
            { class: 'meters' },
            threads.length
              ? meter('Threads', `${counts.resolved} of ${threads.length} resolved`, [
                  [counts.resolved, 'resolved', 'Resolved'],
                  [counts.awaitingAgent, 'awaitingAgent', 'Awaiting agent'],
                  [counts.awaitingYou, 'awaitingYou', 'Awaiting you'],
                ])
              : null,
            files.length
              ? meter('Files viewed', `${viewed} of ${files.length}`, [
                  [viewed, 'resolved', 'Viewed'],
                  [updated, 'awaitingYou', 'Changed since viewed'],
                  [files.length - viewed - updated, 'rest', 'Not viewed'],
                ])
              : null,
          )
        : null,
    );
  }

  function meter(label, value, segments) {
    return h(
      'div',
      { class: 'meter' },
      h('div', { class: 'meter-label' }, h('span', {}, label), h('span', { class: 'meter-value' }, value)),
      h(
        'div',
        { class: 'bar', role: 'img', 'aria-label': `${label}: ${value}` },
        segments
          .filter(([n]) => n)
          .map(([n, cls, title]) => {
            const seg = h('span', { class: `seg ${cls}`, title: `${title}: ${n}` });
            seg.style.flexGrow = n;
            return seg;
          }),
      ),
    );
  }

  function jumpTo(id) {
    const card = app.querySelector(`.thread[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
    card.querySelector('textarea.reply')?.focus({ preventScroll: true });
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
  }

  function filesCard() {
    if (!state.files.length) return null;
    return h(
      'section',
      { class: 'card files-card' },
      h(
        'div',
        { class: 'card-head' },
        h('strong', {}, 'Files'),
        h('span', { class: 'count' }, state.files.length),
        h('span', { class: 'spacer' }),
        iconButton('diff', 'Open all changes', command('openAllChanges')),
      ),
      h('ul', { class: 'file-list' }, state.files.map(fileRow)),
    );
  }

  function fileRow(f) {
    const [iconName, label] = VIEWED[f.viewed];
    const slash = f.path.lastIndexOf('/');
    return h(
      'li',
      { class: `file-row ${f.viewed}` },
      h(
        'button',
        {
          class: 'view-toggle',
          type: 'button',
          title: label,
          'aria-label': label,
          'aria-pressed': f.viewed === 'viewed' ? 'true' : 'false',
          'data-key': `viewed:${f.path}`,
          onclick: () => post({ type: 'viewed', path: f.path, viewed: f.viewed !== 'viewed' }),
        },
        icon(iconName),
      ),
      h(
        'a',
        {
          class: 'file-link',
          href: '#',
          title: f.status === 'R' ? `${f.oldPath} → ${f.path}` : f.path,
          'data-key': `file:${f.path}`,
          onclick: (event) => {
            event.preventDefault();
            post({ type: 'openFile', path: f.path });
          },
        },
        h(
          'span',
          { class: 'file-path' },
          h('span', { class: `file-name ${f.status}` }, f.path.slice(slash + 1)),
          slash >= 0 ? h('span', { class: 'file-dir' }, f.path.slice(0, slash)) : null,
        ),
        h('span', { class: 'file-threads', title: f.open ? plural(f.open, 'open thread') : undefined }, f.open ? [icon('comment'), f.open] : null),
        h('span', { class: 'added' }, f.added ? `+${f.added}` : ''),
        h('span', { class: 'deleted' }, f.deleted ? `−${f.deleted}` : ''),
        h('span', { class: `file-status ${f.status}`, title: FILE_STATUS[f.status] }, f.status),
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
          { class: 'empty-state', 'data-flip': 'empty' },
          emptyArt(),
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
        { class: `group-head ${status}`, 'data-flip': `group:${status}` },
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
        h('summary', { 'data-key': 'resolved' }, heading),
        threads.map(thread),
      );
    });
  }

  function thread(t) {
    const resolved = t.status === 'resolved';
    return h(
      'article',
      { class: `card thread ${t.status}`, 'data-id': t.id, 'data-flip': `${t.id}:${t.status}` },
      h(
        'div',
        { class: 'card-head' },
        t.file
          ? h(
              'a',
              {
                class: 'location',
                href: '#',
                title: 'Open in diff',
                'data-key': `open:${t.id}:${t.status}`,
                onclick: (event) => {
                  event.preventDefault();
                  post({ type: 'open', id: t.id });
                },
              },
              icon('file', 'kind'),
              filePath(t.file),
            )
          : h('span', { class: 'location general' }, icon('comment', 'kind'), 'General comment'),
        t.where ? h('span', { class: 'where' }, t.where) : null,
        h(
          'span',
          { class: 'head-actions' },
          t.outdated
            ? h('span', { class: 'pill outdated', title: 'The code this comment was left on has changed' }, icon('outdated'), 'Outdated')
            : null,
          button(
            resolved ? 'Reopen' : 'Resolve',
            'ghost',
            () => post({ type: 'resolve', id: t.id, resolved: !resolved }),
            resolved ? 'reopen' : 'check',
            `resolve:${t.id}:${t.status}`,
          ),
        ),
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
      { class: `snippet${t.base ? ' base' : ''}${t.snippet.lines.length > t.snippet.focus[1] - t.snippet.focus[0] + 1 ? ' context' : ''}` },
      t.snippet.lines.map((line, i) => {
        const n = t.snippet.start + i;
        const focus = n >= t.snippet.focus[0] && n <= t.snippet.focus[1];
        return h('div', { class: focus ? 'line focus' : 'line' }, h('span', { class: 'ln' }, n), h('span', { class: 'code', html: line || ' ' }));
      }),
    );
  }

  function comment(t, c, i) {
    const isEditing = editing && editing.id === t.id && editing.index === i;
    const key = `${t.id}:${c.time || i}`;
    const fresh = primed && !seen.has(key);
    seen.add(key);
    return h(
      'div',
      { class: `comment ${c.mine ? 'mine' : 'theirs'}${fresh ? ' fresh' : ''}` },
      avatar(c.mine),
      h(
        'div',
        { class: 'comment-main' },
        h(
          'div',
          { class: 'comment-head' },
          h('span', { class: 'author' }, c.author),
          c.time ? h('time', { class: 'time', datetime: c.time, title: new Date(c.time).toLocaleString() }, ago(c.time)) : null,
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
      avatar(true),
      h(
        'div',
        { class: 'reply-main' },
        area,
        h('div', { class: 'buttons' }, h('span', { class: 'hint' }, keys(MAC ? '⌘' : 'Ctrl', 'Enter'), ' to send'), button('Reply', 'primary', send)),
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
      { class: 'new-comment', 'data-flip': 'composer' },
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
