const { randomUUID: uuidv4 } = require('crypto');
const { db } = require('../config/db');

/** Cria um produto. Usado pela API admin e pela automação do painel admin. */
async function createProduct({ name, description, origin, roastLevel, weightGrams, priceCents, stock }) {
  return db.products.insertAsync({
    public_id: uuidv4(),
    name,
    description: description || null,
    origin: origin || null,
    roast_level: roastLevel,
    weight_grams: weightGrams,
    price_cents: priceCents,
    stock,
    active: true,
    created_at: new Date(),
  });
}

module.exports = { createProduct };
