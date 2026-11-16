const { randomUUID: uuidv4 } = require('crypto');
const { db, withTransaction } = require('../config/db');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Realiza uma compra. Usado pela rota POST /api/orders e pela automação do
 * painel admin, então as duas passam pelas MESMAS regras.
 *
 * Roda dentro de withTransaction (seção crítica serializada): valida estoque,
 * debita estoque e grava o pedido como uma unidade. Duas compras simultâneas
 * do mesmo produto nunca leem o mesmo estoque "antigo". Se qualquer passo
 * falhar, os débitos de estoque já feitos são desfeitos (rollback).
 * O preço SEMPRE vem do banco, nunca de quem chama (evita adulterar o total).
 *
 * @param {{ userId: string, items: {productId: string, quantity: number}[], shipping: object }} input
 */
async function placeOrder({ userId, items, shipping }) {
  return withTransaction(async (tx) => {
    // Agrupa o mesmo produto repetido no carrinho para validar o estoque total.
    const qtyByProduct = new Map();
    for (const item of items) {
      const id = String(item.productId);
      qtyByProduct.set(id, (qtyByProduct.get(id) || 0) + item.quantity);
    }

    let totalCents = 0;
    const resolvedItems = [];
    for (const [productId, quantity] of qtyByProduct) {
      const product = await db.products.findOneAsync({ public_id: productId, active: true });
      if (!product) throw httpError(400, `Produto ${productId} não encontrado ou indisponível.`);
      if (product.stock < quantity) {
        throw httpError(409, `Estoque insuficiente para "${product.name}". Disponível: ${product.stock}.`);
      }
      totalCents += product.price_cents * quantity;
      resolvedItems.push({ product, quantity });
    }

    for (const { product, quantity } of resolvedItems) {
      // Condição "stock >= quantity" no próprio update: segunda barreira contra estoque negativo.
      const { numAffected } = await db.products.updateAsync(
        { _id: product._id, stock: { $gte: quantity } },
        { $inc: { stock: -quantity } }
      );
      if (numAffected !== 1) throw httpError(409, `Estoque insuficiente para "${product.name}".`);
      tx.onRollback(() => db.products.updateAsync({ _id: product._id }, { $inc: { stock: quantity } }));
    }

    const now = new Date();
    return db.orders.insertAsync({
      public_id: uuidv4(),
      user_id: userId,
      status: 'pendente',
      total_cents: totalCents,
      shipping_street: shipping.street,
      shipping_city: shipping.city,
      shipping_state: shipping.state,
      shipping_zip: shipping.zip,
      tracking_code: null,
      // Itens embutidos no pedido (modelagem NoSQL), com nome e preço da hora da compra.
      items: resolvedItems.map(({ product, quantity }) => ({
        product_id: product._id,
        product_name: product.name,
        quantity,
        unit_price_cents: product.price_cents,
      })),
      created_at: now,
      updated_at: now,
    });
  });
}

const STATUS_FLOW = ['pendente', 'pago', 'em_separacao', 'enviado', 'entregue'];
const NEXT_STATUS = { pendente: 'pago', pago: 'em_separacao', em_separacao: 'enviado', enviado: 'entregue' };
const CANCELLABLE = ['pendente', 'pago', 'em_separacao'];

/**
 * Cancela um pedido e devolve os itens ao estoque, numa seção crítica.
 * O pedido é lido DENTRO da transação: evita cancelar duas vezes (estoque
 * devolvido em dobro). Se `actor` for informado, aplica a checagem de posse
 * (cliente só cancela o próprio pedido; admin cancela qualquer um).
 */
async function cancelOrder(orderPublicId, actor = null) {
  return withTransaction(async (tx) => {
    const found = await db.orders.findOneAsync({ public_id: String(orderPublicId) });
    if (!found) throw httpError(404, 'Pedido não encontrado.');
    if (actor && found.user_id !== actor.id && actor.role !== 'admin') {
      throw httpError(403, 'Você não tem permissão para cancelar este pedido.');
    }
    if (!CANCELLABLE.includes(found.status)) {
      throw httpError(409, `Pedido no status "${found.status}" não pode mais ser cancelado.`);
    }

    for (const item of found.items) {
      await db.products.updateAsync({ _id: item.product_id }, { $inc: { stock: item.quantity } });
      tx.onRollback(() => db.products.updateAsync({ _id: item.product_id }, { $inc: { stock: -item.quantity } }));
    }
    await db.orders.updateAsync({ _id: found._id }, { $set: { status: 'cancelado', updated_at: new Date() } });
    return found;
  });
}

/** Altera o status de venda/entrega de um pedido (uso administrativo). */
async function setOrderStatus(orderPublicId, status, trackingCode) {
  const order = await db.orders.findOneAsync({ public_id: String(orderPublicId) });
  if (!order) throw httpError(404, 'Pedido não encontrado.');
  if (order.status === 'cancelado') throw httpError(409, 'Pedido cancelado não pode ter o status alterado.');
  if (!STATUS_FLOW.includes(status)) throw httpError(400, 'Status inválido.');

  const changes = { status, updated_at: new Date() };
  if (trackingCode) changes.tracking_code = String(trackingCode);

  const { affectedDocuments } = await db.orders.updateAsync(
    { _id: order._id },
    { $set: changes },
    { returnUpdatedDocs: true }
  );
  return affectedDocuments;
}

module.exports = { placeOrder, cancelOrder, setOrderStatus, httpError, STATUS_FLOW, NEXT_STATUS, CANCELLABLE };
