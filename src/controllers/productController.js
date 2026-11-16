const { db } = require('../config/db');
const { auditLog } = require('../utils/logger');
const { createProduct } = require('../services/productService');

function toPublicProduct(p) {
  return {
    id: p.public_id,
    name: p.name,
    description: p.description,
    origin: p.origin,
    roastLevel: p.roast_level,
    weightGrams: p.weight_grams,
    priceCents: p.price_cents,
    priceFormatted: (p.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    stock: p.stock,
    active: p.active,
  };
}

/** GET /api/products - catálogo público (somente produtos ativos) */
async function list(req, res) {
  const rows = await db.products.findAsync({ active: true }).sort({ name: 1 });
  res.json({ products: rows.map(toPublicProduct) });
}

/** GET /api/products/:id */
async function getOne(req, res) {
  const product = await db.products.findOneAsync({ public_id: String(req.params.id) });
  if (!product || !product.active) {
    return res.status(404).json({ error: 'Produto não encontrado.' });
  }
  return res.json({ product: toPublicProduct(product) });
}

/** GET /api/admin/products - inclui inativos (uso administrativo) */
async function listAdmin(req, res) {
  const rows = await db.products.findAsync({}).sort({ created_at: -1 });
  res.json({ products: rows.map(toPublicProduct) });
}

/** POST /api/admin/products */
async function create(req, res) {
  const { name, description, origin, roastLevel, weightGrams, priceCents, stock } = req.body;
  const product = await createProduct({ name, description, origin, roastLevel, weightGrams, priceCents, stock });
  auditLog('product_created', { userId: req.user.id, details: { productId: product.public_id } });
  res.status(201).json({ product: toPublicProduct(product) });
}

/** PUT /api/admin/products/:id */
async function update(req, res) {
  const product = await db.products.findOneAsync({ public_id: String(req.params.id) });
  if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });

  // Lista fechada de campos editáveis (allowlist): o cliente nunca consegue
  // gravar campos arbitrários como _id, public_id ou created_at (mass assignment).
  const dbFieldMap = {
    name: 'name',
    description: 'description',
    origin: 'origin',
    roastLevel: 'roast_level',
    weightGrams: 'weight_grams',
    priceCents: 'price_cents',
    stock: 'stock',
    active: 'active',
  };

  const changes = {};
  for (const [field, dbField] of Object.entries(dbFieldMap)) {
    if (req.body[field] !== undefined) changes[dbField] = req.body[field];
  }
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar foi informado.' });
  }

  const { affectedDocuments } = await db.products.updateAsync(
    { _id: product._id },
    { $set: changes },
    { returnUpdatedDocs: true }
  );

  auditLog('product_updated', { userId: req.user.id, details: { productId: product.public_id } });
  res.json({ product: toPublicProduct(affectedDocuments) });
}

/** DELETE /api/admin/products/:id - soft delete (mantém histórico de pedidos íntegro) */
async function remove(req, res) {
  const { numAffected } = await db.products.updateAsync(
    { public_id: String(req.params.id) },
    { $set: { active: false } }
  );
  if (numAffected === 0) return res.status(404).json({ error: 'Produto não encontrado.' });
  auditLog('product_deactivated', { userId: req.user.id, details: { productId: req.params.id } });
  res.status(204).send();
}

module.exports = { list, getOne, listAdmin, create, update, remove, toPublicProduct };
