const crypto = require('crypto');
const { db } = require('../config/db');
const env = require('../config/env');
const { auditLog } = require('../utils/logger');
const { createCustomer } = require('./userService');
const { createProduct } = require('./productService');
const { placeOrder, cancelOrder, setOrderStatus, NEXT_STATUS } = require('./orderService');

/*
 * AUTOMAÇÃO DE OPERAÇÕES DA LOJA (painel "Administração")
 *
 * Executa, em PRODUÇÃO, funcionalidades reais do sistema escolhidas por
 * sorteio. Não é uma simulação: cada ação chama os MESMOS serviços usados
 * pelas telas e pela API (cadastro, catálogo, compra, entrega, cancelamento)
 * e grava no banco de verdade. Os registros criados são iguais aos criados
 * manualmente: aparecem no catálogo, nos pedidos dos clientes, no painel e
 * no audit_log, com os mesmos nomes de evento (ex.: "order_created").
 *
 * Funciona em "fases". Cada fase dura AUTOMATION_PHASE_SECONDS (padrão 30 s)
 * e tem UMA funcionalidade sorteada, repetida a cada
 * AUTOMATION_ACTION_INTERVAL_SECONDS (padrão 3 s). Quando a fase acaba, uma
 * nova funcionalidade é sorteada, até um administrador desativar.
 *
 * Roda dentro do servidor (continua mesmo que o admin feche a página) e só
 * pode ser ligada/desligada pelas rotas /api/admin/automation/*, protegidas
 * por login + papel "admin" + CSRF.
 */

// weight = chance relativa de ser sorteada a cada fase.
const ACTIONS = {
  users: { label: 'Cadastrando clientes', weight: 2, run: registerCustomer },
  products: { label: 'Cadastrando produtos no catálogo', weight: 1, run: addProduct },
  restock: { label: 'Repondo estoque', weight: 1, run: restockProduct },
  orders: { label: 'Realizando compras', weight: 3, run: purchase },
  fulfillment: { label: 'Processando pagamentos e entregas', weight: 2, run: advanceOrder },
  cancellations: { label: 'Cancelando pedidos', weight: 1, run: cancelPendingOrder },
};
const MAX_EVENTS = 60;
const SOURCE = 'automacao_admin'; // vai no audit_log para saber a origem da ação

const emptyCounters = () => ({ ...Object.fromEntries(Object.keys(ACTIONS).map((k) => [k, 0])), failures: 0 });

const state = {
  running: false,
  startedBy: null, // { id (interno), publicId, name }
  startedAt: null,
  stoppedAt: null,
  config: { phaseSeconds: env.automationPhaseSeconds, intervalSeconds: env.automationIntervalSeconds },
  phase: null, // { action, label, number, startedAt, endsAt, done }
  counters: emptyCounters(),
  events: [],
  timer: null,
};

// ---------------- dados para os cadastros ----------------

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
const brl = (cents) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Embaralhamento Fisher-Yates com gerador criptográfico. */
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Sorteio ponderado pelo "weight" de cada funcionalidade. */
function pickAction() {
  const entries = Object.entries(ACTIONS);
  let roll = crypto.randomInt(entries.reduce((sum, [, a]) => sum + a.weight, 0));
  for (const [key, a] of entries) {
    if (roll < a.weight) return key;
    roll -= a.weight;
  }
  return entries[0][0];
}

/** CPF com dígitos verificadores válidos (passa na mesma validação do cadastro). */
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

/** Código de rastreio no formato dos Correios (AA123456789BR). */
function trackingCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return `${pick(letters)}${pick(letters)}${String(between(0, 999999999)).padStart(9, '0')}BR`;
}

/** Ação que não pôde rodar agora (ex.: sem estoque): é registrada como "pulada", não como erro. */
function skip(message) {
  const err = new Error(message);
  err.skip = true;
  return err;
}

const adminId = () => (state.startedBy ? state.startedBy.id : null);

// ---------------- funcionalidades reais ----------------

