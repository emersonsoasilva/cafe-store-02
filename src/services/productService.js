const { randomUUID: uuidv4 } = require('crypto');
const { db } = require('../config/db');

/** Cria um produto. Usado pelo painel admin e pelo simulador. */
async function createProduct(
  { name, description, origin, roastLevel, weightGrams, priceCents, stock },
  { simulated = false } = {}
) {
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
    simulated,
    created_at: new Date(),
  });
}

module.exports = { createProduct };
