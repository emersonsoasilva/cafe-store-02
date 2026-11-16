const path = require('path');
const fs = require('fs');
const Datastore = require('@seald-io/nedb');
const bcrypt = require('bcryptjs');
const { randomUUID: uuidv4 } = require('crypto');
const env = require('./env');
const { encryptField } = require('../utils/crypto');

/*
 * Banco NoSQL orientado a documentos (NeDB — API compatível com um
 * subconjunto do MongoDB: find, findOne, insert, update com $set/$inc...).
 *
 * Por que NeDB:
 * - roda embutido no próprio processo Node, escrito 100% em JavaScript;
 * - não precisa instalar servidor de banco, Workbench, Docker nem ter
 *   privilégios de administrador na máquina;
 * - cada coleção é persistida em um arquivo dentro de DATA_DIR (padrão: ./data).
 *
 * Coleções (equivalentes às antigas tabelas):
 *   users, password_reset_tokens, products, orders (itens EMBUTIDOS no
 *   documento do pedido — modelagem típica de NoSQL), audit_log.
 */
fs.mkdirSync(env.dataDir, { recursive: true });

function collection(name) {
  return new Datastore({ filename: path.join(env.dataDir, `${name}.db`), timestampData: false });
}

const db = {
  users: collection('users'),
  passwordResetTokens: collection('password_reset_tokens'),
  products: collection('products'),
  orders: collection('orders'),
  auditLog: collection('audit_log'),
};

/*
 * "Transação" para um banco embutido sem suporte nativo a transações.
 *
 * O Node executa o JavaScript em uma única thread e o NeDB vive dentro do
 * mesmo processo, então o único jeito de duas requisições interferirem uma
 * na outra é intercalando os seus `await`. Este mutex garante que as seções
 * críticas (criar pedido/debitar estoque, cancelar pedido, redefinir senha)
 * rodem UMA DE CADA VEZ — o mesmo efeito do "SELECT ... FOR UPDATE" da
 * versão PostgreSQL: duas compras simultâneas nunca leem o mesmo estoque
 * "antigo" e nunca vendem mais unidades do que existem.
 *
 * Dentro da seção crítica, o chamador registra ações de desfazer (undo) para
 * cada escrita; se qualquer passo falhar, elas são executadas em ordem
 * inversa (rollback por compensação), evitando estados parcialmente aplicados.
 */
let lockChain = Promise.resolve();

function withTransaction(fn) {
  const run = lockChain.then(async () => {
    const undo = [];
    const tx = { onRollback: (action) => undo.push(action) };
    try {
      return await fn(tx);
    } catch (err) {
      for (const action of undo.reverse()) {
        try {
          await action();
        } catch (rollbackErr) {
          console.error('[rollback-error]', rollbackErr.message);
        }
      }
      throw err;
    }
  });
  // A fila continua mesmo que esta operação falhe.
  lockChain = run.catch(() => {});
  return run;
}

async function initSchema() {
  await Promise.all(Object.values(db).map((c) => c.loadDatabaseAsync()));

  // Índices únicos: o banco recusa e-mail/ids/tokens duplicados mesmo que a
  // validação da aplicação falhe (defesa em profundidade).
  await db.users.ensureIndexAsync({ fieldName: 'email', unique: true });
  await db.users.ensureIndexAsync({ fieldName: 'public_id', unique: true });
  await db.products.ensureIndexAsync({ fieldName: 'public_id', unique: true });
  await db.orders.ensureIndexAsync({ fieldName: 'public_id', unique: true });
  await db.orders.ensureIndexAsync({ fieldName: 'user_id' });
  await db.passwordResetTokens.ensureIndexAsync({ fieldName: 'token_hash', unique: true });
  await db.passwordResetTokens.ensureIndexAsync({ fieldName: 'user_id' });

  // O NeDB grava em modo append; compactar periodicamente mantém os arquivos pequenos.
  for (const c of Object.values(db)) c.setAutocompactionInterval(10 * 60 * 1000);
}

