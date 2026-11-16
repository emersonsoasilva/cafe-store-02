const bcrypt = require('bcryptjs');
const { randomUUID: uuidv4 } = require('crypto');
const { db } = require('../config/db');
const { encryptField } = require('../utils/crypto');

/**
 * Cria um cliente. Usado pelo cadastro (authController) e pela automação,
 * para que os dois sigam exatamente as mesmas regras de armazenamento:
 * senha só como hash bcrypt, CPF criptografado (AES-256-GCM), papel sempre
 * "customer" (nunca vindo do cliente — evita escalada de privilégio).
 *
 * Lança erro com errorType "uniqueViolated" se o e-mail já existir.
 */
async function createCustomer({ name, email, password, cpf, phone, street, city, state, zip }) {
  const cpfDigits = String(cpf).replace(/\D/g, '');
  // Versão assíncrona do bcrypt: não trava o servidor enquanto calcula o hash.
  const passwordHash = await bcrypt.hash(String(password), 12);

  return db.users.insertAsync({
    public_id: uuidv4(),
    name: String(name).trim(),
    email: String(email).trim().toLowerCase(),
    password_hash: passwordHash,
    cpf_encrypted: encryptField(cpfDigits),
    cpf_last2: cpfDigits.slice(-2),
    phone: phone || null,
    address_street: street,
    address_city: city,
    address_state: state,
    address_zip: zip,
    role: 'customer',
    failed_login_attempts: 0,
    locked_until: null,
    created_at: new Date(),
  });
}

module.exports = { createCustomer };
