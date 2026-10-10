// These two functions are serialized by chrome.scripting. Keep them self-contained.
export function collectPage(options) {
  if (location.origin !== 'https://delta.yandex-team.ru') return { error: 'wrong_origin' };
  const frames = [];
  const warnings = [];
  let busy = false;
  let reloadSuggested = false;
  const normalize = value => String(value || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
  const visible = (element, doc) => {
    const style = doc.defaultView.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && element.getClientRects().length > 0;
  };
  const visit = (doc, label, depth) => {
    const win = doc.defaultView;
    if (!doc.body) { busy = true; return; }
    if (/попробуйте\s+перезагрузить\s+страницу/i.test(normalize(doc.body.innerText))) reloadSuggested = true;
    if (doc.readyState !== 'complete') busy = true;
    const loading = '[aria-busy="true"], [role="progressbar"], .spin2_progress_yes, .spin2_visible, .Spin_visible, .spin_visible, .monaco-progress-container.active, [data-testid="loading"], [data-testid="loader"], [class*="Spinner"], [class*="spinner"], [class*="Loader"], [class*="loader"]';
    const loaders = [...doc.querySelectorAll(loading)];
    if (options.loadingSelector) loaders.push(...doc.querySelectorAll(options.loadingSelector));
    if (loaders.some(element => visible(element, doc))) busy = true;
    if (depth === 0 && options.readySelector && ![...doc.querySelectorAll(options.readySelector)].some(el => visible(el, doc))) busy = true;
    let roots = options.contentSelector && depth === 0 ? [...doc.querySelectorAll(options.contentSelector)] : [doc.body];
    // Delta epad uses Ace. Its body also contains toolbar, line numbers and a
    // rendered preview; prefer source lines, preserving indentation and blanks.
    if (!options.contentSelector) {
      const aceRoots = [...doc.querySelectorAll('.ace_editor')].filter(el => visible(el, doc));
      if (aceRoots.length) roots = aceRoots;
    }
    if (!roots.length) busy = true;
    roots = roots.filter((el, index) => !roots.some((other, otherIndex) => otherIndex !== index && other.contains(el)));
    const aceSource = roots.some(el => el.matches('.ace_editor'));
    let text = roots.map(el => el.matches('.ace_editor')
      ? [...el.querySelectorAll('.ace_text-layer .ace_line')].map(line => line.textContent.replace(/\u00a0/g, ' ')).join('\n')
      : normalize(el.innerText)).filter(Boolean).join('\n\n');
    // Form controls may hold the document while innerText contains only surrounding UI.
    const fields = roots.flatMap(root => [...root.querySelectorAll('textarea, input[type="text"], input:not([type])')])
      .filter(el => visible(el, doc) && !el.disabled && !el.classList.contains('ace_text-input') && !/password|token|secret/i.test(el.type + ' ' + el.name + ' ' + el.id))
      .map(el => normalize(el.value)).filter(value => value && !text.includes(value));
    if (fields.length) text += '\n\n[Текст полей]\n' + fields.join('\n\n');
    const password = [...doc.querySelectorAll('input[type="password"]')].some(el => visible(el, doc));
    const authShell = text.length < 800 && /^(?:войти|вход|авторизация|sign in|log in|authentication required)[\s\S]*$/i.test(text);
    if (password || authShell) warnings.push('authentication_required');
    const alerts = [...doc.querySelectorAll('[role="alert"]')].filter(el => visible(el, doc)).map(el => normalize(el.innerText));
    if (alerts.some(t => /ошибка|не удалось|error|failed|access denied|нет доступа/i.test(t))) warnings.push('page_error');
    const closedDetails = roots.reduce((n, root) => n + root.querySelectorAll('details:not([open])').length, 0);
    const collapsed = roots.reduce((n, root) => n + [...root.querySelectorAll('[aria-expanded="false"]')].filter(el => visible(el, doc)).length, 0);
    if (closedDetails || collapsed) warnings.push('collapsed_content');
    if (doc.querySelector('.ace_editor, .monaco-editor, .cm-editor, .CodeMirror, [data-virtualized], .ReactVirtualized__Grid, [role="grid"]')) warnings.push('editor_or_virtualized_content');
    frames.push({ frame: label, url: doc.location.href, text: aceSource ? text : normalize(text), strategy: aceSource ? 'ace_visible_source_lines' : 'dom_text', aceSourceOnly: roots.length === 1 && roots[0].matches('.ace_editor'), aceEditorId: roots.length === 1 && roots[0].matches('.ace_editor') ? roots[0].id : null, aceEditorDetected: Boolean(doc.querySelector('.ace_editor')) });
    const children = [...doc.querySelectorAll('iframe, frame')];
    for (let i = 0; i < children.length; i++) {
      if (!visible(children[i], doc)) continue;
      try {
        const child = children[i].contentDocument;
        if (!child) { warnings.push('unreadable_frame'); continue; }
        if (depth >= 5) { warnings.push('frame_depth_limit'); continue; }
        visit(child, label + '/frame-' + (i + 1), depth + 1);
      } catch { warnings.push('unreadable_frame'); }
    }
  };
  try {
    visit(document, 'main', 0);
    return { url: location.href, title: document.title, readyState: document.readyState, busy, reloadSuggested, frames, warnings: [...new Set(warnings)] };
  } catch (error) {
    return { error: error.name === 'SyntaxError' ? 'invalid_selector' : 'collector_error', message: error.name };
  }
}

export function readEditors() {
  if (location.origin !== 'https://delta.yandex-team.ru') return [];
  const models = [];
  const seen = new Set();
  const add = (kind, text, name) => {
    if (typeof text !== 'string' || !text || seen.has(text)) return;
    seen.add(text); models.push({ kind, name: String(name || ''), text });
  };
  const visit = (win, depth) => {
    try {
      // A global Monaco registry can include unrelated, historical models. Only
      // attached editors are used; never dump editor.getModels().
      const editors = win.monaco?.editor?.getEditors?.() || [];
      for (const editor of editors) {
        const node = editor.getDomNode?.();
        if (node?.isConnected && win.getComputedStyle(node).display !== 'none') {
          const model = editor.getModel?.();
          if (model) add('Monaco', model.getValue(), model.uri?.toString());
        }
      }
      for (const node of win.document.querySelectorAll('.CodeMirror')) {
        const style = win.getComputedStyle(node);
        if (node.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden' && node.CodeMirror?.getValue) add('CodeMirror', node.CodeMirror.getValue(), '');
      }
      for (const node of win.document.querySelectorAll('.ace_editor')) {
        const style = win.getComputedStyle(node);
        if (!node.getClientRects().length || style.display === 'none' || style.visibility === 'hidden') continue;
        // ace.edit(node) can create a new editor. Use only an existing instance
        // attached to the visible DOM node; do not initialize or modify editors.
        const editor = node.env?.editor;
        if (typeof editor?.getValue === 'function') add('Ace', editor.getValue(), node.id);
      }
      // CodeMirror 6 exposes no stable global registry. Avoid guessing internals.
      for (const frame of win.document.querySelectorAll('iframe, frame')) {
        if (depth < 5 && frame.contentWindow && frame.contentDocument) visit(frame.contentWindow, depth + 1);
      }
    } catch { /* DOM snapshots remain available; completeness stays unverified. */ }
  };
  visit(window, 0);
  return models;
}
