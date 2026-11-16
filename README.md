# ☕ Café Store — Loja de grãos de café (projeto de demonstração)

Sistema completo (back-end + front-end estático) simulando uma loja de grãos
de café: cadastro/login com recuperação de senha, catálogo, compras com
controle de estoque, e acompanhamento de vendas/entregas. Construído como
material de estudo/demonstração de **boas práticas de segurança (OWASP)** em
uma aplicação Node.js + Express + **banco NoSQL embutido (NeDB)**.
Roda sem MySQL/PostgreSQL, sem Workbench, sem Docker e **sem privilégios de
administrador** — e pode ser acessado de outra máquina pelo IP.

> ⚠️ **Todos os dados (usuários, CPFs, senhas, endereços) são 100% fictícios**,
> gerados apenas para popular o banco de exemplo. Não é um sistema para uso em
> produção sem revisão adicional (ver seção "Limitações" no final).

---

## Como rodar

Pré-requisito: **Node.js 18+**. Não precisa instalar banco de dados.

**Máquina sem permissão de administrador (faculdade):** baixe em
<https://nodejs.org/en/download> a versão **"Windows Binary (.zip)"** (não o
instalador .msi), extraia e renomeie a pasta para `node`, deixando-a dentro do
projeto (fica `cafe-store/node/node.exe`). O `iniciar.bat` usa esse Node
automaticamente.

### Jeito rápido (Windows)
Dê dois cliques em **`iniciar.bat`**. Ele instala as dependências (se faltar),
faz o build e sobe o servidor.

### Pelo terminal
```bash
npm install        # só na primeira vez (a pasta node_modules já vem no zip)
npm run build      # gera o .env com segredos aleatórios + valida + gera dist/
npm start          # sobe o servidor a partir de dist/
```

O terminal mostra os endereços:
```
☕ Cafe Store rodando (banco NoSQL em ...\cafe-store\data)
   Nesta máquina:        http://localhost
   Na rede (professor):  http://10.81.211.26
```
O professor digita **só o IP** no navegador dele (ex.: `10.81.211.26`), na
mesma rede. Isso funciona porque o servidor usa a **porta 80**, a porta padrão
do navegador; no Windows, usar a porta 80 não exige administrador.

Se a porta 80 estiver ocupada (por exemplo, por IIS, Skype ou outro servidor),
o sistema avisa e usa a **3000**. Aí o endereço precisa da porta no final,
ex.: `http://10.81.211.26:3000`, e o terminal mostra isso. Para fixar uma
porta, preencha `PORT=` no `.env`.

Na primeira execução o banco é criado na pasta `data/` e populado com dados
fictícios (3 usuários e 5 produtos).

### Se o professor não conseguir abrir
- **Confira o IP no dia:** o IP da máquina pode mudar ao reconectar na rede.
  Use o que o terminal mostrar em "Na rede (professor)" ou rode `ipconfig` e
  veja o "Endereço IPv4".
- **O terminal disse porta 3000:** o professor precisa digitar `IP:3000`.
- **Página nem carrega:** o Firewall do Windows está bloqueando. Na janela
  "Permitir acesso" que aparece ao rodar, marque *Redes privadas*. Se a
  máquina não deixar (exige admin), peça ao técnico do laboratório para
  liberar o Node.js (ou a porta 80) no firewall.
- **Mesma rede:** o computador do professor precisa estar na mesma rede
  (ex.: os dois com IP `10.81.x.x`).
- **Página carrega sem estilo:** já corrigido nesta versão (veja abaixo).

### Por que antes a página aparecia sem estilo pelo IP
O `helmet` envia por padrão a diretiva de CSP `upgrade-insecure-requests`,
que manda o navegador buscar CSS/JS por **https**. Em `localhost` o navegador
abre exceção (por isso funcionava na sua máquina), mas em
`http://10.81.211.26` ele tenta `https://10.81.211.26/css/style.css`,
que não existe — o HTML aparece cru. Agora essa diretiva (e o HSTS) só é
ativada quando `HTTPS_ENABLED=true`. Também saíram do código dois pontos
presos a `localhost`: o `CORS_ORIGIN` fixo e o link de reset de senha.

