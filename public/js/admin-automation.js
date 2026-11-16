/*
 * Painel "Automação de operações" da página Administração.
 * Liga/desliga a automação no servidor e mostra, em tempo real, as
 * funcionalidades reais que ela está executando. Iniciado por admin.js
 * depois da checagem de admin (startAutomationPanel).
 */
function startAutomationPanel({ onChange } = {}) {
  const $ = (id) => document.getElementById(id);
  const msgEl = $('msg');
  const POLL_MS = 2000;
  const KINDS = ['users', 'products', 'restock', 'orders', 'fulfillment', 'cancellations'];
  const EVENT_TAG = {
    users: 'Cliente', products: 'Produto', restock: 'Estoque', orders: 'Compra',
    fulfillment: 'Entrega', cancellations: 'Cancelado', failure: 'Pulado', phase: 'Fase', control: 'Controle',
  };

  let current = null;       // último status recebido do servidor
  let clockOffset = 0;      // diferença entre o relógio do servidor e o do navegador
  let lastEventKey = null;  // para destacar só os eventos novos
  let lastDone = null;      // total de ações concluídas, para saber quando recarregar as listas
  let busy = false;

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
    stateEl.textContent = s.running ? 'Ativa' : 'Desativada';
    stateEl.className = `sim-state ${s.running ? 'on' : 'off'}`;
    const btn = $('sim-toggle');
    btn.textContent = s.running ? 'Desativar automação' : 'Ativar automação';
    btn.className = s.running ? 'danger' : '';
    $('phaseSeconds').disabled = s.running;
    $('intervalSeconds').disabled = s.running;
    if (s.running || !$('phaseSeconds').value) {
      $('phaseSeconds').value = s.config.phaseSeconds;
      $('intervalSeconds').value = s.config.intervalSeconds;
    }
    const skipped = s.session.failures
      ? ` ${s.session.failures} ação(ões) pulada(s) por não haver o que fazer no momento.` : '';
    $('sim-started').textContent = s.running
      ? `Ativada por ${s.startedBy.name} às ${time(s.startedAt)}.${skipped}`
      : s.stoppedAt ? `Desativada às ${time(s.stoppedAt)}.${skipped}` : '';

    // Contadores desta execução + totais da loja
    for (const kind of KINDS) bump(`c-${kind}`, s.session[kind]);
    $('t-users').textContent = `${s.totals.customers} clientes na loja`;
    $('t-products').textContent = `${s.totals.products} produtos ativos`;
    $('t-orders').textContent = `${s.totals.orders} pedidos na loja`;
    $('t-open').textContent = `${s.totals.openOrders} pedidos em aberto`;

    // Fase ativa: destaca o card da funcionalidade sorteada
    document.querySelectorAll('.sim-stat').forEach((el) => {
      el.classList.toggle('active', Boolean(s.phase) && el.dataset.kind === s.phase.action);
    });
    $('sim-phase').dataset.kind = s.phase ? s.phase.action : '';

    renderEvents(s.events);
    renderPhaseClock();

    // A automação gravou algo novo: atualiza as listas de produtos e pedidos.
    const done = KINDS.reduce((sum, k) => sum + s.session[k], 0);
    if (lastDone !== null && done !== lastDone && onChange) onChange();
    lastDone = done;
  }

  function renderEvents(events) {
    const list = $('sim-events');
    if (!events.length) {
      list.innerHTML = '<li class="hint">Nenhuma atividade ainda.</li>';
      return;
    }
    const prevKey = lastEventKey;
    lastEventKey = events[0].at + events[0].text;
    list.innerHTML = events.map((e) => `
      <li class="sim-event" data-kind="${escapeHtml(e.type)}">
        <time>${time(e.at)}</time>
        <span class="sim-tag">${escapeHtml(EVENT_TAG[e.type] || e.type)}</span>
        <span>${escapeHtml(e.text)}</span>
      </li>`).join('');
    // Destaca apenas o que chegou desde a última atualização.
    if (prevKey) {
      for (let i = 0; i < events.length; i++) {
        if (events[i].at + events[i].text === prevKey) break;
        list.children[i].classList.add('fresh');
      }
    }
  }

  // Atualiza a contagem regressiva várias vezes por segundo, sem esperar o servidor.
  function renderPhaseClock() {
    const s = current;
    if (!s || !s.running || !s.phase) {
      $('phase-label').textContent = s && s.running ? 'Iniciando...' : 'Automação parada';
      $('phase-bar').style.width = '0%';
      $('phase-meta').textContent = s && s.running ? '' : 'Ative a automação para começar.';
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
      ? `${s.phase.done} feito(s) nesta fase · nova funcionalidade sorteada em ${left} s`
      : 'Sorteando a próxima funcionalidade...';
  }

  async function refresh() {
    try {
      render(await api('/admin/automation'));
    } catch (err) {
      showMessage(msgEl, err.message);
    }
  }

  $('sim-toggle').addEventListener('click', async () => {
    if (busy || !current) return;
    if (!current.running && !window.confirm(
      'A automação executa ações reais em produção: cadastra clientes e produtos, '
      + 'realiza compras, altera status e cancela pedidos no banco da loja. Ativar?'
    )) return;
    busy = true;
    msgEl.hidden = true;
    try {
      if (current.running) {
        render(await api('/admin/automation/stop', { method: 'POST' }));
      } else {
        if (!$('sim-config').reportValidity()) return;
        render(await api('/admin/automation/start', {
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

  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(renderPhaseClock, 250);
}
