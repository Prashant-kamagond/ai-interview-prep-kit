import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { ValidationIssue } from '@trao/core';
import type { KitDoc } from '../models.js';
import type { KitSummaryDoc } from '../repositories/kits.js';
import type { KitService } from '../services/kits.js';

// The kit itself is validated by the shared kit rules in the service; here we only require that
// something was sent.
const kitField = z.custom<unknown>((v) => v !== undefined && v !== null, 'kit is required');

const createBody = z.object({ kit: kitField });
const updateBody = z.object({ version: z.number().int().min(1), kit: kitField });

function kitView(doc: KitDoc, warnings?: ValidationIssue[]) {
  return {
    id: doc._id.toHexString(),
    version: doc.version,
    kit: doc.kit,
    created_at: doc.createdAt.toISOString(),
    updated_at: doc.updatedAt.toISOString(),
    ...(warnings ? { warnings } : {}),
  };
}

function summaryView(doc: KitSummaryDoc) {
  return {
    id: doc._id.toHexString(),
    company: doc.kit.source.company,
    role: doc.kit.source.role,
    version: doc.version,
    created_at: doc.createdAt.toISOString(),
    updated_at: doc.updatedAt.toISOString(),
  };
}

/** Every handler passes the authenticated user's id; there is no code path without an owner. */
export function kitsRouter(deps: { kits: KitService; requireAuth: RequestHandler }): Router {
  const { kits, requireAuth } = deps;
  const router = Router();
  router.use('/kits', requireAuth);

  router.get('/kits', async (req, res) => {
    const docs = await kits.list(req.user!.objectId);
    res.json({ kits: docs.map(summaryView) });
  });

  router.post('/kits', async (req, res) => {
    const { kit } = createBody.parse(req.body ?? {});
    const { doc, warnings } = await kits.create(req.user!.objectId, kit);
    res.status(201).json(kitView(doc, warnings));
  });

  router.get('/kits/:id', async (req, res) => {
    res.json(kitView(await kits.get(req.user!.objectId, req.params.id)));
  });

  router.put('/kits/:id', async (req, res) => {
    const { version, kit } = updateBody.parse(req.body ?? {});
    const { doc, warnings } = await kits.update(req.user!.objectId, req.params.id, version, kit);
    res.json(kitView(doc, warnings));
  });

  router.delete('/kits/:id', async (req, res) => {
    await kits.remove(req.user!.objectId, req.params.id);
    res.status(204).end();
  });

  return router;
}