### Contas fictícias para teste

| Papel     | E-mail                        | Senha              |
|-----------|--------------------------------|---------------------|
| Admin     | admin@cafestore.test           | Admin@Cafe123!      |
| Cliente   | maria.silva@exemplo.test       | CafeComLeite@2024   |
| Cliente   | joao.pereira@exemplo.test      | ExpressoForte#7     |

**Conta de administrador fixa:** `nelson.alves@ifsp.edu.br` (papel admin;
senha informada à parte, não fica escrita no projeto). Ela é criada
automaticamente sempre que o servidor sobe e não existe no banco, inclusive
em bancos antigos. No código (`src/config/db.js`, `FIXED_ADMINS`) fica só o
**hash bcrypt** da senha. Se a conta já existir, nada é alterado, então uma
senha trocada pelo "esqueci minha senha" é mantida.

O fluxo de **recuperação de senha** não envia e-mail real: o link de reset é
impresso no console/terminal onde o `npm start` está rodando (veja
`src/utils/mailer.js`).

---

## Funcionalidades

- **Catálogo** de grãos de café (nome, origem, torra, peso, preço, estoque).
- **Cadastro e login** de clientes, com senha com política mínima de força.
- **Recuperação de senha** por token de uso único e com expiração (15 min).
- **Compra** com carrinho, checkout com endereço de entrega, débito de
  estoque em transação atômica.
- **Cancelamento** de pedido pelo cliente (enquanto ainda não foi enviado),
  com devolução automática ao estoque.
- **Painel administrativo**: automação de operações (abaixo), desativação de
  produtos e avanço do status do pedido
  (`pendente → pago → em_separação → enviado → entregue`), incluindo código
  de rastreio.
- **Auditoria**: eventos sensíveis (login, falhas de login, reset de senha,
  mudança de status de pedido) ficam registrados na coleção `audit_log`.

---

## Automação de operações (só administrador)

Fica no topo da tela **Administração** (`http://IP/admin.html`), no lugar
onde antes ficava o formulário "Novo produto". Ela executa **em produção**
funcionalidades reais da loja, escolhidas por sorteio. Não é simulação: cada
ação chama os mesmos serviços usados pelas telas e pela API e grava no banco
de verdade. O que ela cria aparece no catálogo, nos pedidos dos clientes, no
painel e no `audit_log` exatamente como um registro feito à mão.

**Funcionalidades sorteadas** (entre parênteses, o peso no sorteio)
| Funcionalidade | O que faz | Serviço usado |
|---|---|---|
| Cadastrar clientes (2) | cria uma conta de cliente | `userService.createCustomer` (mesmo do `/register`) |
| Cadastrar produtos (1) | adiciona um café ao catálogo | `productService.createProduct` (mesmo do `POST /api/admin/products`) |
| Repor estoque (1) | soma 10 a 40 unidades ao produto ativo com menos estoque | update `$inc` no produto |
| Realizar compras (3) | um cliente cadastrado compra 1 ou 2 produtos | `orderService.placeOrder` (mesmo do `POST /api/orders`) |
| Processar entregas (2) | avança o pedido em aberto mais antigo para o próximo status; ao ir para "enviado" gera um código de rastreio | `orderService.setOrderStatus` (mesmo do `PATCH /api/admin/orders/:id/status`) |
| Cancelar pedidos (1) | cancela um pedido pendente e devolve os itens ao estoque | `orderService.cancelOrder` (mesmo do `POST /api/orders/:id/cancel`) |

**Como funciona**
- O tempo é dividido em **fases** (padrão: **30 segundos**). No começo de cada
  fase uma funcionalidade é sorteada e repetida a cada **3 segundos** (padrão)
  até a fase acabar. Depois sorteia de novo, até alguém clicar em
  **Desativar automação**.
