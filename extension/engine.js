import { collectPage, readEditors } from './collector.js';
import { isDelta, samePage, fingerprint, textOf, detectGate, hasFullAceSource } from './core.js';

export function makeChromeAdapter() {
  return {
    getTab: id => chrome.tabs.get(id),
    reload: id => chrome.tabs.reload(id),
    async snapshot(id, settings) {
      const results = await chrome.scripting.executeScript({ target: { tabId: id }, world: 'ISOLATED', func: collectPage, args: [settings] });
      const snapshot = results[0]?.result;
      if (!snapshot) throw new Error('No snapshot');
      if (snapshot.error) return { snapshot, editors: [] };
      let editors = [];
      try {
        const values = await chrome.scripting.executeScript({ target: { tabId: id }, world: 'MAIN', func: readEditors });
        editors = values[0]?.result || [];
      } catch {
        snapshot.warnings.push('editor_probe_unavailable');
      }
      if (snapshot.frames.some(frame => frame.aceEditorDetected) && !editors.some(editor => editor.kind === 'Ace')) snapshot.warnings.push('ace_model_unavailable');
      return { snapshot, editors };
    }
  };
}

export async function captureTab(entry, settings, dependencies) {
  const { api, paused, onProgress = async () => {}, onReload = async () => {}, checkpoint = async () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollMs = 1000, callTimeoutMs = 15000 } = dependencies;
  const started = now();
  let cycleStarted = started;
  let deadline = started + settings.timeout * 1000;
  const warnings = new Set(['readiness_is_heuristic']);
  const samples = [];
  const sampleKeys = new Set();
  let latest;
  let longest;
  let previousSignature;
  let stableSince = started;
  let temporaryInjectionFailures = 0;
  let reloads = 0;
  let deadlineReason = 'deadline';
  const request = (task, limit = callTimeoutMs, cleanup = false) => {
    let timer;
    return Promise.race([
      Promise.resolve().then(task),
      new Promise((resolve, reject) => { timer = setTimeout(() => {
        const error = new Error('Browser call timeout'); error.code = 'browser_call_timeout'; reject(error);
      }, Math.max(1, cleanup ? limit : Math.min(limit, deadline - now()))); })
    ]).finally(() => clearTimeout(timer));
  };
  const sample = (snapshot, editors, text) => {
    const signature = fingerprint(JSON.stringify([snapshot.frames, editors]));
    if (sampleKeys.has(signature)) return;
    sampleKeys.add(signature);
    const item = { capturedAt: new Date(now()).toISOString(), frames: snapshot.frames, editors, text, extractionMethod: hasFullAceSource(snapshot, editors) ? 'ace_model' : 'page_text' };
    samples.push(item);
    if (!longest || text.length >= longest.text.length) longest = item;
  };
  const result = (status, reason) => ({
    status, reason, reloads, capture: latest || samples.length ? {
      capturedAt: new Date(now()).toISOString(), originalUrl: entry.url,
      finalUrl: latest?.snapshot.url || entry.url, title: latest?.snapshot.title || entry.title,
      text: longest?.text || latest?.text || '', samples,
      extractionMethod: longest?.extractionMethod || latest?.extractionMethod,
      warnings: [...warnings].filter(code => (longest?.extractionMethod || latest?.extractionMethod) !== 'ace_model' || !['ace_model_unavailable', 'editor_probe_unavailable', 'editor_or_virtualized_content', 'virtualized_content_unverified'].includes(code)),
      completeness: 'unverified', partial: status !== 'captured', recoveryReloads: reloads,
      settings: structuredClone(settings)
    } : null
  });
  const recover = async reason => {
    const previousWaitSeconds = Math.floor((now() - cycleStarted) / 1000);
    // A timeout-triggered reload happens after the preceding deadline. The
    // browser call still has its own bound; the next wait gets a fresh budget.
    await request(() => api.reload(entry.tabId), callTimeoutMs, true);
    reloads++;
    cycleStarted = now(); deadline = cycleStarted + settings.timeout * 1000;
    try { await onReload({ reloads, at: new Date(now()).toISOString(), reason, previousWaitSeconds, nextWaitSeconds: settings.timeout }); }
    catch (cause) { const error = new Error('Не удалось записать перезагрузку', { cause }); error.checkpointFailure = true; throw error; }
    samples.length = 0; sampleKeys.clear(); longest = undefined; latest = undefined;
    warnings.clear(); warnings.add('readiness_is_heuristic');
    previousSignature = undefined; stableSince = now(); temporaryInjectionFailures = 0;
    deadlineReason = 'deadline_browser_loading';
    await sleep(pollMs);
  };
  try {
    let tab;
    try { tab = await request(() => api.getTab(entry.tabId)); } catch (error) { return error.code === 'browser_call_timeout' ? result('error', 'browser_unresponsive') : result('closed', 'closed'); }
    if (!samePage(tab.pendingUrl || tab.url, entry.url)) return result('navigated', 'navigated');
    if (tab.discarded) await request(() => api.reload(entry.tabId));
    // Metadata lookup and waking a discarded tab precede the first full wait.
    cycleStarted = now(); deadline = cycleStarted + settings.timeout * 1000; stableSince = cycleStarted;
    while (true) {
      if (paused()) return result('paused', 'paused');
      if (now() >= deadline) {
        if (['deadline_browser_loading', 'deadline_page_loading'].includes(deadlineReason) && reloads < (settings.maxReloads ?? 3)) {
          await recover(deadlineReason); continue;
        }
        return result('timeout', deadlineReason);
      }
      try { tab = await request(() => api.getTab(entry.tabId)); } catch (error) { return error.code === 'browser_call_timeout' ? result('error', 'browser_unresponsive') : result('closed', 'closed'); }
      if (!samePage(tab.pendingUrl || tab.url, entry.url)) return result('navigated', 'navigated');
      await onProgress({ phase: 'waiting', elapsed: Math.floor((now() - cycleStarted) / 1000), totalElapsed: Math.floor((now() - started) / 1000), waitLimit: settings.timeout, reloads });
      const browserLoading = tab.status !== 'complete';
      let pair;
      try {
        pair = await request(() => api.snapshot(entry.tabId, settings));
        temporaryInjectionFailures = 0;
      } catch {
        deadlineReason = browserLoading ? 'deadline_browser_loading' : 'deadline_reading';
        temporaryInjectionFailures++;
        stableSince = now(); previousSignature = undefined;
        if (temporaryInjectionFailures >= 8 && !browserLoading) return result('error', 'injection_failed');
        await sleep(pollMs); continue;
      }
      const { snapshot, editors } = pair;
      if (snapshot.error) {
        if (browserLoading) { deadlineReason = 'deadline_browser_loading'; stableSince = now(); previousSignature = undefined; await sleep(pollMs); continue; }
        return result('error', snapshot.error);
      }
      if (!isDelta(snapshot.url) || !samePage(snapshot.url, entry.url)) {
        if (browserLoading) { deadlineReason = 'deadline_browser_loading'; stableSince = now(); previousSignature = undefined; await sleep(pollMs); continue; }
        return result('navigated', 'navigated');
      }
      for (const warning of snapshot.warnings) warnings.add(warning);
      const text = textOf(snapshot, editors);
      const fullAceSource = hasFullAceSource(snapshot, editors);
      if (!fullAceSource && snapshot.warnings.includes('editor_or_virtualized_content')) warnings.add('virtualized_content_unverified');
      latest = { snapshot, editors, text, extractionMethod: fullAceSource ? 'ace_model' : 'page_text' };
      const reloadSuggested = snapshot.reloadSuggested || snapshot.frames.some(frame => /попробуйте\s+перезагрузить\s+страницу/i.test(frame.text));
      if (reloadSuggested) {
        if (reloads >= (settings.maxReloads ?? 3)) return result('error', 'reload_limit');
        await recover('reload_suggested'); continue;
      }
      // Reading a message during navigation is allowed; successful capture still
      // requires both browser load completion and the application's readiness.
      if (browserLoading) { deadlineReason = 'deadline_browser_loading'; stableSince = now(); previousSignature = undefined; await sleep(pollMs); continue; }
      const gate = detectGate(snapshot, text);
      if (gate.fatal) return result('error', gate.fatal);
      const signature = fingerprint(JSON.stringify([text, fullAceSource ? 'ace_model' : 'page_text']));
      deadlineReason = gate.waitingReason || 'deadline_unstable_text';
      if (!gate.eligible || previousSignature !== signature) {
        stableSince = now(); previousSignature = gate.eligible ? signature : undefined;
        await sleep(pollMs); continue;
      }
      const stableMs = settings.stable * 1000;
      if (now() - stableSince < stableMs) { await sleep(pollMs); continue; }
      sample(snapshot, editors, text);
      try { await checkpoint(result('waiting')); } catch (cause) {
        const error = new Error('Не удалось сохранить промежуточный снимок', { cause });
        error.checkpointFailure = true;
        throw error;
      }
      return result('captured');
    }
  } catch (error) {
    if (error.checkpointFailure) throw error;
    return result('error', 'injection_failed');
  }
}

export function nextEntry(run) {
  // Finish the first pass before retrying slow/error tabs.
  const pending = run.entries.find(entry => entry.status === 'pending' || entry.status === 'waiting');
  if (pending) return pending;
  return run.entries.find(entry => ['timeout', 'error'].includes(entry.status) && !['invalid_selector', 'authentication_required', 'wrong_origin'].includes(entry.reason) && entry.attempts < 1 + run.settings.retries);
}
