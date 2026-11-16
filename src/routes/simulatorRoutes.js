const express = require('express');
const { body } = require('express-validator');
const validateRequest = require('../middleware/validateRequest');
const { requireAuth, requireRole, requireCsrf } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const simulator = require('../services/simulator');

const router = express.Router();

// Todas as rotas do simulador: login obrigatório + papel "admin" (RBAC).
// Um cliente comum recebe 403 mesmo chamando a API direto, sem a tela.
router.use('/admin/simulator', requireAuth, requireRole('admin'));

router.get(
  '/admin/simulator',
  asyncHandler(async (req, res) => res.json(await simulator.status()))
);

router.post(
  '/admin/simulator/start',
  requireCsrf,
  [
    body('phaseSeconds').optional({ values: 'falsy' }).isInt({ min: 5, max: 3600 })
      .withMessage('A duração da fase deve ser entre 5 e 3600 segundos.').toInt(),
    body('intervalSeconds').optional({ values: 'falsy' }).isInt({ min: 1, max: 60 })
      .withMessage('O intervalo entre ações deve ser entre 1 e 60 segundos.').toInt(),
    body('intervalSeconds').custom((value, { req }) => {
      if (value && req.body.phaseSeconds && Number(value) > Number(req.body.phaseSeconds)) {
        throw new Error('O intervalo entre ações não pode ser maior que a duração da fase.');
      }
      return true;
    }),
  ],
  validateRequest,
  asyncHandler(async (req, res) => {
    const { phaseSeconds, intervalSeconds } = req.body;
    const { alreadyRunning } = simulator.start(req.user, { phaseSeconds, intervalSeconds });
    if (alreadyRunning) return res.status(409).json({ error: 'O simulador já está ativo.' });
    return res.json(await simulator.status());
  })
);

router.post(
  '/admin/simulator/stop',
  requireCsrf,
  asyncHandler(async (req, res) => {
    const { alreadyStopped } = simulator.stop(req.user);
    if (alreadyStopped) return res.status(409).json({ error: 'O simulador já está desativado.' });
    return res.json(await simulator.status());
  })
);

module.exports = router;