- Ao ativar, a tela pede confirmação, porque as ações mudam dados reais.
- Roda **no servidor**: continua se o admin fechar a página e para quando o
  servidor é desligado.
- Se não houver o que fazer (sem estoque, sem pedido em aberto...), a ação é
  **pulada** e isso aparece na tela; não é tratado como erro.
- As listas de produtos e pedidos da própria tela se atualizam sozinhas
  quando a automação grava algo.

**Como alterar o tempo**

*Na tela:* com a automação desativada, mude **"Duração de cada fase (s)"** e
**"Uma ação a cada (s)"** e clique em Ativar. Vale só para aquela execução.

*Padrão permanente no `.env`:*
```
AUTOMATION_PHASE_SECONDS=30             # duração de cada fase (5 a 3600)
AUTOMATION_ACTION_INTERVAL_SECONDS=3    # uma ação a cada N segundos (1 a 60)
```
Os nomes antigos `SIMULATOR_PHASE_SECONDS` e
`SIMULATOR_ACTION_INTERVAL_SECONDS` continuam aceitos. Depois de salvar,
reinicie o servidor.

**Regras e segurança**
- Ativar, desativar e ver o status exige **login de admin** (as rotas
  `/api/admin/automation/*` respondem 401 sem login e 403 para cliente) e
  **token CSRF**.
- As compras passam pela checagem de estoque, preço lido do banco, seção
  crítica e rollback de qualquer compra; nunca vendem além do estoque.
- Os clientes cadastrados seguem as regras do cadastro: senha só como hash
  bcrypt, CPF válido e criptografado. O e-mail usa o domínio reservado
  `@cliente.cafestore.test` (o mesmo padrão das contas de exemplo) e a senha
  inicial é aleatória e não é mostrada a ninguém; o acesso é definido pelo
  "esqueci minha senha".
- Cada ação gera no `audit_log` o mesmo evento da ação manual
  (`user_registered`, `product_created`, `product_updated`, `order_created`,
  `order_status_updated`, `order_cancelled`), com `source: "automacao_admin"`
  nos detalhes. Ligar e desligar gera `automation_started` /
  `automation_stopped`.
- O cadastro manual de produto saiu da tela, mas a rota
  `POST /api/admin/products` continua disponível.

---

## Estrutura do projeto

```
cafe-store/
├── server.js                  # bootstrap do Express + middlewares de segurança
├── scripts/build.js           # build: gera .env seguro, checa sintaxe, gera dist/
├── iniciar.bat / iniciar.sh   # instala (se preciso), faz build e sobe
├── data/                      # arquivos do banco NoSQL (criado na 1ª execução)
├── src/
│   ├── config/
│   │   ├── env.js              # carregamento e validação de variáveis de ambiente
│   │   └── db.js               # coleções NeDB, índices únicos, seed, "transação"
│   ├── utils/
│   │   ├── crypto.js           # criptografia AES-256-GCM, hashing de tokens
│   │   ├── logger.js           # auditoria com redação de campos sensíveis
│   │   ├── mailer.js           # "envio" simulado de e-mail de reset
│   │   ├── network.js          # descobre o IP da máquina na rede
│   │   └── asyncHandler.js     # encaminha erros de rotas assíncronas ao error handler
│   ├── middleware/             # auth (JWT, RBAC, CSRF), rate limit, validação, erros
│   ├── services/               # regras compartilhadas (usuário, produto, pedido) + automação
│   ├── controllers/            # regra de negócio (auth, produtos, pedidos)
│   └── routes/                 # definição das rotas + validação de entrada
└── public/                     # front-end estático (HTML/CSS/JS puro)
```

---

## Banco de dados: NoSQL embutido (NeDB)