/** Cadastro de cliente (mesmo serviço do /register). */
async function registerCustomer() {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const [city, uf, zip] = pick(CITIES);
  const user = await createCustomer({
    name: `${first} ${last}`,
    // Domínio .test (reservado): o mesmo padrão das contas de exemplo do projeto.
    email: `${slug(first)}.${slug(last)}.${crypto.randomBytes(3).toString('hex')}@cliente.cafestore.test`,
    // Senha forte aleatória, guardada só como hash bcrypt. O cliente define a
    // dele pelo "esqueci minha senha", como qualquer conta criada pela loja.
    password: crypto.randomBytes(18).toString('base64url') + 'Aa1!',
    cpf: randomCpf(),
    phone: `(12) 9${between(1000, 9999)}-${between(1000, 9999)}`,
    street: `${pick(STREETS)}, ${between(1, 2000)}`,
    city,
    state: uf,
    zip,
  });
  auditLog('user_registered', { userId: user._id, details: { source: SOURCE } });
  return `Cliente cadastrado: ${user.name} (${user.email})`;
}

/** Cadastro de produto no catálogo (mesmo serviço do POST /api/admin/products). */
async function addProduct() {
  const product = await createProduct({
    name: `Café ${pick(VARIETIES)} ${pick(PROCESSES)}`,
    description: `Lote com notas de ${pick(NOTES)}.`,
    origin: pick(ORIGINS),
    roastLevel: pick(ROASTS),
    weightGrams: pick([250, 250, 500, 1000]),
    priceCents: between(25, 99) * 100 + 90,
    stock: between(10, 60),
  });
  auditLog('product_created', { userId: adminId(), details: { productId: product.public_id, source: SOURCE } });
  return `Produto cadastrado: ${product.name} (${product.stock} un. a ${brl(product.price_cents)})`;
}

/** Reposição de estoque do produto ativo com MENOS unidades. */
async function restockProduct() {
  const [product] = await db.products.findAsync({ active: true }).sort({ stock: 1 }).limit(1);
  if (!product) throw skip('Nenhum produto ativo para repor.');
  const added = between(10, 40);
  const { affectedDocuments } = await db.products.updateAsync(
    { _id: product._id, active: true },
    { $inc: { stock: added } },
    { returnUpdatedDocs: true }
  );
  if (!affectedDocuments) throw skip(`"${product.name}" foi desativado antes da reposição.`);
  auditLog('product_updated', {
    userId: adminId(),
    details: { productId: product.public_id, stockAdded: added, source: SOURCE },
  });
  return `Estoque reposto: ${product.name} +${added} un. (agora ${affectedDocuments.stock})`;
}

/** Compra de um cliente real (mesmo serviço do POST /api/orders: transação, estoque, preço do banco). */
async function purchase() {
  const customers = await db.users.findAsync({ role: 'customer' });
  if (customers.length === 0) throw skip('Nenhum cliente cadastrado para comprar.');
  const inStock = await db.products.findAsync({ active: true, stock: { $gt: 0 } });
  if (inStock.length === 0) throw skip('Nenhum produto com estoque disponível.');

  const customer = pick(customers);
  // 1 ou 2 produtos diferentes, 1 a 3 unidades de cada (sem passar do estoque).
  const chosen = shuffle(inStock).slice(0, between(1, Math.min(2, inStock.length)));
  const items = chosen.map((p) => ({ productId: p.public_id, quantity: Math.min(p.stock, between(1, 3)) }));

  const order = await placeOrder({
    userId: customer._id,
    items,
    shipping: {
      street: customer.address_street,
      city: customer.address_city,
      state: customer.address_state,
      zip: customer.address_zip,
    },
  });
  auditLog('order_created', {
    userId: customer._id,
    details: { orderId: order.public_id, totalCents: order.total_cents, source: SOURCE },
  });
  const summary = order.items.map((i) => `${i.quantity}× ${i.product_name}`).join(', ');
  return `Compra de ${customer.name}: ${summary} — ${brl(order.total_cents)}`;
}

/** Avança o pedido em aberto mais antigo para o próximo status (pago → separação → enviado → entregue). */
async function advanceOrder() {
  const [order] = await db.orders
    .findAsync({ status: { $in: Object.keys(NEXT_STATUS) } })
    .sort({ updated_at: 1 })
    .limit(1);
  if (!order) throw skip('Nenhum pedido em aberto para processar.');

  const next = NEXT_STATUS[order.status];
  const code = next === 'enviado' ? trackingCode() : undefined;
  await setOrderStatus(order.public_id, next, code);
  auditLog('order_status_updated', {
    userId: adminId(),
    details: { orderId: order.public_id, newStatus: next, source: SOURCE },
  });
  return `Pedido ${order.public_id.slice(0, 8)}: ${order.status} → ${next}${code ? ` (rastreio ${code})` : ''}`;
}

