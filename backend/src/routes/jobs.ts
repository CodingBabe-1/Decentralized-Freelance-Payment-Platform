/**
 * jobs.ts
 *
 * GET  /api/jobs                   — list jobs (filterable by status, client, freelancer, tag)
 * GET  /api/jobs/tags              — the curated skill-tag list
 * GET  /api/jobs/by-escrow/:escrowId — lookup job by on-chain escrow ID (issue #173)
 * GET  /api/jobs/saved             — the caller's bookmarked jobs
 * POST /api/jobs/:id/save          — bookmark a job
 * DELETE /api/jobs/:id/save        — remove a bookmark
 * POST /api/jobs                   — create a job (off-chain record; escrow funded separately)
 * GET  /api/jobs/:id               — get single job with milestones
 * POST /api/jobs/:id/cancel        — client withdraws an unfunded CREATED job
 * PUT  /api/jobs/:id/assign        — client assigns a freelancer
 *
 * Route order matters: the literal paths (`/tags`, `/by-escrow`, `/saved`) are registered
 * before `/:id`, or they would be read as job ids.
 */

import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { withTransactionRetry } from "../lib/transactionRetry";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { idempotency } from "../middleware/idempotency";
import { AppError } from "../middleware/errorHandler";
import {
  formatAmount,
  getAsset,
  sumAmounts,
  toBaseUnits,
  UnknownAssetError,
  type AssetInfo,
} from "../lib/assets";
import {
  createJobSchema,
  createProposalSchema,
  createDeliverableSchema,
  assignJobSchema,
  listJobsQuerySchema,
} from "../lib/schemas";
import { isSkillTag, SKILL_TAGS, SKILL_TAG_SLUGS } from "../lib/tags";
import { isListed, parseList } from "../lib/access";
import { getArbitratorPanel } from "../lib/arbitratorPanel";
import { notifyProposalSubmitted, notifyJobAssigned } from "../lib/notifications";

export const jobsRouter = Router();