O projeto usa [`@seald-io/nedb`](https://github.com/seald/nedb), um banco
**NoSQL orientado a documentos** com API no estilo do MongoDB (`find`,
`findOne`, `insert`, `update` com `$set`/`$inc`, índices). Ele roda dentro do
próprio processo Node, escrito 100% em JavaScript, e grava cada coleção em um
arquivo na pasta `data/`. Por isso não precisa de servidor de banco, Workbench
ou administrador.

| Coleção | Conteúdo |
|---|---|
| `users` | usuários (hash bcrypt, CPF criptografado, bloqueio de login) |
| `password_reset_tokens` | apenas o hash SHA-256 de cada token de reset |
| `products` | catálogo, preço em centavos, estoque, `active` (soft delete) |
| `orders` | pedidos com os **itens embutidos** no próprio documento |
| `audit_log` | trilha de eventos de segurança |

Pontos de atenção da migração SQL → NoSQL:

- **Itens embutidos no pedido**: em vez da tabela `order_items` + JOIN, cada
  pedido guarda seus itens (nome e preço copiados no momento da compra).
  Editar um produto depois não altera pedidos antigos, e um pedido é lido
  com uma consulta só.
- **Transações**: o NeDB não tem `BEGIN/COMMIT`. O helper `withTransaction`
  serializa as seções críticas com um mutex (o Node roda o JS numa única
  thread e o banco está no mesmo processo, então isso impede que duas
  requisições se intercalem) e faz **rollback por compensação**: cada escrita
  registra como se desfazer, e tudo é desfeito se um passo falhar.
- **Venda além do estoque**: além do mutex, o débito usa um update
  condicional `{ stock: { $gte: quantidade } }` com `$inc`, uma segunda
  barreira contra estoque negativo. Testado com 10 compras simultâneas:
  nenhuma unidade vendida a mais.
- **Índices únicos** em `email`, `public_id` e `token_hash`: o próprio banco
  recusa duplicatas, mesmo em dois cadastros simultâneos.
- **Injeção NoSQL** (ex.: enviar `{"$ne": null}` no lugar do e-mail): todo
  valor vindo do cliente passa pelo `express-validator` e é convertido com
  `String(...)` antes de entrar numa consulta, então nunca vira operador.

## Modelagem de dados (dados fictícios sensíveis)

Coleção `users`: nome, e-mail, **hash bcrypt da senha** (nunca a senha em
texto puro), **CPF criptografado em repouso (AES-256-GCM)** com apenas os 2
últimos dígitos guardados separadamente para exibição mascarada
(`***.***.***-25`), telefone e endereço.

Coleção `password_reset_tokens`: guarda somente o **hash SHA-256** do token de
reset, nunca o token em texto puro — mesmo um vazamento do banco não permite
reutilizar um link de recuperação.

Coleções `products` e `orders`: catálogo e pedidos (com os itens embutidos), com histórico de status de entrega e valores em centavos (evita
problemas de arredondamento de ponto flutuante).

Coleção `audit_log`: trilha de eventos de segurança, com qualquer campo
sensível (senha, token, cpf) automaticamente removido antes de gravar.

---

## Segurança aplicada (mapeamento com OWASP Top 10 2021)

| Categoria OWASP | O que foi aplicado |
|---|---|
| **A01 – Broken Access Control** | RBAC (`requireRole('admin')`), checagem de posse (*ownership*) em pedidos (cliente só vê/cancela os próprios; admin vê todos), uso de `public_id` (UUID) em vez do ID incremental do banco para evitar enumeração de recursos (IDOR). |
| **A02 – Cryptographic Failures** | Senhas com **bcrypt (custo 12)**; CPF criptografado em repouso com **AES-256-GCM**; tokens de reset armazenados apenas como **hash SHA-256**; cookies de sessão `httpOnly` + `Secure` (em produção) + `SameSite=Lax`. |
| **A03 – Injection** | Consultas NoSQL montadas como objetos (sem concatenação de strings), com todo valor do cliente convertido com `String(...)` para bloquear **injeção de operadores** (`$ne`, `$gt`...); toda entrada do usuário passa por `express-validator` (tipos, tamanhos, formatos, `escape()` contra XSS). |
| **A04 – Insecure Design** | Fluxo de reset de senha com token de uso único e expiração curta; **bloqueio de conta** após 5 tentativas de login incorretas (15 min); mensagens de erro genéricas em login/reset para não revelar quais e-mails existem (anti-enumeração de usuários); seção crítica serializada + update condicional (`$gte`) para evitar venda além do estoque sob concorrência. |
| **A05 – Security Misconfiguration** | `helmet` com CSP restritiva (com `upgrade-insecure-requests` e HSTS só sob HTTPS), `X-Powered-By` removido, variáveis de ambiente validadas na subida (falha rápido se segredo fraco/ausente), handler de erro que nunca expõe stack trace ao cliente. |
| **A06 – Vulnerable and Outdated Components** | Dependências atuais no momento da criação; recomenda-se rodar `npm audit` periodicamente. |
| **A07 – Identification and Authentication Failures** | JWT de curta duração (30 min), rate limiting dedicado em `/login`, `/register` e `/forgot-password`, política de senha (mínimo 10 caracteres, maiúscula/minúscula/número), comparação de senha em tempo constante via bcrypt, mitigação de *timing attack* na checagem de e-mail inexistente. |
| **A08 – Software and Data Integrity Failures** | Validação estrita de payloads (`express-validator`), seções críticas com rollback por compensação (`withTransaction`) para evitar estados inconsistentes de estoque/pedido. |
| **A09 – Security Logging and Monitoring Failures** | Coleção `audit_log` para eventos de autenticação e de pedidos, com redação automática de dados sensíveis antes de logar. |
| **A10 – Server-Side Request Forgery (SSRF)** | Não há chamadas a URLs fornecidas pelo usuário nesta aplicação; ponto documentado caso o sistema evolua para buscar imagens/links externos. |

### Outras proteções implementadas

- **CSRF**: padrão *double-submit cookie* — o cliente precisa reenviar, num
  header (`X-CSRF-Token`), o mesmo valor recebido em um cookie legível por
  JS; requisições que alteram estado (`POST`/`PUT`/`PATCH`/`DELETE`) exigem
  esse header (middleware `requireCsrf`).
- **CORS** fechado por padrão: o front é servido pelo próprio servidor (mesma
  origem); só se libera uma origem externa se `CORS_ORIGIN` for definido.
- **`trust proxy` desligado por padrão**: sem proxy reverso, confiar em
  `X-Forwarded-For` deixaria o cliente forjar o IP e burlar o rate limiting.
- Limite de tamanho do corpo da requisição (`express.json({ limit: '100kb' })`)
  para mitigar negação de serviço por payloads grandes.
- *Soft delete* de produtos (campo `active`) em vez de exclusão física, para
  preservar a integridade do histórico de pedidos antigos.

---

## Limitações conhecidas (o que faltaria para produção real)

- Servir a aplicação atrás de **HTTPS/TLS** (ex.: proxy reverso Nginx +
  Let's Encrypt) e então ativar `COOKIE_SECURE=true`.
- Trocar o "envio de e-mail" simulado por um provedor real (SES, SendGrid…).
- Adicionar autenticação multifator (MFA/2FA) para contas administrativas.
- Para muitos acessos simultâneos ou mais de um servidor, trocar o NeDB
  (embutido, um processo só) por um MongoDB de verdade; a API das consultas é
  muito parecida, então a migração é pequena.
- Adicionar testes automatizados (unitários e de integração) e pipeline de
  CI com `npm audit` / SCA (Software Composition Analysis).
- Rotacionar `JWT_SECRET`/`FIELD_ENCRYPTION_KEY` via um cofre de segredos
  (Vault, AWS Secrets Manager etc.) em vez de arquivo `.env`.