/** Cancela um pedido ainda pendente (desistência do cliente) e devolve os itens ao estoque. */
async function cancelPendingOrder() {
  const pending = await db.orders.findAsync({ status: 'pendente' });
  if (pending.length === 0) throw skip('Nenhum pedido pendente para cancelar.');
  const order = await cancelOrder(pick(pending).public_id);
  auditLog('order_cancelled', { userId: order.user_id, details: { orderId: order.public_id, source: SOURCE } });
  const items = order.items.map((i) => `${i.quantity}× ${i.product_name}`).join(', ');
  return `Pedido ${order.public_id.slice(0, 8)} cancelado — devolvido ao estoque: ${items}`;
}

// ---------------- ciclo ----------------

function pushEvent(type, text) {
  state.events.unshift({ at: new Date(), type, text });
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
}

function startPhase() {
  const action = pickAction();
  const now = Date.now();
  state.phase = {
    action,
    label: ACTIONS[action].label,
    number: (state.phase ? state.phase.number : 0) + 1,
    startedAt: new Date(now),
    endsAt: new Date(now + state.config.phaseSeconds * 1000),
    done: 0,
  };
  pushEvent('phase', `Fase ${state.phase.number}: ${state.phase.label} por ${state.config.phaseSeconds} s`);
}

async function tick() {
  if (!state.running) return;
  if (!state.phase || Date.now() >= state.phase.endsAt.getTime()) startPhase();

  const { action } = state.phase;
  try {
    const text = await ACTIONS[action].run();
    state.phase.done += 1;
    state.counters[action] += 1;
    pushEvent(action, text);
  } catch (err) {
    state.counters.failures += 1;
    pushEvent('failure', err.skip ? `Pulado: ${err.message}` : `Falhou: ${err.message}`);
    if (!err.skip && !err.status) console.error('[automacao]', err);
  }

  // Agenda a próxima só depois que esta terminou (nunca duas ao mesmo tempo).
  if (state.running) state.timer = setTimeout(tick, state.config.intervalSeconds * 1000);
}

// ---------------- controle (chamado pelas rotas de admin) ----------------

function start(admin, { phaseSeconds, intervalSeconds } = {}) {
  if (state.running) return { alreadyRunning: true };
  state.config = {
    phaseSeconds: phaseSeconds || env.automationPhaseSeconds,
    intervalSeconds: intervalSeconds || env.automationIntervalSeconds,
  };
  state.running = true;
  state.startedBy = { id: admin.id, publicId: admin.public_id, name: admin.name };
  state.startedAt = new Date();
  state.stoppedAt = null;
  state.phase = null;
  state.counters = emptyCounters();
  pushEvent('control', `Automação ativada por ${admin.name}`);
  auditLog('automation_started', { userId: admin.id, details: state.config });
  tick();
  return { alreadyRunning: false };
}

function stop(admin) {
  if (!state.running) return { alreadyStopped: true };
  state.running = false;
  clearTimeout(state.timer);
  state.timer = null;
  state.stoppedAt = new Date();
  pushEvent('control', `Automação desativada por ${admin.name}`);
  auditLog('automation_stopped', { userId: admin.id, details: { ...state.counters } });
  return { alreadyStopped: false };
}

async function status() {
  const [customers, products, openOrders, orders] = await Promise.all([
    db.users.countAsync({ role: 'customer' }),
    db.products.countAsync({ active: true }),
    db.orders.countAsync({ status: { $in: Object.keys(NEXT_STATUS) } }),
    db.orders.countAsync({}),
  ]);
  return {
    running: state.running,
    startedBy: state.startedBy ? { name: state.startedBy.name } : null,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    config: state.config,
    defaults: { phaseSeconds: env.automationPhaseSeconds, intervalSeconds: env.automationIntervalSeconds },
    phase: state.running ? state.phase : null,
    serverTime: new Date(),
    session: state.counters,
    totals: { customers, products, openOrders, orders },
    events: state.events,
  };
}

module.exports = { start, stop, status };