// GET /api/jobs
//
// The query string is parsed with `listJobsQuerySchema` before it reaches
// Prisma: an unknown `status` used to throw inside Prisma (a 500 rather than a
// 400), a non-numeric `page`/`limit` became `NaN` in `skip`/`take`, and `limit`
// was unbounded.
//
// The response is an envelope, `{ data, pagination }`, where `pagination` is
// `{ total, page, limit, totalPages, hasMore }`.
jobsRouter.get("/", async (req, res, next) => {
  try {
    const parsed = listJobsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join(", "));
    }
    const {
      status,
      client,
      freelancer,
      tag,
      q,
      sort,
      sortBy,
      sortOrder,
      page,
      limit,
      isVerified,
      asset,
      createdAfter,
      createdBefore,
    } = parsed.data;

    // A tag the taxonomy does not know is a caller mistake, not "no results" —
    // answering 400 with the accepted slugs keeps a typo from looking like an
    // empty marketplace.
    let tagFilter: string | undefined;
    if (tag !== undefined) {
      const value = String(tag);
      if (!isSkillTag(value)) {
        throw new AppError(400, `Unknown tag "${value}". Accepted tags: ${SKILL_TAG_SLUGS.join(", ")}`);
      }
      tagFilter = value;
    }

    // Date range filters (issue #265)
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (createdAfter) {
      const d = new Date(createdAfter);
      if (isNaN(d.getTime())) throw new AppError(400, "Invalid createdAfter date format");
      dateFilter.gte = d;
    }
    if (createdBefore) {
      const d = new Date(createdBefore);
      if (isNaN(d.getTime())) throw new AppError(400, "Invalid createdBefore date format");
      dateFilter.lte = d;
    }

    // Keyword search (issue #62): one case-insensitive substring match across
    // the two human-readable fields. Empty/whitespace `q` means "no filter".
    const searchFilter = q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { description: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {};

    // Sort order (issue #62, #265).
    let orderBy: Record<string, "asc" | "desc">;
    if (sortBy) {
      const order = sortOrder === "asc" ? ("asc" as const) : ("desc" as const);
      orderBy = { [sortBy]: order };
    } else if (sort === "oldest") {
      orderBy = { createdAt: "asc" };
    } else if (sort === "amount_desc") {
      orderBy = { totalAmount: "desc" };
    } else if (sort === "amount_asc") {
      orderBy = { totalAmount: "asc" };
    } else {
      orderBy = { createdAt: "desc" };
    }

    const where = {
      // Cancelled jobs are withdrawn, not open work: hide them from the
      // default listing (issue #81). They stay reachable by id, and an
      // explicit `?status=CANCELLED` still lists them for history/audit.
      ...(status ? { status } : { status: { not: "CANCELLED" as const } }),
      ...(asset ? { asset } : {}),
      ...(client ? { client: { stellarAddress: client } } : {}),
      ...(freelancer ? { freelancer: { stellarAddress: freelancer } } : {}),
      // Postgres array containment: a job matches when its tags include this one.
      ...(tagFilter ? { tags: { has: tagFilter } } : {}),
      ...(isVerified !== undefined ? { isVerified } : {}),
      ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}),
      ...searchFilter,
    };

    // The count uses the same `where` as the page, so `total` is the size of the
    // whole filtered result set — not of the page.
    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        include: { milestones: true, client: true, freelancer: true },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.job.count({ where }),
    ]);

    // Pagination envelope (issue: total/page metadata), so a client can render
    // page controls without probing out-of-range pages.
    res.json({
      data: jobs,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/tags — the curated taxonomy, so a client can render the picker
// and the filter without duplicating the list (issue #70).
jobsRouter.get("/tags", (_req, res) => {
  res.json(SKILL_TAGS);
});

// GET /api/jobs/by-escrow/:escrowId — direct lookup by on-chain escrow ID.
//
// Frontend pages route by the on-chain escrowId, while most backend API routes
// require the off-chain job.id. This endpoint eliminates expensive multi-page
// scans when searching for a job by its escrow (issue #173).
jobsRouter.get("/by-escrow/:escrowId", async (req, res, next) => {
  try {
    const escrowIdStr = req.params.escrowId;
    
    // Parse the escrow ID as a BigInt. Allow both string and number formats.
    let escrowId: bigint;
    try {
      escrowId = BigInt(escrowIdStr);
    } catch {
      throw new AppError(400, "Invalid escrow ID format");
    }

    const job = await prisma.job.findUnique({
      where: { escrowId },
      include: { milestones: true, client: true, freelancer: true },
    });
    
    if (!job) throw new AppError(404, "Job not found");
    res.json(job);
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/saved — the caller's bookmarks, most recently saved first.
//
// Returns job rows (not bookmark rows) so the client can render them with the
// same list component it uses for `GET /api/jobs` (issue #71).
jobsRouter.get("/saved", requireAuth, async (_req, res, next) => {
  try {
    const saved = await prisma.savedJob.findMany({
      where: { user: { stellarAddress: res.locals.stellarAddress } },
      orderBy: { createdAt: "desc" },
      include: { job: { include: { milestones: true, client: true, freelancer: true } } },
    });
    res.json(saved.map((entry) => entry.job));
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/save
//
// Idempotent: `upsert` on the (user, job) key, so a double click leaves one
// bookmark rather than a 409 the UI has to interpret.
jobsRouter.post("/:id/save", requireAuth, async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!job) throw new AppError(404, "Job not found");

    const user = await prisma.user.findUnique({
      where: { stellarAddress: res.locals.stellarAddress },
      select: { id: true },
    });
    if (!user) throw new AppError(404, "User not found — call /api/users/auth first");

    const saved = await prisma.savedJob.upsert({
      where: { userId_jobId: { userId: user.id, jobId: job.id } },
      create: { userId: user.id, jobId: job.id },
      update: {},
    });
    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/jobs/:id/save — unsaving something that was never saved is a
// no-op, not an error, so the toggle always settles.
jobsRouter.delete("/:id/save", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { stellarAddress: res.locals.stellarAddress },
      select: { id: true },
    });
    if (!user) throw new AppError(404, "User not found — call /api/users/auth first");

    await prisma.savedJob.deleteMany({ where: { userId: user.id, jobId: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs (idempotent, issue #267)
jobsRouter.post("/", requireAuth, idempotency(), validate(createJobSchema), async (req, res, next) => {
  try {
    const { title, description, milestones, expiresAt, asset, tags } = req.body as z.infer<
      typeof createJobSchema
    >;

    let assetInfo: AssetInfo;
    try {
      assetInfo = getAsset(asset);
    } catch (err) {
      if (err instanceof UnknownAssetError) throw new AppError(400, err.message);
      throw err;
    }

    const client = await prisma.user.findUnique({
      where: { stellarAddress: res.locals.stellarAddress },
    });
    if (!client) throw new AppError(404, "User not found — call /api/users/auth first");

    // Sum in the asset's integer base units and format once. Adding whole-unit
    // decimals as JavaScript numbers carries float error into the DECIMAL(65,30)
    // column: two `0.1` milestones became `0.30000000000000004`, which is what
    // GET /api/jobs then returned and the dashboard displayed.
    const totalAmount = formatAmount(
      sumAmounts(milestones.map((m) => m.amount), assetInfo.decimals),
      assetInfo.decimals,
    );

    const job = await prisma.job.create({
      data: {
        title,
        description,
        asset: assetInfo.symbol,
        tags,
        totalAmount,
        clientId: client.id,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        milestones: {
          create: milestones.map((m, i) => ({
            index: i,
            // Store each amount at the asset's own precision so the milestones
            // and the total are consistent with the on-chain base units.
            amount: formatAmount(
              toBaseUnits(m.amount, assetInfo.decimals),
              assetInfo.decimals,
            ),
            description: m.description,
            deadline: m.deadline ? new Date(m.deadline) : undefined,
          })),
        },
      },
      include: { milestones: true },
    });

    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id
jobsRouter.get("/:id", optionalAuth, async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      include: {
        milestones: {
          include: {
            deliverables: {
              include: { uploadedBy: true },
              orderBy: { createdAt: "desc" },
            },
          },
          orderBy: { index: "asc" },
        },
        client: true,
        freelancer: true,
        // PENDING rows are intents whose transaction was built but not confirmed;
        // they must not appear on a job either (#32).
        disputes: { where: { onChainId: { not: null } }, orderBy: { createdAt: "asc" } },
        ratings: true,
        proposals: { include: { freelancer: true }, orderBy: { createdAt: "desc" } },
      },
    });
    if (!job) throw new AppError(404, "Job not found");

    // Restrict proposal details visibility (issue #309):
    // 1. Client can view all submitted proposals.
    // 2. Authenticated freelancer can view only their own proposal.
    // 3. Unauthenticated visitor or other third parties receive an empty list.
    const callerAddress = res.locals.stellarAddress;
    if (!callerAddress) {
      job.proposals = [];
    } else if (job.client?.stellarAddress !== callerAddress) {
      job.proposals = (job.proposals || []).filter(
        (p) => p.freelancer?.stellarAddress === callerAddress,
      );
    }

    res.json(job);
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/cancel — withdraw an unfunded job (issue #81).
//
// Only the client may cancel, and only while the job is still CREATED with no
// on-chain escrow: once funds exist the refund/resolve paths own the job. A
// repeat call is a no-op that returns the already-cancelled row, so a retried
// request settles instead of erroring.
jobsRouter.post("/:id/cancel", requireAuth, async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      include: { client: true },
    });
    if (!job) throw new AppError(404, "Job not found");

    if (job.client.stellarAddress !== res.locals.stellarAddress) {
      throw new AppError(403, "Only the client can cancel this job");
    }

    // Already withdrawn: return the row rather than a conflict, so a retry
    // after a dropped response does not look like a failure.
    if (job.status === "CANCELLED") {
      res.json(job);
      return;
    }

    if (
      job.status !== "CREATED" ||
      (job.escrowId !== null && job.escrowId !== undefined)
    ) {
      throw new AppError(409, "Only an unfunded CREATED job can be cancelled");
    }

    const cancelled = await prisma.job.update({
      where: { id: job.id },
      data: { status: "CANCELLED" },
    });

    // The job is gone from the marketplace, so pending applications have
    // nothing left to compete for. They are rejected rather than left dangling
    // for a freelancer to wonder about.
    await prisma.proposal.updateMany({
      where: { jobId: job.id, status: "PENDING" },
      data: { status: "REJECTED" },
    });

    res.json(cancelled);
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/proposals (idempotent, issue #267)
jobsRouter.post("/:id/proposals", requireAuth, idempotency(), validate(createProposalSchema), async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      include: { client: true },
    });
    if (!job) throw new AppError(404, "Job not found");

    if (job.client.stellarAddress === res.locals.stellarAddress) {
      throw new AppError(400, "Client cannot apply to their own job");
    }

    if (job.freelancerId || job.status !== "CREATED") {
      throw new AppError(400, "Job is not open for proposals");
    }

    const freelancer = await prisma.user.upsert({
      where: { stellarAddress: res.locals.stellarAddress },
      create: { stellarAddress: res.locals.stellarAddress },
      update: {},
    });

    const { coverLetter, proposedRate } = req.body as {
      coverLetter?: string;
      proposedRate?: string | number;
    };

    try {
      const proposal = await prisma.proposal.create({
        data: {
          jobId: job.id,
          freelancerId: freelancer.id,
          coverLetter,
          proposedRate: proposedRate !== undefined ? String(proposedRate) : undefined,
        },
        include: { freelancer: true },
      });

      void notifyProposalSubmitted(
        { id: job.id, title: job.title, client: job.client },
        proposal,
        freelancer,
      );

      res.status(201).json(proposal);
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === "P2002") {
        throw new AppError(409, "You have already applied for this job");
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/proposals
//
// Bids, rates and cover letters are private to the people involved, so this is
// authenticated and follows the same visibility rule as the proposals embedded
// in GET /api/jobs/:id (issue #309): the job's client sees every proposal, a
// freelancer who applied sees only their own, and anyone else is refused.
jobsRouter.get("/:id/proposals", requireAuth, async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: req.params.id },
      include: { client: true },
    });
    if (!job) throw new AppError(404, "Job not found");

    const callerAddress = res.locals.stellarAddress;
    const isClient = job.client?.stellarAddress === callerAddress;

    const proposals = await prisma.proposal.findMany({
      where: {
        jobId: job.id,
        ...(isClient ? {} : { freelancer: { stellarAddress: callerAddress } }),
      },
      include: { freelancer: true },
      orderBy: { createdAt: "desc" },
    });

    if (!isClient && proposals.length === 0) {
      throw new AppError(403, "Access denied: only the client or an applicant can view proposals");
    }

    res.json(proposals);
  } catch (err) {
    next(err);
  }
});

// PUT /api/jobs/:id/assign — assign freelancer under RepeatableRead isolation (issue #276, #267)
jobsRouter.put("/:id/assign", requireAuth, idempotency(), validate(assignJobSchema), async (req, res, next) => {
  try {
    const { freelancerAddress } = req.body as z.infer<typeof assignJobSchema>;

    // The job update, the winning proposal's ACCEPTED transition and the
    // rejection of competing PENDING proposals must commit or roll back
    // together, so a failure part-way never leaves a job assigned while its
    // proposals are still PENDING.
    const updated = (await withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const job = await tx.job.findUnique({
            where: { id: req.params.id },
            include: { client: true },
          });
          if (!job) throw new AppError(404, "Job not found");
          if (job.client.stellarAddress !== res.locals.stellarAddress) {
            throw new AppError(403, "Only the client can assign a freelancer");
          }

          if (job.freelancerId) {
            throw new AppError(400, "Job is already assigned to a freelancer");
          }

          if (job.client.stellarAddress === freelancerAddress) {
            throw new AppError(400, "Client cannot be assigned as freelancer to their own job");
          }

          const freelancer = await tx.user.findUnique({
            where: { stellarAddress: freelancerAddress },
          });
          if (!freelancer) throw new AppError(404, "Freelancer not found");

          const assigned = await tx.job.update({
            where: { id: req.params.id },
            data: { freelancerId: freelancer.id },
          });

          // Accept selected proposal and reject other pending proposals
          await tx.proposal.updateMany({
            where: { jobId: job.id, freelancerId: freelancer.id },
            data: { status: "ACCEPTED" },
          });
          await tx.proposal.updateMany({
            where: { jobId: job.id, freelancerId: { not: freelancer.id }, status: "PENDING" },
            data: { status: "REJECTED" },
          });

          return { assigned, job, freelancer };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
    )) as {
      assigned: Prisma.JobGetPayload<Record<string, never>>;
      job: Prisma.JobGetPayload<{ include: { client: true } }>;
      freelancer: Prisma.UserGetPayload<Record<string, never>>;
    };

    void notifyJobAssigned(
      { id: updated.job.id, title: updated.job.title, client: updated.job.client },
      updated.freelancer,
    );

    res.json(updated.assigned);
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:jobId/milestones/:index/deliverables
jobsRouter.post(
  "/:jobId/milestones/:index/deliverables",
  requireAuth,
  validate(createDeliverableSchema),
  async (req, res, next) => {
    try {
      const milestoneIndex = parseInt(req.params.index, 10);
      if (isNaN(milestoneIndex)) throw new AppError(400, "Invalid milestone index");

      const job = await prisma.job.findUnique({
        where: { id: req.params.jobId },
        include: { freelancer: true },
      });
      if (!job) throw new AppError(404, "Job not found");

      if (job.freelancer?.stellarAddress !== res.locals.stellarAddress) {
        throw new AppError(403, "Only the assigned freelancer can attach deliverables to this milestone");
      }

      const milestone = await prisma.milestone.findFirst({
        where: { jobId: job.id, index: milestoneIndex },
      });
      if (!milestone) throw new AppError(404, "Milestone not found");

      if (milestone.status === "RELEASED") {
        throw new AppError(400, "Cannot attach deliverables to an already released milestone");
      }

      const user = await prisma.user.upsert({
        where: { stellarAddress: res.locals.stellarAddress },
        create: { stellarAddress: res.locals.stellarAddress },
        update: {},
      });

      const { fileName, fileUrl, fileSize, fileType, description } = req.body as {
        fileName: string;
        fileUrl: string;
        fileSize?: number;
        fileType?: string;
        description?: string;
      };

      const deliverable = await prisma.deliverable.create({
        data: {
          milestoneId: milestone.id,
          fileName,
          fileUrl,
          fileSize,
          fileType,
          description,
          uploadedById: user.id,
        },
        include: { uploadedBy: true },
      });

      res.status(201).json(deliverable);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/jobs/:jobId/milestones/:index/deliverables
//
// Deliverables are confidential work product, so this mirrors the access rule of
// GET /api/milestones/:id/deliverables: only the job's client, its assigned
// freelancer or a panel arbitrator may read them.
jobsRouter.get("/:jobId/milestones/:index/deliverables", requireAuth, async (req, res, next) => {
  try {
    const milestoneIndex = parseInt(req.params.index, 10);
    if (isNaN(milestoneIndex)) throw new AppError(400, "Invalid milestone index");

    const job = await prisma.job.findUnique({
      where: { id: req.params.jobId },
      include: { client: true, freelancer: true },
    });
    if (!job) throw new AppError(404, "Job not found");

    const stellarAddress = res.locals.stellarAddress;
    const isParticipant =
      job.client?.stellarAddress === stellarAddress ||
      job.freelancer?.stellarAddress === stellarAddress;
    if (!isParticipant && !isListed(stellarAddress, await getArbitratorPanel())) {
      throw new AppError(403, "Access denied: you must be the client, freelancer, or arbitrator");
    }

    const milestone = await prisma.milestone.findFirst({
      where: { jobId: job.id, index: milestoneIndex },
    });
    if (!milestone) throw new AppError(404, "Milestone not found");

    const deliverables = await prisma.deliverable.findMany({
      where: { milestoneId: milestone.id },
      include: { uploadedBy: true },
      orderBy: { createdAt: "desc" },
    });

    res.json(deliverables);
  } catch (err) {
    next(err);
  }
});

export const verifyJobSchema = z.object({
  isVerified: z.boolean().default(true),
  verificationSource: z.string().trim().min(1).max(100).nullable().optional(),
});

const requireAdmin: RequestHandler = (_req, res, next) => {
  const admins = parseList(config.INDEXER_ADMIN_ADDRESSES);
  if (admins.length === 0) {
    return next(new AppError(503, "Administration is unavailable: no admins configured"));
  }
  if (!isListed(res.locals.stellarAddress, admins)) {
    return next(new AppError(403, "Only a configured admin can verify jobs"));
  }
  next();
};

// PATCH /api/jobs/:id/verify (issue #314)
jobsRouter.patch(
  "/:id/verify",
  requireAuth,
  requireAdmin,
  validate(verifyJobSchema),
  async (req, res, next) => {
    try {
      const { isVerified, verificationSource } = req.body;
      const existing = await prisma.job.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        throw new AppError(404, "Job not found");
      }

      const updated = await prisma.job.update({
        where: { id: req.params.id },
        data: {
          isVerified,
          verificationSource: isVerified ? (verificationSource ?? "Stellar Community Fund") : null,
        },
        include: {
          milestones: { orderBy: { index: "asc" } },
          client: { select: { id: true, stellarAddress: true, displayName: true } },
          freelancer: { select: { id: true, stellarAddress: true, displayName: true } },
        },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);
