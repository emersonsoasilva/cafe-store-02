const crypto = require('crypto');
const { db } = require('../config/db');
const env = require('../config/env');
const { auditLog } = require('../utils/logger');
const { createCustomer } = require('./userService');
const { createProduct } = require('./productService');
const { placeOrder } = require('./orderService');

/*
 * SIMULADOR DE ATIVIDADE DA LOJA
 *
 * Funciona em "fases". Cada fase dura SIMULATOR_PHASE_SECONDS (padrão 30 s)
 * e tem UMA atividade sorteada: criar usuários, criar produtos ou realizar
 * compras. Durante a fase, a atividade é repetida sem parar, uma a cada
 * SIMULATOR_ACTION_INTERVAL_SECONDS (padrão 3 s): cria um usuário, depois
 * outro, e assim por diante. Quando a fase acaba, uma nova atividade é
 * sorteada e o ciclo continua até um administrador desativar.
 *
 * Roda dentro do servidor (não no navegador): continua funcionando mesmo
 * que o admin feche a página, e só pode ser ligado/desligado pelas rotas
 * /api/admin/simulator/*, protegidas por login + papel "admin" + CSRF.
 *
 * Tudo que ele cria recebe "simulated: true", para ser diferenciado dos
 * dados reais (o painel mostra a etiqueta "simulado").
 */

const ACTIONS = {
  users: { label: 'Criando usuários', run: simulateUser },
  products: { label: 'Adicionando produtos ao estoque', run: simulateProduct },
  orders: { label: 'Realizando compras', run: simulateOrder },
};
const MAX_EVENTS = 60;

const state = {
  running: false,
  startedBy: null,
  startedAt: null,
  stoppedAt: null,
  config: { phaseSeconds: env.simulatorPhaseSeconds, intervalSeconds: env.simulatorIntervalSeconds },
  phase: null, // { action, number, startedAt, endsAt, done }
  counters: { users: 0, products: 0, orders: 0, failures: 0 },
  events: [],
  timer: null,
};

// ---------------- dados fictícios ----------------

const FIRST_NAMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Larissa', 'Marcos', 'Natália', 'Otávio', 'Paula', 'Rafael', 'Sofia', 'Thiago', 'Vitória', 'Yuri'];
const LAST_NAMES = ['Almeida', 'Barbosa', 'Cardoso', 'Dias', 'Ferreira', 'Gomes', 'Lima', 'Martins', 'Nascimento', 'Oliveira', 'Pereira', 'Ribeiro', 'Santos', 'Souza', 'Teixeira'];
const CITIES = [
  ['Caraguatatuba', 'SP', '11660-000'], ['São José dos Campos', 'SP', '12210-000'], ['Ubatuba', 'SP', '11680-000'],
  ['Taubaté', 'SP', '12010-000'], ['Rio de Janeiro', 'RJ', '20040-000'], ['Belo Horizonte', 'MG', '30110-000'],
  ['Curitiba', 'PR', '80010-000'], ['Campinas', 'SP', '13010-000'],
];
const STREETS = ['Rua das Flores', 'Av. Brasil', 'Rua do Café', 'Rua XV de Novembro', 'Av. da Praia', 'Rua dos Ipês'];
const VARIETIES = ['Bourbon', 'Catuaí', 'Mundo Novo', 'Acaiá', 'Topázio', 'Arara', 'Obatã', 'Catucaí', 'Icatu'];
const PROCESSES = ['Natural', 'Cereja Descascado', 'Fermentado', 'Lavado', 'Honey'];
const ORIGINS = ['Sul de Minas, MG', 'Cerrado Mineiro, MG', 'Mogiana Paulista, SP', 'Chapada Diamantina, BA', 'Matas de Minas, MG', 'Norte Pioneiro, PR', 'Montanhas do ES'];
const NOTES = ['chocolate e caramelo', 'frutas vermelhas', 'castanhas e mel', 'notas cítricas', 'rapadura e baunilha', 'floral e delicado'];
const ROASTS = ['claro', 'medio', 'escuro'];

