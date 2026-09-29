function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mount(root, api) {
  const panel = element('section', 'project-cockpit');
  const title = element('h2', '', 'Project Cockpit');
  const summary = element('pre', '', 'Loading project summary…');
  const actions = element('div', 'project-cockpit__actions');
  const refreshButton = element('button', '', 'Refresh');
  const checkButton = element('button', '', 'Run bun run check');
  const askButton = element('button', '', 'Summarize in chat');
  const status = element('p', '', '');
  const style = element('style');
  style.textContent = `
    .project-cockpit { color: inherit; font: inherit; padding: 1rem; }
    .project-cockpit h2 { font-size: 1rem; font-weight: 600; margin: 0 0 .75rem; }
    .project-cockpit pre { background: rgba(127,127,127,.08); border-radius: .5rem; font-size: .75rem;
      max-height: 55vh; overflow: auto; padding: .75rem; white-space: pre-wrap; }
    .project-cockpit__actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .project-cockpit button { border: 1px solid rgba(127,127,127,.3); border-radius: .4rem;
      cursor: pointer; padding: .4rem .65rem; }
    .project-cockpit button:disabled { cursor: wait; opacity: .55; }
    .project-cockpit p { font-size: .75rem; white-space: pre-wrap; }
  `;
  actions.append(refreshButton, checkButton, askButton);
  panel.append(title, actions, status, summary);
  root.replaceChildren(style, panel);

  let disposed = false;
  let refreshController;
  let checkController;

  async function refresh() {
    refreshController?.abort();
    const requestController = new AbortController();
    refreshController = requestController;
    refreshButton.disabled = true;
    try {
      const result = await api.read('project-summary', {}, { signal: requestController.signal });
      if (!disposed && refreshController === requestController) {
        summary.textContent = JSON.stringify(result, null, 2);
      }
    } catch (error) {
      if (
        !disposed &&
        refreshController === requestController &&
        !requestController.signal.aborted
      ) {
        summary.textContent = String(error);
      }
    } finally {
      if (!disposed && refreshController === requestController) refreshButton.disabled = false;
    }
  }

  async function runCheck() {
    checkController?.abort();
    const requestController = new AbortController();
    checkController = requestController;
    checkButton.disabled = true;
    status.textContent = 'Running check…';
    try {
      const result = await api.invoke('run-check', {}, { signal: requestController.signal });
      if (disposed || checkController !== requestController) return;
      status.textContent = `Exit code: ${result.exitCode}\n${result.timedOut ? 'Timed out.\n' : ''}${result.killed ? 'Cancelled.\n' : ''}${result.stdout}${result.stderr}`;
      api.notify(
        result.exitCode === 0
          ? 'Project check passed.'
          : 'Project check finished with a non-zero exit code.',
        result.exitCode === 0 ? 'success' : 'warning'
      );
    } catch (error) {
      if (!disposed && checkController === requestController && !requestController.signal.aborted) {
        status.textContent = String(error);
        api.notify('Project check failed.', 'error');
      }
    } finally {
      if (!disposed && checkController === requestController) checkButton.disabled = false;
    }
  }

  async function askAgent() {
    askButton.disabled = true;
    try {
      await api.prompt(
        'Summarize the current project status: read package.json and git status, then give a one-paragraph overview.'
      );
      api.notify('Prompt sent to chat.', 'success');
    } catch (error) {
      if (!disposed) status.textContent = String(error);
    } finally {
      if (!disposed) askButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', refresh);
  checkButton.addEventListener('click', runCheck);
  askButton.addEventListener('click', askAgent);
  void refresh();

  return () => {
    disposed = true;
    refreshController?.abort();
    checkController?.abort();
    refreshButton.removeEventListener('click', refresh);
    checkButton.removeEventListener('click', runCheck);
    askButton.removeEventListener('click', askAgent);
    root.replaceChildren();
  };
}