async function seedIfEmpty() {
  if ((await db.users.countAsync({})) > 0) return;

  // Dados 100% fictícios para fins de demonstração/teste.
  const fakeUsers = [
    {
      name: 'Admin da Loja',
      email: 'admin@cafestore.test',
      password: 'Admin@Cafe123!',
      cpf: '11144477735',
      phone: '(12) 90000-0001',
      address_street: 'Rua das Torrefações, 100',
      address_city: 'Caraguatatuba',
      address_state: 'SP',
      address_zip: '11660-000',
      role: 'admin',
    },
    {
      name: 'Maria Fictícia da Silva',
      email: 'maria.silva@exemplo.test',
      password: 'CafeComLeite@2024',
      cpf: '52998224725',
      phone: '(11) 98888-1234',
      address_street: 'Av. dos Grãos, 45, Apto 12',
      address_city: 'São Paulo',
      address_state: 'SP',
      address_zip: '01310-000',
      role: 'customer',
    },
    {
      name: 'João Fictício Pereira',
      email: 'joao.pereira@exemplo.test',
      password: 'ExpressoForte#7',
      cpf: '39053344705',
      phone: '(21) 97777-5678',
      address_street: 'Rua do Cerrado Mineiro, 789',
      address_city: 'Rio de Janeiro',
      address_state: 'RJ',
      address_zip: '20040-000',
      role: 'customer',
    },
  ];

  const now = new Date();
  for (const u of fakeUsers) {
    const cpfDigits = u.cpf.replace(/\D/g, '');
    await db.users.insertAsync({
      public_id: uuidv4(),
      name: u.name,
      email: u.email,
      password_hash: bcrypt.hashSync(u.password, 12),
      cpf_encrypted: encryptField(cpfDigits),
      cpf_last2: cpfDigits.slice(-2),
      phone: u.phone,
      address_street: u.address_street,
      address_city: u.address_city,
      address_state: u.address_state,
      address_zip: u.address_zip,
      role: u.role,
      failed_login_attempts: 0,
      locked_until: null,
      created_at: now,
    });
  }

  const products = [
    {
      name: 'Café Bourbon Amarelo',
      description: 'Grãos de Bourbon Amarelo, notas de caramelo e frutas amarelas.',
      origin: 'Sul de Minas, MG',
      roast_level: 'medio',
      weight_grams: 250,
      price_cents: 3490,
      stock: 40,
    },
    {
      name: 'Café Catuaí Vermelho',
      description: 'Doçura equilibrada com acidez cítrica suave.',
      origin: 'Cerrado Mineiro, MG',
      roast_level: 'claro',
      weight_grams: 250,
      price_cents: 3290,
      stock: 55,
    },
    {
      name: 'Café Mundo Novo Torra Escura',
      description: 'Corpo encorpado, ideal para espresso, notas de chocolate amargo.',
      origin: 'Mogiana Paulista, SP',
      roast_level: 'escuro',
      weight_grams: 500,
      price_cents: 5990,
      stock: 25,
    },
    {
      name: 'Café Geisha Especial',
      description: 'Edição limitada, notas florais e de jasmim, processo natural.',
      origin: 'Carmo de Minas, MG',
      roast_level: 'claro',
      weight_grams: 250,
      price_cents: 8990,
      stock: 12,
    },
    {
      name: 'Café Orgânico Descafeinado',
      description: 'Descafeinado por processo de água (Swiss Water), sabor suave.',
      origin: 'Vale do Paraíba, SP',
      roast_level: 'medio',
      weight_grams: 250,
      price_cents: 3790,
      stock: 30,
    },
  ];

  for (const p of products) {
    await db.products.insertAsync({ public_id: uuidv4(), ...p, active: true, created_at: now });
  }
  console.log('[seed] Banco populado com 3 usuários e 5 produtos fictícios.');
}

/*
 * Contas de administrador fixas, garantidas a CADA subida do servidor
 * (inclusive em bancos que já existiam antes desta conta ser adicionada).
 *
 * Só o HASH bcrypt da senha fica no código, nunca a senha em texto puro
 * (OWASP A02/A07): quem ler o repositório não descobre a senha.
 * Se a conta já existir, nada é alterado (não sobrescreve uma senha trocada
 * pelo próprio usuário via "esqueci minha senha").
 */
const FIXED_ADMINS = [
  {
    name: 'Nelson Alves',
    email: 'nelson.alves@ifsp.edu.br',
    password_hash: '$2b$12$Arf4wxPwkx/JCawWed4yO.CF1OQeH7RmEZ/Vo.fiT9PXbzqIsaTcS',
    cpf: '86288366757', // fictício (dígitos verificadores válidos)
    phone: null,
    address_street: 'Endereço não informado',
    address_city: 'Caraguatatuba',
    address_state: 'SP',
    address_zip: '11660-000',
  },
];

async function ensureFixedAdmins() {
  for (const admin of FIXED_ADMINS) {
    if (await db.users.findOneAsync({ email: admin.email })) continue;
    const { cpf, ...data } = admin;
    await db.users.insertAsync({
      public_id: uuidv4(),
      ...data,
      cpf_encrypted: encryptField(cpf),
      cpf_last2: cpf.slice(-2),
      role: 'admin',
      failed_login_attempts: 0,
      locked_until: null,
      created_at: new Date(),
    });
    console.log(`[seed] Conta de administrador criada: ${admin.email}`);
  }
}

/** Chamado uma vez na subida do servidor (ver server.js). */
async function initDatabase() {
  await initSchema();
  await seedIfEmpty();
  await ensureFixedAdmins();
}

module.exports = { db, withTransaction, initDatabase };
