const { db, withTransaction } = require('../config/db');
const { placeOrder, httpError } = require('../services/orderService');
const { auditLog } = require('../utils/logger');

const STATUS_FLOW = ['pendente', 'pago', 'em_separacao', 'enviado', 'entregue'];

/*
 * Modelagem NoSQL: os itens ficam EMBUTIDOS no documento do pedido
 * (orders.items[]), com nome e preço copiados no momento da compra.
 * Assim o histórico do pedido não muda se o produto for editado depois,
 * e um pedido é lido inteiro com uma única consulta (sem JOIN).
 */
function toPublicOrder(order) {
  return {
    id: order.public_id,
    status: order.status,
    totalCents: order.total_cents,
    totalFormatted: (order.total_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    shippingAddress: {
      street: order.shipping_street,
      city: order.shipping_city,
      state: order.shipping_state,
      zip: order.shipping_zip,
    },
    trackingCode: order.tracking_code,
    simulated: Boolean(order.simulated),
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    items: order.items.map((i) => ({
      productName: i.product_name,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      subtotalCents: i.unit_price_cents * i.quantity,
    })),
  };
}

/**
 * POST /api/orders - cria um pedido (compra).
 * As regras de estoque/transação ficam em services/orderService.js, para
 * serem compartilhadas com o simulador de atividade.
 */
async function createOrder(req, res) {
  const { items, shipping } = req.body;

  try {
    const order = await placeOrder({ userId: req.user.id, items, shipping });

    auditLog('order_created', {
      userId: req.user.id,
      details: { orderId: order.public_id, totalCents: order.total_cents },
    });

    return res.status(201).json({ order: toPublicOrder(order) });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    // Em erro 500 a mensagem é genérica: não vaza detalhes internos.
    return res.status(status).json({ error: status < 500 ? err.message : 'Não foi possível concluir o pedido.' });
  }
}

/** GET /api/orders - pedidos do próprio usuário autenticado */
async function listMyOrders(req, res) {
  const orders = await db.orders.findAsync({ user_id: req.user.id }).sort({ created_at: -1 });
  res.json({ orders: orders.map(toPublicOrder) });
}

/**
 * GET /api/orders/:id - detalhe de um pedido.
 * Checagem de posse (ownership check): um cliente só pode ver o próprio
 * pedido; administradores podem ver qualquer pedido. Isso evita IDOR
 * (Insecure Direct Object Reference, parte da OWASP A01).
 */
async function getOrder(req, res) {
  const order = await db.orders.findOneAsync({ public_id: String(req.params.id) });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Você não tem permissão para ver este pedido.' });
  }
  res.json({ order: toPublicOrder(order) });
}

/** POST /api/orders/:id/cancel - cliente cancela o próprio pedido enquanto ainda não foi enviado */
async function cancelOrder(req, res) {
  try {
    const order = await withTransaction(async (tx) => {
      // Lido dentro da seção crítica: evita cancelar duas vezes (estoque devolvido em dobro).
      const found = await db.orders.findOneAsync({ public_id: String(req.params.id) });
      if (!found) throw httpError(404, 'Pedido não encontrado.');
      if (found.user_id !== req.user.id && req.user.role !== 'admin') {
        throw httpError(403, 'Você não tem permissão para cancelar este pedido.');
      }
      if (['enviado', 'entregue', 'cancelado'].includes(found.status)) {
        throw httpError(409, `Pedido no status "${found.status}" não pode mais ser cancelado.`);
      }

      for (const item of found.items) {
        await db.products.updateAsync({ _id: item.product_id }, { $inc: { stock: item.quantity } });
        tx.onRollback(() => db.products.updateAsync({ _id: item.product_id }, { $inc: { stock: -item.quantity } }));
      }
      await db.orders.updateAsync({ _id: found._id }, { $set: { status: 'cancelado', updated_at: new Date() } });
      return found;
    });

    auditLog('order_cancelled', { userId: req.user.id, details: { orderId: order.public_id } });
    res.json({ message: 'Pedido cancelado e itens devolvidos ao estoque.' });
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

/**
 * PATCH /api/admin/orders/:id/status - avança o status de venda/entrega
 * (uso administrativo: pago -> em_separacao -> enviado -> entregue).
 */
async function updateOrderStatus(req, res) {
  const { status, trackingCode } = req.body;
  const order = await db.orders.findOneAsync({ public_id: String(req.params.id) });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });

  if (order.status === 'cancelado') {
    return res.status(409).json({ error: 'Pedido cancelado não pode ter o status alterado.' });
  }
  if (!STATUS_FLOW.includes(status)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }

  const changes = { status, updated_at: new Date() };
  if (trackingCode) changes.tracking_code = String(trackingCode);

  const { affectedDocuments } = await db.orders.updateAsync(
    { _id: order._id },
    { $set: changes },
    { returnUpdatedDocs: true }
  );

  auditLog('order_status_updated', {
    userId: req.user.id,
    details: { orderId: order.public_id, newStatus: status },
  });

  res.json({ order: toPublicOrder(affectedDocuments) });
}

/** GET /api/admin/orders - visão administrativa de todos os pedidos */
async function listAllOrders(req, res) {
  const orders = await db.orders.findAsync({}).sort({ created_at: -1 });
  res.json({ orders: orders.map(toPublicOrder) });
}

module.exports = {
  createOrder,
  listMyOrders,
  getOrder,
  cancelOrder,
  updateOrderStatus,
  listAllOrders,
};
