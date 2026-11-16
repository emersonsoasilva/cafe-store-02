(() => {
  const $ = (id) => document.getElementById(id);
  const msgEl = $('msg');
  const POLL_MS = 2000;
  const EVENT_TAG = { users: 'Usuário', products: 'Produto', orders: 'Compra', failure: 'Pulado', phase: 'Fase', control: 'Controle' };

  let current = null;       // último status recebido do servidor
  let clockOffset = 0;      // diferença entre o relógio do servidor e o do navegador
  let lastEventKey = null;  // para destacar só os eventos novos
  let lastCounters = {};
  let busy = false;

  // A tela só abre para admin. A proteção de verdade está no servidor:
  // as rotas /api/admin/simulator/* respondem 401/403 para qualquer outro.
  async function guardAdmin() {
    try {
      const { user } = await api('/auth/me');
      if (user.role !== 'admin') {
        window.location.href = '/index.html';
        return false;
      }
      return true;
    } catch (_) {
      window.location.href = '/login.html?next=/simulator.html';
      return false;
    }
  }

  const time = (d) => new Date(d).toLocaleTimeString('pt-BR');

  function bump(id, value) {
    const el = $(id);
    if (String(value) !== el.textContent) {
      el.textContent = value;
      el.classList.remove('bump');
      void el.offsetWidth; // reinicia a animação
      el.classList.add('bump');
    }
  }

  function render(s) {
    current = s;
    clockOffset = new Date(s.serverTime).getTime() - Date.now();

    // Controle
    const stateEl = $('sim-state');
    stateEl.textContent = s.running ? 'Ativo' : 'Desativado';
    stateEl.className = `sim-state ${s.running ? 'on' : 'off'}`;
    const btn = $('sim-toggle');
    btn.textContent = s.running ? 'Desativar simulador' : 'Ativar simulador';
    btn.className = s.running ? 'danger' : '';
    $('phaseSeconds').disabled = s.running;
    $('intervalSeconds').disabled = s.running;
    if (s.running || !$('phaseSeconds').value) {
      $('phaseSeconds').value = s.config.phaseSeconds;
      $('intervalSeconds').value = s.config.intervalSeconds;
    }
    $('sim-started').textContent = s.running
      ? `Ativado por ${s.startedBy.name} às ${time(s.startedAt)}.`
      : s.stoppedAt ? `Desativado às ${time(s.stoppedAt)}.` : '';

    // Contadores desta sessão + totais da loja
    bump('c-users', s.session.users);
    bump('c-products', s.session.products);
    bump('c-orders', s.session.orders);
    bump('c-failures', s.session.failures);
    $('t-users').textContent = `${s.totals.customers.all} clientes na loja (${s.totals.customers.simulated} simulados)`;
    $('t-products').textContent = `${s.totals.products.all} produtos ativos (${s.totals.products.simulated} simulados)`;
    $('t-orders').textContent = `${s.totals.orders.all} pedidos na loja (${s.totals.orders.simulated} simulados)`;
    lastCounters = s.session;

    // Fase ativa: destaca o card da atividade sorteada
    document.querySelectorAll('.sim-stat').forEach((el) => {
      el.classList.toggle('active', Boolean(s.phase) && el.dataset.kind === s.phase.action);
    });
    $('sim-phase').dataset.kind = s.phase ? s.phase.action : '';

    renderEvents(s.events);
    renderPhaseClock();
  }

  function renderEvents(events) {
    const list = $('sim-events');
    if (!events.length) {
      list.innerHTML = '<li class="hint">Nenhuma atividade ainda.</li>';
      return;
    }
    const newestKey = events[0].at + events[0].text;
    const prevKey = lastEventKey;
    lastEventKey = newestKey;
    list.innerHTML = events.map((e) => `
      <li class="sim-event" data-kind="${e.type}">
        <time>${time(e.at)}</time>
        <span class="sim-tag">${EVENT_TAG[e.type] || e.type}</span>
        <span>${escapeHtml(e.text)}</span>
      </li>`).join('');
    // Destaca apenas o que chegou desde a última atualização.
    if (prevKey) {
      for (const li of list.children) {
        const idx = Array.prototype.indexOf.call(list.children, li);
        const e = events[idx];
        if (e.at + e.text === prevKey) break;
        li.classList.add('fresh');
      }
    }
  }

  // Atualiza a contagem regressiva várias vezes por segundo, sem esperar o servidor.
  function renderPhaseClock() {
    const s = current;
    if (!s || !s.running || !s.phase) {
      $('phase-label').textContent = s && s.running ? 'Iniciando...' : 'Simulador parado';
      $('phase-bar').style.width = '0%';
      $('phase-meta').textContent = s && s.running ? '' : 'Ative o simulador para começar.';
      return;
    }
    const now = Date.now() + clockOffset;
    const start = new Date(s.phase.startedAt).getTime();
    const end = new Date(s.phase.endsAt).getTime();
    const left = Math.max(0, Math.ceil((end - now) / 1000));
    const pct = Math.min(100, ((now - start) / (end - start)) * 100);
    $('phase-label').textContent = `Fase ${s.phase.number}: ${s.phase.label}`;
    $('phase-bar').style.width = `${pct}%`;
    $('phase-meta').textContent = left > 0
      ? `${s.phase.done} feito(s) nesta fase · nova atividade sorteada em ${left} s`
      : 'Sorteando a próxima atividade...';
  }

  async function refresh() {
    try {
      render(await api('/admin/simulator'));
    } catch (err) {
      showMessage(msgEl, err.message);
    }
  }

  $('sim-toggle').addEventListener('click', async () => {
    if (busy || !current) return;
    busy = true;
    msgEl.hidden = true;
    try {
      if (current.running) {
        render(await api('/admin/simulator/stop', { method: 'POST' }));
      } else {
        const form = $('sim-config');
        if (!form.reportValidity()) return;
        render(await api('/admin/simulator/start', {
          method: 'POST',
          body: {
            phaseSeconds: parseInt($('phaseSeconds').value, 10),
            intervalSeconds: parseInt($('intervalSeconds').value, 10),
          },
        }));
      }
    } catch (err) {
      showMessage(msgEl, err.message);
      refresh();
    } finally {
      busy = false;
    }
  });

  (async () => {
    if (!(await guardAdmin())) return;
    $('sim').hidden = false;
    await refresh();
    setInterval(refresh, POLL_MS);
    setInterval(renderPhaseClock, 250);
  })();
})();
