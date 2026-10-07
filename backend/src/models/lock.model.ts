import * as mongoose from 'mongoose';

/**
 * Mutual exclusion between processes, stored where they can all see it.
 *
 * Two backend instances can receive a withdrawal for the same merchant at the
 * same moment, and both will decide the vault needs deploying. An in-memory
 * lock cannot stop that — each process would be excluding only itself — so the
 * lock lives in the database, which is the one piece of shared infrastructure
 * this project already has.
 *
 * `_id` is the lock key rather than a generated ObjectId: it makes "at most one
 * holder per resource" the same rule as "at most one document per `_id`", which
 * the database enforces already. Acquiring is a single upsert against that key,
 * so there is no read-then-write window for a second caller to slip through.
 *
 * ## The TTL index is a janitor, not the mechanism
 *
 * MongoDB's TTL monitor runs about once a minute, so an expired lock can sit in
 * the collection for a while after it has stopped meaning anything. Nothing
 * depends on it having been deleted: the acquire query treats `expiresAt` in
 * the past as free and takes the record over. The index exists so that a
 * process which dies mid-operation does not leave a row behind forever.
 */
const lockSchema = new mongoose.Schema<ILock>(
  {
    _id: {
      type: String,
      required: true,
    },
    owner: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    // A lock is not a domain record: it has no version to track and no
    // created/updated timestamps worth keeping.
    versionKey: false,
  },
);

lockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const lockModel = mongoose.model<ILock>('Lock', lockSchema);

export default lockModel;
