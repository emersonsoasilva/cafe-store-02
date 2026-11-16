const { randomUUID: uuidv4 } = require('crypto');
const { db, withTransaction } = require('../config/db');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Realiza uma compra. Usado pela rota POST /api/orders e pelo simulador,
 * então as compras simuladas passam pelas MESMAS regras das reais.
 *
 * Roda dentro de withTransaction (seção crítica serializada): valida estoque,
 * debita estoque e grava o pedido como uma unidade. Duas compras simultâneas
 * do mesmo produto nunca leem o mesmo estoque "antigo". Se qualquer passo
 * falhar, os débitos de estoque já feitos são desfeitos (rollback).
 * O preço SEMPRE vem do banco, nunca de quem chama (evita adulterar o total).
 *
 * @param {{ userId: string, items: {productId: string, quantity: number}[], shipping: object }} input
 */
async function placeOrder({ userId, items, shipping }, { simulated = false } = {}) {
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
      simulated,
      created_at: now,
      updated_at: now,
    });
  });
}

module.exports = { placeOrder, httpError };