const pick = (list) => list[crypto.randomInt(list.length)];
const between = (min, max) => crypto.randomInt(min, max + 1);
/** Embaralhamento Fisher-Yates com gerador criptográfico. */
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** CPF fictício, porém com dígitos verificadores válidos (passa na mesma validação do cadastro). */
function randomCpf() {
  const base = Array.from({ length: 9 }, () => crypto.randomInt(10));
  const digit = (nums) => {
    const sum = nums.reduce((acc, n, i) => acc + n * (nums.length + 1 - i), 0);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  const d1 = digit(base);
  const d2 = digit([...base, d1]);
  return [...base, d1, d2].join('');
}

// ---------------- atividades ----------------

async function simulateUser() {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const [city, uf, zip] = pick(CITIES);
  const user = await createCustomer(
    {
      name: `${first} ${last}`,
      // Domínio .test: reservado, nunca é um e-mail real.
      email: `${slug(first)}.${slug(last)}.${crypto.randomBytes(3).toString('hex')}@simulado.test`,
      // Senha aleatória forte que ninguém conhece: conta simulada não serve para login.
      password: crypto.randomBytes(18).toString('base64url') + 'Aa1!',
      cpf: randomCpf(),
      phone: `(12) 9${between(1000, 9999)}-${between(1000, 9999)}`,
      street: `${pick(STREETS)}, ${between(1, 2000)}`,
      city,
      state: uf,
      zip,
    },
    { simulated: true }
  );
  state.counters.users += 1;
  return { text: `Usuário criado: ${user.name} (${user.email})`, refId: user.public_id };
}

async function simulateProduct() {
  const variety = pick(VARIETIES);
  const process = pick(PROCESSES);
  const product = await createProduct(
    {
      name: `Café ${variety} ${process}`,
      description: `Lote simulado com ${pick(NOTES)}.`,
      origin: pick(ORIGINS),
      roastLevel: pick(ROASTS),
      weightGrams: pick([250, 250, 500, 1000]),
      priceCents: between(25, 99) * 100 + 90,
      stock: between(10, 60),
    },
    { simulated: true }
  );
  state.counters.products += 1;
  return {
    text: `Produto adicionado: ${product.name} (${product.stock} un. a ${(product.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })})`,
    refId: product.public_id,
  };
}

async function simulateOrder() {
  const customers = await db.users.findAsync({ role: 'customer' });
  if (customers.length === 0) {
    const err = new Error('Nenhum cliente cadastrado para comprar.');
    err.skip = true;
    throw err;
  }
  const inStock = await db.products.findAsync({ active: true, stock: { $gt: 0 } });
  if (inStock.length === 0) {
    const err = new Error('Nenhum produto com estoque disponível.');
    err.skip = true;
    throw err;
  }

  const customer = pick(customers);
  // 1 ou 2 produtos diferentes, 1 a 3 unidades de cada (sem passar do estoque).
  const chosen = shuffle(inStock).slice(0, between(1, Math.min(2, inStock.length)));
  const items = chosen.map((p) => ({ productId: p.public_id, quantity: Math.min(p.stock, between(1, 3)) }));

  // Passa pelo MESMO serviço da compra real: transação, checagem de estoque, preço do banco.
  const order = await placeOrder(
    {
      userId: customer._id,
      items,
      shipping: {
        street: customer.address_street,
        city: customer.address_city,
        state: customer.address_state,
        zip: customer.address_zip,
      },
    },
    { simulated: true }
  );
  state.counters.orders += 1;
  const summary = order.items.map((i) => `${i.quantity}× ${i.product_name}`).join(', ');
  return {
    text: `Compra de ${customer.name}: ${summary} — ${(order.total_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
    refId: order.public_id,
  };
}

// ---------------- ciclo ----------------

function pushEvent(type, text, extra = {}) {
  state.events.unshift({ at: new Date(), type, text, ...extra });
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
}

function startPhase() {
  const action = pick(Object.keys(ACTIONS)); // sorteio a cada fase
  const now = Date.now();
  state.phase = {
    action,
    label: ACTIONS[action].label,
    number: (state.phase ? state.phase.number : 0) + 1,
    startedAt: new Date(now),
    endsAt: new Date(now + state.config.phaseSeconds * 1000),
    done: 0,
  };
  pushEvent('phase', `Fase ${state.phase.number}: ${state.phase.label} por ${state.config.phaseSeconds} s`, { action });
}

async function tick() {
  if (!state.running) return;
  if (!state.phase || Date.now() >= state.phase.endsAt.getTime()) startPhase();

  const { action } = state.phase;
  try {
    const result = await ACTIONS[action].run();
    state.phase.done += 1;
    pushEvent(action, result.text);
    auditLog(`simulator_${action}_created`, { details: { refId: result.refId, simulated: true } });
  } catch (err) {
    state.counters.failures += 1;
    pushEvent('failure', err.skip ? `Pulado: ${err.message}` : `Falhou: ${err.message}`, { action });
    if (!err.skip && !err.status) console.error('[simulator]', err);
  }

  // Agenda a próxima só depois que esta terminou (nunca duas ao mesmo tempo).
  if (state.running) state.timer = setTimeout(tick, state.config.intervalSeconds * 1000);
}

// ---------------- controle (chamado pelas rotas de admin) ----------------

function start(admin, { phaseSeconds, intervalSeconds } = {}) {
  if (state.running) return { alreadyRunning: true };
  state.config = {
    phaseSeconds: phaseSeconds || env.simulatorPhaseSeconds,
    intervalSeconds: intervalSeconds || env.simulatorIntervalSeconds,
  };
  state.running = true;
  state.startedBy = { id: admin.public_id, name: admin.name };
  state.startedAt = new Date();
  state.stoppedAt = null;
  state.phase = null;
  state.counters = { users: 0, products: 0, orders: 0, failures: 0 };
  pushEvent('control', `Simulador ativado por ${admin.name}`);
  auditLog('simulator_started', { userId: admin.id, details: state.config });
  tick();
  return { alreadyRunning: false };
}

function stop(admin, reason) {
  if (!state.running) return { alreadyStopped: true };
  state.running = false;
  clearTimeout(state.timer);
  state.timer = null;
  state.stoppedAt = new Date();
  pushEvent('control', reason || `Simulador desativado por ${admin.name}`);
  if (admin) auditLog('simulator_stopped', { userId: admin.id, details: { ...state.counters } });
  return { alreadyStopped: false };
}

async function status() {
  const [customers, simulatedCustomers, products, simulatedProducts, orders, simulatedOrders] = await Promise.all([
    db.users.countAsync({ role: 'customer' }),
    db.users.countAsync({ role: 'customer', simulated: true }),
    db.products.countAsync({ active: true }),
    db.products.countAsync({ active: true, simulated: true }),
    db.orders.countAsync({}),
    db.orders.countAsync({ simulated: true }),
  ]);
  return {
    running: state.running,
    startedBy: state.startedBy,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    config: state.config,
    defaults: { phaseSeconds: env.simulatorPhaseSeconds, intervalSeconds: env.simulatorIntervalSeconds },
    phase: state.running ? state.phase : null,
    serverTime: new Date(),
    session: state.counters,
    totals: {
      customers: { all: customers, simulated: simulatedCustomers },
      products: { all: products, simulated: simulatedProducts },
      orders: { all: orders, simulated: simulatedOrders },
    },
    events: state.events,
  };
}

module.exports = { start, stop, status };
