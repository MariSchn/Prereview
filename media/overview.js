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
  const drafts = new Map();
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
    refresh: '<path d="M13.25 8a5.25 5.25 0 1 1-1.2-3.3"/><path d="M13.5 2.25v3h-3"/>',
    reopen: '<path d="M3 8a5 5 0 1 0 1.46-3.54"/><path d="M3.25 2.25v2.5h2.5"/>',
    edit: '<path d="M10.75 2.5 13.5 5.25 6 12.75H3.25V10z"/>',
    trash: '<path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4.25 4.25l.6 9h6.3l.6-9"/>',
    outdated: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75V8l2.25 1.5"/>',
    chevron: '<path d="m6 3.75 4.25 4.25L6 12.25"/>',
    bold: '<path d="M4.75 2.75h3.75a2.6 2.6 0 0 1 0 5.25H4.75zM4.75 8h4.5a2.6 2.6 0 0 1 0 5.25h-4.5z"/>',
    italic: '<path d="M6.75 2.75h5M4.25 13.25h5M9.5 2.75 6.5 13.25"/>',
    code: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
    link: '<path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2-2a2.75 2.75 0 0 0-3.9-3.9l-.75.75"/><path d="M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2 2a2.75 2.75 0 0 0 3.9 3.9l.75-.75"/>',
    quote: '<path d="M3 3.5v9M6.5 5.5h6.5M6.5 8h6.5M6.5 10.5h4"/>',
    bullets: '<circle class="f" cx="3" cy="4.5" r="1"/><circle class="f" cx="3" cy="8" r="1"/><circle class="f" cx="3" cy="11.5" r="1"/><path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5"/>',
    numbers: '<path d="M2.5 3.25h1v3.25M2.5 6.5h2M2.5 9.75h1.75l-1.75 2.75h2"/><path d="M7 4.5h6.5M7 8h6.5M7 11.5h6.5"/>',
    history: '<path d="M2.75 8a5.25 5.25 0 1 0 1.54-3.71"/><path d="M2.5 2.25v2.75h2.75"/><path d="M8 5v3.25l2.25 1.5"/>',
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

  function cleanArt() {
    const el = svg('svg', { class: 'clean-art', viewBox: '0 0 120 72', 'aria-hidden': 'true' });
    el.innerHTML =
      '<path class="page" d="M4 14h42a4 4 0 0 1 4 4v36a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4z"/>' +
      '<path class="page line" d="M12 30h24M12 38h16M12 46h20"/>' +
      '<path class="page" d="M70 14h42a4 4 0 0 1 4 4v36a4 4 0 0 1-4 4H70a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4z"/>' +
      '<path class="page line" d="M78 30h24M78 38h16M78 46h20"/>' +
      '<circle class="badge" cx="60" cy="38" r="13"/>' +
      '<path class="tick" d="M54 38.4l3.6 3.6 8-8.4"/>';
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

  const FORMATS = {
    bold: { label: 'Bold', key: 'b', wrap: ['**', '**'] },
    italic: { label: 'Italic', key: 'i', wrap: ['_', '_'] },
    code: { label: 'Code', key: 'e', wrap: ['`', '`'], block: ['```\n', '\n```'] },
    link: { label: 'Link', wrap: ['[', '](url)'] },
    quote: { label: 'Quote', prefix: () => '> ' },
    bullets: { label: 'Bulleted list', prefix: () => '- ' },
    numbers: { label: 'Numbered list', prefix: (i) => `${i + 1}. ` },
  };

  function format(area, name) {
    const f = FORMATS[name];
    const { selectionStart: start, selectionEnd: end, value } = area;
    const selected = value.slice(start, end);
    area.focus();
    if (f.prefix) {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      area.setSelectionRange(lineStart, end);
      // insertText keeps the change on the textarea's undo stack.
      document.execCommand('insertText', false, value.slice(lineStart, end).split('\n').map((line, i) => f.prefix(i) + line).join('\n'));
      return;
    }
    const [before, after] = f.block && selected.includes('\n') ? f.block : f.wrap;
    document.execCommand('insertText', false, before + selected + after);
    const inner = start + before.length;
    if (name === 'link' && selected) area.setSelectionRange(inner + selected.length + 2, inner + selected.length + 5);
    else area.setSelectionRange(inner, inner + selected.length);
  }

  function toolbar(area) {
    const mod = MAC ? '⌘' : 'Ctrl+';
    return h(
      'span',
      { class: 'toolbar' },
      Object.entries(FORMATS).map(([name, f]) => {
        const label = f.key ? `${f.label} (${mod}${f.key.toUpperCase()})` : f.label;
        const el = iconButton(name, label, () => format(area, name));
        // Keep the focus and selection in the textarea.
        el.addEventListener('mousedown', (event) => event.preventDefault());
        return el;
      }),
    );
  }

  function textarea(key, props, initial = '') {
    const area = h('textarea', { 'data-key': key, ...props });
    area.value = initial;
    const sync = () => area.classList.toggle('filled', area.value.trim() !== '');
    area.addEventListener('input', sync);
    area.addEventListener('keydown', (event) => {
      if (!(MAC ? event.metaKey : event.ctrlKey) || event.shiftKey || event.altKey) return;
      const name = Object.keys(FORMATS).find((n) => FORMATS[n].key === event.key.toLowerCase());
      if (!name) return;
      // Don't let the webview forward the key to VS Code, where Ctrl/Cmd+B toggles the sidebar.
      event.preventDefault();
      event.stopPropagation();
      format(area, name);
    });
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
    const content = h('div', { class: 'content' }, fileProblem(), changesProblem(), description(), ...groups(), state.files.length ? newComment() : null);
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
          s.files.length ? button('Open all changes', 'secondary', command('openAllChanges'), 'diff') : null,
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
        s.files.length
          ? [
              h('span', { class: 'meta-item' }, icon('file'), plural(s.files.length, 'file')),
              h(
                'span',
                { class: 'meta-item diffstat', title: `${s.added} added, ${s.deleted} deleted` },
                h('span', { class: 'added' }, `+${s.added}`),
                h('span', { class: 'deleted' }, `−${s.deleted}`),
                diffBlocks(s.added, s.deleted),
              ),
            ]
          : s.changesError
            ? null
            : s.threads.length
              ? h('span', { class: 'meta-item' }, 'No file changes')
              : h('span', { class: 'meta-item in-sync' }, icon('check'), 'In sync'),
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
    if (!state.files.length && !state.threads.length) {
      return state.changesError
        ? ['idle', "Couldn't load the changes", state.changesError, () => button('Refresh', 'secondary', command('refresh'), 'refresh', 'refresh')]
        : ['resolved', 'In sync', 'The two sides match.', () => button('Refresh', 'secondary', command('refresh'), 'refresh', 'refresh')];
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
    const card = statusCard();
    const files = filesCard();
    if (!card && !files) return null;
    return h('aside', { class: 'rail' }, card, files);
  }

  function statusCard() {
    if (!state.files.length && !state.threads.length) return null;
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
      updated
        ? h(
            'a',
            {
              class: 'since-viewed',
              href: '#',
              'data-key': 'since-viewed',
              onclick: (event) => {
                event.preventDefault();
                post({ type: 'command', name: 'openAllSinceViewed' });
              },
            },
            icon('history'),
            h('span', {}, `${plural(updated, 'file')} changed since you viewed ${updated === 1 ? 'it' : 'them'}`),
            h('span', { class: 'since-viewed-action' }, 'Show changes'),
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
    const updated = state.files.some((f) => f.viewed === 'updated');
    return h(
      'section',
      { class: 'card files-card' },
      h(
        'div',
        { class: 'card-head' },
        h('strong', {}, 'Files'),
        h('span', { class: 'count' }, state.files.length),
        h('span', { class: 'spacer' }),
        updated ? iconButton('history', 'Open all changes since viewed', command('openAllSinceViewed')) : null,
        iconButton('diff', 'Open all changes', command('openAllChanges')),
      ),
      h('ul', { class: `file-list${updated ? ' has-updated' : ''}` }, state.files.map(fileRow)),
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
      f.viewed === 'updated'
        ? iconButton('history', 'Open changes since viewed', () => post({ type: 'sinceViewed', path: f.path }), 'since-viewed-file')
        : h('span'),
    );
  }

  function fileProblem() {
    if (!state.fileError && !state.unreadable) return null;
    return h(
      'div',
      { class: 'notice', 'data-flip': 'file-error' },
      h('strong', {}, state.fileError ? "The review file can't be read" : `${plural(state.unreadable, 'thread')} in the review file can't be read`),
      h(
        'span',
        { class: 'muted' },
        state.fileError
          ? `${state.fileError} Your comments can't be saved until it is fixed. The agent may still be writing it.`
          : 'They have no comment text Prereview can read, so they are not shown here. They stay in the file.',
      ),
      h('div', { class: 'empty-actions' }, button('Open review file', 'secondary', () => post({ type: 'openReviewFile' }), 'file')),
    );
  }

  function changesProblem() {
    if (!state.changesError) return null;
    return h(
      'div',
      { class: state.threads.length ? 'notice' : 'empty-state error', 'data-flip': 'error' },
      h('strong', {}, "Couldn't load the changes"),
      h('span', { class: 'muted' }, state.changesError),
      h('div', { class: 'empty-actions' }, button('Refresh', 'secondary', command('refresh'), 'refresh', 'refresh')),
    );
  }

  function description() {
    if (!state.description && !state.files.length && !state.threads.length) return null;
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

  function emptyComments() {
    return h(
      'div',
      { class: 'empty-state', 'data-flip': 'empty' },
      emptyArt(),
      h('strong', {}, 'No comments yet'),
      h('span', { class: 'muted' }, 'Comment on lines in the diff, or leave a general comment below.'),
    );
  }

  function cleanState() {
    return h(
      'div',
      { class: 'empty-state clean', 'data-flip': 'empty' },
      cleanArt(),
      h('strong', {}, 'No changes'),
      h(
        'span',
        { class: 'clean-pair' },
        h('code', { class: 'branch' }, icon('branch'), state.base),
        icon('arrow', 'into'),
        h('code', { class: 'branch' }, icon('branch'), state.target),
      ),
      h('span', { class: 'muted' }, 'These two match, so there is nothing to comment on yet.'),
      h('div', { class: 'empty-actions' }, button('Refresh', 'secondary', command('refresh'), 'refresh', 'refresh')),
    );
  }

  function groups() {
    if (!state.threads.length) return [state.changesError ? null : state.files.length ? emptyComments() : cleanState()];
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
        t.comments.map((c) => comment(t, c)),
        t.unreadable
          ? h(
              'div',
              { class: 'unreadable' },
              h('span', { class: 'muted' }, `${plural(t.unreadable, 'comment')} in this thread can't be read.`),
              button('Open review file', 'ghost', () => post({ type: 'openReviewFile' })),
            )
          : null,
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

  function comment(t, c) {
    const isEditing = editing && editing.id === t.id && editing.commentId === c.id;
    const key = `${t.id}:${c.id}`;
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
                      editing = { id: t.id, commentId: c.id };
                      focusKey = `edit:${t.id}:${c.id}`;
                      drafts.delete(focusKey);
                      render();
                    })
                  : null,
                iconButton('trash', 'Delete', () => post({ type: 'delete', id: t.id, commentId: c.id }), 'danger'),
              ),
        ),
        isEditing ? editBox(t, c) : h('div', { class: 'markdown', html: c.html }),
      ),
    );
  }

  function editBox(t, c) {
    const area = textarea(`edit:${t.id}:${c.id}`, { rows: 4 }, c.body);
    const cancel = () => {
      editing = null;
      render();
    };
    const save = () => {
      const body = area.value.trim();
      if (!body) return;
      post({ type: 'edit', id: t.id, commentId: c.id, body });
      editing = null;
      // An unchanged comment brings no new state, so leave edit mode here
      render();
    };
    onSubmit(area, save);
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') cancel();
    });
    return h(
      'div',
      { class: 'editor' },
      area,
      h('div', { class: 'buttons' }, toolbar(area), button('Cancel', 'ghost', cancel), button('Save', 'primary', save)),
    );
  }

  function replyBox(t) {
    const area = textarea(`reply:${t.id}`, { class: 'reply', rows: 1, placeholder: 'Reply…' });
    const canResolve = t.status !== 'resolved';
    const send = (resolve) => {
      const body = area.value.trim();
      if (!body) return;
      post({ type: 'reply', id: t.id, body, resolve });
      area.value = '';
      area.dispatchEvent(new Event('input'));
    };
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        send(canResolve && event.shiftKey);
      }
    });
    const resolveButton = canResolve ? button('Reply and resolve', 'secondary', () => send(true), 'check') : null;
    resolveButton?.setAttribute('title', `${MAC ? '⇧⌘' : 'Ctrl+Shift+'}Enter`);
    return h(
      'div',
      { class: 'reply-box' },
      avatar(true),
      h(
        'div',
        { class: 'reply-main' },
        area,
        h(
          'div',
          { class: 'buttons' },
          toolbar(area),
          h('span', { class: 'hint' }, keys(MAC ? '⌘' : 'Ctrl', 'Enter'), ' to send'),
          resolveButton,
          button('Reply', 'primary', () => send(false)),
        ),
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
          toolbar(area),
          h('span', { class: 'hint' }, keys(MAC ? '⌘' : 'Ctrl', 'Enter'), ' to send'),
          button('Comment', 'primary', send),
        ),
      ),
    );
  }
})();
