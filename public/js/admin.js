  const msgEl = document.getElementById('msg');
  const STATUS_LABEL = {
    pendente: 'Pendente', pago: 'Pago', em_separacao: 'Em separação',
    enviado: 'Enviado', entregue: 'Entregue', cancelado: 'Cancelado',
  };
  const NEXT_STATUS = {
    pendente: 'pago', pago: 'em_separacao', em_separacao: 'enviado', enviado: 'entregue',
  };

  // A tela só abre para admin. A proteção de verdade está no servidor: as
  // rotas /api/admin/* respondem 401/403 para qualquer outro usuário.
  async function guardAdmin() {
    try {
      const { user } = await api('/auth/me');
      if (user.role !== 'admin') {
        window.location.href = '/index.html';
        return false;
      }
      return true;
    } catch (_) {
      window.location.href = '/login.html?next=/admin.html';
      return false;
    }
  }

  async function loadProducts() {
    const el = document.getElementById('admin-products');
    try {
      const { products } = await api('/admin/products');
      el.innerHTML = `
        <table>
          <thead><tr><th>Nome</th><th>Preço</th><th>Estoque</th><th>Ativo</th><th></th></tr></thead>
          <tbody>
            ${products.map((p) => `
              <tr>
                <td>${escapeHtml(p.name)}</td>
                <td>${p.priceFormatted}</td>
                <td>${p.stock}</td>
                <td>${p.active ? 'Sim' : 'Não'}</td>
                <td>${p.active ? `<button class="danger deactivate-btn" data-id="${p.id}">Desativar</button>` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      document.querySelectorAll('.deactivate-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api(`/admin/products/${btn.dataset.id}`, { method: 'DELETE' });
            loadProducts();
          } catch (err) {
            showMessage(msgEl, err.message);
          }
        });
      });
    } catch (err) {
      showMessage(msgEl, err.message);
    }
  }

  async function loadOrders() {
    const el = document.getElementById('admin-orders');
    try {
      const { orders } = await api('/admin/orders');
      el.innerHTML = orders.map((o) => `
        <div class="card">
          <div class="row" style="justify-content:space-between;align-items:center;">
            <strong>Pedido ${o.id.slice(0, 8)}</strong>
            <span class="badge ${o.status}">${STATUS_LABEL[o.status] || o.status}</span>
          </div>
          <p class="hint">${o.totalFormatted} · Entrega em ${escapeHtml(o.shippingAddress.city)}/${escapeHtml(o.shippingAddress.state)}</p>
          ${NEXT_STATUS[o.status] ? `<button class="advance-btn" data-id="${o.id}" data-next="${NEXT_STATUS[o.status]}">Avançar para "${STATUS_LABEL[NEXT_STATUS[o.status]]}"</button>` : ''}
        </div>
      `).join('') || '<p class="hint">Nenhum pedido registrado ainda.</p>';

      document.querySelectorAll('.advance-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api(`/admin/orders/${btn.dataset.id}/status`, {
              method: 'PATCH',
              body: { status: btn.dataset.next },
            });
            loadOrders();
          } catch (err) {
            showMessage(msgEl, err.message);
          }
        });
      });
    } catch (err) {
      showMessage(msgEl, err.message);
    }
  }

  (async () => {
    if (!(await guardAdmin())) return;
    document.getElementById('admin').hidden = false;
    loadProducts();
    loadOrders();
    // Painel de automação (admin-automation.js): recarrega as listas acima
    // sempre que a automação gravar algo novo no banco.
    startAutomationPanel({ onChange: () => { loadProducts(); loadOrders(); } });
  })();
