import { Schema, type InferSchemaType } from 'mongoose';
import { registerModel } from '../../db/register-model.js';

/**
 * One admin mutation that succeeded.
 *
 * Written by middleware on the admin router rather than by each handler, for the reason
 * `requireRole` is mounted there: a per-handler audit call is one forgotten line away from
 * an unaudited route, and nothing would notice. Here a new admin route is audited by
 * existing.
 *
 * **What it records is the request, not the diff.** The route pattern, the target id and
 * who did it — enough to answer "who shipped this order" and "what did anyone do on
 * Tuesday", and to go to the order's own history or the product's current state for the
 * rest. A before/after snapshot of every write would be a second copy of the catalogue
 * that nobody reads, and one that holds whatever a body happened to contain.
 *
 * No TTL. An audit log that forgets is a log of the recent past, which is not the thing
 * anyone reaches for one to find.
 */
const adminAuditSchema = new Schema(
  {
    actor: {
      type: new Schema(
        {
          userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          email: { type: String, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    method: { type: String, required: true },
    /** The matched pattern — `/api/admin/orders/:id/status` — so rows group by action. */
    route: { type: String, required: true },
    /** The concrete path, for the rows where the pattern alone is ambiguous. */
    path: { type: String, required: true },
    targetId: { type: String, default: null },
    status: { type: Number, required: true },
    requestId: { type: String, default: null },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { collection: 'admin_audit', versionKey: false },
);

adminAuditSchema.index({ at: -1 });
adminAuditSchema.index({ targetId: 1, at: -1 });
adminAuditSchema.index({ 'actor.userId': 1, at: -1 });

export type AdminAuditAttrs = InferSchemaType<typeof adminAuditSchema>;

export const AdminAudit = registerModel('AdminAudit', adminAuditSchema);
